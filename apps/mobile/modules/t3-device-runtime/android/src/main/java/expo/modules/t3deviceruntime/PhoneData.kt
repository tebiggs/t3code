package expo.modules.t3deviceruntime

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.content.Context
import android.content.pm.PackageManager
import android.database.Cursor
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.HandlerThread
import android.os.SystemClock
import android.provider.CallLog
import android.provider.ContactsContract
import android.provider.ContactsContract.CommonDataKinds.Phone
import android.provider.Telephony
import android.service.notification.NotificationListenerService
import android.telephony.CellInfoGsm
import android.telephony.CellInfoLte
import android.telephony.CellInfoNr
import android.telephony.CellInfoWcdma
import android.telephony.CellIdentityNr
import android.telephony.CellSignalStrengthNr
import android.telephony.SmsManager
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import org.json.JSONArray
import org.json.JSONObject
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

private const val LOCATION_WAIT_SECONDS = 30L
private const val LOCATION_UPDATE_MS = 5_000L
private val SMS_TYPES = listOf("all", "inbox", "sent", "draft", "outbox", "failed", "queued")
private val CALL_TYPES = mapOf(
  CallLog.Calls.BLOCKED_TYPE to "BLOCKED",
  CallLog.Calls.INCOMING_TYPE to "INCOMING",
  CallLog.Calls.MISSED_TYPE to "MISSED",
  CallLog.Calls.OUTGOING_TYPE to "OUTGOING",
  CallLog.Calls.REJECTED_TYPE to "REJECTED",
  CallLog.Calls.VOICEMAIL_TYPE to "VOICEMAIL",
)
private val DATA_ACTIVITIES = mapOf(
  TelephonyManager.DATA_ACTIVITY_NONE to "none",
  TelephonyManager.DATA_ACTIVITY_IN to "in",
  TelephonyManager.DATA_ACTIVITY_OUT to "out",
  TelephonyManager.DATA_ACTIVITY_INOUT to "inout",
  TelephonyManager.DATA_ACTIVITY_DORMANT to "dormant",
)
private val DATA_STATES = mapOf(
  TelephonyManager.DATA_DISCONNECTED to "disconnected",
  TelephonyManager.DATA_CONNECTING to "connecting",
  TelephonyManager.DATA_CONNECTED to "connected",
  TelephonyManager.DATA_SUSPENDED to "suspended",
)
@Suppress("DEPRECATION")
private val PHONE_TYPES = mapOf(
  TelephonyManager.PHONE_TYPE_CDMA to "cdma",
  TelephonyManager.PHONE_TYPE_GSM to "gsm",
  TelephonyManager.PHONE_TYPE_NONE to "none",
  TelephonyManager.PHONE_TYPE_SIP to "sip",
)

// Termux:API's names, "hdspa" included.
@Suppress("DEPRECATION")
private val NETWORK_TYPES = mapOf(
  TelephonyManager.NETWORK_TYPE_1xRTT to "1xrtt",
  TelephonyManager.NETWORK_TYPE_CDMA to "cdma",
  TelephonyManager.NETWORK_TYPE_EDGE to "edge",
  TelephonyManager.NETWORK_TYPE_EHRPD to "ehrpd",
  TelephonyManager.NETWORK_TYPE_EVDO_0 to "evdo_0",
  TelephonyManager.NETWORK_TYPE_EVDO_A to "evdo_a",
  TelephonyManager.NETWORK_TYPE_EVDO_B to "evdo_b",
  TelephonyManager.NETWORK_TYPE_GPRS to "gprs",
  TelephonyManager.NETWORK_TYPE_HSDPA to "hdspa",
  TelephonyManager.NETWORK_TYPE_HSPA to "hspa",
  TelephonyManager.NETWORK_TYPE_HSPAP to "hspap",
  TelephonyManager.NETWORK_TYPE_HSUPA to "hsupa",
  TelephonyManager.NETWORK_TYPE_IDEN to "iden",
  TelephonyManager.NETWORK_TYPE_LTE to "lte",
  TelephonyManager.NETWORK_TYPE_NR to "nr",
  TelephonyManager.NETWORK_TYPE_UMTS to "umts",
  TelephonyManager.NETWORK_TYPE_UNKNOWN to "unknown",
)
private val SIM_STATES = mapOf(
  TelephonyManager.SIM_STATE_ABSENT to "absent",
  TelephonyManager.SIM_STATE_NETWORK_LOCKED to "network_locked",
  TelephonyManager.SIM_STATE_PIN_REQUIRED to "pin_required",
  TelephonyManager.SIM_STATE_PUK_REQUIRED to "puk_required",
  TelephonyManager.SIM_STATE_READY to "ready",
  TelephonyManager.SIM_STATE_UNKNOWN to "unknown",
)

