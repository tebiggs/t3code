package expo.modules.t3deviceruntime

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.DialogInterface
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

private const val EXTRA_REQUEST = "request"
private const val APPROVAL_TIMEOUT_SECONDS = 60L
private const val DETAILS_LIMIT = 4000
private const val MAX_WAITING = 4

private val INVISIBLE = Regex("[\\u061C\\u200B-\\u200F\\u2028-\\u202E\\u2060-\\u206F\\uFEFF]")

/**
 * A command's whole request, as the user approves it. JSON escapes newlines and control
 * characters; the rest that could hide or reorder text gets escaped here. A dialog scrolls, so
 * nothing is cut: a request too long to read is refused, since nobody could approve it.
 */
internal fun approvalDetails(body: JSONObject): String {
  if (body.length() == 0) return ""
  val details = body.toString(2).replace(INVISIBLE) { "\\u%04X".format(it.value[0].code) }
  if (details.length > DETAILS_LIMIT) throw BridgeError("This request is too long to show on the phone for approval.", 413)
  return details
}

private class WaitingApproval(val title: String, val message: String, val answer: CompletableFuture<Boolean>)

/**
 * One prompt per request, so an answer can't also cover a command the user never saw. What the
 * prompt shows stays in this process, keyed by a random id, so a same-UID caller that starts the
 * activity can't change what the user reads, and only a tap on its dialog can answer.
 */
internal object AccessApproval {
  private val pending = ConcurrentHashMap<String, WaitingApproval>()

  /** Whether the user allowed it. Nobody answering in time counts as no. */
  fun request(
    context: Context,
    category: AccessCategory,
    command: String,
    details: String,
    show: (Intent) -> Unit,
    dismiss: () -> Unit,
  ): Boolean {
    // Requests wait on bridge connections, which unrelated commands need too.
    if (pending.size >= MAX_WAITING) throw BridgeError("Too many requests are waiting for an answer on the phone.", 429)
    val id = UUID.randomUUID().toString()
    val message = buildString {
      append("termux-$command")
      if (details.isNotEmpty()) append("\n\n$details")
      append("\n\nAn agent or another device using this phone's server asked for this.")
    }
    val waiting = WaitingApproval("Allow ${category.label}?", message, CompletableFuture())
    pending[id] = waiting
    try {
      show(
        Intent(context, AccessApprovalActivity::class.java)
          // A distinct intent per request: Android would otherwise reuse a waiting prompt's.
          .setData(Uri.parse("t3-access://$id"))
          .putExtra(EXTRA_REQUEST, id)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      )
      return waiting.answer.get(APPROVAL_TIMEOUT_SECONDS, TimeUnit.SECONDS)
    } catch (error: TimeoutException) {
      throw BridgeError("Nobody answered T3 Code's ${category.label} prompt on the phone.", 403)
    } finally {
      pending.remove(id)
      // Closes a prompt that's still open, so a late tap can't look like it counted.
      waiting.answer.complete(false)
      dismiss()
    }
  }

  fun prompt(id: String): Pair<String, String>? = pending[id]?.let { it.title to it.message }

  fun answer(id: String, allowed: Boolean) {
    pending[id]?.answer?.complete(allowed)
  }

  /** Runs once the request ends, or at once when it already has, as for an old notification. */
  fun whenEnded(id: String, action: () -> Unit) {
    val waiting = pending[id]
    if (waiting == null) action() else waiting.answer.whenComplete { _, _ -> action() }
  }
}

/** A see-through activity holding one approval dialog, over whatever is on screen. */
class AccessApprovalActivity : Activity() {
  private var request: String? = null
  private var dialog: AlertDialog? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val id = intent.getStringExtra(EXTRA_REQUEST) ?: return finish()
    val (title, message) = AccessApproval.prompt(id) ?: return finish()
    request = id
    val shown = AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
      .setTitle(title)
      .setMessage(message)
      .setPositiveButton("Allow") { _, _ -> answer(true) }
      .setNegativeButton("Don't allow") { _, _ -> answer(false) }
      .setOnCancelListener { answer(false) }
      .create()
    shown.setCanceledOnTouchOutside(false)
    shown.show()
    // Another app's overlay shouldn't be able to trick the user into tapping Allow.
    shown.getButton(DialogInterface.BUTTON_POSITIVE).filterTouchesWhenObscured = true
    dialog = shown
    AccessApproval.whenEnded(id) { runOnUiThread { if (!isFinishing) finish() } }
  }

  private fun answer(allowed: Boolean) {
    request?.let { AccessApproval.answer(it, allowed) }
    finish()
  }

  override fun onDestroy() {
    dialog?.dismiss()
    // Closed without an answer. A fold or rotation only recreates it, and it asks again.
    if (isFinishing) request?.let { AccessApproval.answer(it, false) }
    super.onDestroy()
  }
}
