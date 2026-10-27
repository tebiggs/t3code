package expo.modules.t3deviceruntime

import android.content.Context
import android.net.TrafficStats
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Process as AndroidProcess
import android.os.SystemClock
import android.util.Log
import android.view.WindowManager
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

private const val TAG = "T3DeviceRuntime"
private const val LOG_LIMIT = 4000

private data class PrototypeStep(val id: String, val title: String)

// Phase 1 of the on-device runtime: proves each layer on a real phone and measures it.
private val PROTOTYPE_STEPS = listOf(
  PrototypeStep("ubuntu", "Download and extract Ubuntu base"),
  PrototypeStep("proot", "Start proot from the native library directory"),
  PrototypeStep("uname", "Run uname -a inside Ubuntu"),
  PrototypeStep("ca-certificates", "apt-get update and install ca-certificates"),
  PrototypeStep("essentials", "Install git, curl, openssh-client and ripgrep"),
  PrototypeStep("node", "Install Node.js from nodejs.org"),
  PrototypeStep("claude-code", "Install Claude Code from Anthropic's apt repository"),
  PrototypeStep("versions", "node --version and claude --version"),
)

class T3DeviceRuntimeModule : Module() {
  private val executor = Executors.newSingleThreadExecutor()
  private val mainHandler = Handler(Looper.getMainLooper())
  private val log = ArrayDeque<String>()
  private val pendingLines = ArrayList<String>()
  private var flushScheduled = false
  @Volatile private var activeRuntime: DeviceRuntime? = null
  @Volatile private var state: Map<String, Any?> = mapOf("running" to false)

  override fun definition() = ModuleDefinition {
    Name("T3DeviceRuntime")
    Events("onLog", "onState")

    Function("getStatus") {
      val context = requireContext()
      val probe = DeviceRuntime(context) {}
      state + mapOf(
        "supported" to probe.supported,
        "ubuntuInstalled" to probe.ubuntuInstalled,
        "log" to synchronized(log) { log.toList() },
      )
    }

    Function("startPrototype") {
      val context = requireContext()
      val created = DeviceRuntime(context, ::appendLog)
      synchronized(this@T3DeviceRuntimeModule) {
        if (activeRuntime != null) return@Function false
        activeRuntime = created
      }
      synchronized(log) { log.clear() }
      setKeepScreenOn(true)
      executor.execute { runPrototype(context, created) }
      true
    }

    Function("cancel") { activeRuntime?.cancel() }

    AsyncFunction("reset") {
      val context = requireContext()
      if (activeRuntime != null) throw CodedException("RUNNING", "Stop the prototype before resetting.", null)
      DeviceRuntime(context) {}.reset()
    }
  }

  private fun requireContext(): Context =
    appContext.reactContext ?: throw CodedException("NO_CONTEXT", "The React context isn't ready.", null)

