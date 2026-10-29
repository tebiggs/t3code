package expo.modules.t3deviceruntime

import android.annotation.SuppressLint
import android.app.WallpaperManager
import android.content.Context
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.SurfaceTexture
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.camera2.CameraAccessException
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.CaptureResult
import android.hardware.camera2.TotalCaptureResult
import android.hardware.display.DisplayManager
import android.media.AudioManager
import android.media.ImageReader
import android.media.MediaRecorder
import android.media.MediaScannerConnection
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.view.Display
import android.view.Surface
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

private const val CAMERA_TIMEOUT_SECONDS = 10L
private const val SETTLE_TIMEOUT_MS = 3_000L
private const val SETTLE_FRAMES = 3
private const val SENSOR_WAIT_MS = 1_500L
private const val SPEECH_START_SECONDS = 10L
private const val SPEECH_WAIT_SECONDS = 240L
private const val DEFAULT_RECORDING_MS = 15 * 60 * 1000
private const val MIN_RECORDING_MS = 1000
private const val MAX_IMAGE_BYTES = 64 shl 20
private const val DOWNLOAD_TIMEOUT_MS = 30_000
// Android's own values for a network hidden from apps without location access.
private const val REDACTED_SSID = "<unknown ssid>"
private const val REDACTED_BSSID = "02:00:00:00:00:00"

// In the order Termux:API lists them, which is Android's stream numbers.
private val VOLUME_STREAMS = linkedMapOf(
  "call" to AudioManager.STREAM_VOICE_CALL,
  "system" to AudioManager.STREAM_SYSTEM,
  "ring" to AudioManager.STREAM_RING,
  "music" to AudioManager.STREAM_MUSIC,
  "alarm" to AudioManager.STREAM_ALARM,
  "notification" to AudioManager.STREAM_NOTIFICATION,
)
private val SPEECH_STREAMS = mapOf(
  "ALARM" to AudioManager.STREAM_ALARM,
  "MUSIC" to AudioManager.STREAM_MUSIC,
  "NOTIFICATION" to AudioManager.STREAM_NOTIFICATION,
  "RING" to AudioManager.STREAM_RING,
  "SYSTEM" to AudioManager.STREAM_SYSTEM,
  "VOICE_CALL" to AudioManager.STREAM_VOICE_CALL,
)
private val AE_MODES = mapOf(
  CameraMetadata.CONTROL_AE_MODE_OFF to "CONTROL_AE_MODE_OFF",
  CameraMetadata.CONTROL_AE_MODE_ON to "CONTROL_AE_MODE_ON",
  CameraMetadata.CONTROL_AE_MODE_ON_ALWAYS_FLASH to "CONTROL_AE_MODE_ON_ALWAYS_FLASH",
  CameraMetadata.CONTROL_AE_MODE_ON_AUTO_FLASH to "CONTROL_AE_MODE_ON_AUTO_FLASH",
  CameraMetadata.CONTROL_AE_MODE_ON_AUTO_FLASH_REDEYE to "CONTROL_AE_MODE_ON_AUTO_FLASH_REDEYE",
  CameraMetadata.CONTROL_AE_MODE_ON_EXTERNAL_FLASH to "CONTROL_AE_MODE_ON_EXTERNAL_FLASH",
)
private val CAPABILITIES = mapOf(
  CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_BACKWARD_COMPATIBLE to "backward_compatible",
  CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_BURST_CAPTURE to "burst_capture",
  CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_CONSTRAINED_HIGH_SPEED_VIDEO to "constrained_high_speed_video",
  CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_DEPTH_OUTPUT to "depth_output",
  CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_LOGICAL_MULTI_CAMERA to "logical_multi_camera",
  CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_POST_PROCESSING to "manual_post_processing",
  CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR to "manual_sensor",
  CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_MONOCHROME to "monochrome",
  CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_MOTION_TRACKING to "motion_tracking",
  CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_PRIVATE_REPROCESSING to "private_reprocessing",
  CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_RAW to "raw",
  CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_READ_SENSOR_SETTINGS to "read_sensor_settings",
  CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_YUV_REPROCESSING to "yuv_reprocessing",
)
private val SETTLED_EXPOSURE = setOf(
  CaptureResult.CONTROL_AE_STATE_CONVERGED,
  CaptureResult.CONTROL_AE_STATE_FLASH_REQUIRED,
  CaptureResult.CONTROL_AE_STATE_LOCKED,
)

