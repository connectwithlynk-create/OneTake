import AVFoundation
import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation
import QuartzCore
import UIKit
import Vision

/// Counter accessed from AVFoundation's concurrent CIFilter handler
/// queue. Uses os_unfair_lock for atomic increment — the closure can
/// fire from multiple threads in parallel and a plain Int increment
/// would race.
final class HandlerCounter {
  private var value: UInt64 = 0
  private var lock = os_unfair_lock_s()
  func next() -> UInt64 {
    os_unfair_lock_lock(&lock)
    value &+= 1
    let v = value
    os_unfair_lock_unlock(&lock)
    return v
  }
}

/// Resident memory of this process in megabytes. Reads
/// `mach_task_basic_info`, which is what jetsam consults when deciding
/// whether to kill a backgrounded/foreground app for OOM. Cheap (~µs).
/// Returns -1 on failure so callers don't have to handle optionals
/// inside the crumb data dict.
func processResidentMB() -> Double {
  var info = mach_task_basic_info()
  var count = mach_msg_type_number_t(
    MemoryLayout<mach_task_basic_info>.size / MemoryLayout<integer_t>.size
  )
  let kr = withUnsafeMutablePointer(to: &info) {
    $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
      task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
    }
  }
  if kr != KERN_SUCCESS { return -1 }
  return Double(info.resident_size) / (1024.0 * 1024.0)
}

/// Persistent ring of native breadcrumbs, batch-flushed to
/// `<docs>/native-breadcrumbs.jsonl` on a serial queue. Survives
/// process death (jetsam / watchdog / SIGSEGV) so the JS-side
/// /debug-crash screen can show what the native side was doing in
/// the last ~200ms before the kill.
///
/// Why a file: NSLog goes to the unified system log, which Metro
/// doesn't show — users staring at Metro see "nothing" when iOS
/// terminates the app. A simple JSONL file in the document dir is
/// readable from JS on the next launch.
final class NativeCrumbStore {
  static let shared = NativeCrumbStore()
  private let queue = DispatchQueue(label: "nle.crumb", qos: .utility)
  private var pending: [String] = []
  private let pathOnce: () -> String = {
    let docs =
      NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true)
        .first ?? NSTemporaryDirectory()
    return (docs as NSString).appendingPathComponent("native-breadcrumbs.jsonl")
  }
  private lazy var path: String = pathOnce()
  private let maxBytes: UInt64 = 96 * 1024 // 96KB rolling cap
  private var lastFlush: Date = .distantPast

  func add(source: String, msg: String, data: [String: Any]? = nil) {
    let ts = Date().timeIntervalSince1970 * 1000 // ms epoch, matches JS
    var entry: [String: Any] = [
      "ts": ts,
      "source": source,
      "msg": msg,
    ]
    if let data = data { entry["data"] = data }
    queue.async {
      if let json = try? JSONSerialization.data(withJSONObject: entry, options: []),
         let line = String(data: json, encoding: .utf8) {
        self.pending.append(line + "\n")
        self.maybeFlushLocked()
      }
    }
  }

  /// Force a flush — useful right before a known-risky op so the file
  /// reflects everything up to that point even if the op kills us.
  func flush() {
    queue.sync { self.flushLocked() }
  }

  private func maybeFlushLocked() {
    // Flush aggressively (every entry, no debounce) so the trail is on
    // disk as fast as we can write it. The disk cost is small compared
    // to the value of capturing what was happening in the last few
    // milliseconds before iOS terminates us. Without this, batched
    // flushes leave a black hole right where the crash lives.
    flushLocked()
    lastFlush = Date()
  }

  private func flushLocked() {
    if pending.isEmpty { return }
    let blob = pending.joined()
    pending.removeAll(keepingCapacity: true)
    // Roll if oversize.
    if let attrs = try? FileManager.default.attributesOfItem(atPath: path),
       let size = attrs[.size] as? UInt64, size > maxBytes {
      if let text = try? String(contentsOfFile: path, encoding: .utf8) {
        let tail = String(text.suffix(Int(maxBytes / 2)))
        // Strip a partial leading line so the JSONL stays parseable.
        if let nl = tail.firstIndex(of: "\n") {
          try? tail[tail.index(after: nl)...].write(
            toFile: path, atomically: true, encoding: .utf8
          )
        } else {
          try? "".write(toFile: path, atomically: true, encoding: .utf8)
        }
      }
    }
    if let fh = FileHandle(forWritingAtPath: path) {
      fh.seekToEndOfFile()
      if let d = blob.data(using: .utf8) { fh.write(d) }
      fh.closeFile()
    } else {
      try? blob.write(toFile: path, atomically: true, encoding: .utf8)
    }
  }
}

/// One clip on the composed timeline.
struct NleClip {
  let id: String
  let url: URL
  let inMs: Double   // trim in (source ms)
  let outMs: Double  // trim out (source ms)
  let volume: Float
  // Color adjust (defaults are neutral)
  let brightness: Float
  let contrast: Float
  let saturation: Float
  let warmth: Float
  let shadows: Float
  let highlights: Float
  // Chroma key
  let chromaEnabled: Bool
  let chromaColor: String  // '#RRGGBB' or ''
  let chromaThreshold: Float
  // Person segmentation (Cutout). When true, the CIFilter pass masks
  // frames so only the segmented person remains over a transparent BG.
  let cutoutEnabled: Bool

