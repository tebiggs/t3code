package expo.modules.t3termux

import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.atomic.AtomicInteger

private const val TERMUX_PACKAGE = "com.termux"
private const val RUN_COMMAND_SERVICE = "com.termux.app.RunCommandService"
private const val RUN_COMMAND_PERMISSION = "com.termux.permission.RUN_COMMAND"
private const val TERMUX_HOME = "/data/data/com.termux/files/home"
private const val TERMUX_BASH = "/data/data/com.termux/files/usr/bin/bash"

// Extra names from termux-shared TermuxConstants.TERMUX_APP.RUN_COMMAND_SERVICE.
private const val EXTRA_COMMAND_PATH = "com.termux.RUN_COMMAND_PATH"
private const val EXTRA_ARGUMENTS = "com.termux.RUN_COMMAND_ARGUMENTS"
private const val EXTRA_WORKDIR = "com.termux.RUN_COMMAND_WORKDIR"
private const val EXTRA_BACKGROUND = "com.termux.RUN_COMMAND_BACKGROUND"
private const val EXTRA_RUNNER = "com.termux.RUN_COMMAND_RUNNER"
private const val EXTRA_SESSION_ACTION = "com.termux.RUN_COMMAND_SESSION_ACTION"
private const val EXTRA_COMMAND_LABEL = "com.termux.RUN_COMMAND_COMMAND_LABEL"
private const val EXTRA_PENDING_INTENT = "com.termux.RUN_COMMAND_PENDING_INTENT"

// TermuxConstants.TERMUX_APP.TERMUX_SERVICE.VALUE_EXTRA_SESSION_ACTION_*.
private const val SESSION_ACTION_SWITCH_AND_DONT_OPEN = "2"

class T3TermuxModule : Module() {
  // Each result PendingIntent needs its own request code, or Termux answers only the first.
  private val requestCodes = AtomicInteger((System.currentTimeMillis() % 1_000_000).toInt())
  private val mainHandler = Handler(Looper.getMainLooper())
  private var phoneScript: String? = null

  override fun definition() = ModuleDefinition {
    Name("T3Termux")

    Function("getStatus") { termuxStatus(requireContext()) }

    // Runs a t3-phone subcommand without a terminal and resolves with its output.
    AsyncFunction("runScript") { arguments: List<String>, timeoutMs: Int, promise: Promise ->
      val context = requireContext()
      runInBackground(context, scriptArguments(context, arguments), timeoutMs.toLong(), promise)
    }

    // Runs a t3-phone subcommand in a new Termux terminal session and brings Termux forward.
    // Termux's own service can't open its activity from the background on Android 10+
    // without "Display over other apps", so this app, in the foreground, opens it. The
    // session only starts its process once Termux shows it.
    Function("startScriptSession") { arguments: List<String>, label: String ->
      val context = requireContext()
      startTermuxService(
        context,
        runCommandIntent(scriptArguments(context, arguments), background = false)
          .putExtra(EXTRA_SESSION_ACTION, SESSION_ACTION_SWITCH_AND_DONT_OPEN)
          .putExtra(EXTRA_COMMAND_LABEL, label),
      )
      context.packageManager.getLaunchIntentForPackage(TERMUX_PACKAGE)?.let {
        startActivity(context, it)
      }
    }

    // Starts a long-running t3-phone subcommand without a terminal or a result.
    Function("startScriptInBackground") { arguments: List<String> ->
      val context = requireContext()
      startTermuxService(
        context,
        runCommandIntent(scriptArguments(context, arguments), background = true),
      )
    }

    Function("openTermux") {
      val context = requireContext()
      val intent = context.packageManager.getLaunchIntentForPackage(TERMUX_PACKAGE)
      intent != null && startActivity(context, intent)
    }

    Function("openTermuxSettings") {
      val context = requireContext()
      startActivity(
        context,
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$TERMUX_PACKAGE")),
      )
    }

    // Before developer options are turned on, open About phone, where Build number is.
    Function("openDeveloperSettings") {
      val context = requireContext()
      val enabled = readGlobalSetting(context, Settings.Global.DEVELOPMENT_SETTINGS_ENABLED) == "1"
      startActivity(
        context,
        Intent(
          if (enabled) {
            Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS
          } else {
            Settings.ACTION_DEVICE_INFO_SETTINGS
          },
        ),
      )
    }
  }

  private fun termuxStatus(context: Context): Map<String, Any?> {
    val packageManager = context.packageManager
    val termux =
      try {
        packageManager.getPackageInfo(TERMUX_PACKAGE, 0)
      } catch (_: PackageManager.NameNotFoundException) {
        null
      }
    return mapOf(
      "installed" to (termux != null),
      "versionName" to termux?.versionName,
      "installer" to termux?.let { installerOf(packageManager) },
      "permissionGranted" to
        (
          ContextCompat.checkSelfPermission(context, RUN_COMMAND_PERMISSION) ==
            PackageManager.PERMISSION_GRANTED
          ),
      "batteryUnrestricted" to
        termux?.let {
          context
            .getSystemService(PowerManager::class.java)
            ?.isIgnoringBatteryOptimizations(TERMUX_PACKAGE)
        },
      "developerOptionsEnabled" to
        (readGlobalSetting(context, Settings.Global.DEVELOPMENT_SETTINGS_ENABLED) == "1"),
      "deviceName" to (readGlobalSetting(context, Settings.Global.DEVICE_NAME) ?: Build.MODEL),
      "manufacturer" to Build.MANUFACTURER,
      // Claude Code and the T3 server ship only arm64 and x86_64 Linux builds.
      "supportedAbi" to
        Build.SUPPORTED_64_BIT_ABIS.any { it == "arm64-v8a" || it == "x86_64" },
      "appLaunchComponent" to
        packageManager
          .getLaunchIntentForPackage(context.packageName)
          ?.component
          ?.flattenToShortString(),
    )
  }

