package expo.modules.t3deviceruntime

import android.app.ActivityManager
import android.app.DownloadManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.system.Os
import android.util.Log
import android.webkit.MimeTypeMap
import android.webkit.URLUtil
import android.widget.Toast
import androidx.core.app.NotificationCompat
import androidx.core.content.FileProvider
import org.json.JSONException
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.file.Files
import java.security.MessageDigest
import java.security.SecureRandom
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.FutureTask
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

private const val GUEST_SCRIPT = "/usr/local/lib/t3-android/bridge.mjs"
private const val ENDPOINT = "run/t3-android/endpoint"
private val GUEST_COMMANDS = listOf(
  "termux-open-url",
  "termux-open",
  "xdg-open",
  "termux-clipboard-get",
  "termux-clipboard-set",
  "termux-notification",
  "termux-notification-remove",
  "termux-notification-list",
  "termux-toast",
  "termux-share",
  "termux-vibrate",
  "termux-battery-status",
  "termux-download",
  "termux-media-scan",
  "termux-torch",
  "termux-tts-speak",
  "termux-tts-engines",
  "termux-volume",
  "termux-sensor",
  "termux-wallpaper",
  "termux-wifi-connectioninfo",
  "termux-camera-info",
  "termux-camera-photo",
  "termux-microphone-record",
  "termux-location",
  "termux-contact-list",
  "termux-sms-list",
  "termux-sms-send",
  "termux-call-log",
  "termux-telephony-call",
  "termux-telephony-deviceinfo",
  "termux-telephony-cellinfo",
)

// Commands that wait on hardware, an engine or a database, so they run on the request's thread.
private val WAITING_COMMANDS = setOf(
  "media-scan",
  "tts-speak",
  "tts-engines",
  "sensor",
  "wallpaper",
  "camera-photo",
  "microphone-record",
  "location",
  "contact-list",
  "sms-list",
  "sms-send",
  "call-log",
  "telephony-deviceinfo",
  "telephony-cellinfo",
  "notification-list",
)
private const val NOTIFICATION_CHANNEL = "t3-agent-notifications"
private const val REQUEST_CHANNEL = "t3-agent-requests"
private const val NOTIFICATION_TAG = "t3-agent:"
private const val REQUEST_TAG = "t3-agent-request"
private const val MAX_LINE = 8 * 1024
private const val MAX_HEADERS = 64
private const val MAX_CONNECTIONS = 16
private const val MAX_BODY = 1 shl 20
private const val MAX_VIBRATE_MS = 60_000L
private const val SOCKET_TIMEOUT_MS = 10_000
private const val COMMAND_TIMEOUT_SECONDS = 10L
private const val FILE_AUTHORITY = ".t3-device-runtime.files"

/** Hands files to the apps termux-open opens them in; a subclass, as manifests allow one provider per class. */
class GuestFileProvider : FileProvider()

/** A request the bridge turns down, with the HTTP status it answers. */
internal class BridgeError(message: String, val status: Int = 400) : Exception(message)

private class RequestHead(val method: String, val path: String, val headers: Map<String, String>)

/**
 * Lets agents in the guest reach Android through Termux:API-style commands: a loopback
 * HTTP server that lives as long as the phone's T3 server. Any app can connect to
 * loopback, so requests carry a token that only the guest can read, from the endpoint file.
 */
class AndroidBridge private constructor(context: Context, private val rootfs: File) {
  private val context = context.applicationContext
  private val endpoint = File(rootfs, ENDPOINT)
  private val realRootfs = rootfs.canonicalFile
  private val data = PhoneData(this.context)
  private val hardware = PhoneHardware(this.context, ::hostFile)
  private val server = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
  private val token = ByteArray(32).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
  private val connections = Executors.newCachedThreadPool()
  // Any app can connect to loopback, so connections are capped before the token is checked.
  private val connectionSlots = Semaphore(MAX_CONNECTIONS)
  private val requestIds = AtomicInteger()

