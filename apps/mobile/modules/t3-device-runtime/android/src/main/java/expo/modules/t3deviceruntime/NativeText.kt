package expo.modules.t3deviceruntime

/**
 * The app's translations of the English passed to [localized], sent by
 * apps/mobile/src/features/device-runtime/native-text.ts. Text it hasn't sent stays English.
 */
@Volatile internal var nativeTranslations: Map<String, String> = emptyMap()

/** Text Android shows the user, in the app's language. Text for agents and logs stays English. */
internal fun localized(english: String, vararg values: Pair<String, Any>): String =
  values.fold(nativeTranslations[english] ?: english) { text, (name, value) ->
    text.replace("{$name}", value.toString())
  }
