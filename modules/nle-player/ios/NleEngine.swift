import AVFoundation
import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation
import QuartzCore
import Vision

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

  /// Monotonic build id — every setClips() bumps this, and the async
  /// composition build only commits if its id is still current. Prevents
  /// a slow build from a stale clip list overwriting a newer one.
  private var buildId: Int = 0

  private func rebuildComposition() {
    buildId += 1
    let myBuildId = buildId

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
      // with a setTransform(_:at:) per clip insert so each segment
      // applies its source's preferredTransform. Without this, portrait
      // phone video (90° transform baked into the source) renders
      // outside the layer's render rect → black preview.
      let layerInstruction = videoTrack.map {
        AVMutableVideoCompositionLayerInstruction(assetTrack: $0)
      }
      var renderSize: CGSize = .zero

      var insertionTime = CMTime.zero
      var insertedVideo = false
      for c in snapshot {
        let a = self.asset(for: c.url)
        let videos: [AVAssetTrack]
        let audios: [AVAssetTrack]
        do {
          videos = try await a.loadTracks(withMediaType: .video)
          audios = try await a.loadTracks(withMediaType: .audio)
        } catch {
          self.emit(
            "onStatusChange",
            ["status": "error", "error": error.localizedDescription]
          )
          return
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

            // Apply the source's preferredTransform from this clip's
            // insertion point forward — it stays in effect until the
            // next setTransform on the same layer instruction.
            let transform = v.preferredTransform
            layerInstruction?.setTransform(transform, at: insertionTime)

            // Render size = post-transform size of the first clip. For
            // a portrait recording the raw naturalSize is landscape
            // and the 90° transform swaps the axes.
            if renderSize == .zero {
              let rect = CGRect(origin: .zero, size: v.naturalSize)
                .applying(transform)
              renderSize = CGSize(
                width: abs(rect.width),
                height: abs(rect.height)
              )
            }
          } catch {
            // Skip just this clip; keep building.
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
          self.emit(
            "onStatusChange",
            ["status": "error", "error": "composition has no video"]
          )
          return
        }

        let videoComp: AVMutableVideoComposition
        if needsColor {
          // Apply per-frame CIFilter chain. Map the request's time to a
          // clip index via cumulativeS and pull that clip's color params.
          videoComp = AVMutableVideoComposition(asset: comp) { request in
            let t = request.compositionTime
            let idx = NleEngine.indexFor(time: t, cumulative: cumulativeS)
            let source = request.sourceImage.clampedToExtent()
            let clip = (idx >= 0 && idx < snapshotClips.count) ? snapshotClips[idx] : nil
            let filtered = NleEngine.applyColor(image: source, clip: clip)
              .cropped(to: request.sourceImage.extent)
            request.finish(with: filtered, context: nil)
          }
          // applyingCIFiltersWithHandler initializer doesn't carry our
          // per-track preferredTransform layer instructions, so the
          // composition needs renderSize set explicitly to honor
          // portrait orientation.
        } else {
          // Single instruction spanning the whole composed timeline,
          // carrying the single per-track layer instruction whose
          // setTransform calls switch transform per segment.
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
        }
        videoComp.renderSize = renderSize == .zero
          ? CGSize(width: 1080, height: 1920)
          : renderSize
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

        self.player.replaceCurrentItem(with: item)

        // Restore playback position after the new item is ready. clamp
        // into the new composed duration in case a trim shortened the
        // timeline past where we were.
        let clampedMs = min(
          max(0, CMTimeGetSeconds(previousTime) * 1000.0),
          self.totalMs
        )
        let restoreTime = CMTime(value: CMTimeValue(clampedMs), timescale: 1000)
        self.player.seek(
          to: restoreTime,
          toleranceBefore: .zero,
          toleranceAfter: .zero
        ) { [weak self] _ in
          guard let self = self else { return }
          if wasPlaying { self.player.play() }
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
/// single-channel mask CIImage sized to the input frame. The request
/// object is reused across calls; only the per-frame buffer changes.
final class PersonMaskRunner {
  private let request: VNGeneratePersonSegmentationRequest = {
    let r = VNGeneratePersonSegmentationRequest()
    r.qualityLevel = .balanced
    r.outputPixelFormat = kCVPixelFormatType_OneComponent8
    return r
  }()
  private let context = CIContext(options: nil)

  /// Returns nil if Vision didn't surface a mask (no person detected
  /// or an error). Callers should fall back to the unmasked image.
  func mask(for image: CIImage) -> CIImage? {
    // Vision needs a CGImage / CVPixelBuffer. Render the input to a
    // pixel buffer at the source extent.
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
    // Mask comes back at the segmenter's working resolution; CIImage
    // scaling lines it back up with the source extent.
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
