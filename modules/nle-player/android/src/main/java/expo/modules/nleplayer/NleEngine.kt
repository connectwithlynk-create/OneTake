package expo.modules.nleplayer

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.Choreographer
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.ClippingMediaSource
import androidx.media3.exoplayer.source.ConcatenatingMediaSource2
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.datasource.DefaultDataSource

/** One clip on the composed timeline. */
data class NleClip(
  val id: String,
  val uri: Uri,
  val inMs: Long,
  val outMs: Long,
  val volume: Float
) {
  companion object {
    fun from(map: Map<String, Any>): NleClip? {
      val id = map["id"] as? String ?: return null
      val uriStr = map["uri"] as? String ?: return null
      val inMs = (map["inMs"] as? Number)?.toLong() ?: return null
      val outMs = (map["outMs"] as? Number)?.toLong() ?: return null
      val volume = (map["volume"] as? Number)?.toFloat() ?: 1f
      return NleClip(
        id = id,
        uri = Uri.parse(uriStr),
        inMs = inMs.coerceAtLeast(0),
        outMs = outMs.coerceAtLeast(inMs),
        volume = volume.coerceIn(0f, 1f)
      )
    }
  }
}

typealias EventSink = (String, Map<String, Any>) -> Unit

/** Wraps a ConcatenatingMediaSource2 + ExoPlayer. Owns a Choreographer
 *  frame callback for display-synced time updates. */
class NleEngine(
  val handle: Int,
  private val context: Context,
  private val sink: EventSink
) {
  private val mainHandler = Handler(Looper.getMainLooper())
  val player: ExoPlayer = ExoPlayer.Builder(context).build()

  private var clips: List<NleClip> = emptyList()
  /** Cumulative composed-timeline starts (ms), length = clips.size + 1. */
  private var cumulativeMs: LongArray = longArrayOf(0)
  private var totalMs: Long = 0

  private val clipVolumes: MutableMap<String, Float> = mutableMapOf()

  private var frameCallback: Choreographer.FrameCallback? = null

  private val playerListener = object : Player.Listener {
    override fun onIsPlayingChanged(isPlaying: Boolean) {
      emit("onPlayingChange", mapOf("isPlaying" to isPlaying))
      if (isPlaying) startFrameLoop() else stopFrameLoop()
    }
    override fun onPlaybackStateChanged(state: Int) {
      val status = when (state) {
        Player.STATE_IDLE -> "idle"
        Player.STATE_BUFFERING -> "loading"
        Player.STATE_READY -> "readyToPlay"
        Player.STATE_ENDED -> "readyToPlay"
        else -> "loading"
      }
      emit("onStatusChange", mapOf("status" to status))
      if (state == Player.STATE_ENDED) {
        emit("onPlayToEnd", emptyMap())
      }
    }
  }

  init {
    player.addListener(playerListener)
  }

  // --- Public API -----------------------------------------------------

  fun setClips(clips: List<NleClip>) {
    this.clips = clips
    var sum = 0L
    val cum = LongArray(clips.size + 1)
    cum[0] = 0
    for (i in clips.indices) {
      sum += (clips[i].outMs - clips[i].inMs).coerceAtLeast(0)
      cum[i + 1] = sum
    }
    this.cumulativeMs = cum
    this.totalMs = sum
    clipVolumes.clear()
    for (c in clips) clipVolumes[c.id] = c.volume
    rebuildSource()
  }

  fun play() {
    player.playWhenReady = true
  }
  fun pause() {
    player.playWhenReady = false
  }
  fun seek(ms: Double) {
    val target = ms.toLong().coerceIn(0, totalMs)
    player.seekTo(target)
    // Emit immediately for instant UI feedback.
    tickEmit()
  }
  fun setClipVolume(clipId: String, volume: Float) {
    clipVolumes[clipId] = volume.coerceIn(0f, 1f)
    // ExoPlayer doesn't support per-source volume out of the box. We
    // approximate by setting the player volume when the playhead enters
    // a clip with a different volume. The frame loop handles this.
  }

  fun currentTimeMs(): Double = player.currentPosition.toDouble()
  fun durationMs(): Double = totalMs.toDouble()
  fun isPlaying(): Boolean = player.isPlaying

  fun release() {
    stopFrameLoop()
    player.removeListener(playerListener)
    player.release()
  }

  // --- Source build ---------------------------------------------------

  @androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
  private fun rebuildSource() {
    val factory = DefaultDataSource.Factory(context)
    val concat = ConcatenatingMediaSource2.Builder()
    for (c in clips) {
      val mediaItem = MediaItem.fromUri(c.uri)
      val base = ProgressiveMediaSource.Factory(factory).createMediaSource(mediaItem)
      val clipped = ClippingMediaSource.Builder(base)
        .setStartPositionUs(c.inMs * 1000L)
        .setEndPositionUs(c.outMs * 1000L)
        .build()
      concat.add(clipped)
    }
    val source = concat.build()
    player.setMediaSource(source)
    player.prepare()
  }

  // --- Time emit loop -------------------------------------------------

  private fun startFrameLoop() {
    if (frameCallback != null) return
    val cb = object : Choreographer.FrameCallback {
      override fun doFrame(frameTimeNanos: Long) {
        tickEmit()
        Choreographer.getInstance().postFrameCallback(this)
      }
    }
    frameCallback = cb
    Choreographer.getInstance().postFrameCallback(cb)
  }

  private fun stopFrameLoop() {
    frameCallback?.let { Choreographer.getInstance().removeFrameCallback(it) }
    frameCallback = null
  }

  private fun tickEmit() {
    val ms = player.currentPosition
    val idx = indexAt(ms)
    val payload = mutableMapOf<String, Any>(
      "ms" to ms.toDouble(),
      "clipIndex" to idx,
      "clipId" to (if (idx in clips.indices) clips[idx].id else "")
    )
    emit("onTimeUpdate", payload)
    // Apply per-clip volume if it changed.
    if (idx in clips.indices) {
      val v = clipVolumes[clips[idx].id] ?: clips[idx].volume
      if (player.volume != v) player.volume = v
    }
  }

  private fun indexAt(ms: Long): Int {
    if (clips.isEmpty()) return -1
    for (i in clips.indices) {
      if (ms < cumulativeMs[i + 1]) return i
    }
    return clips.size - 1
  }

  private fun emit(name: String, payload: Map<String, Any>) {
    val out = HashMap<String, Any>(payload)
    out["handle"] = handle
    mainHandler.post { sink(name, out) }
  }
}

class NleRegistry(
  private val context: Context,
  private val sink: EventSink
) {
  private var next: Int = 0
  private val engines: MutableMap<Int, NleEngine> = mutableMapOf()

  fun createEngine(): Int {
    val h = next++
    engines[h] = NleEngine(h, context, sink)
    return h
  }

  fun destroy(handle: Int) {
    engines.remove(handle)?.release()
  }

  fun engine(handle: Int): NleEngine? = engines[handle]
}