  init {
    try {
      writeEndpoint()
    } catch (error: Throwable) {
      server.close()
      throw error
    }
    Thread(::serve, "t3-android-bridge").start()
    current = this
  }

  fun stop() {
    if (current === this) current = null
    // The next server's bridge may have written its own endpoint already.
    if (runCatching { endpoint.readText() }.getOrNull()?.contains(token) == true) endpoint.delete()
    runCatching { server.close() }
    connections.shutdown()
    hardware.stopRecording()
  }

  private fun writeEndpoint() {
    val directory = endpoint.parentFile ?: throw IOException("No directory for ${endpoint.path}")
    directory.mkdirs()
    Os.chmod(directory.path, "700".toInt(8))
    val staging = File(directory, "${endpoint.name}.new")
    staging.delete()
    staging.writeText("${server.localPort} $token\n")
    Os.chmod(staging.path, "600".toInt(8))
    if (!staging.renameTo(endpoint)) throw IOException("Couldn't write ${endpoint.path}")
  }

  private fun serve() {
    while (!server.isClosed) {
      val client = try {
        server.accept()
      } catch (error: IOException) {
        break
      }
      if (!connectionSlots.tryAcquire()) {
        client.close()
        continue
      }
      runCatching {
        connections.execute {
          try {
            client.use { answer(it) }
          } finally {
            connectionSlots.release()
          }
        }
      }.onFailure {
        connectionSlots.release()
        client.close()
      }
    }
  }

  private fun answer(client: Socket) {
    client.soTimeout = SOCKET_TIMEOUT_MS
    val (status, reply) = try {
      200 to JSONObject().put("ok", true).put("result", handle(client.getInputStream()) ?: JSONObject.NULL)
    } catch (error: BridgeError) {
      error.status to failure(error.message)
    } catch (error: JSONException) {
      400 to failure(error.message)
    } catch (error: Exception) {
      Log.w(TAG, "Android bridge request failed", error)
      500 to failure(error.message ?: error.javaClass.simpleName)
    }
    val body = reply.toString().toByteArray()
    val head = "HTTP/1.1 $status ${reason(status)}\r\nContent-Type: application/json\r\n" +
      "Content-Length: ${body.size}\r\nConnection: close\r\n\r\n"
    runCatching {
      client.getOutputStream().apply {
        write(head.toByteArray())
        write(body)
        flush()
      }
    }
  }

  private fun handle(stream: InputStream): Any? {
    val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(SOCKET_TIMEOUT_MS.toLong())
    val input = stream.buffered()
    val request = readHead(input, deadline)
    val authorization = request.headers["authorization"].orEmpty().toByteArray()
    if (!MessageDigest.isEqual(authorization, "Bearer $token".toByteArray())) throw BridgeError("Unauthorized", 401)
    if (request.method != "POST") throw BridgeError("Use POST", 405)
    val command = request.path.removePrefix("/")
    val bytes = readBody(input, request.headers, deadline)
    val body = if (bytes.isEmpty()) JSONObject() else JSONObject(String(bytes, Charsets.UTF_8))
    Log.i(TAG, "Android bridge: $command")
    AgentAccess.check(context, command)?.let(::requireGranted)
    if (command in WAITING_COMMANDS) return perform(command, body)
    // Toasts need a looper, and the rest of Android's UI APIs expect the main thread.
    return onMainThread { perform(command, body) }
  }