  init?(dict: [String: Any]) {
    guard
      let id = dict["id"] as? String,
      let uriStr = dict["uri"] as? String,
      let inMs = (dict["inMs"] as? Double) ?? (dict["inMs"] as? NSNumber)?.doubleValue,
      let outMs = (dict["outMs"] as? Double) ?? (dict["outMs"] as? NSNumber)?.doubleValue
    else { return nil }
    let url: URL = URL(string: uriStr) ?? URL(fileURLWithPath: uriStr)
    self.id = id
    self.url = url
    self.inMs = max(0, inMs)
    self.outMs = max(self.inMs, outMs)
    let v = (dict["volume"] as? Double) ?? (dict["volume"] as? NSNumber)?.doubleValue ?? 1.0
    self.volume = Float(max(0.0, min(1.0, v)))
    func f(_ key: String, _ def: Float) -> Float {
      if let n = dict[key] as? Double { return Float(n) }
      if let n = (dict[key] as? NSNumber)?.doubleValue { return Float(n) }
      return def
    }
    self.brightness = f("brightness", 0)
    self.contrast = f("contrast", 1)
    self.saturation = f("saturation", 1)
    self.warmth = f("warmth", 0)
    self.shadows = f("shadows", 0)
    self.highlights = f("highlights", 0)
    self.chromaEnabled = (dict["chromaEnabled"] as? Bool) ?? false
    self.chromaColor = (dict["chromaColor"] as? String) ?? ""
    self.chromaThreshold = f("chromaThreshold", 0.3)
    self.cutoutEnabled = (dict["cutoutEnabled"] as? Bool) ?? false
  }

  /// True if this clip's effect bag deviates from the neutral defaults
  /// in any way that warrants a CoreImage pass.
  var hasColorEffects: Bool {
    return abs(brightness) > 0.001
      || abs(contrast - 1) > 0.001
      || abs(saturation - 1) > 0.001
      || abs(warmth) > 0.001
      || abs(shadows) > 0.001
      || abs(highlights) > 0.001
      || chromaEnabled
      || cutoutEnabled
  }
}

/// Wraps an AVMutableComposition + AVPlayer. Owns a CADisplayLink for
/// frame-synced time updates and emits events upward via a sink.
final class NleEngine {
  typealias EventSink = (String, [String: Any]) -> Void

  let handle: Int
  private var sink: EventSink = { _, _ in }

  private var clips: [NleClip] = []
  /// Cumulative composed-timeline starts (ms), length = clips.count + 1.
  private var cumulativeMs: [Double] = [0]
  /// Total composed duration in ms.
  private var totalMs: Double = 0

  private let player = AVPlayer()
  private var item: AVPlayerItem?
  private var displayLink: CADisplayLink?
  private var lastClipIndex = -1
  private var statusObs: NSKeyValueObservation?
  private var rateObs: NSKeyValueObservation?
  private var endObs: NSObjectProtocol?
  // Pre-warm pool: keep AVURLAssets resident so the decoder ramp-up cost
  // for a clip is paid before we need its frames on the composed timeline.
  // Composition can re-use the same AVAsset across composition tracks.
  private var assetCache: [URL: AVURLAsset] = [:]

  /// Per-clip volume — applied via an AVMutableAudioMix at composition build.
  private var clipVolumes: [String: Float] = [:]

  init(handle: Int, sink: @escaping EventSink) {
    self.handle = handle
    self.sink = sink
    // Allows the AVPlayer to keep playing when the screen goes to sleep
    // in pathological cases. iOS pauses bg playback by default anyway.
    self.player.automaticallyWaitsToMinimizeStalling = false
    // Subscribe to memory warnings — when iOS fires this we're close to
    // jetsam kill. The crumb gives us the smoking gun if a kill follows.
    NotificationCenter.default.addObserver(
      forName: UIApplication.didReceiveMemoryWarningNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      guard let self = self else { return }
      self.crumb(
        "MEMORY WARNING",
        data: ["residentMB": processResidentMB()]
      )
      NativeCrumbStore.shared.flush()
    }
  }

  deinit {
    stopDisplayLink()
    if let endObs = endObs { NotificationCenter.default.removeObserver(endObs) }
    statusObs?.invalidate()
    rateObs?.invalidate()
  }

  // MARK: - Public API

  func setClips(_ clips: [NleClip]) {
    crumb(
      "setClips",
      data: [
        "n": clips.count,
        "ids": clips.map { String($0.id.prefix(6)) },
        "prevTot": totalMs,
        "playing": player.timeControlStatus == .playing,
        "t": currentTimeMs(),
      ]
    )
    self.clips = clips
    // Recompute cumulative timeline (ms).
    var cum: [Double] = [0]
    for c in clips {
      cum.append(cum.last! + max(0, c.outMs - c.inMs))
    }
    self.cumulativeMs = cum
    self.totalMs = cum.last ?? 0
    self.clipVolumes = Dictionary(uniqueKeysWithValues: clips.map { ($0.id, $0.volume) })
    rebuildComposition()
  }

  func play() {
    crumb("play", data: ["t": currentTimeMs(), "tot": totalMs])
    player.play()
    startDisplayLink()
    emit("onPlayingChange", ["isPlaying": true])
  }