/**
 * Cameras, microphone, speech, sensors and other hardware for the bridge, in Termux:API's
 * shapes. `hostFile` maps the guest's paths to the app's.
 */
@SuppressLint("MissingPermission") // AgentAccess.check comes first.
internal class PhoneHardware(private val context: Context, private val hostFile: (String) -> File) {
  private var recorder: MediaRecorder? = null
  private var recording: String? = null

  fun torch(enabled: Boolean) {
    val cameras = context.getSystemService(CameraManager::class.java)
    val id = cameras.cameraIdList.firstOrNull {
      cameras.getCameraCharacteristics(it).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
    } ?: throw BridgeError("This phone has no torch.")
    try {
      cameras.setTorchMode(id, enabled)
    } catch (error: CameraAccessException) {
      throw BridgeError("The torch is unavailable: ${error.message}")
    }
  }

  fun volume(body: JSONObject): JSONArray? {
    val audio = context.getSystemService(AudioManager::class.java)
    if (!body.has("stream")) {
      return JSONArray(VOLUME_STREAMS.map { (name, stream) ->
        JSONObject()
          .put("stream", name)
          .put("volume", audio.getStreamVolume(stream))
          .put("max_volume", audio.getStreamMaxVolume(stream))
      })
    }
    val name = body.getString("stream")
    val stream = VOLUME_STREAMS[name] ?: throw BridgeError("Unknown stream: $name")
    try {
      audio.setStreamVolume(stream, body.getInt("volume").coerceIn(0, audio.getStreamMaxVolume(stream)), 0)
    } catch (error: SecurityException) {
      throw BridgeError("Android won't let T3 Code change the $name volume while Do Not Disturb is on.")
    }
    return null
  }

  @Suppress("DEPRECATION")
  fun wifi(): JSONObject {
    val info = context.getSystemService(WifiManager::class.java).connectionInfo
      ?: return JSONObject().put("API_ERROR", "No current connection")
    val ip = info.ipAddress
    // The network's name and BSSID can locate the phone, so agents get them only with Location on Always allow.
    val located = AgentAccess.allowed(context, "location")
    return JSONObject()
      .put("bssid", if (located) orNull(info.bssid) else REDACTED_BSSID)
      .put("frequency_mhz", info.frequency)
      .put("ip", "${ip and 0xff}.${ip shr 8 and 0xff}.${ip shr 16 and 0xff}.${ip shr 24 and 0xff}")
      .put("link_speed_mbps", info.linkSpeed)
      .put("mac_address", orNull(info.macAddress))
      .put("network_id", info.networkId)
      .put("rssi", info.rssi)
      .put("ssid", if (located) info.ssid.replace("\"", "") else REDACTED_SSID)
      .put("ssid_hidden", info.hiddenSSID)
      .put("supplicant_state", info.supplicantState.toString())
  }