  private fun runPrototype(context: Context, runtime: DeviceRuntime) {
    val script = context.assets.open("device-runtime-setup.sh").bufferedReader().readText()
    val results = JSONArray()
    val started = SystemClock.elapsedRealtime()
    var failure: String? = null
    try {
      for (step in PROTOTYPE_STEPS) {
        setState(mapOf("running" to true, "step" to step.id, "stepTitle" to step.title))
        appendLog("@@ ${step.title}")
        val rxBefore = TrafficStats.getUidRxBytes(AndroidProcess.myUid())
        val stepStarted = SystemClock.elapsedRealtime()
        val exitCode = when (step.id) {
          "ubuntu" -> { runtime.installUbuntu(); 0 }
          "proot" -> runDirect(runtime.proot.path, "--version")
          "uname" -> runtime.run(listOf("/bin/sh", "-c", "uname -a; . /etc/os-release; echo \"\$PRETTY_NAME\""))
          "claude-code" -> {
            runtime.installClaudeKey()
            runtime.run(listOf("/bin/bash", "-s", "--", step.id), stdin = script)
          }
          else -> runtime.run(listOf("/bin/bash", "-s", "--", step.id), stdin = script)
        }
        val result = JSONObject()
          .put("id", step.id)
          .put("title", step.title)
          .put("seconds", (SystemClock.elapsedRealtime() - stepStarted) / 1000.0)
          .put("downloadedBytes", TrafficStats.getUidRxBytes(AndroidProcess.myUid()) - rxBefore)
          .put("exitCode", exitCode)
        if (runtime.rootfs.isDirectory) result.put("rootfsBytes", runtime.guestSize("/"))
        results.put(result)
        appendLog("@@ ${step.id}: exit $exitCode in ${result.getDouble("seconds")} s, " +
          "downloaded ${megabytes(result.getLong("downloadedBytes"))}, " +
          "rootfs ${megabytes(result.optLong("rootfsBytes"))}")
        if (exitCode != 0) {
          failure = "${step.title} exited with status $exitCode"
          break
        }
      }
    } catch (error: RuntimeCancelled) {
      failure = "Cancelled"
    } catch (error: Throwable) {
      Log.e(TAG, "Prototype failed", error)
      failure = "${error.javaClass.simpleName}: ${error.message}"
    }
    val report = JSONObject()
      .put("device", "${Build.MANUFACTURER} ${Build.MODEL}")
      .put("android", "${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
      .put("targetSdk", context.applicationInfo.targetSdkVersion)
      .put("kernel", System.getProperty("os.version"))
      .put("totalSeconds", (SystemClock.elapsedRealtime() - started) / 1000.0)
      .put("failure", failure)
      .put("steps", results)
    if (runtime.rootfs.isDirectory) {
      report.put("sizes", JSONObject().apply {
        for (path in listOf("/", "/usr", "/opt/node", "/usr/bin/claude", "/var/lib/apt/lists", "/var/cache/apt")) {
          put(path, runtime.guestSize(path))
        }
      })
    }
    appendLog("@@ report ${report.toString(2)}")
    writeReport(context, runtime, report)
    synchronized(this) { activeRuntime = null }
    setKeepScreenOn(false)
    setState(mapOf("running" to false, "failure" to failure, "report" to report.toString()))
  }

  // Runs a native-library-directory binary directly, outside the guest.
  private fun runDirect(vararg command: String): Int {
    val process = ProcessBuilder(*command).redirectErrorStream(true).start()
    process.inputStream.bufferedReader().useLines { lines -> lines.forEach(::appendLog) }
    return process.waitFor()
  }

  private fun writeReport(context: Context, runtime: DeviceRuntime, report: JSONObject) {
    val text = report.toString(2)
    val lines = synchronized(log) { log.joinToString("\n") }
    runCatching { File(runtime.home.apply { mkdirs() }, "prototype-report.json").writeText(text) }
    // Readable over adb without a debuggable build.
    context.getExternalFilesDir(null)?.let { dir ->
      runCatching {
        File(dir, "device-runtime-report.json").writeText(text)
        File(dir, "device-runtime.log").writeText(lines)
      }
    }
  }

  private fun appendLog(line: String) {
    Log.i(TAG, line)
    synchronized(log) {
      log.addLast(line)
      while (log.size > LOG_LIMIT) log.removeFirst()
      pendingLines.add(line)
      if (flushScheduled) return
      flushScheduled = true
    }
    mainHandler.postDelayed(::flushLog, 250)
  }

  private fun flushLog() {
    val lines = synchronized(log) {
      flushScheduled = false
      pendingLines.toList().also { pendingLines.clear() }
    }
    if (lines.isNotEmpty()) sendEvent("onLog", mapOf("lines" to lines))
  }

  private fun setState(next: Map<String, Any?>) {
    state = next
    mainHandler.post { sendEvent("onState", next) }
  }

  // The app's processes, proot's included, freeze once it leaves the screen.
  private fun setKeepScreenOn(on: Boolean) {
    mainHandler.post {
      val window = appContext.currentActivity?.window ?: return@post
      if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
  }
}
