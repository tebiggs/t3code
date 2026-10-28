package expo.modules.t3deviceruntime

import android.app.ActivityManager
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
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.system.Os
import android.util.Log
import android.widget.Toast
import androidx.core.app.NotificationCompat
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
import java.util.UUID
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

private const val GUEST_SCRIPT = "/usr/local/lib/t3-android/bridge.mjs"
private const val ENDPOINT = "run/t3-android/endpoint"
private val GUEST_COMMANDS = listOf(
  "termux-open-url",
  "xdg-open",
  "termux-clipboard-get",
  "termux-clipboard-set",
  "termux-notification",
  "termux-notification-remove",
  "termux-toast",
  "termux-share",
  "termux-vibrate",
  "termux-battery-status",
)
private const val NOTIFICATION_CHANNEL = "t3-agent-notifications"
private const val REQUEST_CHANNEL = "t3-agent-requests"
private const val NOTIFICATION_TAG = "t3-agent:"
private const val REQUEST_TAG = "t3-agent-request"
private const val MAX_LINE = 8 * 1024
private const val MAX_BODY = 1 shl 20
private const val MAX_VIBRATE_MS = 60_000L
private const val SOCKET_TIMEOUT_MS = 10_000
private const val COMMAND_TIMEOUT_SECONDS = 10L

/** A request the bridge turns down, with the HTTP status it answers. */
private class BridgeError(message: String, val status: Int = 400) : Exception(message)

private class Request(val method: String, val path: String, val headers: Map<String, String>, val body: ByteArray)

/**
 * Lets agents in the guest reach Android through Termux:API-style commands: a loopback
 * HTTP server that lives as long as the phone's T3 server. Any app can connect to
 * loopback, so requests carry a token that only the guest can read, from the endpoint file.
 */
class AndroidBridge private constructor(context: Context, private val endpoint: File) {
  private val context = context.applicationContext
  private val server = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
  private val token = ByteArray(32).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
  private val connections = Executors.newCachedThreadPool()
  private val mainHandler = Handler(Looper.getMainLooper())
  private val requestIds = AtomicInteger()

  init {
    try {
      writeEndpoint()
    } catch (error: Throwable) {
      server.close()
      throw error
    }
    Thread(::serve, "t3-android-bridge").start()
  }

  fun stop() {
    // The next server's bridge may have written its own endpoint already.
    if (runCatching { endpoint.readText() }.getOrNull()?.contains(token) == true) endpoint.delete()
    runCatching { server.close() }
    connections.shutdown()
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
      runCatching { connections.execute { client.use { answer(it) } } }.onFailure { client.close() }
    }
  }

  private fun answer(client: Socket) {
    client.soTimeout = SOCKET_TIMEOUT_MS
    val (status, reply) = try {
      200 to JSONObject().put("ok", true).put("result", handle(readRequest(client.getInputStream())) ?: JSONObject.NULL)
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

  private fun handle(request: Request): Any? {
    val authorization = request.headers["authorization"].orEmpty().toByteArray()
    if (!MessageDigest.isEqual(authorization, "Bearer $token".toByteArray())) throw BridgeError("Unauthorized", 401)
    if (request.method != "POST") throw BridgeError("Use POST", 405)
    val command = request.path.removePrefix("/")
    val body = if (request.body.isEmpty()) JSONObject() else JSONObject(String(request.body, Charsets.UTF_8))
    Log.i(TAG, "Android bridge: $command")
    val task = FutureTask { perform(command, body) }
    // Toasts need a looper, and the rest of Android's UI APIs expect the main thread.
    mainHandler.post(task)
    return try {
      task.get(COMMAND_TIMEOUT_SECONDS, TimeUnit.SECONDS)
    } catch (error: ExecutionException) {
      throw error.cause ?: error
    }
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
    else -> throw BridgeError("Unknown command: $command", 404)
  }

  private fun openUrl(url: String): Any? {
    val uri = Uri.parse(url)
    if (uri.scheme.isNullOrEmpty() || uri.scheme.equals("file", ignoreCase = true)) {
      throw BridgeError("Only URLs are supported, not local files: $url")
    }
    return startOrNotify(Intent(Intent.ACTION_VIEW, uri), "Open a link from an agent", url)
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

  /** Whether an activity of this app is on screen, which Android's activity and clipboard rules ask. */
  private fun onScreen(): Boolean {
    val state = ActivityManager.RunningAppProcessInfo()
    ActivityManager.getMyMemoryState(state)
    return state.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
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
      NotificationChannel(REQUEST_CHANNEL, "Links and shares from agents", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "Links and shares that agents ask for while T3 Code isn't on screen."
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

  companion object {
    /** Starts the bridge and installs its commands in the guest; without it the server runs anyway. */
    fun start(context: Context): AndroidBridge? = try {
      val rootfs = DeviceRuntime(context) {}.rootfs
      installCommands(context, rootfs)
      AndroidBridge(context, File(rootfs, ENDPOINT))
    } catch (error: Exception) {
      Log.w(TAG, "The Android bridge couldn't start", error)
      null
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

private fun failure(message: String?): JSONObject = JSONObject().put("ok", false).put("error", message ?: "Failed")

private fun reason(status: Int) = when (status) {
  200 -> "OK"
  400 -> "Bad Request"
  401 -> "Unauthorized"
  404 -> "Not Found"
  405 -> "Method Not Allowed"
  413 -> "Content Too Large"
  else -> "Internal Server Error"
}

private fun readRequest(input: InputStream): Request {
  val buffered = input.buffered()
  val requestLine = readLine(buffered).split(' ')
  if (requestLine.size != 3) throw BridgeError("Malformed request line")
  val headers = HashMap<String, String>()
  while (true) {
    val line = readLine(buffered)
    if (line.isEmpty()) break
    val colon = line.indexOf(':')
    if (colon > 0) headers[line.substring(0, colon).trim().lowercase()] = line.substring(colon + 1).trim()
  }
  val length = headers["content-length"]?.toIntOrNull() ?: 0
  if (length !in 0..MAX_BODY) throw BridgeError("The request is too large", 413)
  val body = ByteArray(length)
  var read = 0
  while (read < length) {
    val count = buffered.read(body, read, length - read)
    if (count < 0) throw BridgeError("The request ended early")
    read += count
  }
  return Request(requestLine[0], requestLine[1], headers, body)
}

private fun readLine(input: InputStream): String {
  val line = ByteArrayOutputStream()
  while (true) {
    val byte = input.read()
    if (byte < 0) throw BridgeError("The request ended early")
    if (byte == '\n'.code) break
    if (line.size() >= MAX_LINE) throw BridgeError("A request line is too long", 413)
    line.write(byte)
  }
  return line.toString(Charsets.ISO_8859_1.name()).removeSuffix("\r")
}