/** Personal data, telephony and location for the bridge, in Termux:API's JSON shapes. */
@SuppressLint("MissingPermission", "HardwareIds") // AgentAccess.check comes first.
internal class PhoneData(private val context: Context) {
  fun contacts(): JSONArray {
    val resolver = context.contentResolver
    val numbers = HashMap<Long, String>()
    val columns = arrayOf(Phone.CONTACT_ID, Phone.NUMBER)
    resolver.query(Phone.CONTENT_URI, columns, "${Phone.NUMBER} IS NOT NULL", null, null)?.use { cursor ->
      while (cursor.moveToNext()) numbers[cursor.getLong(0)] = cursor.getString(1)
    }
    val contacts = JSONArray()
    resolver.query(ContactsContract.Contacts.CONTENT_URI,
      arrayOf(ContactsContract.Contacts._ID, ContactsContract.Contacts.DISPLAY_NAME),
      null, null, ContactsContract.Contacts.DISPLAY_NAME)?.use { cursor ->
      while (cursor.moveToNext()) {
        val number = numbers[cursor.getLong(0)] ?: continue
        contacts.put(JSONObject().put("name", orNull(cursor.getString(1))).put("number", number))
      }
    }
    return contacts
  }

  /** Newest first from the provider, then reversed: Termux lists the latest last. */
  fun smsList(body: JSONObject): JSONArray {
    val conversations = body.optBoolean("conversations")
    val from = body.optString("from").ifEmpty { null }
    val type = SMS_TYPES.indexOf(body.optString("type", "all")).coerceAtLeast(0)
    val selection = when {
      from != null -> "${Telephony.Sms.ADDRESS} LIKE ?"
      type > 0 && !conversations -> "${Telephony.Sms.TYPE} = ?"
      else -> null
    }
    val arguments = from?.let { arrayOf(it) } ?: selection?.let { arrayOf("$type") }
    // Sender names come from contacts, so only when agents may read those as well.
    val names = if (AgentAccess.allowed(context, "contacts")) HashMap<String, String?>() else null
    val messages = ArrayList<JSONObject>()
    val newest = "${Telephony.Sms.DATE} DESC"
    context.contentResolver.query(Telephony.Sms.CONTENT_URI, null, selection, arguments, newest)?.use { cursor ->
      if (conversations) {
        val threads = HashSet<Long>()
        while (cursor.moveToNext()) {
          if (threads.add(cursor.long(Telephony.Sms.THREAD_ID))) messages += smsJson(cursor, names)
        }
      } else {
        cursor.moveToPosition(body.optInt("offset") - 1)
        while (messages.size < body.optInt("limit", 10) && cursor.moveToNext()) messages += smsJson(cursor, names)
      }
    }
    return JSONArray(messages.reversed())
  }

  private fun smsJson(cursor: Cursor, names: MutableMap<String, String?>?): JSONObject {
    val address = cursor.string(Telephony.Sms.ADDRESS)
    val type = cursor.long(Telephony.Sms.TYPE).toInt()
    val json = JSONObject()
      .put("threadid", cursor.long(Telephony.Sms.THREAD_ID))
      .put("type", if (type == 0) "" else SMS_TYPES.getOrElse(type) { "" })
    val read = cursor.getColumnIndex(Telephony.Sms.READ)
    if (read >= 0) json.put("read", cursor.getInt(read) != 0)
    val name = if (names != null && address != null) names.getOrPut(address) { contactName(address) } else null
    if (name != null) json.put("sender", if (type == Telephony.Sms.MESSAGE_TYPE_INBOX) name else "You")
    return json
      .put("address", orNull(address))
      .put("number", orNull(address))
      .put("received", formatDate(cursor.long(Telephony.Sms.DATE)))
      .put("body", orNull(cursor.string(Telephony.Sms.BODY)))
      .put("_id", cursor.long(Telephony.Sms._ID))
  }

