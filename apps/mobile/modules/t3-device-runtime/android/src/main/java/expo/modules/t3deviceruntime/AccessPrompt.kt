package expo.modules.t3deviceruntime

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

private const val EXTRA_CATEGORY = "category"
private const val PROMPT_TIMEOUT_SECONDS = 60L

/** Shows Android's permission prompt for a category an agent just used, and waits for the answer. */
internal object AccessPrompt {
  private val pending = ConcurrentHashMap<String, CompletableFuture<Boolean>>()

  /** Whether the user allowed it. Needs T3 Code on screen, as Android only prompts over an app in use. */
  fun request(context: Context, category: AccessCategory): Boolean {
    val future = CompletableFuture<Boolean>()
    val answer = pending.putIfAbsent(category.id, future) ?: future.also {
      try {
        context.startActivity(intent(context, category))
      } catch (error: Exception) {
        pending.remove(category.id, future)
        throw error
      }
    }
    return try {
      answer.get(PROMPT_TIMEOUT_SECONDS, TimeUnit.SECONDS)
    } catch (error: TimeoutException) {
      pending.remove(category.id, answer)
      throw BridgeError("Nobody answered Android's ${category.label} prompt on the phone.", 403)
    }
  }

  fun intent(context: Context, category: AccessCategory): Intent =
    Intent(context, AccessPromptActivity::class.java)
      .putExtra(EXTRA_CATEGORY, category.id)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

  fun answered(id: String, granted: Boolean) {
    pending.remove(id)?.complete(granted)
  }
}

/** A see-through activity that only asks for a category's permissions, over whatever is on screen. */
class AccessPromptActivity : Activity() {
  private var category: AccessCategory? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    category = intent.getStringExtra(EXTRA_CATEGORY)?.let(AgentAccess::category)
    val permissions = category?.permissions.orEmpty()
    if (permissions.isEmpty()) return finish()
    // A fold or rotation recreates the activity; Android delivers the open prompt's answer to it.
    if (savedInstanceState == null) requestPermissions(permissions.toTypedArray(), 0)
  }

  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
    category?.let { category ->
      AccessPrompt.answered(
        category.id,
        grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED },
      )
    }
    finish()
  }

  override fun onDestroy() {
    // Closed without an answer, such as by Back before the prompt appeared.
    if (isFinishing) category?.let { AccessPrompt.answered(it.id, AgentAccess.granted(this, it)) }
    super.onDestroy()
  }
}
