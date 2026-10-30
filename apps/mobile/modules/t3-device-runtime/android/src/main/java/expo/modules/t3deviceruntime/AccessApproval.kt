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
private const val EXTRA_TITLE = "title"
private const val EXTRA_MESSAGE = "message"
private const val APPROVAL_TIMEOUT_SECONDS = 60L
private const val DETAILS_LIMIT = 600

/** A command's arguments, as the user approves them: the number to call, the text to send. */
internal fun approvalDetails(body: JSONObject): String {
  val details = body.keys().asSequence().joinToString("\n") { key -> "$key: ${body.opt(key)}" }
  if (details.length <= DETAILS_LIMIT) return details
  return "${details.take(DETAILS_LIMIT)}… (${details.length - DETAILS_LIMIT} more characters)"
}

/**
 * One prompt per request, so an answer can't also cover a command the user never saw. Answers
 * only ever come from AccessApprovalActivity, which nothing outside this app can start.
 */
internal object AccessApproval {
  private val pending = ConcurrentHashMap<String, CompletableFuture<Boolean>>()

  /** Whether the user allowed it. Nobody answering in time counts as no. */
  fun request(
    context: Context,
    category: AccessCategory,
    command: String,
    details: String,
    show: (Intent) -> Unit,
    dismiss: () -> Unit,
  ): Boolean {
    val id = UUID.randomUUID().toString()
    val answer = CompletableFuture<Boolean>()
    pending[id] = answer
    try {
      show(intent(context, id, category, command, details))
      return answer.get(APPROVAL_TIMEOUT_SECONDS, TimeUnit.SECONDS)
    } catch (error: TimeoutException) {
      throw BridgeError("Nobody answered T3 Code's ${category.label} prompt on the phone.", 403)
    } finally {
      pending.remove(id)
      // Closes a prompt that's still open, so a late tap can't look like it counted.
      answer.complete(false)
      dismiss()
    }
  }

  fun answer(id: String, allowed: Boolean) {
    pending[id]?.complete(allowed)
  }

  /** Runs once the request ends, or at once when it already has, as for an old notification. */
  fun whenEnded(id: String, action: () -> Unit) {
    val answer = pending[id]
    if (answer == null) action() else answer.whenComplete { _, _ -> action() }
  }

  private fun intent(
    context: Context,
    id: String,
    category: AccessCategory,
    command: String,
    details: String,
  ): Intent {
    val message = buildString {
      append("termux-$command")
      if (details.isNotEmpty()) append("\n\n$details")
      append("\n\nAn agent or another device using this phone's server asked for this.")
    }
    return Intent(context, AccessApprovalActivity::class.java)
      // A distinct intent per request: Android would otherwise reuse a waiting prompt's.
      .setData(Uri.parse("t3-access://$id"))
      .putExtra(EXTRA_REQUEST, id)
      .putExtra(EXTRA_TITLE, "Allow ${category.label}?")
      .putExtra(EXTRA_MESSAGE, message)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
  }
}

/** A see-through activity holding one approval dialog, over whatever is on screen. */
class AccessApprovalActivity : Activity() {
  private var request: String? = null
  private var dialog: AlertDialog? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val id = intent.getStringExtra(EXTRA_REQUEST) ?: return finish()
    request = id
    val shown = AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
      .setTitle(intent.getStringExtra(EXTRA_TITLE))
      .setMessage(intent.getStringExtra(EXTRA_MESSAGE))
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
