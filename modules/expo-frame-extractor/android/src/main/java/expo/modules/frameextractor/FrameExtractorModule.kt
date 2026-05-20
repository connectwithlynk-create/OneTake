package expo.modules.frameextractor

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.util.Base64
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetector
import com.google.mlkit.vision.face.FaceDetectorOptions
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.TextRecognizer
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream
import kotlin.math.max

/**
 * Pulls frames from a remote video URL using MediaMetadataRetriever.
 * setDataSource(uri, headers) streams via HTTP range requests where
 * the server supports them, so we don't download the full file just to
 * sample 20-30 timestamps.
 */
class FrameExtractorModule : Module() {
  // Lazy ML Kit clients - heavy to construct, cheap to reuse across
  // many frames. Both stay alive for the module's lifetime.
  private val faceDetector: FaceDetector by lazy {
    FaceDetection.getClient(
      FaceDetectorOptions.Builder()
        .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
        .setMinFaceSize(0.15f)
        .build()
    )
  }
  private val textRecognizer: TextRecognizer by lazy {
    TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
  }

  override fun definition() = ModuleDefinition {
    Name("FrameExtractor")

    AsyncFunction("extractFrames") { url: String, timestampsMs: DoubleArray, options: Map<String, Any>? ->
      val maxDim = (options?.get("maxDimension") as? Number)?.toInt() ?: 480
      val quality = ((options?.get("quality") as? Number)?.toDouble() ?: 0.6) * 100.0

      val retriever = MediaMetadataRetriever()
      val results = mutableListOf<Map<String, Any>>()
      try {
        retriever.setDataSource(url, HashMap())
        for (tsMs in timestampsMs) {
          val tsUs = (tsMs * 1000.0).toLong()
          val raw = retriever.getFrameAtTime(tsUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
            ?: continue
          val bitmap = if (raw.width > maxDim || raw.height > maxDim) {
            val ratio = max(raw.width, raw.height).toFloat() / maxDim.toFloat()
            val w = (raw.width / ratio).toInt()
            val h = (raw.height / ratio).toInt()
            val scaled = Bitmap.createScaledBitmap(raw, w, h, true)
            raw.recycle()
            scaled
          } else raw
          val baos = ByteArrayOutputStream()
          bitmap.compress(Bitmap.CompressFormat.JPEG, quality.toInt().coerceIn(1, 100), baos)
          val dhash = computeDHash(bitmap)
          val hasFace = detectFaceSync(bitmap)
          results.add(
            mapOf(
              "jpegBase64" to Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP),
              "width" to bitmap.width,
              "height" to bitmap.height,
              "timestampMs" to tsMs,
              "dhashHex" to dhash,
              "hasFace" to hasFace
            )
          )
          bitmap.recycle()
        }
      } finally {
        try { retriever.release() } catch (_: Throwable) {}
      }
      results
    }

    AsyncFunction("recognizeText") { jpegBase64: String ->
      if (jpegBase64.isEmpty()) return@AsyncFunction ""
      val bytes = try {
        Base64.decode(jpegBase64, Base64.DEFAULT)
      } catch (_: Throwable) {
        return@AsyncFunction ""
      }
      val bm = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        ?: return@AsyncFunction ""
      try {
        val img = InputImage.fromBitmap(bm, 0)
        val text = Tasks.await(textRecognizer.process(img))
        text.text
      } catch (_: Throwable) {
        ""
      } finally {
        bm.recycle()
      }
    }
  }

  /** Synchronous wrapper around ML Kit's async face detector. Safe to
   *  call from AsyncFunction (already on a background thread); Tasks.await
   *  blocks the worker until detection finishes (~10-30ms on the FAST
   *  perf-mode setting). */
  private fun detectFaceSync(bitmap: Bitmap): Boolean {
    return try {
      val img = InputImage.fromBitmap(bitmap, 0)
      val faces = Tasks.await(faceDetector.process(img))
      faces.isNotEmpty()
    } catch (_: Throwable) {
      false
    }
  }

  /**
   * 64-bit difference hash (dHash). Resizes to 9x8 grayscale, compares
   * each pixel to its right neighbor, packs 64 bits. Stable under
   * lighting changes and small motion - flipping > ~18 bits between
   * consecutive frames is a reliable cut signal.
   */
  private fun computeDHash(bitmap: Bitmap): String {
    val w = 9
    val h = 8
    val scaled = Bitmap.createScaledBitmap(bitmap, w, h, true)
    val pixels = IntArray(w * h)
    scaled.getPixels(pixels, 0, w, 0, 0, w, h)
    scaled.recycle()

    var hash = 0L
    for (y in 0 until h) {
      for (x in 0 until (w - 1)) {
        val i = y * w + x
        if (luma(pixels[i]) > luma(pixels[i + 1])) {
          hash = hash or (1L shl (y * 8 + x))
        }
      }
    }
    return String.format("%016x", hash)
  }

  private fun luma(px: Int): Int {
    val r = (px shr 16) and 0xff
    val g = (px shr 8) and 0xff
    val b = px and 0xff
    return (0.299 * r + 0.587 * g + 0.114 * b).toInt()
  }
}
