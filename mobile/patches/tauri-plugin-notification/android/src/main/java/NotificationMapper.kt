package app.tauri.notification

import app.tauri.plugin.JSObject
import com.fasterxml.jackson.core.JsonParser
import com.fasterxml.jackson.databind.DeserializationContext
import com.fasterxml.jackson.databind.DeserializationFeature
import com.fasterxml.jackson.databind.JsonDeserializer
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.module.SimpleModule

/**
 * Display Buddy patch (D-84): mapper for the stored notifications. The broadcast receivers
 * (TimedNotificationPublisher, LocalNotificationRestoreReceiver, NotificationDismissReceiver)
 * run without the Tauri plugin handle, and a bare ObjectMapper cannot fill the JSObject field
 * `extra` – the receiver crashed before the notification was shown. Unknown fields of the
 * stored request (e.g. `silent`) are ignored.
 */
internal fun notificationMapper(): ObjectMapper {
  val module = SimpleModule().addDeserializer(JSObject::class.java, object : JsonDeserializer<JSObject>() {
    override fun deserialize(p: JsonParser, ctxt: DeserializationContext): JSObject =
      JSObject(ctxt.readTree(p).toString())
  })
  return ObjectMapper()
    .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
    .registerModule(module)
}