  private fun perform(command: String, body: JSONObject): Any? = when (command) {
    "open-url" -> openUrl(body.getString("url"))
    "clipboard-get" -> clipboardText()
    "clipboard-set" -> {
      clipboard().setPrimaryClip(ClipData.newPlainText("T3 Code", body.getString("text")))
      null
    }
    "notification" -> {
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
        PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE)
      }
      val id = body.optString("id").ifEmpty { UUID.randomUUID().toString() }
      notify(NOTIFICATION_CHANNEL, NOTIFICATION_TAG + id, 0, body.optString("title"), body.optString("content"), launch)
      null
    }
    "notification-remove" -> {
      notificationManager().cancel(NOTIFICATION_TAG + body.getString("id"), 0)
      null
    }
    "toast" -> {
      val length = if (body.optBoolean("short")) Toast.LENGTH_SHORT else Toast.LENGTH_LONG
      Toast.makeText(context, body.getString("text"), length).show()
      null
    }
    "share" -> {
      val text = body.getString("text")
      val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
      startOrNotify(Intent.createChooser(send, null), "Share from an agent", text)
    }
    "vibrate" -> vibrate(body.optLong("duration", 1000))
    "battery-status" -> batteryStatus()
    "open" -> open(body)
    "download" -> download(body)
    "media-scan" -> hardware.mediaScan(body)
    "torch" -> hardware.torch(body.getBoolean("enabled"))
    "tts-speak" -> hardware.speak(body)
    "tts-engines" -> hardware.speechEngines()
    "volume" -> hardware.volume(body)
    "sensor-list" -> hardware.sensorList()
    "sensor" -> hardware.readSensors(body)
    "wallpaper" -> hardware.setWallpaper(body)
    "wifi-connectioninfo" -> hardware.wifi()
    "camera-info" -> hardware.cameraInfo()
    "camera-photo" -> hardware.takePhoto(body.optString("camera", "0"), hostFile(body.getString("file")))
    "microphone-record" -> hardware.microphone(body)
    "location" -> data.location(body)
    "contact-list" -> data.contacts()
    "sms-list" -> data.smsList(body)
    "sms-send" -> data.sendSms(body)
    "call-log" -> data.callLog(body)
    "telephony-call" -> {
      val number = body.getString("number")
      startOrNotify(Intent(Intent.ACTION_CALL, Uri.fromParts("tel", number, null)), "Call from an agent", number)
    }
    "telephony-deviceinfo" -> data.deviceInfo()
    "telephony-cellinfo" -> data.cellInfo()
    "notification-list" -> data.notifications()
    else -> throw BridgeError("Unknown command: $command", 404)
  }.takeUnless { it == Unit }

  private fun openUrl(url: String): Any? =
    startOrNotify(Intent(Intent.ACTION_VIEW, webUri(url)), "Open a link from an agent", url)

  private fun webUri(url: String): Uri {
    val uri = Uri.parse(url)
    if (uri.scheme.isNullOrEmpty() || uri.scheme.equals("file", ignoreCase = true)) {
      throw BridgeError("Only URLs are supported, not local files: $url")
    }
    return uri
  }

  /** termux-open: a URL, or a file through a content URI that the app it opens in may read. */
  private fun open(body: JSONObject): Any? {
    val send = body.optBoolean("send")
    val target = body.optString("path").ifEmpty { body.getString("url") }
    val intent = when {
      body.has("url") && send -> Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, target)
      body.has("url") -> Intent(Intent.ACTION_VIEW, webUri(target))
      else -> fileIntent(target, send, body.optString("contentType"))
    }
    val chosen = if (send || body.optBoolean("chooser")) Intent.createChooser(intent, null) else intent
    return startOrNotify(chosen, if (send) "Share from an agent" else "Open from an agent", target)
  }

  private fun fileIntent(path: String, send: Boolean, contentType: String): Intent {
    val file = hostFile(path)
    if (!file.isFile) throw BridgeError("No such file: $path")
    val uri = try {
      FileProvider.getUriForFile(context, context.packageName + FILE_AUTHORITY, file)
    } catch (error: IllegalArgumentException) {
      throw BridgeError("Only files in Ubuntu and phone storage can be opened: $path")
    }
    val type = contentType.ifEmpty {
      MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.extension.lowercase(Locale.ROOT)) ?: "*/*"
    }
    val intent = if (send) {
      Intent(Intent.ACTION_SEND).setType(type).putExtra(Intent.EXTRA_STREAM, uri)
        .also { it.clipData = ClipData.newRawUri(null, uri) }
    } else {
      Intent(Intent.ACTION_VIEW).setDataAndType(uri, type)
    }
    return intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
  }

  /** Android's download manager writes only to phone storage, so that's where downloads go. */
  @Suppress("DEPRECATION")
  private fun download(body: JSONObject): JSONObject {
    val url = body.getString("url")
    val uri = Uri.parse(url)
    val scheme = uri.scheme?.lowercase(Locale.ROOT)
    if (scheme != "http" && scheme != "https") {
      throw BridgeError("The download manager takes http and https URLs, not $url")
    }
    val name = URLUtil.guessFileName(url, null, null)
    val request = DownloadManager.Request(uri)
      .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
    body.optString("title").takeIf { it.isNotEmpty() }?.let { request.setTitle(it) }
    body.optString("description").takeIf { it.isNotEmpty() }?.let { request.setDescription(it) }
    val target = if (body.optString("path").isEmpty()) {
      request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
      File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), name)
    } else {
      val chosen = hostFile(body.getString("path")).let { if (it.isDirectory) File(it, name) else it }
      if (!chosen.path.startsWith("/storage/")) {
        throw BridgeError("The download manager saves only to phone storage, such as /sdcard/Download.")
      }
      request.setDestinationUri(Uri.fromFile(chosen))
      chosen
    }
    try {
      context.getSystemService(DownloadManager::class.java).enqueue(request)
    } catch (error: RuntimeException) {
      throw BridgeError("The download manager won't save to ${target.path}: ${error.message}")
    }
    return JSONObject().put("message", "Downloading to ${target.path}.")
  }

  /**
   * The app's path for a guest path: phone storage is bound into the guest at /storage, and
   * the rest is the rootfs. A symlink in the rootfs means something else to the app than to
   * the guest, so a path that resolves elsewhere is refused.
   */
  private fun hostFile(guestPath: String): File {
    if (!guestPath.startsWith("/")) throw BridgeError("Expected an absolute path, not $guestPath")
    val parts = guestPath.split('/').filter { it.isNotEmpty() && it != "." }
    if (".." in parts) throw BridgeError("Expected a path without \"..\": $guestPath")
    val file = when (parts.firstOrNull()) {
      "storage" -> File("/" + parts.joinToString("/"))
      "sdcard" -> File("/storage/emulated/0/" + parts.drop(1).joinToString("/"))
      else -> File(rootfs, parts.joinToString("/"))
    }.canonicalFile
    if (!file.path.startsWith("/storage/") && !file.startsWith(realRootfs)) {
      throw BridgeError("$guestPath leads outside Ubuntu and phone storage.")
    }
    return file
  }

  /** The user let the agent run this, or always allows it; Android still has to let T3 Code. */
  private fun requireGranted(category: AccessCategory) {
    if (AgentAccess.granted(context, category)) return
    val label = category.label
    if (category.permissions.isEmpty()) {
      // Notification access is a system settings page, not a prompt.
      startOrNotify(
        AgentAccess.notificationAccessIntent(context),
        "Allow notification access",
        "An agent on this phone wants to read its notifications. Turn on T3 Code here.",
      )
      throw BridgeError(
        "Android hasn't given T3 Code notification access. The user can turn it on in the settings page " +
          "T3 Code opened (or from its notification), then run this again.",
        403,
      )
    }
    if (!onScreen()) {
      val id = requestIds.incrementAndGet()
      val tap = PendingIntent.getActivity(context, id, AccessPrompt.intent(context, category), PendingIntent.FLAG_IMMUTABLE)
      notify(REQUEST_CHANNEL, REQUEST_TAG, id, "Allow $label?", "An agent on this phone wants $label. Tap to answer Android's prompt.", tap)
      throw BridgeError(
        "Android hasn't given T3 Code $label, and can only ask while T3 Code is on screen. The user can tap " +
          "T3 Code's notification to allow it, then run this again.",
        403,
      )
    }
    if (!AccessPrompt.request(context, category)) {
      throw BridgeError(
        "The user didn't allow $label in Android's prompt, or Android has stopped asking. " +
          "It can be allowed in ${AgentAccess.where(category)}.",
        403,
      )
    }
  }

  /** Android blocks activity starts from the background, but a notification's tap can start one. */
  private fun startOrNotify(intent: Intent, title: String, text: String): Any? {
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    if (onScreen()) {
      try {
        context.startActivity(intent)
      } catch (error: ActivityNotFoundException) {
        throw BridgeError("No app on this phone opens $text")
      }
      return null
    }
    val id = requestIds.incrementAndGet()
    val tap = PendingIntent.getActivity(context, id, intent, PendingIntent.FLAG_IMMUTABLE)
    notify(REQUEST_CHANNEL, REQUEST_TAG, id, title, text, tap)
    return JSONObject().put("notified", true).put(
      "message",
      "T3 Code isn't on screen, so Android won't open this until the user taps T3 Code's notification.",
    )
  }

  private fun clipboardText(): String {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && !onScreen()) {
      throw BridgeError("Android lets T3 Code read the clipboard only while it's on screen.")
    }
    val clip = clipboard().primaryClip?.takeIf { it.itemCount > 0 } ?: return ""
    return clip.getItemAt(0).coerceToText(context).toString()
  }

  private fun vibrate(duration: Long): Any? {
    if (duration !in 1..MAX_VIBRATE_MS) throw BridgeError("Vibrate for 1 to $MAX_VIBRATE_MS ms.")
    val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      context.getSystemService(VibratorManager::class.java).defaultVibrator
    } else {
      context.getSystemService(Vibrator::class.java)
    }
    if (!vibrator.hasVibrator()) throw BridgeError("This phone can't vibrate.")
    vibrator.vibrate(VibrationEffect.createOneShot(duration, VibrationEffect.DEFAULT_AMPLITUDE))
    return null
  }

  /** The keys and values termux-battery-status prints. */
  private fun batteryStatus(): JSONObject {
    val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
      ?: throw BridgeError("Android didn't report the battery.")
    val batteryManager = context.getSystemService(BatteryManager::class.java)
    val level = battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
    val scale = battery.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
    val health = when (val code = battery.getIntExtra(BatteryManager.EXTRA_HEALTH, -1)) {
      BatteryManager.BATTERY_HEALTH_COLD -> "COLD"
      BatteryManager.BATTERY_HEALTH_DEAD -> "DEAD"
      BatteryManager.BATTERY_HEALTH_GOOD -> "GOOD"
      BatteryManager.BATTERY_HEALTH_OVERHEAT -> "OVERHEAT"
      BatteryManager.BATTERY_HEALTH_OVER_VOLTAGE -> "OVER_VOLTAGE"
      BatteryManager.BATTERY_HEALTH_UNKNOWN -> "UNKNOWN"
      BatteryManager.BATTERY_HEALTH_UNSPECIFIED_FAILURE -> "UNSPECIFIED_FAILURE"
      else -> "$code"
    }
    val plugged = when (val code = battery.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1)) {
      0 -> "UNPLUGGED"
      BatteryManager.BATTERY_PLUGGED_AC -> "PLUGGED_AC"
      BatteryManager.BATTERY_PLUGGED_DOCK -> "PLUGGED_DOCK"
      BatteryManager.BATTERY_PLUGGED_USB -> "PLUGGED_USB"
      BatteryManager.BATTERY_PLUGGED_WIRELESS -> "PLUGGED_WIRELESS"
      else -> "PLUGGED_$code"
    }
    val status = when (val code = battery.getIntExtra(BatteryManager.EXTRA_STATUS, -1)) {
      BatteryManager.BATTERY_STATUS_CHARGING -> "CHARGING"
      BatteryManager.BATTERY_STATUS_DISCHARGING -> "DISCHARGING"
      BatteryManager.BATTERY_STATUS_FULL -> "FULL"
      BatteryManager.BATTERY_STATUS_NOT_CHARGING -> "NOT_CHARGING"
      BatteryManager.BATTERY_STATUS_UNKNOWN -> "UNKNOWN"
      else -> "$code"
    }
    return JSONObject()
      .put("health", health)
      .put("percentage", if (scale > 0) level * 100 / scale else level)
      .put("plugged", plugged)
      .put("status", status)
      .put("temperature", battery.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) / 10.0)
      .put("current", batteryManager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW))
  }

  private fun clipboard() = context.getSystemService(ClipboardManager::class.java)

  private fun notificationManager() = context.getSystemService(NotificationManager::class.java)

  private fun notify(channel: String, tag: String, id: Int, title: String, text: String, tap: PendingIntent?) {
    val manager = notificationManager()
    if (!manager.areNotificationsEnabled()) throw BridgeError("T3 Code's notifications are turned off.")
    manager.createNotificationChannel(
      NotificationChannel(NOTIFICATION_CHANNEL, "Agent notifications", NotificationManager.IMPORTANCE_DEFAULT).apply {
        description = "Notifications that agents on this phone post."
      },
    )
    manager.createNotificationChannel(
      NotificationChannel(REQUEST_CHANNEL, "Requests from agents", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "Links, shares and permissions that agents ask for while T3 Code isn't on screen."
      },
    )
    val blocked = manager.getNotificationChannel(channel)
      ?.takeIf { it.importance == NotificationManager.IMPORTANCE_NONE }
    if (blocked != null) throw BridgeError("T3 Code's \"${blocked.name}\" notifications are turned off.")
    val icon = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
      .takeIf { it != 0 } ?: context.applicationInfo.icon
    val notification = NotificationCompat.Builder(context, channel)
      .setSmallIcon(icon)
      .setContentTitle(title.ifEmpty { null })
      .setContentText(text.ifEmpty { null })
      .setStyle(NotificationCompat.BigTextStyle().bigText(text))
      .setContentIntent(tap)
      .setAutoCancel(true)
      .build()
    manager.notify(tag, id, notification)
  }

  /** Called when the user sets a category to Never, so nothing it started keeps running. */
  fun denied(category: AccessCategory) {
    if (category.id == "microphone") hardware.stopRecording()
  }

  companion object {
    @Volatile var current: AndroidBridge? = null
      private set

    /** Starts the bridge and installs its commands in the guest; without it the server runs anyway. */
    fun start(context: Context): AndroidBridge? = try {
      val rootfs = DeviceRuntime(context) {}.rootfs
      // Without the access rules agents would reach phone data unasked, so no rules, no bridge.
      AgentAccess.writeManagedSettings(context, rootfs)
      installCommands(context, rootfs)
      installGuide(context, rootfs)
      AndroidBridge(context, rootfs)
    } catch (error: Exception) {
      Log.w(TAG, "The Android bridge couldn't start", error)
      null
    }

    // Claude Code loads its managed CLAUDE.md in every session; the user's own stays theirs.
    private fun installGuide(context: Context, rootfs: File) {
      val guide = File(rootfs, "etc/claude-code/CLAUDE.md")
      guide.parentFile?.mkdirs()
      context.assets.open("phone-agent-guide.md").use { input ->
        guide.outputStream().use { input.copyTo(it) }
      }
    }

    private fun installCommands(context: Context, rootfs: File) {
      val script = File(rootfs, GUEST_SCRIPT.removePrefix("/"))
      script.parentFile?.mkdirs()
      Files.deleteIfExists(script.toPath())
      context.assets.open("android-bridge.mjs").use { input -> script.outputStream().use { input.copyTo(it) } }
      for (command in GUEST_COMMANDS) {
        val wrapper = File(rootfs, "usr/local/bin/$command")
        // Deleted first, so a symlink left there isn't written through.
        Files.deleteIfExists(wrapper.toPath())
        wrapper.writeText("#!/bin/sh\nexec /usr/local/bin/node $GUEST_SCRIPT $command \"\$@\"\n")
        Os.chmod(wrapper.path, "755".toInt(8))
      }
    }
  }
}

