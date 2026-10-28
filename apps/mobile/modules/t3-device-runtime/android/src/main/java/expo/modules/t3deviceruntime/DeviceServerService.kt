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
import android.os.IBinder
import android.os.PowerManager
import android.system.Os
import android.system.OsConstants
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import java.io.File
import java.util.concurrent.TimeUnit

private const val ACTION_START = "expo.modules.t3deviceruntime.START"
private const val ACTION_STOP = "expo.modules.t3deviceruntime.STOP"
private const val EXTRA_PORT = "port"
private const val CHANNEL_ID = "t3-device-server"
private const val NOTIFICATION_ID = 3773
private const val STOP_TIMEOUT_SECONDS = 10L
// Guest path of the file the server's shell writes its pid to before exec'ing t3.
private const val SERVER_PID_FILE = "tmp/.t3-server.pid"

/**
 * The T3 server inside the on-device runtime. It runs under a foreground service: Android
 * freezes a backgrounded app's processes, and proot's guests are this app's children.
 */
object DeviceServer {
  @Volatile private var guest: GuestProcess? = null
  @Volatile var port: Int = 0
    private set

  val running: Boolean
    get() = guest?.process?.isAlive == true

  fun logFile(context: Context): File = File(DeviceRuntime(context) {}.home, "server.log")

  fun start(context: Context, port: Int) {
    ContextCompat.startForegroundService(
      context,
      Intent(context, DeviceServerService::class.java).setAction(ACTION_START).putExtra(EXTRA_PORT, port),
    )
  }

  /** Asks the server to shut down and waits until proot has exited. */
  fun stop(context: Context) {
    val started = guest ?: return
    val runtime = DeviceRuntime(context) {}
    // The guest's pids are real: proot traces processes but doesn't namespace them.
    val pid = File(runtime.rootfs, SERVER_PID_FILE).takeIf { it.isFile }?.readText()?.trim()?.toIntOrNull()
    if (pid != null) runCatching { Os.kill(pid, OsConstants.SIGTERM) }
    if (!started.process.waitFor(STOP_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
      started.terminate()
      started.process.waitFor(STOP_TIMEOUT_SECONDS, TimeUnit.SECONDS)
    }
  }

  @Synchronized
  internal fun launch(context: Context, port: Int, onExit: () -> Unit): Boolean {
    if (running) return false
    val log = logFile(context)
    val runtime = DeviceRuntime(context) {}
    File(runtime.rootfs, SERVER_PID_FILE).delete()
    val started = runtime.start(
      listOf(
        "/bin/sh", "-c", "echo \$\$ > /$SERVER_PID_FILE && exec t3 serve --host 127.0.0.1 --port $port",
      ),
      // Claude Code refuses full access as root unless it is told it runs in a sandbox.
      mapOf("IS_SANDBOX" to "1"),
    )
    guest = started
    this.port = port
    Thread({
      log.outputStream().use { output ->
        // A forced stop closes the output while it's being copied.
        runCatching { started.process.inputStream.copyTo(output) }
        output.write("\nT3 Code exited with status ${started.process.waitFor()}.\n".toByteArray())
      }
      started.cleanUp()
      synchronized(this) { if (guest === started) guest = null }
      onExit()
    }, "t3-device-server").start()
    return true
  }
}

class DeviceServerService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      Thread({ DeviceServer.stop(this) }, "t3-device-server-stop").start()
      return START_NOT_STICKY
    }
    ServiceCompat.startForeground(
      this,
      NOTIFICATION_ID,
      notification(),
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
      } else {
        0
      },
    )
    val port = intent?.getIntExtra(EXTRA_PORT, 0) ?: 0
    if (DeviceServer.running || port == 0) return START_NOT_STICKY
    // Agents keep working with the screen off, as they did in Termux with its wake lock.
    wakeLock = getSystemService(PowerManager::class.java)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "T3Code:device-server")
      .apply { acquire() }
    val launched = runCatching {
      DeviceServer.launch(this, port) {
        wakeLock?.takeIf { it.isHeld }?.release()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
      }
    }
    if (launched.getOrDefault(false) == false) {
      wakeLock?.takeIf { it.isHeld }?.release()
      if (!DeviceServer.running) {
        launched.exceptionOrNull()?.let { error ->
          DeviceServer.logFile(this).writeText("T3 Code couldn't start: ${error.message}\n")
        }
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
      }
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    wakeLock?.takeIf { it.isHeld }?.release()
    super.onDestroy()
  }

  private fun notification(): Notification {
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "T3 Code server", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Shown while T3 Code's server runs on this phone."
      },
    )
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE)
    }
    val stop = PendingIntent.getService(
      this,
      1,
      Intent(this, DeviceServerService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_IMMUTABLE,
    )
    val icon = resources.getIdentifier("notification_icon", "drawable", packageName)
      .takeIf { it != 0 } ?: applicationInfo.icon
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(icon)
      .setContentTitle("T3 Code server")
      .setContentText("Running on this phone")
      .setOngoing(true)
      .setContentIntent(open)
      .addAction(0, "Stop", stop)
      .build()
  }
}