  private fun requireContext(): Context =
    appContext.reactContext
      ?: throw CodedException("ERR_TERMUX_CONTEXT", "No Android context.", null)

  private fun scriptArguments(context: Context, arguments: List<String>): List<String> {
    val script =
      phoneScript ?: context.assets.open("t3-phone.sh").bufferedReader().use { it.readText() }
    phoneScript = script
    // With `bash -c`, the next argument becomes $0, so the script sees itself as t3-phone.
    return listOf("-c", script, "t3-phone") + arguments
  }

  private fun runInBackground(
    context: Context,
    arguments: List<String>,
    timeoutMs: Long,
    promise: Promise
  ) {
    val requestCode = requestCodes.incrementAndGet()
    val action = "${context.packageName}.T3_TERMUX_RESULT.$requestCode"
    // The receiver and the timeout both run on the main looper, so `settled` needs no lock.
    var settled = false
    lateinit var receiver: BroadcastReceiver
    val timeout = Runnable {
      if (settled) return@Runnable
      settled = true
      unregister(context, receiver)
      promise.reject(
        "ERR_TERMUX_TIMEOUT",
        "Termux didn't answer within ${timeoutMs / 1000} seconds.",
        null,
      )
    }
    receiver =
      object : BroadcastReceiver() {
        override fun onReceive(receiverContext: Context, intent: Intent) {
          if (settled) return
          settled = true
          mainHandler.removeCallbacks(timeout)
          unregister(context, this)
          val result = intent.getBundleExtra("result")
          promise.resolve(
            mapOf(
              "stdout" to (result?.getString("stdout") ?: ""),
              "stderr" to (result?.getString("stderr") ?: ""),
              "exitCode" to
                if (result?.containsKey("exitCode") == true) result.getInt("exitCode") else null,
              // Activity.RESULT_OK (-1) means Termux itself hit no error.
              "err" to (result?.getInt("err", -1) ?: -1),
              "errmsg" to result?.getString("errmsg"),
            )
          )
        }
      }
    // Termux sends the PendingIntent on this app's behalf, so a non-exported receiver gets it.
    ContextCompat.registerReceiver(
      context,
      receiver,
      IntentFilter(action),
      null,
      mainHandler,
      ContextCompat.RECEIVER_NOT_EXPORTED,
    )
    val resultIntent = Intent(action).setPackage(context.packageName)
    val flags =
      PendingIntent.FLAG_ONE_SHOT or
        (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
    val pendingIntent = PendingIntent.getBroadcast(context, requestCode, resultIntent, flags)
    try {
      startTermuxService(
        context,
        runCommandIntent(arguments, background = true)
          .putExtra(EXTRA_PENDING_INTENT, pendingIntent),
      )
    } catch (error: CodedException) {
      settled = true
      unregister(context, receiver)
      promise.reject(error)
      return
    }
    mainHandler.postDelayed(timeout, timeoutMs)
  }

  private fun runCommandIntent(arguments: List<String>, background: Boolean): Intent =
    Intent("com.termux.RUN_COMMAND")
      .setClassName(TERMUX_PACKAGE, RUN_COMMAND_SERVICE)
      .putExtra(EXTRA_COMMAND_PATH, TERMUX_BASH)
      .putExtra(EXTRA_ARGUMENTS, arguments.toTypedArray())
      .putExtra(EXTRA_WORKDIR, TERMUX_HOME)
      // Termux before 0.119 reads only the boolean; later versions prefer the runner.
      .putExtra(EXTRA_BACKGROUND, background)
      .putExtra(EXTRA_RUNNER, if (background) "app-shell" else "terminal-session")

  private fun startTermuxService(context: Context, intent: Intent) {
    val component =
      runCatching {
        // RunCommandService calls startForeground itself, as Android 8+ requires.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
      }.getOrElse { throw startFailure(it) }
    if (component == null) {
      throw CodedException("ERR_TERMUX_MISSING", "Termux isn't installed.", null)
    }
  }

  private fun startFailure(error: Throwable): Throwable =
    when (error) {
      is SecurityException ->
        CodedException(
          "ERR_TERMUX_PERMISSION",
          "T3 Code isn't allowed to run commands in Termux.",
          error,
        )
      is IllegalStateException ->
        CodedException("ERR_TERMUX_START", "Android didn't let Termux start.", error)
      else -> error
    }

  private fun unregister(context: Context, receiver: BroadcastReceiver) {
    try {
      context.unregisterReceiver(receiver)
    } catch (_: IllegalArgumentException) {
    }
  }

  private fun startActivity(context: Context, intent: Intent): Boolean =
    try {
      context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      true
    } catch (_: ActivityNotFoundException) {
      false
    }

  private fun installerOf(packageManager: PackageManager): String? =
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        packageManager.getInstallSourceInfo(TERMUX_PACKAGE).installingPackageName
      } else {
        @Suppress("DEPRECATION")
        packageManager.getInstallerPackageName(TERMUX_PACKAGE)
      }
    } catch (_: Exception) {
      null
    }

  private fun readGlobalSetting(context: Context, name: String): String? =
    try {
      Settings.Global.getString(context.contentResolver, name)
    } catch (_: SecurityException) {
      null
    }
}