/** Whether an activity of this app is on screen, which Android's activity and privacy rules ask. */
internal fun onScreen(): Boolean {
  val state = ActivityManager.RunningAppProcessInfo()
  ActivityManager.getMyMemoryState(state)
  return state.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
}

/** Android keeps the camera, microphone and location from apps in the background. */
internal fun requireOnScreen(what: String) {
  if (!onScreen()) {
    throw BridgeError("Android lets T3 Code $what only while it's on screen. Open T3 Code and try again.")
  }
}

internal fun <T> onMainThread(block: () -> T): T {
  val task = FutureTask { block() }
  Handler(Looper.getMainLooper()).post(task)
  return try {
    task.get(COMMAND_TIMEOUT_SECONDS, TimeUnit.SECONDS)
  } catch (error: ExecutionException) {
    throw error.cause ?: error
  }
}

/** Termux:API's null, which JSONObject.put would otherwise take as removing the key. */
internal fun orNull(value: Any?): Any = value ?: JSONObject.NULL

internal fun formatDate(millis: Long): String = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date(millis))

/** mm:ss, or hh:mm:ss from an hour. */
internal fun timeString(seconds: Int): String {
  val minutes = "%02d:%02d".format(Locale.US, seconds % 3600 / 60, seconds % 60)
  return if (seconds >= 3600) "%02d:%s".format(Locale.US, seconds / 3600, minutes) else minutes
}

