import ExpoModulesCore
import AVFoundation
import UIKit
import Vision

/// Pulls frames from a remote video URL using AVAssetImageGenerator.
/// AVURLAsset issues HTTP range requests for the specific times asked
/// for (provided the mp4 has the moov atom at the front), so this
/// downloads ~50-200KB per reel instead of the full file.
public class FrameExtractorModule: Module {
  public func definition() -> ModuleDefinition {
    Name("FrameExtractor")

    AsyncFunction("extractFrames") { (
      url: String,
      timestampsMs: [Double],
      options: [String: Any]?
    ) -> [[String: Any]] in
      guard let videoUrl = URL(string: url) else {
        throw FrameExtractorError.invalidUrl(url)
      }

      let maxDim = (options?["maxDimension"] as? Double).map { CGFloat($0) } ?? 480.0
      let quality = (options?["quality"] as? Double).map { CGFloat($0) } ?? 0.6

      let asset = AVURLAsset(url: videoUrl, options: [
        AVURLAssetPreferPreciseDurationAndTimingKey: false
      ])
      let generator = AVAssetImageGenerator(asset: asset)
      generator.appliesPreferredTrackTransform = true
      // 100ms tolerance: keeps decoder fast since it can land on the
      // nearest sync frame instead of seeking precisely between keyframes.
      let tol = CMTime(value: 100, timescale: 1000)
      generator.requestedTimeToleranceBefore = tol
      generator.requestedTimeToleranceAfter = tol
      // Cap downscale to keep base64 small over the JS bridge.
      generator.maximumSize = CGSize(width: maxDim, height: maxDim)

      var results: [[String: Any]] = []
      for tsMs in timestampsMs {
        let time = CMTime(seconds: tsMs / 1000.0, preferredTimescale: 600)
        do {
          let cgImage = try generator.copyCGImage(at: time, actualTime: nil)
          let uiImage = UIImage(cgImage: cgImage)
          guard let jpegData = uiImage.jpegData(compressionQuality: quality) else {
            continue
          }
          let dhash = Self.computeDHash(cgImage: cgImage)
          let hasFace = Self.detectFace(cgImage: cgImage)
          results.append([
            "jpegBase64": jpegData.base64EncodedString(),
            "width": cgImage.width,
            "height": cgImage.height,
            "timestampMs": tsMs,
            "dhashHex": dhash,
            "hasFace": hasFace
          ])
        } catch {
          // Silently skip failing timestamps so one bad sample
          // (past end, decode error) does not lose all the others.
          continue
        }
      }
      return results
    }

    AsyncFunction("recognizeText") { (jpegBase64: String) -> String in
      guard let data = Data(base64Encoded: jpegBase64),
            let uiImage = UIImage(data: data),
            let cgImage = uiImage.cgImage else {
        return ""
      }
      let request = VNRecognizeTextRequest()
      request.recognitionLevel = .accurate
      request.usesLanguageCorrection = true
      let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
      do {
        try handler.perform([request])
        guard let results = request.results as? [VNRecognizedTextObservation] else {
          return ""
        }
        let lines = results.compactMap { $0.topCandidates(1).first?.string }
        return lines.joined(separator: "\n")
      } catch {
        return ""
      }
    }
  }

  /// VNDetectFaceRectanglesRequest - Apple Vision's fast face detector.
  /// Runs in ~5-20ms per frame. Used as the talking-head heuristic.
  static func detectFace(cgImage: CGImage) -> Bool {
    let request = VNDetectFaceRectanglesRequest()
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do {
      try handler.perform([request])
      let faces = request.results as? [VNFaceObservation]
      return !(faces?.isEmpty ?? true)
    } catch {
      return false
    }
  }

  /// 64-bit difference hash (dHash). Resizes to 9x8 grayscale, compares
  /// each pixel to its right neighbor, packs 64 bits. Stable under
  /// lighting changes and small motion - flipping > ~18 bits between
  /// consecutive frames is a reliable cut signal.
  static func computeDHash(cgImage: CGImage) -> String {
    let w = 9, h = 8
    let colorSpace = CGColorSpaceCreateDeviceGray()
    let bitmapInfo = CGImageAlphaInfo.none.rawValue
    var pixels = [UInt8](repeating: 0, count: w * h)
    guard let ctx = CGContext(
      data: &pixels, width: w, height: h,
      bitsPerComponent: 8, bytesPerRow: w,
      space: colorSpace, bitmapInfo: bitmapInfo
    ) else { return String(repeating: "0", count: 16) }
    ctx.interpolationQuality = .low
    ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: w, height: h))

    var hash: UInt64 = 0
    for y in 0..<h {
      for x in 0..<(w - 1) {
        let i = y * w + x
        if pixels[i] > pixels[i + 1] {
          hash |= (UInt64(1) << UInt64(y * 8 + x))
        }
      }
    }
    return String(format: "%016llx", hash)
  }
}

enum FrameExtractorError: Error, LocalizedError {
  case invalidUrl(String)

  var errorDescription: String? {
    switch self {
    case .invalidUrl(let url): return "Invalid video URL: \(url)"
    }
  }
}
