package expo.modules.nleplayer

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class NlePlayerModule : Module() {
  private val registry: NleRegistry by lazy {
    NleRegistry(appContext.reactContext!!) { name, payload ->
      sendEvent(name, payload)
    }
  }

  override fun definition() = ModuleDefinition {
    Name("NlePlayer")

    Events("onTimeUpdate", "onPlayingChange", "onStatusChange", "onPlayToEnd")

    Function("create") {
      registry.createEngine()
    }

    Function("destroy") { handle: Int ->
      registry.destroy(handle)
    }

    Function("setClips") { handle: Int, raw: List<Map<String, Any>> ->
      registry.engine(handle)?.setClips(raw.mapNotNull { NleClip.from(it) })
    }

    Function("play") { handle: Int -> registry.engine(handle)?.play() }
    Function("pause") { handle: Int -> registry.engine(handle)?.pause() }
    Function("seek") { handle: Int, ms: Double ->
      registry.engine(handle)?.seek(ms)
    }
    Function("setClipVolume") { handle: Int, clipId: String, volume: Double ->
      registry.engine(handle)?.setClipVolume(clipId, volume.toFloat())
    }

    Function("getCurrentTime") { handle: Int ->
      registry.engine(handle)?.currentTimeMs() ?: 0.0
    }
    Function("getDuration") { handle: Int ->
      registry.engine(handle)?.durationMs() ?: 0.0
    }
    Function("getIsPlaying") { handle: Int ->
      registry.engine(handle)?.isPlaying() ?: false
    }

    View(NlePlayerView::class) {
      Prop("playerHandle") { view: NlePlayerView, handle: Int ->
        view.attach(registry.engine(handle))
      }
    }
  }
}