  func pause() {
    crumb("pause", data: ["t": currentTimeMs()])
    player.pause()
    emit("onPlayingChange", ["isPlaying": false])
    // Keep display link running briefly so the JS side gets a final
    // tick reflecting the paused time; it'll idle itself otherwise.
  }

  // Scrub-coalescing state. seek(ms:) writes chaseMs and kicks off an
  // actual AVPlayer seek only if none is in flight; the completion
  // handler chases to whatever the latest target became while it was
  // working. Without this, scroll-driven scrub (one seek per ScrollView
  // frame, .zero tolerance) piles up inside AVFoundation and wedges
  // the player — Apple QA1820 antipattern.
  private var chaseMs: Double = -1
  private var isSeekInProgress = false

  // Scrub bypass. JS sets this true on scroll begin / false on settle
  // (onMomentumScrollEnd / scrubEndTimer). When true, the CIFilter
  // handler returns request.sourceImage unmodified — skipping color
  // adjust + Vision personSegmentation + chroma key. Vision requests in
  // particular are stateful + not thread-safe and have been the prime
  // suspect for native crashes during fast scrub (no NSException, no
  // jetsam, just death — classic EXC_BAD_ACCESS).
  //
  // Atomic-ish access: reading a Bool from a CIFilter handler on a
  // background queue while main writes is safe in practice on aligned
  // platforms; we don't need a lock.
  private var isScrubbing = false
  /// Sampled-by-8 counter for the seek breadcrumb. Sub-counting avoids
  /// hammering the crumb file at 60Hz scrub.
  private var seekCallCount: UInt = 0

  func setScrubbing(_ on: Bool) {
    isScrubbing = on
    crumb("setScrubbing", data: ["on": on])
    NativeCrumbStore.shared.flush()
  }

  func seek(ms: Double) {
    chaseMs = max(0, min(totalMs, ms))
    seekCallCount &+= 1
    if seekCallCount % 8 == 0 {
      crumb(
        "seek (sampled 1:8)",
        data: [
          "chaseMs": chaseMs,
          "inFlight": isSeekInProgress,
          "residentMB": processResidentMB(),
        ]
      )
    }
    if !isSeekInProgress { actuallySeek() }
    tickEmit() // immediate UI feedback
  }

  /// Best-effort breadcrumb. Goes to two places:
  ///   1. NSLog → unified system log (Xcode console / log stream)
  ///   2. NativeCrumbStore → persistent JSONL the JS side reads on the
  ///      next launch after an iOS-level kill (jetsam / watchdog /
  ///      SIGSEGV won't reach any handler, but the file persists).
  /// Keep call sites narrow — scrub paths fire thousands of times a
  /// second and shouldn't drown the log.
  private func crumb(_ msg: String, data: [String: Any]? = nil) {
    NSLog("[NleEngine h=%d] %@", handle, msg)
    NativeCrumbStore.shared.add(
      source: "nle.engine.h\(handle)", msg: msg, data: data
    )
  }

  /// Run the AVPlayer seek for the current chase target. ~50ms tolerance
  /// is loose enough that rapid scrub seeks finish before the next one
  /// arrives; the settle commit (onMomentumScrollEnd) seeks once more
  /// via the same path — also at 50ms — which is fine for editor scrub.
  /// Frame-accurate seeks are reserved for rebuildComposition's
  /// position-restore path, which has its own completion handler.
  private func actuallySeek() {
    let toSeek = chaseMs
    if toSeek < 0 { return }
    isSeekInProgress = true
    let time = CMTime(value: CMTimeValue(toSeek), timescale: 1000)
    let tol = CMTime(value: 50, timescale: 1000)
    player.seek(to: time, toleranceBefore: tol, toleranceAfter: tol) { [weak self] _ in
      guard let self = self else { return }
      self.isSeekInProgress = false
      if abs(self.chaseMs - toSeek) > 1 {
        self.actuallySeek()
      } else {
        // End of a scrub burst — flush so the crumb file reflects the
        // last seek even if the next thing the user does is the thing
        // that kills the app.
        NativeCrumbStore.shared.flush()
      }
    }
  }

  func setClipVolume(clipId: String, volume: Double) {
    let v = Float(max(0.0, min(1.0, volume)))
    clipVolumes[clipId] = v
    // Rebuild the audio mix without touching the video composition.
    item?.audioMix = buildAudioMix()
  }

  func currentTimeMs() -> Double {
    let t = player.currentTime()
    if !t.isValid || t.isIndefinite { return 0 }
    return CMTimeGetSeconds(t) * 1000.0
  }
  func durationMs() -> Double { totalMs }
  func isPlaying() -> Bool { player.timeControlStatus == .playing }

  /// View attachment hook. The view installs its AVPlayerLayer onto our
  /// player when it gets the handle.
  var avPlayer: AVPlayer { player }

  // MARK: - Composition

  private func asset(for url: URL) -> AVURLAsset {
    if let a = assetCache[url] { return a }
    let a = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
    assetCache[url] = a
    return a
  }

  /// Monotonic build id — every setClips() bumps this, and the async
  /// composition build only commits if its id is still current. Prevents
  /// a slow build from a stale clip list overwriting a newer one.
  private var buildId: Int = 0

