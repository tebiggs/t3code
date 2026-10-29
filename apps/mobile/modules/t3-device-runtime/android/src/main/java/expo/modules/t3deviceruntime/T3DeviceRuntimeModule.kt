package expo.modules.t3deviceruntime

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.util.concurrent.Executors

private const val LOG_LIMIT = 2000

private data class JobStep(val id: String, val title: String)

private val INSTALL_STEPS = listOf(
  JobStep("ubuntu", "Downloading Ubuntu"),
  JobStep("packages", "Installing Ubuntu packages"),
  JobStep("node", "Installing Node.js"),
  JobStep("claude-code", "Installing Claude Code"),
  JobStep("t3", "Installing T3 Code"),
  JobStep("cleanup", "Cleaning up"),
)

private val UPDATE_STEPS = listOf(
  JobStep("t3", "Updating T3 Code"),
  JobStep("upgrade-claude-code", "Updating Claude Code"),
  JobStep("cleanup", "Cleaning up"),
)

class RuntimeJobFailed(message: String) : CodedException("ERR_DEVICE_RUNTIME_JOB", message, null)

class T3DeviceRuntimeModule : Module() {
  private val jobs = Executors.newSingleThreadExecutor()
  private val work = Executors.newCachedThreadPool()
  private val mainHandler = Handler(Looper.getMainLooper())
  private val jobLog = ArrayDeque<String>()
  @Volatile private var activeJob: DeviceRuntime? = null
  @Volatile private var jobState: Map<String, Any?>? = null
  @Volatile private var login: ClaudeLogin? = null
  @Volatile private var loginState: Map<String, Any?>? = null

