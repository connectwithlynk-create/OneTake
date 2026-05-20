import AVFoundation
import Foundation
import QuartzCore

/// One clip on the composed timeline.
struct NleClip {
  let id: String
  let url: URL
  let inMs: Double   // trim in (source ms)
  let outMs: Double  // trim out (source ms)
  let volume: Float

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
  }

  deinit {
    stopDisplayLink()
    if let endObs = endObs { NotificationCenter.default.removeObserver(endObs) }
    statusObs?.invalidate()
    rateObs?.invalidate()
  }

  // MARK: - Public API

  func setClips(_ clips: [NleClip]) {
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
    player.play()
    startDisplayLink()
    emit("onPlayingChange", ["isPlaying": true])
  }

  func pause() {
    player.pause()
    emit("onPlayingChange", ["isPlaying": false])
    // Keep display link running briefly so the JS side gets a final
    // tick reflecting the paused time; it'll idle itself otherwise.
  }

  func seek(ms: Double) {
    let target = max(0, min(totalMs, ms))
    let time = CMTime(value: CMTimeValue(target), timescale: 1000)
    player.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero)
    tickEmit() // immediate UI feedback
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

  private func rebuildComposition() {
    if let endObs = endObs { NotificationCenter.default.removeObserver(endObs) }
    statusObs?.invalidate()
    rateObs?.invalidate()

    let comp = AVMutableComposition()
    let videoTrack = comp.addMutableTrack(
      withMediaType: .video,
      preferredTrackID: kCMPersistentTrackID_Invalid
    )
    let audioTrack = comp.addMutableTrack(
      withMediaType: .audio,
      preferredTrackID: kCMPersistentTrackID_Invalid
    )

    var insertionTime = CMTime.zero
    for c in clips {
      let a = asset(for: c.url)
      let start = CMTime(value: CMTimeValue(c.inMs), timescale: 1000)
      let duration = CMTime(value: CMTimeValue(max(0, c.outMs - c.inMs)), timescale: 1000)
      let range = CMTimeRange(start: start, duration: duration)

      if let v = a.tracks(withMediaType: .video).first, let videoTrack = videoTrack {
        try? videoTrack.insertTimeRange(range, of: v, at: insertionTime)
      }
      if let au = a.tracks(withMediaType: .audio).first, let audioTrack = audioTrack {
        try? audioTrack.insertTimeRange(range, of: au, at: insertionTime)
      }
      insertionTime = insertionTime + duration
    }

    let item = AVPlayerItem(asset: comp)
    item.audioMix = buildAudioMix(in: comp)
    self.item = item

    statusObs = item.observe(\.status, options: [.new]) { [weak self] item, _ in
      guard let self = self else { return }
      switch item.status {
      case .readyToPlay:
        self.emit("onStatusChange", ["status": "readyToPlay"])
      case .failed:
        self.emit(
          "onStatusChange",
          [
            "status": "error",
            "error": item.error?.localizedDescription ?? "unknown",
          ]
        )
      case .unknown:
        self.emit("onStatusChange", ["status": "loading"])
      @unknown default:
        break
      }
    }
    rateObs = player.observe(\.rate, options: [.new]) { [weak self] player, _ in
      guard let self = self else { return }
      self.emit("onPlayingChange", ["isPlaying": player.rate != 0])
    }
    endObs = NotificationCenter.default.addObserver(
      forName: .AVPlayerItemDidPlayToEndTime,
      object: item,
      queue: .main
    ) { [weak self] _ in
      self?.emit("onPlayToEnd", [:])
    }

    player.replaceCurrentItem(with: item)
    emit("onStatusChange", ["status": "loading"])
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