  private func rebuildComposition() {
    buildId += 1
    let myBuildId = buildId
    crumb(
      "rebuildComposition begin buildId=\(myBuildId) clips=\(clips.count)",
      data: ["residentMB": processResidentMB()]
    )

    // Preserve current playback position so a rebuild during scrub /
    // trim doesn't snap the playhead back to zero.
    let previousTime = player.currentTime()
    let wasPlaying = player.timeControlStatus == .playing

    if let endObs = endObs { NotificationCenter.default.removeObserver(endObs) }
    statusObs?.invalidate()
    rateObs?.invalidate()

    emit("onStatusChange", ["status": "loading"])

    let snapshot = clips
    Task { [weak self] in
      guard let self = self else { return }
      let comp = AVMutableComposition()
      let videoTrack = comp.addMutableTrack(
        withMediaType: .video,
        preferredTrackID: kCMPersistentTrackID_Invalid
      )
      let audioTrack = comp.addMutableTrack(
        withMediaType: .audio,
        preferredTrackID: kCMPersistentTrackID_Invalid
      )

      // One layer instruction for the single composed video track,
      // with a SINGLE setTransform(_:at: .zero) using the first clip's
      // preferredTransform. Per-clip setTransform calls created a step
      // function that crashed AVFoundation at clip boundaries (silent
      // SIGKILL with no crumb flush). All clips in a recording session
      // are assumed same-orientation; mixed-orientation projects will
      // render the off-orientation clips rotated wrong rather than
      // crash, which is the better failure mode.
      let layerInstruction = videoTrack.map {
        AVMutableVideoCompositionLayerInstruction(assetTrack: $0)
      }
      var renderSize: CGSize = .zero
      // Per-clip preferredTransforms parallel to `snapshot` (NOT to
      // the inserted clips), so indexFor(time:cumulative:) — which uses
      // cumulativeS built from `snapshot` — can look up the right
      // transform. Skipped clips stay at .identity; their slots on the
      // composition timeline are empty anyway. The CIFilter handler
      // path doesn't pick up layer-instruction transforms, so we apply
      // these to request.sourceImage ourselves at handler time.
      var clipTransforms: [CGAffineTransform] =
        Array(repeating: .identity, count: snapshot.count)

      var insertionTime = CMTime.zero
      var insertedVideo = false
      var skipped: [(index: Int, id: String, reason: String)] = []
      for (cIdx, c) in snapshot.enumerated() {
        // Skip zero-or-negative-duration clips defensively. The
        // insertTimeRange call would throw and abort this slot's build
        // anyway — better to log + continue.
        if c.outMs - c.inMs <= 0 {
          skipped.append((cIdx, c.id, "zero duration"))
          continue
        }
        // Skip clips whose file isn't on disk — happens transiently
        // right after picker copies / network downloads.
        if c.url.isFileURL, !FileManager.default.fileExists(atPath: c.url.path) {
          skipped.append((cIdx, c.id, "file missing"))
          continue
        }
        let a = self.asset(for: c.url)
        // Try loadTracks once; on failure wait 200ms and retry, since
        // freshly-written files sometimes need a beat before AVAsset
        // can probe them.
        var videos: [AVAssetTrack] = []
        var audios: [AVAssetTrack] = []
        var loadErr: Error?
        for attempt in 0..<2 {
          do {
            videos = try await a.loadTracks(withMediaType: .video)
            audios = try await a.loadTracks(withMediaType: .audio)
            loadErr = nil
            break
          } catch {
            loadErr = error
            if attempt == 0 {
              try? await Task.sleep(nanoseconds: 200_000_000)
            }
          }
        }
        if let err = loadErr {
          skipped.append((cIdx, c.id, "loadTracks failed: \(err.localizedDescription)"))
          continue
        }
        if videos.isEmpty {
          skipped.append((cIdx, c.id, "no video tracks"))
          continue
        }

        let start = CMTime(value: CMTimeValue(c.inMs), timescale: 1000)
        let duration = CMTime(
          value: CMTimeValue(max(0, c.outMs - c.inMs)),
          timescale: 1000
        )
        let range = CMTimeRange(start: start, duration: duration)

        if let v = videos.first, let videoTrack = videoTrack {
          do {
            try videoTrack.insertTimeRange(range, of: v, at: insertionTime)
            insertedVideo = true

            let transform = v.preferredTransform
            clipTransforms[cIdx] = transform

            // Rotation diagnostic. iPhone portrait clips should land
            // here with naturalSize=(1920,1080) and transform≈
            // (a=0,b=1,c=-1,d=0,tx=1080,ty=0). If we see identity or
            // unexpected values, the source itself is wrong (recording
            // pipeline lost orientation metadata) and no amount of
            // composition wiring fixes it.
            let ns = v.naturalSize
            self.crumb(
              "clip transform",
              data: [
                "cIdx": cIdx,
                "id": c.id,
                "naturalW": Double(ns.width),
                "naturalH": Double(ns.height),
                "a": Double(transform.a),
                "b": Double(transform.b),
                "c": Double(transform.c),
                "d": Double(transform.d),
                "tx": Double(transform.tx),
                "ty": Double(transform.ty),
              ]
            )

            // Use the FIRST clip's preferredTransform as the single,
            // time-invariant transform on the layer instruction.
            // Multiple setTransform(_:at:) calls (one per seam) create
            // a step-function transform that AVFoundation has been
            // observed to choke on at clip boundaries — silent decoder
            // kills with no NSException, no jetsam, no native crumb
            // flush. Single setTransform avoids the discontinuity.
            // Assumption: clips in a single recording session share
            // orientation. If a mixed-orientation clip appears, it
            // will render rotated wrong rather than crashing.
            if renderSize == .zero {
              layerInstruction?.setTransform(transform, at: .zero)
              let rect = CGRect(origin: .zero, size: v.naturalSize)
                .applying(transform)
              renderSize = CGSize(
                width: abs(rect.width),
                height: abs(rect.height)
              )
            }
          } catch {
            // Skip just this clip; keep building. Surface to JS via
            // onNativeError so the user has something to read on
            // /debug-crash instead of a silent gap in the composition.
            let msg = error.localizedDescription
            let detail = "clipId=\(c.id) inMs=\(c.inMs) outMs=\(c.outMs)"
            self.crumb("insertTimeRange threw: \(msg) (\(detail))")
            await MainActor.run {
              self.emit("onNativeError", [
                "source": "nle.insertTimeRange",
                "message": msg,
                "detail": detail,
              ])
            }
          }
        }
        if let au = audios.first, let audioTrack = audioTrack {
          try? audioTrack.insertTimeRange(range, of: au, at: insertionTime)
        }
        insertionTime = insertionTime + duration
      }

      // Drop this build if the clip list moved on while we were loading.
      // Stash cumulative + clip ranges so the CIFilter handler below
      // can map a frame time back to the source clip.
      let snapshotClips = snapshot
      let cumulativeS: [CMTime] = {
        var out: [CMTime] = [.zero]
        var acc = CMTime.zero
        for c in snapshot {
          let dur = CMTime(
            value: CMTimeValue(max(0, c.outMs - c.inMs)),
            timescale: 1000
          )
          acc = acc + dur
          out.append(acc)
        }
        return out
      }()
      let needsColor = snapshot.contains(where: { $0.hasColorEffects })

      await MainActor.run {
        guard self.buildId == myBuildId else { return }

        if !insertedVideo {
          let detail = skipped
            .map { "[\($0.index):\($0.id)] \($0.reason)" }
            .joined(separator: "; ")
          self.emit(
            "onStatusChange",
            [
              "status": "error",
              "error": skipped.isEmpty
                ? "composition has no video"
                : "no clips loaded — \(detail)",
            ]
          )
          return
        }
        if !skipped.isEmpty {
          // Composition is partially good — emit a warning channel
          // entry so the JS side can surface "N clips failed to load"
          // without bricking the rest of the preview.
          let detail = skipped
            .map { "[\($0.index):\($0.id)] \($0.reason)" }
            .joined(separator: "; ")
          self.emit(
            "onStatusChange",
            ["status": "loading", "warning": detail]
          )
        }

        let videoComp: AVMutableVideoComposition
        if needsColor {
          // Apply per-frame CIFilter chain. The
          // (asset:applyingCIFiltersWithHandler:) initializer DOES
          // auto-apply each asset track's preferredTransform before
          // delivering the source image — confirmed empirically.
          // weak self is captured so the handler can early-out when
          // the user is scrubbing: skipping color + Vision saves the
          // suspected crash path (Vision request stateful + UB under
          // the handler's concurrent queue).
          weak var weakSelf = self
          // Sampled-call counter — bumped on every handler invocation
          // so we can crumb 1:30 (~once per second at 30fps) for
          // visibility on whether the handler is being called at all
          // during scrub and how its rate spikes.
          let handlerCount = HandlerCounter()
          videoComp = AVMutableVideoComposition(asset: comp) { request in
            let cnt = handlerCount.next()
            let scrubbing = weakSelf?.isScrubbing == true
            if scrubbing {
              // Bypass everything during scrub. The framework already
              // applied preferredTransform to sourceImage; pass it
              // through. User just wants to see roughly which frame
              // is at the playhead — color/chroma/cutout will resume
              // applying as soon as scroll settles.
              if cnt % 30 == 0 {
                NativeCrumbStore.shared.add(
                  source: "nle.filter",
                  msg: "frame (scrub bypass)",
                  data: ["count": cnt]
                )
              }
              request.finish(with: request.sourceImage, context: nil)
              return
            }
            let t = request.compositionTime
            let idx = NleEngine.indexFor(time: t, cumulative: cumulativeS)
            let source = request.sourceImage.clampedToExtent()
            let clip = (idx >= 0 && idx < snapshotClips.count) ? snapshotClips[idx] : nil
            if cnt % 30 == 0 {
              NativeCrumbStore.shared.add(
                source: "nle.filter",
                msg: "frame",
                data: [
                  "count": cnt,
                  "clipIdx": idx,
                  "cutout": clip?.cutoutEnabled ?? false,
                  "chroma": clip?.chromaEnabled ?? false,
                ]
              )
            }
            let filtered = NleEngine.applyColor(image: source, clip: clip)
              .cropped(to: request.sourceImage.extent)
            request.finish(with: filtered, context: nil)
          }
        } else {
          // Single instruction spanning the whole composed timeline,
          // carrying the per-track layer instruction with a single
          // setTransform at .zero (see comment up where the
          // layerInstruction is configured).
          let mainInstruction = AVMutableVideoCompositionInstruction()
          mainInstruction.timeRange = CMTimeRange(
            start: .zero,
            duration: insertionTime
          )
          if let li = layerInstruction {
            mainInstruction.layerInstructions = [li]
          }
          videoComp = AVMutableVideoComposition()
          videoComp.instructions = [mainInstruction]
          // Only override renderSize on the non-filter path. The
          // CIFilter-handler initializer already picked one that
          // matches the pre-transformed source frame; overriding it
          // there rotates/letterboxes the preview against the layer.
          videoComp.renderSize = renderSize == .zero
            ? CGSize(width: 1080, height: 1920)
            : renderSize
        }
        videoComp.frameDuration = CMTime(value: 1, timescale: 30)

        let item = AVPlayerItem(asset: comp)
        item.videoComposition = videoComp
        item.audioMix = self.buildAudioMix(in: comp)
        self.item = item

        self.statusObs = item.observe(\.status, options: [.new]) { [weak self] item, _ in
          guard let self = self else { return }
          switch item.status {
          case .readyToPlay:
            self.emit("onStatusChange", ["status": "readyToPlay"])
          case .failed:
            // Map generic AVFoundation errors to something the user
            // can actually do something about. "Operation could not
            // be completed" most often = source file gone.
            let raw = item.error?.localizedDescription ?? "unknown"
            let msg: String = {
              let lower = raw.lowercased()
              if lower.contains("could not be completed")
                || lower.contains("no such file")
                || lower.contains("cannot find") {
                return "Source file missing for one of the clips"
              }
              return raw
            }()
            self.emit(
              "onStatusChange",
              ["status": "error", "error": msg]
            )
          case .unknown:
            self.emit("onStatusChange", ["status": "loading"])
          @unknown default:
            break
          }
        }
        self.rateObs = self.player.observe(\.rate, options: [.new]) { [weak self] player, _ in
          guard let self = self else { return }
          self.emit("onPlayingChange", ["isPlaying": player.rate != 0])
        }
        self.endObs = NotificationCenter.default.addObserver(
          forName: .AVPlayerItemDidPlayToEndTime,
          object: item,
          queue: .main
        ) { [weak self] _ in
          self?.emit("onPlayToEnd", [:])
        }

        self.crumb(
          "rebuildComposition done buildId=\(myBuildId) skipped=\(skipped.count) renderSize=\(Int(videoComp.renderSize.width))x\(Int(videoComp.renderSize.height)) needsColor=\(needsColor)",
          data: ["residentMB": processResidentMB()]
        )
        // Pause before the swap. The OLD item could otherwise be
        // mid-decode for a frame past the new composition's total when
        // we replace it — that's the most plausible silent-kill window
        // on a play-into-deleted-region scenario.
        let resumeAfterSwap = (self.player.timeControlStatus == .playing)
        if resumeAfterSwap {
          self.player.pause()
          self.crumb("rebuildComposition paused for swap")
        }
        self.crumb("replaceCurrentItem begin")
        self.player.replaceCurrentItem(with: item)
        self.crumb(
          "replaceCurrentItem done",
          data: ["newTot": self.totalMs]
        )

        // Restore playback position after the new item is ready. clamp
        // into the new composed duration in case a trim shortened the
        // timeline past where we were.
        let prevMs = CMTimeGetSeconds(previousTime) * 1000.0
        let clampedMs = min(max(0, prevMs), self.totalMs)
        self.crumb(
          "position restore",
          data: ["prevMs": prevMs, "clampedMs": clampedMs, "totalMs": self.totalMs]
        )
        let restoreTime = CMTime(value: CMTimeValue(clampedMs), timescale: 1000)
        self.player.seek(
          to: restoreTime,
          toleranceBefore: .zero,
          toleranceAfter: .zero
        ) { [weak self] _ in
          guard let self = self else { return }
          self.crumb("position restore done")
          if resumeAfterSwap || wasPlaying { self.player.play() }
        }
      }
    }
  }