  fun cameraInfo(): JSONArray {
    val manager = context.getSystemService(CameraManager::class.java)
    return JSONArray(manager.cameraIdList.map { id ->
      val camera = manager.getCameraCharacteristics(id)
      val sizes = camera.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
        ?.getOutputSizes(ImageFormat.JPEG).orEmpty()
      val physical = camera.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE)
      val focalLengths = camera.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS) ?: FloatArray(0)
      val exposureModes = camera.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_MODES) ?: IntArray(0)
      val capabilities = camera.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES) ?: IntArray(0)
      JSONObject()
        .put("id", id)
        .put(
          "facing",
          when (val facing = camera.get(CameraCharacteristics.LENS_FACING)) {
            CameraMetadata.LENS_FACING_FRONT -> "front"
            CameraMetadata.LENS_FACING_BACK -> "back"
            else -> orNull(facing)
          },
        )
        .put("jpeg_output_sizes", JSONArray(sizes.map { JSONObject().put("width", it.width).put("height", it.height) }))
        .put("focal_lengths", JSONArray(focalLengths.map { it.toDouble() }))
        .put("auto_exposure_modes", JSONArray(exposureModes.map { AE_MODES[it] ?: it }))
        .put(
          "physical_size",
          physical?.let { JSONObject().put("width", it.width.toDouble()).put("height", it.height.toDouble()) },
        )
        .put("capabilities", JSONArray(capabilities.map { CAPABILITIES[it] ?: it }))
    })
  }

  /** Runs the camera without a preview on screen, as Termux:API does, and saves one JPEG. */
  fun takePhoto(cameraId: String, output: File) {
    requireOnScreen("use the camera")
    val manager = context.getSystemService(CameraManager::class.java)
    if (cameraId !in manager.cameraIdList) throw BridgeError("No camera $cameraId; termux-camera-info lists them.")
    val characteristics = manager.getCameraCharacteristics(cameraId)
    val map = characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
      ?: throw BridgeError("Camera $cameraId can't take photos.")
    val largest = map.getOutputSizes(ImageFormat.JPEG)?.maxByOrNull { it.width.toLong() * it.height }
      ?: throw BridgeError("Camera $cameraId can't take JPEG photos.")
    val smallest = map.getOutputSizes(SurfaceTexture::class.java)?.minByOrNull { it.width.toLong() * it.height }
    val thread = HandlerThread("t3-camera").apply { start() }
    val handler = Handler(thread.looper)
    val reader = ImageReader.newInstance(largest.width, largest.height, ImageFormat.JPEG, 1)
    val texture = SurfaceTexture(0).apply { smallest?.let { setDefaultBufferSize(it.width, it.height) } }
    val preview = Surface(texture)
    val opened = CompletableFuture<CameraDevice>()
    try {
      manager.openCamera(cameraId, cameraCallback(opened), handler)
      val camera = await(opened, "The camera didn't open")
      val session = configure(camera, listOf(preview, reader.surface), handler)
      val photo = CompletableFuture<ByteArray>()
      reader.setOnImageAvailableListener({ ready ->
        ready.acquireNextImage().use { image ->
          val buffer = image.planes[0].buffer
          photo.complete(ByteArray(buffer.remaining()).also { buffer.get(it) })
        }
      }, handler)
      val focus = characteristics.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES)
        ?.contains(CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE) == true
      settle(camera, session, preview, focus, handler)
      val still = camera.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE).apply {
        addTarget(reader.surface)
        if (focus) set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
        set(CaptureRequest.JPEG_ORIENTATION, jpegOrientation(characteristics))
      }
      session.capture(still.build(), null, handler)
      output.writeBytes(await(photo, "The camera took no photo"))
    } catch (error: CameraAccessException) {
      throw BridgeError("The camera is unavailable: ${error.message}")
    } finally {
      opened.cancel(false)
      if (opened.isDone && !opened.isCancelled) runCatching { opened.get().close() }
      reader.close()
      preview.release()
      texture.release()
      thread.quitSafely()
    }
  }

  private fun cameraCallback(opened: CompletableFuture<CameraDevice>) = object : CameraDevice.StateCallback() {
    override fun onOpened(camera: CameraDevice) {
      if (!opened.complete(camera)) camera.close()
    }

    override fun onDisconnected(camera: CameraDevice) {
      camera.close()
      opened.completeExceptionally(BridgeError("Another app took the camera."))
    }

    override fun onError(camera: CameraDevice, error: Int) {
      camera.close()
      val reason = when (error) {
        ERROR_CAMERA_IN_USE -> "Another app is using the camera."
        ERROR_MAX_CAMERAS_IN_USE -> "Too many cameras are open."
        ERROR_CAMERA_DISABLED -> "Android has the camera turned off for T3 Code."
        else -> "The camera failed (error $error)."
      }
      opened.completeExceptionally(BridgeError(reason))
    }
  }

  @Suppress("DEPRECATION")
  private fun configure(camera: CameraDevice, surfaces: List<Surface>, handler: Handler): CameraCaptureSession {
    val configured = CompletableFuture<CameraCaptureSession>()
    camera.createCaptureSession(surfaces, object : CameraCaptureSession.StateCallback() {
      override fun onConfigured(session: CameraCaptureSession) {
        configured.complete(session)
      }

      override fun onConfigureFailed(session: CameraCaptureSession) {
        configured.completeExceptionally(BridgeError("The camera couldn't be set up for a photo."))
      }
    }, handler)
    return await(configured, "The camera wasn't ready")
  }

  /** Runs the preview until exposure settles, so the photo isn't dark. */
  private fun settle(
    camera: CameraDevice,
    session: CameraCaptureSession,
    preview: Surface,
    focus: Boolean,
    handler: Handler,
  ) {
    val settled = CountDownLatch(1)
    var frames = 0
    val request = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
      addTarget(preview)
      if (focus) set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
    }
    session.setRepeatingRequest(request.build(), object : CameraCaptureSession.CaptureCallback() {
      override fun onCaptureCompleted(
        session: CameraCaptureSession,
        request: CaptureRequest,
        result: TotalCaptureResult,
      ) {
        val exposure = result.get(CaptureResult.CONTROL_AE_STATE)
        frames += 1
        if (frames >= SETTLE_FRAMES && (exposure == null || exposure in SETTLED_EXPOSURE)) settled.countDown()
      }
    }, handler)
    settled.await(SETTLE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    session.stopRepeating()
  }

  private fun jpegOrientation(characteristics: CameraCharacteristics): Int {
    val sensor = characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0
    val display = context.getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY)
    val rotation = when (display?.rotation) {
      Surface.ROTATION_90 -> 90
      Surface.ROTATION_180 -> 180
      Surface.ROTATION_270 -> 270
      else -> 0
    }
    val front = characteristics.get(CameraCharacteristics.LENS_FACING) == CameraMetadata.LENS_FACING_FRONT
    return ((if (front) sensor + rotation else sensor - rotation) + 360) % 360
  }

  /** termux-microphone-record's three actions, with its messages. */
  @Synchronized
  fun microphone(body: JSONObject): Any = when (body.optString("action")) {
    "info" -> JSONObject().put("isRecording", recorder != null).apply { recording?.let { put("outputFile", it) } }
    "quit" -> {
      val file = recording
      stopRecording()
      if (file == null) "No recording to stop" else "Recording finished: $file"
    }
    else -> startRecording(body)
  }

  private fun startRecording(body: JSONObject): String {
    if (recorder != null) throw BridgeError("Recording already in progress!")
    // Under the lock stopRecording takes, so a switch to Never either refuses this or stops it.
    AgentAccess.check(context, "microphone-record")
    requireOnScreen("use the microphone")
    val encoders = mutableMapOf(
      "aac" to MediaRecorder.AudioEncoder.AAC,
      "amr_nb" to MediaRecorder.AudioEncoder.AMR_NB,
      "amr_wb" to MediaRecorder.AudioEncoder.AMR_WB,
    )
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) encoders["opus"] = MediaRecorder.AudioEncoder.OPUS
    val encoderName = body.optString("encoder").ifEmpty { "aac" }
    val encoder = encoders[encoderName] ?: throw BridgeError("This phone can't record $encoderName.")
    val (format, extension) = when (encoder) {
      MediaRecorder.AudioEncoder.AAC -> MediaRecorder.OutputFormat.MPEG_4 to "m4a"
      MediaRecorder.AudioEncoder.OPUS -> MediaRecorder.OutputFormat.OGG to "ogg"
      else -> MediaRecorder.OutputFormat.THREE_GPP to "3gp"
    }
    val stamp = SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.US).format(Date())
    val guestPath = body.optString("file").ifEmpty { "/sdcard/AudioRecording_$stamp.$extension" }
    val file = hostFile(guestPath)
    if (file.exists()) throw BridgeError("File: ${file.name} already exists! Please specify a different filename")
    val limit = if (body.has("limit")) body.getInt("limit") else DEFAULT_RECORDING_MS
    val duration = if (limit in 1 until MIN_RECORDING_MS) MIN_RECORDING_MS else limit
    val created = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      MediaRecorder(context)
    } else {
      @Suppress("DEPRECATION") MediaRecorder()
    }
    try {
      created.setAudioSource(MediaRecorder.AudioSource.MIC)
      created.setOutputFormat(format)
      created.setAudioEncoder(encoder)
      created.setOutputFile(file.path)
      created.setMaxDuration(duration)
      body.optInt("bitrate").takeIf { it > 0 }?.let(created::setAudioEncodingBitRate)
      body.optInt("rate").takeIf { it > 0 }?.let(created::setAudioSamplingRate)
      body.optInt("channels").takeIf { it > 0 }?.let(created::setAudioChannels)
      created.setOnInfoListener { _, what, _ ->
        if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) stopRecording(created)
      }
      created.setOnErrorListener { _, _, _ -> stopRecording(created) }
      created.prepare()
      created.start()
    } catch (error: Exception) {
      created.release()
      throw BridgeError("Couldn't start recording: ${error.message}")
    }
    recorder = created
    recording = guestPath
    val limitText = if (duration <= 0) "unlimited" else timeString(duration / 1000)
    return "Recording started: $guestPath \nMax Duration: $limitText"
  }

  /** Stops the recording; `only` leaves a newer recording alone when an older one's limit fires late. */
  @Synchronized
  fun stopRecording(only: MediaRecorder? = null) {
    val active = recorder ?: return
    if (only != null && only !== active) return
    recorder = null
    recording = null
    // stop() throws when nothing was recorded yet; the file is unusable either way then.
    runCatching { active.stop() }
    active.release()
  }

  /** Speaks each line in turn and returns when the engine is done, as termux-tts-speak does. */
  @Suppress("DEPRECATION")
  fun speak(body: JSONObject) {
    val engine = body.optString("engine").ifEmpty { null }
    val speech = startSpeech(engine)
    try {
      val language = body.optString("language")
      if (language.isNotEmpty()) {
        val locale = Locale(language, body.optString("region"), body.optString("variant"))
        if (speech.setLanguage(locale) < TextToSpeech.LANG_AVAILABLE) {
          throw BridgeError("The speech engine can't speak $locale.")
        }
      }
      if (body.has("pitch")) speech.setPitch(body.getDouble("pitch").toFloat())
      if (body.has("rate")) speech.setSpeechRate(body.getDouble("rate").toFloat())
      val stream = SPEECH_STREAMS[body.optString("stream")] ?: AudioManager.STREAM_MUSIC
      val params = Bundle().apply { putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, stream) }
      val chunks = body.getString("text").lines().filter { it.isNotBlank() }
        .flatMap { it.chunked(TextToSpeech.getMaxSpeechInputLength()) }
      val done = CountDownLatch(chunks.size)
      speech.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) = Unit

        override fun onDone(utteranceId: String?) = done.countDown()

        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String?) = done.countDown()
      })
      chunks.forEachIndexed { index, chunk ->
        if (speech.speak(chunk, TextToSpeech.QUEUE_ADD, params, "t3-$index") == TextToSpeech.ERROR) {
          throw BridgeError("The speech engine turned the text down.")
        }
      }
      done.await(SPEECH_WAIT_SECONDS, TimeUnit.SECONDS)
    } finally {
      speech.shutdown()
    }
  }

  fun speechEngines(): JSONArray {
    // Listing engines needs no engine running.
    val speech = onMainThread { TextToSpeech(context) {} }
    try {
      val default = speech.defaultEngine
      return JSONArray(speech.engines.map {
        JSONObject().put("name", it.name).put("label", it.label).put("default", it.name == default)
      })
    } finally {
      speech.shutdown()
    }
  }

  private fun startSpeech(engine: String?): TextToSpeech {
    val started = CompletableFuture<Int>()
    // The engine binds from the main thread and reports there.
    val speech = onMainThread { TextToSpeech(context, { started.complete(it) }, engine) }
    val status = try {
      started.get(SPEECH_START_SECONDS, TimeUnit.SECONDS)
    } catch (error: TimeoutException) {
      TextToSpeech.ERROR
    }
    if (status != TextToSpeech.SUCCESS) {
      speech.shutdown()
      throw BridgeError(
        if (engine == null) "This phone's speech engine didn't start."
        else "The speech engine $engine didn't start; termux-tts-engines lists them.",
      )
    }
    return speech
  }

  fun sensorList(): JSONObject {
    val sensors = context.getSystemService(SensorManager::class.java).getSensorList(Sensor.TYPE_ALL)
    return JSONObject().put("sensors", JSONArray(sensors.map { it.name }))
  }

  /** One reading of each sensor; a name picks the shortest sensor name containing it, as Termux:API does. */
  fun readSensors(body: JSONObject): JSONObject {
    val manager = context.getSystemService(SensorManager::class.java)
    val available = manager.getSensorList(Sensor.TYPE_ALL).sortedBy { it.name }
    val sensors = if (body.optBoolean("all")) {
      available
    } else {
      val names = body.optJSONArray("sensors") ?: JSONArray()
      (0 until names.length()).map { names.getString(it).trim().uppercase() }.filter { it.isNotEmpty() }
        .mapNotNull { name -> available.filter { it.name.uppercase().contains(name) }.minByOrNull { it.name.length } }
        .distinct()
    }
    if (sensors.isEmpty()) throw BridgeError("No valid sensors were registered!")
    val readings = ConcurrentHashMap<Sensor, FloatArray>()
    val reported = CountDownLatch(sensors.size)
    val listener = object : SensorEventListener {
      override fun onSensorChanged(event: SensorEvent) {
        if (readings.put(event.sensor, event.values.copyOf()) == null) reported.countDown()
      }

      override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) = Unit
    }
    val thread = HandlerThread("t3-sensors").apply { start() }
    try {
      val handler = Handler(thread.looper)
      for (sensor in sensors) manager.registerListener(listener, sensor, SensorManager.SENSOR_DELAY_UI, handler)
      reported.await(SENSOR_WAIT_MS, TimeUnit.MILLISECONDS)
    } finally {
      manager.unregisterListener(listener)
      thread.quitSafely()
    }
    val result = JSONObject()
    for (sensor in sensors) {
      val values = readings[sensor] ?: continue
      result.put(sensor.name, JSONObject().put("values", JSONArray(values.map { it.toDouble() })))
    }
    return result
  }

  fun setWallpaper(body: JSONObject) {
    val image = if (body.has("file")) {
      val file = hostFile(body.getString("file"))
      if (file.length() > MAX_IMAGE_BYTES) throw BridgeError("${body.getString("file")} is too large for a wallpaper.")
      file.readBytes()
    } else {
      downloadImage(body.getString("url"))
    }
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(image, 0, image.size, bounds)
    if (bounds.outWidth <= 0) throw BridgeError("That isn't an image Android can read.")
    val which = if (body.optBoolean("lockscreen")) WallpaperManager.FLAG_LOCK else WallpaperManager.FLAG_SYSTEM
    WallpaperManager.getInstance(context).setStream(image.inputStream(), null, true, which)
  }

  private fun downloadImage(url: String): ByteArray {
    val address = if (url.startsWith("http://") || url.startsWith("https://")) url else "https://$url"
    val connection = URL(address).openConnection() as HttpURLConnection
    connection.connectTimeout = DOWNLOAD_TIMEOUT_MS
    connection.readTimeout = DOWNLOAD_TIMEOUT_MS
    try {
      if (connection.responseCode != HttpURLConnection.HTTP_OK) {
        throw BridgeError("$address answered HTTP ${connection.responseCode}.")
      }
      val type = connection.contentType.orEmpty()
      if (!type.startsWith("image/")) throw BridgeError("$address isn't an image; it's ${type.ifEmpty { "untyped" }}.")
      return connection.inputStream.use(::readImage)
    } finally {
      connection.disconnect()
    }
  }

  /** Asks Android's media store to index files in phone storage, walking directories when recursive. */
  fun mediaScan(body: JSONObject): JSONObject {
    val paths = body.getJSONArray("paths")
    val files = ArrayList<File>()
    for (index in 0 until paths.length()) {
      val path = paths.getString(index)
      val file = hostFile(path)
      if (!file.path.startsWith("/storage/")) {
        throw BridgeError("$path isn't in phone storage, the only place Android's media store looks.")
      }
      files += file
      if (body.optBoolean("recursive") && file.isDirectory) files += file.walkTopDown().drop(1)
    }
    MediaScannerConnection.scanFile(context, files.map { it.path }.toTypedArray(), null, null)
    return JSONObject().put("files", JSONArray(files.map { it.path }))
  }
}

private fun <T> await(future: CompletableFuture<T>, what: String): T = try {
  future.get(CAMERA_TIMEOUT_SECONDS, TimeUnit.SECONDS)
} catch (error: TimeoutException) {
  throw BridgeError("$what within $CAMERA_TIMEOUT_SECONDS seconds.")
} catch (error: ExecutionException) {
  throw error.cause ?: error
}

private fun readImage(input: InputStream): ByteArray {
  val output = ByteArrayOutputStream()
  val buffer = ByteArray(1 shl 16)
  while (true) {
    val count = input.read(buffer)
    if (count < 0) return output.toByteArray()
    output.write(buffer, 0, count)
    if (output.size() > MAX_IMAGE_BYTES) throw BridgeError("The image is too large for a wallpaper.")
  }
}
