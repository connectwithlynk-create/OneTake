import AVFoundation
import ExpoModulesCore
import Foundation

/// Single shared registry of player engines. Module instances are short-
/// lived per JS call; the engines themselves must outlive them so the
/// JS handle stays valid across calls.
private let registry = NleRegistry()

/// One-shot install guard for the native crash-trap. The Obj-C uncaught
/// exception handler is process-global; re-installing on every module
/// re-bind would either overwrite a prior handler or leak handler chains.
private var crashTrapInstalled = false

/// Install NSSetUncaughtExceptionHandler exactly once. The handler
/// writes a JSONL line to `<docs>/crash-log.jsonl` synchronously and
/// then lets the process die — JS-side initCrashLog reads that file on
/// the next launch and shows the entry on /debug-crash.
///
/// Caveat: this catches Obj-C NSExceptions only. Swift fatalError /
/// force-unwrap-nil / array-out-of-bounds raise SIGABRT, which doesn't
/// pass through this hook. For those, watch the Xcode console (the
/// NSLog breadcrumbs in NleEngine narrate the last few native calls)
/// or attach a debugger. Adding a signal handler that's truly
/// async-signal-safe is out of scope for a debug aid.
private func installNativeCrashTrap() {
  if crashTrapInstalled { return }
  crashTrapInstalled = true
  NSSetUncaughtExceptionHandler { exception in
    let docs =
      NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true)
        .first ?? NSTemporaryDirectory()
    let path = (docs as NSString).appendingPathComponent("crash-log.jsonl")
    let iso = ISO8601DateFormatter().string(from: Date())
    let stack = exception.callStackSymbols.joined(separator: "\n")
    let entry: [String: Any] = [
      "ts": iso,
      "sev": "fatal",
      "source": "native-nsexception",
      "message": exception.reason ?? exception.name.rawValue,
      "stack": stack,
    ]
    if let data = try? JSONSerialization.data(withJSONObject: entry, options: []),
       let json = String(data: data, encoding: .utf8) {
      let line = json + "\n"
      if let fh = FileHandle(forWritingAtPath: path) {
        fh.seekToEndOfFile()
        if let d = line.data(using: .utf8) { fh.write(d) }
        fh.closeFile()
      } else {
        try? line.write(toFile: path, atomically: true, encoding: .utf8)
      }
    }
    NSLog(
      "[NlePlayer] FATAL NSException: %@ — %@",
      exception.name.rawValue,
      exception.reason ?? ""
    )
  }
}

public class NlePlayerModule: Module {
  public func definition() -> ModuleDefinition {
    Name("NlePlayer")

    // Events emitted by player engines. Each payload includes a
    // `handle` so the JS side can filter to its own player instance.
    // onNativeError is handle-less and global; JS subscribes via
    // attachNativeErrorListener.
    Events(
      "onTimeUpdate",
      "onPlayingChange",
      "onStatusChange",
      "onPlayToEnd",
      "onNativeError"
    )

    OnCreate {
      installNativeCrashTrap()
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
    Function("setScrubbing") { (handle: Int, on: Bool) in
      registry.engine(handle)?.setScrubbing(on)
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