  private func buildAudioMix(in composition: AVComposition? = nil) -> AVAudioMix? {
    let comp = composition ?? (item?.asset as? AVComposition)
    guard let comp = comp,
          let audioTrack = comp.tracks(withMediaType: .audio).first else {
      return nil
    }
    let mix = AVMutableAudioMix()
    let params = AVMutableAudioMixInputParameters(track: audioTrack)
    // Walk our clips in order and stamp the volume for the time range
    // each one occupies on the composed timeline.
    var cursor = CMTime.zero
    for c in clips {
      let dur = CMTime(value: CMTimeValue(max(0, c.outMs - c.inMs)), timescale: 1000)
      let range = CMTimeRange(start: cursor, duration: dur)
      let v = clipVolumes[c.id] ?? c.volume
      params.setVolume(v, at: range.start)
      cursor = cursor + dur
    }
    mix.inputParameters = [params]
    return mix
  }

  // MARK: - Time emit loop (display-synced)

  private func startDisplayLink() {
    if displayLink != nil { return }
    let link = CADisplayLink(target: self, selector: #selector(tick))
    link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 60)
    link.add(to: .main, forMode: .common)
    displayLink = link
  }

  private func stopDisplayLink() {
    displayLink?.invalidate()
    displayLink = nil
  }