  private fun contactName(number: String): String? {
    val uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number))
    return context.contentResolver.query(uri, arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)
      ?.use { if (it.moveToFirst()) it.getString(0) else null }
  }

  fun sendSms(body: JSONObject) {
    val recipients = body.getJSONArray("recipients").let { array -> (0 until array.length()).map(array::getString) }
    if (recipients.isEmpty()) throw BridgeError("No recipient number given.")
    val manager = smsManager(if (body.has("slot")) body.getInt("slot") else null)
    val parts = manager.divideMessage(body.getString("text"))
    for (recipient in recipients) manager.sendMultipartTextMessage(recipient, null, parts, null, null)
  }

  private fun smsManager(slot: Int?): SmsManager {
    val default = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      context.getSystemService(SmsManager::class.java)
    } else {
      @Suppress("DEPRECATION") SmsManager.getDefault()
    }
    if (slot == null) return default
    if (context.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) {
      throw BridgeError("Allow Phone in $ACCESS_SETTINGS to choose a SIM slot.", 403)
    }
    val subscription = context.getSystemService(SubscriptionManager::class.java).activeSubscriptionInfoList
      ?.firstOrNull { it.simSlotIndex == slot } ?: throw BridgeError("No active SIM in slot $slot.")
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      default.createForSubscriptionId(subscription.subscriptionId)
    } else {
      @Suppress("DEPRECATION") SmsManager.getSmsManagerForSubscriptionId(subscription.subscriptionId)
    }
  }

  fun callLog(body: JSONObject): JSONArray {
    val uri = CallLog.Calls.CONTENT_URI.buildUpon()
      .appendQueryParameter(CallLog.Calls.LIMIT_PARAM_KEY, "${body.optInt("limit", 10)}")
      .appendQueryParameter(CallLog.Calls.OFFSET_PARAM_KEY, "${body.optInt("offset")}")
      .build()
    val columns = arrayOf(
      CallLog.Calls.CACHED_NAME,
      CallLog.Calls.NUMBER,
      CallLog.Calls.TYPE,
      CallLog.Calls.DATE,
      CallLog.Calls.DURATION,
      CallLog.Calls.PHONE_ACCOUNT_ID,
    )
    val calls = ArrayList<JSONObject>()
    context.contentResolver.query(uri, columns, null, null, "${CallLog.Calls.DATE} DESC")?.use { cursor ->
      while (cursor.moveToNext()) {
        calls += JSONObject()
          .put("name", cursor.getString(0) ?: "UNKNOWN_CALLER")
          .put("phone_number", orNull(cursor.getString(1)))
          .put("type", CALL_TYPES[cursor.getInt(2)] ?: "UNKNOWN_TYPE")
          .put("date", formatDate(cursor.getLong(3)))
          .put("duration", timeString(cursor.getInt(4)))
          .put("sim_id", orNull(cursor.getString(5)))
      }
    }
    return JSONArray(calls.reversed())
  }

  @Suppress("DEPRECATION")
  fun deviceInfo(): JSONObject {
    val telephony = context.getSystemService(TelephonyManager::class.java)
    val phoneType = telephony.phoneType
    val info = JSONObject()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) info.put("data_enabled", telephony.isDataEnabled.toString())
    // Android keeps hardware and subscriber ids from apps without carrier privileges.
    val deviceId = runCatching {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) null
      else if (phoneType == TelephonyManager.PHONE_TYPE_GSM) telephony.imei else telephony.meid
    }.getOrNull()
    return info
      .put("data_activity", DATA_ACTIVITIES[telephony.dataActivity] ?: "${telephony.dataActivity}")
      .put("data_state", DATA_STATES[telephony.dataState] ?: "${telephony.dataState}")
      .put("device_id", orNull(deviceId))
      .put("device_software_version", orNull(runCatching { telephony.deviceSoftwareVersion }.getOrNull()))
      .put("phone_count", telephony.phoneCount)
      .put("phone_type", PHONE_TYPES[phoneType] ?: "$phoneType")
      .put("network_operator", orNull(telephony.networkOperator))
      .put("network_operator_name", orNull(telephony.networkOperatorName))
      .put("network_country_iso", orNull(telephony.networkCountryIso))
      .put("network_type", NETWORK_TYPES[telephony.dataNetworkType] ?: "${telephony.dataNetworkType}")
      .put("network_roaming", telephony.isNetworkRoaming)
      .put("sim_country_iso", orNull(telephony.simCountryIso))
      .put("sim_operator", orNull(telephony.simOperator))
      .put("sim_operator_name", orNull(telephony.simOperatorName))
      .put("sim_serial_number", orNull(runCatching { telephony.simSerialNumber }.getOrNull()))
      .put("sim_subscriber_id", orNull(runCatching { telephony.subscriberId }.getOrNull()))
      .put("sim_state", SIM_STATES[telephony.simState] ?: "${telephony.simState}")
  }

  @Suppress("DEPRECATION")
  fun cellInfo(): JSONArray {
    requireOnScreen("read cell towers")
    val cells = JSONArray()
    for (cell in context.getSystemService(TelephonyManager::class.java).allCellInfo.orEmpty()) {
      val json = JSONObject()
      when {
        cell is CellInfoGsm -> json.put("type", "gsm")
          .put("registered", cell.isRegistered)
          .put("asu", cell.cellSignalStrength.asuLevel)
          .known("dbm", cell.cellSignalStrength.dbm)
          .put("level", cell.cellSignalStrength.level)
          .known("cid", cell.cellIdentity.cid)
          .known("lac", cell.cellIdentity.lac)
          .known("mcc", cell.cellIdentity.mcc)
          .known("mnc", cell.cellIdentity.mnc)
        cell is CellInfoLte -> json.put("type", "lte")
          .put("registered", cell.isRegistered)
          .put("asu", cell.cellSignalStrength.asuLevel)
          .put("dbm", cell.cellSignalStrength.dbm)
          .known("level", cell.cellSignalStrength.level)
          .known("timing_advance", cell.cellSignalStrength.timingAdvance)
          .known("ci", cell.cellIdentity.ci)
          .known("pci", cell.cellIdentity.pci)
          .known("tac", cell.cellIdentity.tac)
          .known("mcc", cell.cellIdentity.mcc)
          .known("mnc", cell.cellIdentity.mnc)
          .apply {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
              known("rsrp", cell.cellSignalStrength.rsrp)
              known("rsrq", cell.cellSignalStrength.rsrq)
            }
          }
        cell is CellInfoWcdma -> json.put("type", "wcdma")
          .put("registered", cell.isRegistered)
          .put("asu", cell.cellSignalStrength.asuLevel)
          .known("dbm", cell.cellSignalStrength.dbm)
          .put("level", cell.cellSignalStrength.level)
          .known("cid", cell.cellIdentity.cid)
          .known("lac", cell.cellIdentity.lac)
          .known("mcc", cell.cellIdentity.mcc)
          .known("mnc", cell.cellIdentity.mnc)
          .known("psc", cell.cellIdentity.psc)
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && cell is CellInfoNr -> {
          val identity = cell.cellIdentity as CellIdentityNr
          val signal = cell.cellSignalStrength as CellSignalStrengthNr
          json.put("type", "nr")
            .put("registered", cell.isRegistered)
            .put("asu", signal.asuLevel)
            .put("dbm", signal.dbm)
            .known("level", signal.level)
            .apply { if (identity.nci != Long.MAX_VALUE) put("nci", identity.nci) }
            .known("pci", identity.pci)
            .known("tac", identity.tac)
            .put("mcc", orNull(identity.mccString))
            .put("mnc", orNull(identity.mncString))
            .known("csi_rsrp", signal.csiRsrp)
            .known("csi_rsrq", signal.csiRsrq)
            .known("csi_sinr", signal.csiSinr)
            .known("ss_rsrp", signal.ssRsrp)
            .known("ss_rsrq", signal.ssRsrq)
            .known("ss_sinr", signal.ssSinr)
        }
        else -> continue
      }
      cells.put(json)
    }
    return cells
  }

  fun notifications(): JSONArray {
    val listener = AgentNotificationListener.connected
    val active = try {
      listener?.activeNotifications
    } catch (error: SecurityException) {
      null
    } ?: run {
      NotificationListenerService.requestRebind(AgentNotificationListener.component(context))
      throw BridgeError("Android hasn't connected T3 Code's notification access yet. Try again in a moment.")
    }
    val list = JSONArray()
    for (shown in active) {
      val notification = shown.notification
      val extras = notification.extras
      val content = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)
        ?: extras.getCharSequence(Notification.EXTRA_TEXT)
      val json = JSONObject()
        .put("id", shown.id)
        .put("tag", shown.tag ?: "")
        .put("key", shown.key ?: "")
        .put("group", notification.group ?: "")
        .put("packageName", shown.packageName ?: "")
        .put("title", extras.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: "")
        .put("content", content?.toString() ?: "")
        .put("when", formatDate(notification.`when`))
      extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)?.let { lines ->
        json.put("lines", JSONArray(lines.map { it.toString() }))
      }
      list.put(json)
    }
    return list
  }

  /** A fix from `provider`: once, the last known one, or every update for 30 seconds. */
  fun location(body: JSONObject): Any {
    requireOnScreen("read the location")
    val manager = context.getSystemService(LocationManager::class.java)
    val provider = body.optString("provider", LocationManager.GPS_PROVIDER)
    if (provider !in manager.allProviders) throw BridgeError("This phone has no $provider location provider.")
    if (!manager.isProviderEnabled(provider)) throw BridgeError("Location ($provider) is turned off on this phone.")
    return when (body.optString("request", "once")) {
      "last" -> locationJson(
        manager.getLastKnownLocation(provider) ?: throw BridgeError("Android has no last known $provider location."),
      )
      "updates" -> JSONArray(listen(manager, provider, once = false).map(::locationJson))
      else -> locationJson(
        listen(manager, provider, once = true).firstOrNull()
          ?: throw BridgeError("No $provider location within $LOCATION_WAIT_SECONDS seconds."),
      )
    }
  }

  private fun listen(manager: LocationManager, provider: String, once: Boolean): List<Location> {
    val locations = Collections.synchronizedList(ArrayList<Location>())
    val first = CountDownLatch(1)
    // Each method is implemented: before Android 11 the interface had no defaults.
    val listener = object : LocationListener {
      override fun onLocationChanged(location: Location) {
        locations += location
        first.countDown()
      }

      @Deprecated("Deprecated in Java")
      override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit

      override fun onProviderEnabled(provider: String) = Unit

      override fun onProviderDisabled(provider: String) = Unit
    }
    val thread = HandlerThread("t3-location").apply { start() }
    try {
      if (once) {
        manager.requestLocationUpdates(provider, 0L, 0f, listener, thread.looper)
        first.await(LOCATION_WAIT_SECONDS, TimeUnit.SECONDS)
      } else {
        manager.requestLocationUpdates(provider, LOCATION_UPDATE_MS, 1f, listener, thread.looper)
        Thread.sleep(TimeUnit.SECONDS.toMillis(LOCATION_WAIT_SECONDS))
      }
    } finally {
      manager.removeUpdates(listener)
      thread.quitSafely()
    }
    return locations.toList()
  }

  private fun locationJson(location: Location): JSONObject {
    val json = JSONObject()
      .put("latitude", location.latitude)
      .put("longitude", location.longitude)
      .put("altitude", location.altitude)
      .put("accuracy", location.accuracy.toDouble())
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      json.put("vertical_accuracy", location.verticalAccuracyMeters.toDouble())
    }
    return json
      .put("bearing", location.bearing.toDouble())
      .put("speed", location.speed.toDouble())
      .put("elapsedMs", (SystemClock.elapsedRealtimeNanos() - location.elapsedRealtimeNanos) / 1_000_000)
      .put("provider", orNull(location.provider))
  }
}

private fun Cursor.string(column: String): String? = getString(getColumnIndexOrThrow(column))

private fun Cursor.long(column: String): Long = getLong(getColumnIndexOrThrow(column))

/** Termux:API leaves out values Android reports as unavailable. */
private fun JSONObject.known(name: String, value: Int): JSONObject =
  if (value == Int.MAX_VALUE) this else put(name, value)
