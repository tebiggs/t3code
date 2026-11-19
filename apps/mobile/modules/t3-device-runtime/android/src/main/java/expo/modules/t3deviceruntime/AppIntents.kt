package expo.modules.t3deviceruntime

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import org.json.JSONObject

// T3 Code holds CALL_PHONE, so these would place a call outside the Phone category.
private val CALL_ACTIONS = setOf(
  Intent.ACTION_CALL,
  "android.intent.action.CALL_PRIVILEGED",
  "android.intent.action.CALL_EMERGENCY",
)

/**
 * The intent an am command describes. Android sends it as T3 Code, with T3 Code's permissions,
 * so it's built from am's flags rather than parsed: it carries no flags, URI grants, selector or
 * Parcelable extras, and can't reach T3 Code's own components.
 */
internal fun appIntent(context: Context, body: JSONObject): Intent {
  val intent = Intent()
  body.optString("action").takeIf { it.isNotEmpty() }?.let { intent.action = it }
  if (intent.action in CALL_ACTIONS) throw BridgeError("Calls go through termux-telephony-call.")
  val data = body.optString("data").takeIf { it.isNotEmpty() }?.let(Uri::parse)
  intent.setDataAndType(data, body.optString("type").takeIf { it.isNotEmpty() })
  body.optJSONArray("categories")?.let { categories ->
    for (index in 0 until categories.length()) intent.addCategory(categories.getString(index))
  }
  body.optString("component").takeIf { it.isNotEmpty() }?.let { name ->
    intent.component = ComponentName.unflattenFromString(name)
      ?: throw BridgeError("-n takes package/class, such as com.example/.MainActivity, not $name")
  }
  body.optString("package").takeIf { it.isNotEmpty() }?.let { intent.setPackage(it) }
  body.optJSONArray("extras")?.let { extras ->
    for (index in 0 until extras.length()) putExtra(intent, extras.getJSONObject(index))
  }
  val own = context.packageName
  if (intent.`package` == own || intent.component?.packageName == own) {
    throw BridgeError("am can't send intents to T3 Code itself.")
  }
  if (data?.scheme == "content" && data?.authority.orEmpty().startsWith(own)) {
    throw BridgeError("T3 Code's own files go through termux-open or termux-share.")
  }
  return intent
}

/** am start -p <package> with nothing else opens the app, as its launcher icon does. */
internal fun launchIntent(context: Context, intent: Intent): Intent {
  val target = intent.`package`
  val onlyPackage = target != null && intent.action == null && intent.data == null &&
    intent.component == null && intent.categories.isNullOrEmpty()
  if (!onlyPackage) return intent
  val launch = context.packageManager.getLaunchIntentForPackage(target)
    ?: throw BridgeError("$target isn't installed or has no app to open. pm list packages lists the ones that do.")
  return launch.putExtras(intent)
}

/** What a notification or error names the intent by. */
internal fun describeIntent(intent: Intent, fallback: String = "this intent"): String =
  intent.component?.flattenToShortString() ?: intent.`package` ?: intent.dataString ?: intent.action ?: fallback

/** A broadcast names its app, so one can't reach every app that listens for its action. */
internal fun requireTarget(intent: Intent) {
  if (intent.`package` == null && intent.component == null) {
    throw BridgeError("am broadcast needs -p or -n to name the app it's for.")
  }
}

/** Whether an installed app declares a receiver for it; apps can also register one while they run. */
internal fun hasDeclaredReceiver(context: Context, intent: Intent): Boolean =
  @Suppress("DEPRECATION")
  context.packageManager.queryBroadcastReceivers(intent, 0).isNotEmpty()

/**
 * pm list packages, for the apps with a launcher icon: the manifest's queries make only those
 * visible, as Play allows QUERY_ALL_PACKAGES for few kinds of app.
 */
internal fun launchablePackages(context: Context, body: JSONObject): List<String> {
  val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
  val filter = body.optString("filter")
  @Suppress("DEPRECATION")
  return context.packageManager.queryIntentActivities(launcher, 0)
    .map { it.activityInfo.applicationInfo }
    .filter { app ->
      val isSystem = app.flags and ApplicationInfo.FLAG_SYSTEM != 0
      !(body.optBoolean("thirdParty") && isSystem) && !(body.optBoolean("system") && !isSystem)
    }
    .map { it.packageName }
    .filter { filter in it }
    .distinct()
    .sorted()
}

private fun putExtra(intent: Intent, extra: JSONObject) {
  val key = extra.getString("key")
  val value = extra.getString("value")
  fun invalid(): Nothing = throw BridgeError("The extra $key isn't a valid ${extra.getString("type")}: $value")
  when (extra.getString("type")) {
    "string" -> intent.putExtra(key, value)
    "boolean" -> intent.putExtra(key, value.toBooleanStrictOrNull() ?: invalid())
    "int" -> intent.putExtra(key, value.toIntOrNull() ?: invalid())
    "long" -> intent.putExtra(key, value.toLongOrNull() ?: invalid())
    "float" -> intent.putExtra(key, value.toFloatOrNull() ?: invalid())
    else -> throw BridgeError("Unknown extra type ${extra.getString("type")}")
  }
}