  @objc private func tick() {
    tickEmit()
  }

  private func tickEmit() {
    let ms = currentTimeMs()
    let idx = indexAt(ms: ms)
    let payload: [String: Any] = [
      "ms": ms,
      "clipIndex": idx,
      "clipId": idx >= 0 && idx < clips.count ? clips[idx].id : "",
    ]
    emit("onTimeUpdate", payload)
    lastClipIndex = idx
  }

  private func indexAt(ms: Double) -> Int {
    if cumulativeMs.count < 2 { return -1 }
    for i in 0..<clips.count {
      if ms < cumulativeMs[i + 1] {
        return i
      }
    }
    return clips.count - 1
  }

  // MARK: - Event bridge

  private func emit(_ name: String, _ payload: [String: Any]) {
    var p = payload
    p["handle"] = handle
    sink(name, p)
  }

  // MARK: - Color pipeline helpers (used by the CIFilter handler)

  /// Find which clip on the composed timeline covers the given frame
  /// time. Returns -1 when the time is past the last clip.
  static func indexFor(time t: CMTime, cumulative: [CMTime]) -> Int {
    let secs = CMTimeGetSeconds(t)
    if !secs.isFinite { return -1 }
    for i in 0..<(cumulative.count - 1) {
      if CMTimeGetSeconds(cumulative[i + 1]) > secs {
        return i
      }
    }
    return cumulative.count - 2  // last clip
  }

