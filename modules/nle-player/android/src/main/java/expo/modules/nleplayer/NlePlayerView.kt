package expo.modules.nleplayer

import android.content.Context
import androidx.media3.ui.PlayerView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

/** Native surface bound to a single NleEngine. PlayerView handles
 *  SurfaceView lifecycle for ExoPlayer; we just swap in the player. */
class NlePlayerView(context: Context, appContext: AppContext) :
  ExpoView(context, appContext) {

  private val playerView = PlayerView(context).apply {
    useController = false
    layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
  }

  init {
    addView(playerView)
  }

  fun attach(engine: NleEngine?) {
    playerView.player = engine?.player
  }
}
