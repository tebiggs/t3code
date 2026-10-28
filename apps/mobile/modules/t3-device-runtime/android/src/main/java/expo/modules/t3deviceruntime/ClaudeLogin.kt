package expo.modules.t3deviceruntime

import java.io.File
import java.io.IOException

private val MANUAL_URL = Regex("""visit:\s*(https://\S+)""")
private const val BROWSER_WAIT_MS = 3_000L
private const val POLL_MS = 250L

/**
 * `claude auth login` inside the runtime. Claude hands its sign-in URL to $BROWSER, which
 * leaves it in a file for the app to open; the browser then returns to Claude's localhost
 * callback. When that doesn't happen, Claude's printed URL ends on a code to paste back.
 */
class ClaudeLogin(
  private val runtime: DeviceRuntime,
  private val openUrl: (String) -> Unit,
  private val onState: (Map<String, Any?>) -> Unit,
) {
  @Volatile private var guest: GuestProcess? = null
  @Volatile private var cancelled = false

  val running: Boolean
    get() = guest?.process?.isAlive == true

  fun start() {
    runtime.writeOpenUrlCommand()
    val urlFile = runtime.openUrlFile.apply { delete() }
    val started = runtime.start(
      listOf("claude", "auth", "login"),
      mapOf("BROWSER" to "/usr/local/bin/t3-open-url", "IS_SANDBOX" to "1"),
    )
    guest = started
    onState(mapOf("state" to "starting"))
    Thread({ watchOutput(started, urlFile) }, "t3-claude-login").start()
  }

  fun submitCode(code: String) {
    val input = guest?.process?.outputStream ?: return
    input.write((code.trim() + "\n").toByteArray())
    input.flush()
  }

  fun cancel() {
    cancelled = true
    guest?.terminate()
  }

  private fun watchOutput(guestProcess: GuestProcess, urlFile: File) {
    val started = guestProcess.process
    val output = StringBuilder()
    var manualUrl: String? = null
    var opened = false
    val startedAt = System.currentTimeMillis()
    val stream = started.inputStream
    val buffer = ByteArray(4096)
    // A forced stop can close the output under this loop.
    try {
      while (true) {
        if (!opened && urlFile.isFile) {
          opened = true
          openUrl(urlFile.readText().trim())
          onState(mapOf("state" to "browser", "manualUrl" to manualUrl))
        }
        if (stream.available() > 0) {
          val count = stream.read(buffer)
          if (count < 0) break
          output.append(String(buffer, 0, count))
          if (manualUrl == null) {
            manualUrl = MANUAL_URL.find(output)?.groupValues?.get(1)
            if (manualUrl != null && opened) onState(mapOf("state" to "browser", "manualUrl" to manualUrl))
          }
        } else if (!started.isAlive) {
          break
        } else {
          // Without a usable $BROWSER, Claude only prints the URL that ends on a code.
          if (!opened && manualUrl != null && System.currentTimeMillis() - startedAt > BROWSER_WAIT_MS) {
            opened = true
            openUrl(manualUrl)
            onState(mapOf("state" to "browser", "manualUrl" to manualUrl))
          }
          Thread.sleep(POLL_MS)
        }
      }
    } catch (ignored: IOException) {
    }
    val code = started.waitFor()
    guestProcess.cleanUp()
    guest = null
    urlFile.delete()
    if (code == 0) {
      onState(mapOf("state" to "done"))
    } else if (cancelled) {
      onState(mapOf("state" to "cancelled"))
    } else {
      val tail = output.lines().map { it.trim() }.filter { it.isNotEmpty() }.takeLast(3).joinToString("\n")
      onState(mapOf("state" to "failed", "message" to tail.ifEmpty { "Sign-in exited with status $code." }))
    }
  }
}