  /// Chain CIColorControls + warmth (CITemperatureAndTint) +
  /// CIHighlightShadowAdjust based on the clip's params. Applies the
  /// chroma key (CIColorCubeWithColorSpace synth) when enabled.
  static func applyColor(image: CIImage, clip: NleClip?) -> CIImage {
    guard let c = clip else { return image }
    var img = image

    // ColorControls: brightness, saturation, contrast.
    let cc = CIFilter(name: "CIColorControls")!
    cc.setValue(img, forKey: kCIInputImageKey)
    cc.setValue(c.brightness, forKey: "inputBrightness")
    cc.setValue(c.contrast, forKey: "inputContrast")
    cc.setValue(c.saturation, forKey: "inputSaturation")
    if let out = cc.outputImage { img = out }

    // Warmth: CITemperatureAndTint. warmth -1..1 → neutral 6500K.
    if abs(c.warmth) > 0.001 {
      let f = CIFilter(name: "CITemperatureAndTint")!
      f.setValue(img, forKey: kCIInputImageKey)
      f.setValue(CIVector(x: 6500, y: 0), forKey: "inputNeutral")
      // Positive warmth → higher target K (warmer), negative → cooler.
      let target = 6500 + Double(c.warmth) * 2500
      f.setValue(CIVector(x: target, y: 0), forKey: "inputTargetNeutral")
      if let out = f.outputImage { img = out }
    }

    // Shadows + highlights: CIHighlightShadowAdjust. -1..1 mapped to
    // its 0..1 / -1..1 ranges.
    if abs(c.shadows) > 0.001 || abs(c.highlights) > 0.001 {
      let f = CIFilter(name: "CIHighlightShadowAdjust")!
      f.setValue(img, forKey: kCIInputImageKey)
      // shadowAmount is 0..1; map -1..1 → 0..1 (negative crushes,
      // positive lifts) with a soft midpoint.
      let shadow = max(0.0, min(1.0, 0.5 + Double(c.shadows) * 0.5))
      f.setValue(shadow, forKey: "inputShadowAmount")
      // highlightAmount is 0..1; 1 = preserve, lower = clamp.
      let highlight = max(0.0, min(1.0, 1.0 - Double(c.highlights) * 0.4))
      f.setValue(highlight, forKey: "inputHighlightAmount")
      if let out = f.outputImage { img = out }
    }

    // Person segmentation (Cutout). Run Vision on the current frame
    // and use the result as an alpha mask. Failures fall through to
    // the unmasked image so the user never sees a black preview.
    if c.cutoutEnabled {
      if let mask = personMaskCache.mask(for: img) {
        // Composite source over a clear bg using the mask as alpha.
        // CIBlendWithMask: bg = clear, fg = img, mask = personMask.
        let blend = CIFilter(name: "CIBlendWithMask")!
        let clear = CIImage(color: CIColor(red: 0, green: 0, blue: 0, alpha: 0))
          .cropped(to: img.extent)
        blend.setValue(img, forKey: kCIInputImageKey)
        blend.setValue(clear, forKey: kCIInputBackgroundImageKey)
        blend.setValue(mask, forKey: kCIInputMaskImageKey)
        if let out = blend.outputImage { img = out }
      }
    }

    // Chroma key — synth a color cube that zeros alpha where the hue
    // falls inside the threshold band around the target color.
    if c.chromaEnabled {
      let target = parseHex(c.chromaColor) ?? (r: 0, g: 1, b: 0)
      if let cube = chromaCube(target: target, threshold: c.chromaThreshold) {
        let f = CIFilter(name: "CIColorCubeWithColorSpace")!
        f.setValue(img, forKey: kCIInputImageKey)
        f.setValue(cube.size, forKey: "inputCubeDimension")
        f.setValue(cube.data, forKey: "inputCubeData")
        f.setValue(CGColorSpaceCreateDeviceRGB(), forKey: "inputColorSpace")
        if let out = f.outputImage { img = out }
      }
    }

    return img
  }

