package dev.happier.cryptoworker

import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

internal object HappierCryptoWorkerSerializedJson {
  private const val envelopeFlag = "__happierSerializedJsonValueV1"
  private const val typeKey = "type"
  private const val valueKey = "value"

  fun parseEnvelopeOrOriginal(value: String): Any? {
    val trimmed = value.trim()
    if (trimmed.isEmpty()) return value

    return try {
      when (val parsed = JSONTokener(trimmed).nextValue()) {
        is JSONObject -> parseEnvelopeOrJsonObject(parsed, value)
        is JSONArray -> parsed.toList()
        else -> parsed
      }
    } catch (_: Exception) {
      value
    }
  }

  private fun parseEnvelopeOrJsonObject(parsed: JSONObject, original: String): Any? {
    if (!parsed.optBoolean(envelopeFlag, false)) {
      return parsed.toMap()
    }
    return when (parsed.optString(typeKey, "")) {
      "undefined" -> parsed.toMap()
      "json" -> fromJsonValue(parsed.opt(valueKey))
      else -> original
    }
  }

  private fun JSONArray.toList(): List<Any?> =
    List(length()) { index -> fromJsonValue(opt(index)) }

  private fun JSONObject.toMap(): Map<String, Any?> =
    keys().asSequence().associateWith { key -> fromJsonValue(opt(key)) }

  private fun fromJsonValue(value: Any?): Any? = when (value) {
    JSONObject.NULL -> null
    is JSONObject -> value.toMap()
    is JSONArray -> value.toList()
    else -> value
  }
}
