package expo.modules.t3deviceruntime

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

private const val ACTION_STOP_SERVER = "expo.modules.t3deviceruntime.STOP_SERVER"
private const val CHANNEL_ID = "t3-device-server"
private const val NOTIFICATION_ID = 3773
private const val STOP_TIMEOUT_SECONDS = 10L
private const val EARLY_EXIT_MS = 30_000L

/** Why the runtime needs to keep running, in the order the notification prefers them. */
enum class Hold { Job, Login, Server }

/**
 * Keeps the app in the foreground while the runtime works. Android freezes a backgrounded
 * app's processes, and proot's guests are this app's children: an install, a sign-in that
 * waits on the browser, or the server would stall as soon as the user switched apps.
 */
object RuntimeForeground {
  private val holds = sortedMapOf<Hold, String>()
  @Volatile internal var service: DeviceRuntimeService? = null

  fun hold(context: Context, hold: Hold, text: String) {
    val running = synchronized(this) {
      holds[hold] = text
      service
    }
    if (running != null) running.refresh()
    else ContextCompat.startForegroundService(context, Intent(context, DeviceRuntimeService::class.java))
  }

  fun release(hold: Hold) {
    val running = synchronized(this) {
      holds.remove(hold)
      service
    }
    running?.refresh()
  }

  @Synchronized
  internal fun current(): Pair<Hold, String>? = holds.entries.firstOrNull()?.toPair()
}

/** The T3 server inside the on-device runtime, kept alive by the foreground service. */
object DeviceServer {
  @Volatile private var guest: GuestProcess? = null
  @Volatile private var stopRequested = false

  val running: Boolean
    get() = guest?.process?.isAlive == true

  fun logFile(context: Context): File = File(DeviceRuntime(context) {}.home, "server.log")

  @Synchronized
  fun start(context: Context, port: Int) {
    stopRequested = false
    launch(context, port, retry = true)
  }

  @Synchronized
  private fun launch(context: Context, port: Int, retry: Boolean) {
    if (running) return
    RuntimeForeground.hold(context, Hold.Server, "The server is running on this phone.")
    val log = logFile(context)
    val bridge = AndroidBridge.start(context)
    val started = try {
      DeviceRuntime(context) {}.start(
        listOf("t3", "serve", "--host", "127.0.0.1", "--port", "$port"),
        // Claude Code refuses full access as root unless it is told it runs in a sandbox.
        mapOf("IS_SANDBOX" to "1"),
      )
    } catch (error: Throwable) {
      bridge?.stop()
      log.writeText("T3 Code couldn't start: ${error.message}\n")
      RuntimeForeground.release(Hold.Server)
      throw error
    }
    guest = started
    val startedAt = SystemClock.elapsedRealtime()
    Thread({
      val code = log.outputStream().use { output ->
        // A forced stop closes the output while it's being copied.
        runCatching { started.process.inputStream.copyTo(output) }
        started.process.waitFor().also {
          output.write("\nT3 Code exited with status $it.\n".toByteArray())
        }
      }
      started.cleanUp()
      bridge?.stop()
      synchronized(this) {
        // A server started since this one exited owns the hold now.
        if (guest !== started) return@Thread
        guest = null
        // A first start can fail cleaning up after publishing the environment id: proot
        // emulates its hard link with a file the temp directory then can't lose. The id is
        // in place by then, so the second start gets past it.
        val early = SystemClock.elapsedRealtime() - startedAt < EARLY_EXIT_MS
        val relaunched = retry && code != 0 && early && !stopRequested &&
          runCatching { launch(context, port, retry = false) }.isSuccess
        if (!relaunched) RuntimeForeground.release(Hold.Server)
      }
    }, "t3-device-server").start()
  }

  /** Asks the server to shut down and waits until proot has exited. */
  fun stop() {
    stopRequested = true
    val started = guest ?: return
    started.terminate()
    if (!started.process.waitFor(STOP_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
      throw IOException("The server didn't stop within $STOP_TIMEOUT_SECONDS seconds.")
    }
  }
}

class DeviceRuntimeService : Service() {
  private val mainHandler = Handler(Looper.getMainLooper())
  private var wakeLock: PowerManager.WakeLock? = null
  private var shown: Pair<Hold, String>? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    RuntimeForeground.service = this
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP_SERVER) {
      Thread({
        runCatching { DeviceServer.stop() }.onFailure { Log.w(TAG, "Stopping the server failed", it) }
      }, "t3-device-server-stop").start()
      return START_NOT_STICKY
    }
    // A service started with startForegroundService must call startForeground, even when
    // its work has already finished.
    val current = RuntimeForeground.current() ?: (Hold.Job to "Finishing…")
    startForeground(current)
    update()
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    RuntimeForeground.service = null
    wakeLock?.takeIf { it.isHeld }?.release()
    super.onDestroy()
  }

  fun refresh() {
    mainHandler.post(::update)
  }

  /** Shows what the runtime is doing, or stops once nothing needs it. */
  private fun update() {
    val current = RuntimeForeground.current()
    if (current == null) {
      wakeLock?.takeIf { it.isHeld }?.release()
      ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
      stopSelf()
      shown = null
      return
    }
    if (current != shown) startForeground(current)
    // Installs and agents keep going with the screen off, as they did in Termux.
    if (wakeLock?.isHeld != true) {
      wakeLock = getSystemService(PowerManager::class.java)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "T3Code:device-runtime")
        .apply { acquire() }
    }
  }

  private fun startForeground(current: Pair<Hold, String>) {
    shown = current
    ServiceCompat.startForeground(
      this,
      NOTIFICATION_ID,
      notification(current.first, current.second),
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
      } else {
        0
      },
    )
  }

  private fun notification(hold: Hold, text: String): Notification {
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "T3 Code on this phone", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Shown while T3 Code installs, signs in or runs its server on this phone."
      },
    )
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE)
    }
    val icon = resources.getIdentifier("notification_icon", "drawable", packageName)
      .takeIf { it != 0 } ?: applicationInfo.icon
    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(icon)
      .setContentTitle("T3 Code")
      .setContentText(text)
      .setOngoing(true)
      .setContentIntent(open)
    if (hold == Hold.Server) {
      val stop = PendingIntent.getService(
        this,
        1,
        Intent(this, DeviceRuntimeService::class.java).setAction(ACTION_STOP_SERVER),
        PendingIntent.FLAG_IMMUTABLE,
      )
      builder.addAction(0, "Stop server", stop)
    }
    return builder.build()
  }
}