  /// Parse '#RRGGBB' (case-insensitive) into 0..1 RGB.
  private static func parseHex(_ s: String) -> (r: Float, g: Float, b: Float)? {
    var hex = s
    if hex.hasPrefix("#") { hex.removeFirst() }
    guard hex.count == 6, let v = UInt32(hex, radix: 16) else { return nil }
    let r = Float((v >> 16) & 0xFF) / 255.0
    let g = Float((v >> 8) & 0xFF) / 255.0
    let b = Float(v & 0xFF) / 255.0
    return (r, g, b)
  }

  /// Vision person-segmentation runner. Holds a single
  /// VNGeneratePersonSegmentationRequest configured for `.balanced`
  /// quality (good speed/accuracy for live preview). The request is
  /// thread-safe per the docs; we hit it from the CIFilter handler
  /// thread directly.
  static let personMaskCache = PersonMaskRunner()

  /// Build a 16-step color cube that zeros alpha for samples within
  /// `threshold` of the target color in linear RGB. The cube is small
  /// (16³ × 16 bytes ≈ 64KB) so the build is cheap per rebuild.
  private static func chromaCube(
    target: (r: Float, g: Float, b: Float),
    threshold: Float
  ) -> (size: Int, data: Data)? {
    let size = 16
    var data = Data(count: size * size * size * 4 * MemoryLayout<Float>.size)
    let thr = max(0.01, threshold)
    data.withUnsafeMutableBytes { raw in
      let p = raw.baseAddress!.assumingMemoryBound(to: Float.self)
      var off = 0
      for b in 0..<size {
        let bf = Float(b) / Float(size - 1)
        for g in 0..<size {
          let gf = Float(g) / Float(size - 1)
          for r in 0..<size {
            let rf = Float(r) / Float(size - 1)
            let dr = rf - target.r
            let dg = gf - target.g
            let db = bf - target.b
            let d = (dr * dr + dg * dg + db * db).squareRoot()
            let a: Float = d < thr ? 0 : 1
            p[off + 0] = rf * a
            p[off + 1] = gf * a
            p[off + 2] = bf * a
            p[off + 3] = a
            off += 4
          }
        }
      }
    }
    return (size, data)
  }
}

/// Runs Vision person-segmentation on a CIImage frame and returns a
/// single-channel mask CIImage sized to the input frame.
///
/// IMPORTANT: a fresh `VNGeneratePersonSegmentationRequest` is built
/// per call. Previously this class kept a single shared request and
/// called `handler.perform([request])` from the CIFilter handler
/// queue, which AVFoundation can call from multiple threads in
/// parallel. Vision requests hold mutable `results` state and are not
/// thread-safe — concurrent use was UB and the most likely source of
/// the EXC_BAD_ACCESS-class crashes observed during fast scrub (no
/// NSException, no jetsam, just death).
///
/// The `CIContext` IS thread-safe per Apple docs and can stay shared.
final class PersonMaskRunner {
  private let context = CIContext(options: nil)

  /// Returns nil if Vision didn't surface a mask (no person detected
  /// or an error). Callers should fall back to the unmasked image.
  func mask(for image: CIImage) -> CIImage? {
    let extent = image.extent
    guard extent.width > 0, extent.height > 0 else { return nil }
    let w = Int(extent.width)
    let h = Int(extent.height)

    var pb: CVPixelBuffer?
    let attrs: [CFString: Any] = [
      kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
      kCVPixelBufferIOSurfacePropertiesKey: [:],
    ]
    CVPixelBufferCreate(
      kCFAllocatorDefault,
      w,
      h,
      kCVPixelFormatType_32BGRA,
      attrs as CFDictionary,
      &pb
    )
    guard let buf = pb else { return nil }
    context.render(image, to: buf)

    // Per-call request so concurrent CIFilter handler calls don't
    // share mutable Vision state.
    let request = VNGeneratePersonSegmentationRequest()
    request.qualityLevel = .balanced
    request.outputPixelFormat = kCVPixelFormatType_OneComponent8

    let handler = VNImageRequestHandler(cvPixelBuffer: buf, options: [:])
    do {
      try handler.perform([request])
    } catch {
      return nil
    }
    guard
      let result = request.results?.first,
      let maskBuffer = result.pixelBuffer as CVPixelBuffer?
    else {
      return nil
    }
    let mask = CIImage(cvPixelBuffer: maskBuffer)
    let scaleX = extent.width / mask.extent.width
    let scaleY = extent.height / mask.extent.height
    return mask.transformed(by: CGAffineTransform(scaleX: scaleX, y: scaleY))
      .cropped(to: extent)
  }
}

/// Strong registry keyed by integer handle. Modules grab engines from
/// here; engines outlive any single module instance.
final class NleRegistry {
  private var next: Int = 0
  private var engines: [Int: NleEngine] = [:]
  /// Bridge to the module's sendEvent. Set lazily as modules come up.
  var eventSink: ((String, [String: Any]) -> Void)?

  func createEngine() -> Int {
    let h = next
    next += 1
    let engine = NleEngine(handle: h) { [weak self] name, payload in
      self?.eventSink?(name, payload)
    }
    engines[h] = engine
    return h
  }

  func destroy(_ handle: Int) {
    engines.removeValue(forKey: handle)
  }

  func engine(_ handle: Int) -> NleEngine? {
    return engines[handle]
  }
}
