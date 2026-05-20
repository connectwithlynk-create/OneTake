import AVFoundation
import ExpoModulesCore

/// Single shared registry of player engines. Module instances are short-
/// lived per JS call; the engines themselves must outlive them so the
/// JS handle stays valid across calls.
private let registry = NleRegistry()

public class NlePlayerModule: Module {
  public func definition() -> ModuleDefinition {
    Name("NlePlayer")

    // Events emitted by player engines. Each payload includes a
    // `handle` so the JS side can filter to its own player instance.
    Events("onTimeUpdate", "onPlayingChange", "onStatusChange", "onPlayToEnd")

    OnCreate {
      // Wire engine -> JS event bridge once. Subsequent module instances
      // re-bind; the engines themselves are kept alive by the registry.
      registry.eventSink = { [weak self] name, payload in
        self?.sendEvent(name, payload)
      }
    }

    Function("create") { () -> Int in
      return registry.createEngine()
    }

    Function("destroy") { (handle: Int) in
      registry.destroy(handle)
    }

    Function("setClips") { (handle: Int, raw: [[String: Any]]) in
      let clips = raw.compactMap { NleClip(dict: $0) }
      registry.engine(handle)?.setClips(clips)
    }

    Function("play") { (handle: Int) in
      registry.engine(handle)?.play()
    }
    Function("pause") { (handle: Int) in
      registry.engine(handle)?.pause()
    }
    Function("seek") { (handle: Int, ms: Double) in
      registry.engine(handle)?.seek(ms: ms)
    }
    Function("setClipVolume") { (handle: Int, clipId: String, volume: Double) in
      registry.engine(handle)?.setClipVolume(clipId: clipId, volume: volume)
    }

    Function("getCurrentTime") { (handle: Int) -> Double in
      return registry.engine(handle)?.currentTimeMs() ?? 0
    }
    Function("getDuration") { (handle: Int) -> Double in
      return registry.engine(handle)?.durationMs() ?? 0
    }
    Function("getIsPlaying") { (handle: Int) -> Bool in
      return registry.engine(handle)?.isPlaying() ?? false
    }

    View(NlePlayerView.self) {
      Prop("playerHandle") { (view: NlePlayerView, handle: Int) in
        view.attach(engine: registry.engine(handle))
      }
    }
  }
}
