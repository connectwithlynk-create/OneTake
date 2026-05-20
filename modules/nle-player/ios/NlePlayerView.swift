import AVFoundation
import ExpoModulesCore
import UIKit

/// Native surface bound to a single NleEngine. Renders the engine's
/// AVPlayer via an AVPlayerLayer so we get hardware-composed video and
/// the timeline transitions are seamless from the user's perspective.
class NlePlayerView: ExpoView {
  private let playerLayer = AVPlayerLayer()
  private weak var engine: NleEngine?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    // Explicit black bg so any letterbox / pillarbox bars (when the
    // composition's renderSize doesn't match the layer's aspect)
    // render as black instead of whatever system default the
    // underlying view holds.
    backgroundColor = .black
    playerLayer.backgroundColor = UIColor.black.cgColor
    playerLayer.videoGravity = .resizeAspect
    layer.addSublayer(playerLayer)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    playerLayer.frame = bounds
  }

  /// Bind this view to an engine's underlying AVPlayer.
  func attach(engine: NleEngine?) {
    self.engine = engine
    playerLayer.player = engine?.avPlayer
  }
}
