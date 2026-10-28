package expo.modules.t3deviceruntime

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.service.notification.NotificationListenerService
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.nio.file.Files

private const val PREFERENCES = "t3-agent-access"
private const val MANAGED_SETTINGS = "etc/claude-code/managed-settings.json"
internal const val ACCESS_SETTINGS = "Run on this phone > Agent access"
private const val NOTIFICATIONS = "notifications"

enum class AccessPolicy(val id: String) {
  Ask("ask"),
  Allow("allow"),
  Deny("deny"),
}

/** Phone data or hardware behind its own policy, with the bridge commands that reach it. */
class AccessCategory(val id: String, val label: String, val commands: List<String>, val permissions: List<String>)

/**
 * The user's policy per category. Claude Code enforces it through managed settings in the
 * guest: ask rules prompt even in bypassPermissions mode, and T3 shows the prompt in the
 * thread. A rule only matches how a command is written, so the bridge refuses denied ones too.
 */
object AgentAccess {
  val categories = listOf(
    AccessCategory(
      "location",
      "Location",
      listOf("location", "telephony-cellinfo"),
      listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
    ),
    AccessCategory("camera", "Camera", listOf("camera-photo"), listOf(Manifest.permission.CAMERA)),
    AccessCategory("microphone", "Microphone", listOf("microphone-record"), listOf(Manifest.permission.RECORD_AUDIO)),
    AccessCategory("contacts", "Contacts", listOf("contact-list"), listOf(Manifest.permission.READ_CONTACTS)),
    AccessCategory(
      "sms",
      "SMS",
      listOf("sms-list", "sms-send"),
      listOf(Manifest.permission.READ_SMS, Manifest.permission.SEND_SMS),
    ),
    AccessCategory("call-log", "Call log", listOf("call-log"), listOf(Manifest.permission.READ_CALL_LOG)),
    AccessCategory(
      "phone",
      "Phone",
      listOf("telephony-call", "telephony-deviceinfo"),
      listOf(Manifest.permission.CALL_PHONE, Manifest.permission.READ_PHONE_STATE),
    ),
    // Notification access is a special permission, granted in system settings.
    AccessCategory(NOTIFICATIONS, "Notifications", listOf("notification-list"), emptyList()),
  )

  fun category(id: String): AccessCategory? = categories.firstOrNull { it.id == id }

  fun policy(context: Context, category: AccessCategory): AccessPolicy {
    val stored = preferences(context).getString(category.id, null)
    return AccessPolicy.entries.firstOrNull { it.id == stored } ?: AccessPolicy.Ask
  }

  fun setPolicy(context: Context, id: String, policy: String) {
    val category = category(id) ?: throw IllegalArgumentException("Unknown agent access category: $id")
    val parsed = AccessPolicy.entries.firstOrNull { it.id == policy }
      ?: throw IllegalArgumentException("Agent access is ask, allow or deny, not $policy")
    preferences(context).edit().putString(category.id, parsed.id).apply()
    val rootfs = DeviceRuntime(context) {}.rootfs
    if (rootfs.isDirectory) writeManagedSettings(context, rootfs)
  }

  fun granted(context: Context, category: AccessCategory): Boolean =
    if (category.id == NOTIFICATIONS) {
      NotificationManagerCompat.getEnabledListenerPackages(context).contains(context.packageName)
    } else {
      category.permissions.all { context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }
    }

  /** Turns a command down when the user denied its category or Android hasn't granted it. */
  fun check(context: Context, command: String) {
    val category = categories.firstOrNull { command in it.commands } ?: return
    if (policy(context, category) == AccessPolicy.Deny) {
      throw BridgeError("${category.label} is set to Never for agents in $ACCESS_SETTINGS.", 403)
    }
    if (!granted(context, category)) throw BridgeError("Allow ${category.label} in $ACCESS_SETTINGS.", 403)
  }

  /** Whether agents may read this category's data as a side detail of another command's output. */
  fun allowed(context: Context, id: String): Boolean {
    val category = category(id) ?: return false
    return policy(context, category) == AccessPolicy.Allow && granted(context, category)
  }

  /** Rewrites this app's rules in Claude Code's managed settings, keeping everything else there. */
  @Synchronized
  fun writeManagedSettings(context: Context, rootfs: File) {
    val file = File(rootfs, MANAGED_SETTINGS)
    val settings = try {
      if (file.isFile) JSONObject(file.readText()) else JSONObject()
    } catch (error: JSONException) {
      // Claude Code refuses to start with a managed settings file it can't parse.
      Log.w(TAG, "Replacing unreadable ${file.path}", error)
      JSONObject()
    }
    val permissions = settings.optJSONObject("permissions") ?: JSONObject()
    val ours = categories.flatMap(::rules).toSet()
    for (list in AccessPolicy.entries) {
      val existing = permissions.optJSONArray(list.id) ?: JSONArray()
      val kept = (0 until existing.length()).map { existing.get(it) }.filterNot { it is String && it in ours }
      val added = categories.filter { policy(context, it) == list }.flatMap(::rules)
      if (kept.isEmpty() && added.isEmpty()) permissions.remove(list.id)
      else permissions.put(list.id, JSONArray(kept + added))
    }
    if (permissions.length() == 0) settings.remove("permissions") else settings.put("permissions", permissions)
    val directory = file.parentFile ?: throw IOException("No directory for ${file.path}")
    directory.mkdirs()
    // Claude Code reloads the file when it changes, so it's replaced whole.
    val staging = File(directory, "${file.name}.new")
    Files.deleteIfExists(staging.toPath())
    staging.writeText(settings.toString(2) + "\n")
    if (!staging.renameTo(file)) throw IOException("Couldn't write ${file.path}")
  }

  private fun rules(category: AccessCategory) =
    category.commands.flatMap { listOf("Bash(termux-$it)", "Bash(termux-$it *)") }

  private fun preferences(context: Context) = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
}

/** Lets termux-notification-list read the phone's notifications once the user grants notification access. */
class AgentNotificationListener : NotificationListenerService() {
  override fun onListenerConnected() {
    connected = this
  }

  override fun onListenerDisconnected() {
    if (connected === this) connected = null
  }

  companion object {
    @Volatile var connected: AgentNotificationListener? = null

    fun component(context: Context) = ComponentName(context, AgentNotificationListener::class.java)
  }
}