  override fun definition() = ModuleDefinition {
    Name("T3DeviceRuntime")
    Events("onJob", "onLogin")

    Function("getStatus") {
      val runtime = DeviceRuntime(requireContext()) {}
      mapOf(
        "supported" to runtime.supported,
        "storageAccess" to hasStorageAccess(requireContext()),
        "installed" to installedMarker(runtime).isFile,
        "serverRunning" to DeviceServer.running,
        "job" to jobState,
        "login" to loginState,
      )
    }

    // Android 11+ grants phone storage only as All files access, from system settings.
    Function("openStorageSettings") {
      val context = requireContext()
      val intent = Intent(
        Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
        Uri.parse("package:${context.packageName}"),
      ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      runCatching { (appContext.currentActivity ?: context).startActivity(intent) }
        .recoverCatching {
          context.startActivity(
            Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
          )
        }
    }

    Function("getAgentAccess") {
      val context = requireContext()
      AgentAccess.categories.map { category ->
        mapOf(
          "id" to category.id,
          "policy" to AgentAccess.policy(context, category).id,
          "granted" to AgentAccess.granted(context, category),
          "permissions" to category.permissions,
        )
      }
    }

    Function("setAgentAccess") { id: String, policy: String ->
      try {
        AgentAccess.setPolicy(requireContext(), id, policy)
      } catch (error: IllegalArgumentException) {
        throw CodedException("ERR_AGENT_ACCESS", error.message ?: "Invalid agent access", error)
      }
    }

    Function("openNotificationAccessSettings") {
      val context = requireContext()
      val intent = AgentAccess.notificationAccessIntent(context)
      runCatching { (appContext.currentActivity ?: context).startActivity(intent) }
        .recoverCatching {
          context.startActivity(
            Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
          )
        }
    }

    Function("openDeveloperSettings") {
      val context = requireContext()
      val intent = Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      runCatching { (appContext.currentActivity ?: context).startActivity(intent) }
        .recoverCatching { context.startActivity(Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }

    AsyncFunction("install") { promise: Promise ->
      val context = requireContext()
      val deviceName = Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)
        ?.takeIf { it.isNotBlank() } ?: Build.MODEL
      startJob(context, "install", INSTALL_STEPS, promise) { runtime, step, script ->
        when (step.id) {
          "ubuntu" -> {
            runtime.installUbuntu()
            runtime.writeMachineInfo(deviceName)
            0
          }
          "claude-code" -> {
            runtime.installClaudeKey()
            runtime.run(listOf("/bin/bash", "-s", "--", step.id), stdin = script)
          }
          else -> runtime.run(listOf("/bin/bash", "-s", "--", step.id), stdin = script)
        }
      }
    }

    // The server keeps running its old build until the app restarts it.
    AsyncFunction("update") { promise: Promise ->
      val context = requireContext()
      if (!installedMarker(DeviceRuntime(context) {}).isFile) {
        throw CodedException("ERR_DEVICE_RUNTIME_MISSING", "The on-device runtime isn't installed.", null)
      }
      startJob(context, "update", UPDATE_STEPS, promise) { runtime, step, script ->
        if (step.id == "upgrade-claude-code") runtime.installClaudeKey()
        runtime.run(listOf("/bin/bash", "-s", "--", step.id), stdin = script)
      }
    }

    Function("cancelJob") { activeJob?.cancel() }

    Function("getJobLog") { synchronized(jobLog) { jobLog.toList() } }

    AsyncFunction("inspect") { promise: Promise ->
      val context = requireContext()
      inBackground(promise) {
        val runtime = DeviceRuntime(context) {}
        val script = context.assets.open("device-runtime-setup.sh").bufferedReader().readText()
        val (code, output) = runtime.capture(listOf("/bin/bash", "-s", "--", "status"), stdin = script)
        if (code != 0) throw RuntimeJobFailed(output.trim().lines().takeLast(3).joinToString("\n"))
        output.lines().mapNotNull { line ->
          val separator = line.indexOf('=')
          if (separator <= 0) null else line.substring(0, separator) to line.substring(separator + 1).trim()
        }.toMap()
      }
    }

    Function("startServer") { port: Int -> DeviceServer.start(requireContext(), port) }

    AsyncFunction("stopServer") { promise: Promise ->
      inBackground(promise) { DeviceServer.stop() }
    }

    Function("serverLog") { lines: Int ->
      val log = DeviceServer.logFile(requireContext())
      if (log.isFile) log.readLines().takeLast(lines).joinToString("\n") else ""
    }

    AsyncFunction("pair") { promise: Promise ->
      val context = requireContext()
      inBackground(promise) {
        val (_, output) = DeviceRuntime(context) {}
          .capture(listOf("t3", "pair", "--label", "T3 Code app on this phone"))
        output.lines().map { it.trim() }.firstOrNull { it.startsWith("Pairing URL: ") }
          ?.removePrefix("Pairing URL: ")
          ?: throw RuntimeJobFailed(output.trim().ifEmpty { "T3 Code didn't give a pairing link." })
      }
    }

    Function("startLogin") {
      val context = requireContext()
      if (login?.running == true) return@Function null
      val created = ClaudeLogin(DeviceRuntime(context) {}, ::openUrl) { state ->
        Log.i(TAG, "Claude sign-in: ${state["state"]}")
        if (state["state"] in setOf("done", "cancelled", "failed")) RuntimeForeground.release(Hold.Login)
        loginState = state
        mainHandler.post { sendEvent("onLogin", state) }
      }
      login = created
      // The browser takes the screen while the user signs in; Claude has to keep running.
      RuntimeForeground.hold(context, Hold.Login, "Signing in to Claude…")
      try {
        created.start()
      } catch (error: Throwable) {
        RuntimeForeground.release(Hold.Login)
        throw error
      }
    }

    Function("submitLoginCode") { code: String -> login?.submitCode(code) }

    Function("cancelLogin") { login?.cancel() }

    AsyncFunction("logout") { promise: Promise ->
      val context = requireContext()
      inBackground(promise) { DeviceRuntime(context) {}.capture(listOf("claude", "auth", "logout")).first }
    }

    // Stops the server and deletes Ubuntu with everything in it, then turns the runtime off.
    AsyncFunction("remove") { promise: Promise ->
      val context = requireContext()
      if (activeJob != null) throw CodedException("ERR_DEVICE_RUNTIME_BUSY", "Wait for setup to finish first.", null)
      inBackground(promise) {
        login?.cancel()
        DeviceServer.stop()
        DeviceRuntime(context) {}.remove()
        jobState = null
        loginState = null
      }
    }
  }

  private fun requireContext(): Context =
    appContext.reactContext ?: throw CodedException("ERR_NO_CONTEXT", "The React context isn't ready.", null)

  private fun installedMarker(runtime: DeviceRuntime) = File(runtime.home, "setup.done")

  private fun <T> inBackground(promise: Promise, body: () -> T) {
    work.execute {
      try {
        val result = body()
        promise.resolve(if (result == Unit) null else result)
      } catch (error: CodedException) {
        promise.reject(error)
      } catch (error: Throwable) {
        promise.reject(CodedException("ERR_DEVICE_RUNTIME", error.message ?: error.javaClass.simpleName, error))
      }
    }
  }

  private fun startJob(
    context: Context,
    kind: String,
    steps: List<JobStep>,
    promise: Promise,
    runStep: (DeviceRuntime, JobStep, String) -> Int,
  ) {
    val runtime = DeviceRuntime(context, ::appendLog)
    synchronized(this) {
      if (activeJob != null) throw CodedException("ERR_DEVICE_RUNTIME_BUSY", "Setup or an update is already running.", null)
      activeJob = runtime
    }
    synchronized(jobLog) { jobLog.clear() }
    // Held from here, while T3 Code is on screen: Android won't start it from the background.
    RuntimeForeground.hold(context, Hold.Job, "Starting…")
    jobs.execute {
      var failure: String? = null
      try {
        val script = context.assets.open("device-runtime-setup.sh").bufferedReader().readText()
        for ((index, step) in steps.withIndex()) {
          setJobState(kind, true, step, index, steps.size, null)
          appendLog("@@ ${step.title}")
          val code = runStep(runtime, step, script)
          if (code != 0) {
            val tail = synchronized(jobLog) { jobLog.filterNot { it.startsWith("@@") }.takeLast(4) }
            failure = "${step.title} failed (exit $code).\n${tail.joinToString("\n")}".trim()
            break
          }
        }
        if (failure == null && kind == "install") installedMarker(runtime).writeText("")
      } catch (error: RuntimeCancelled) {
        failure = "Cancelled."
      } catch (error: Throwable) {
        Log.e(TAG, "$kind failed", error)
        failure = error.message ?: error.javaClass.simpleName
      }
      synchronized(this) { activeJob = null }
      RuntimeForeground.release(Hold.Job)
      setJobState(kind, false, null, steps.size, steps.size, failure)
      if (failure == null) promise.resolve(null) else promise.reject(RuntimeJobFailed(failure))
    }
  }

  private fun setJobState(kind: String, running: Boolean, step: JobStep?, index: Int, count: Int, error: String?) {
    if (running && step != null) {
      val context = appContext.reactContext
      if (context != null) RuntimeForeground.hold(context, Hold.Job, "${step.title} (step ${index + 1} of $count)…")
    }
    val state = mapOf(
      "kind" to kind,
      "running" to running,
      "step" to step?.id,
      "stepTitle" to step?.title,
      "stepNumber" to index + 1,
      "stepCount" to count,
      "error" to error,
    )
    jobState = state
    mainHandler.post { sendEvent("onJob", state) }
  }

  private fun appendLog(line: String) {
    Log.i(TAG, line)
    synchronized(jobLog) {
      jobLog.addLast(line)
      while (jobLog.size > LOG_LIMIT) jobLog.removeFirst()
    }
  }

  private fun openUrl(url: String) {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    mainHandler.post {
      runCatching { (appContext.currentActivity ?: requireContext()).startActivity(intent) }
        .onFailure { Log.w(TAG, "Couldn't open the sign-in page", it) }
    }
  }
}