private fun failure(message: String?): JSONObject = JSONObject().put("ok", false).put("error", message ?: "Failed")

private fun reason(status: Int) = when (status) {
  200 -> "OK"
  400 -> "Bad Request"
  401 -> "Unauthorized"
  403 -> "Forbidden"
  404 -> "Not Found"
  405 -> "Method Not Allowed"
  413 -> "Content Too Large"
  else -> "Internal Server Error"
}

private fun readHead(input: InputStream, deadline: Long): RequestHead {
  val requestLine = readLine(input, deadline).split(' ')
  if (requestLine.size != 3) throw BridgeError("Malformed request line")
  val headers = HashMap<String, String>()
  while (true) {
    val line = readLine(input, deadline)
    if (line.isEmpty()) break
    if (headers.size >= MAX_HEADERS) throw BridgeError("Too many request headers", 413)
    val colon = line.indexOf(':')
    if (colon > 0) headers[line.substring(0, colon).trim().lowercase()] = line.substring(colon + 1).trim()
  }
  return RequestHead(requestLine[0], requestLine[1], headers)
}

private fun readBody(input: InputStream, headers: Map<String, String>, deadline: Long): ByteArray {
  val length = headers["content-length"]?.toIntOrNull() ?: 0
  if (length !in 0..MAX_BODY) throw BridgeError("The request is too large", 413)
  val body = ByteArray(length)
  var read = 0
  while (read < length) {
    checkDeadline(deadline)
    val count = input.read(body, read, length - read)
    if (count < 0) throw BridgeError("The request ended early")
    read += count
  }
  return body
}

// The socket timeout bounds each read; this bounds a client that sends a byte at a time.
private fun checkDeadline(deadline: Long) {
  if (System.nanoTime() > deadline) throw BridgeError("The request took too long to arrive")
}

private fun readLine(input: InputStream, deadline: Long): String {
  val line = ByteArrayOutputStream()
  while (true) {
    checkDeadline(deadline)
    val byte = input.read()
    if (byte < 0) throw BridgeError("The request ended early")
    if (byte == '\n'.code) break
    if (line.size() >= MAX_LINE) throw BridgeError("A request line is too long", 413)
    line.write(byte)
  }
  return line.toString(Charsets.ISO_8859_1.name()).removeSuffix("\r")
}
