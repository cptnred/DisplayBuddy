package de.displaybuddy.push

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging

/**
 * Minimal FCM plugin (Tauri „Mobile Plugin Development“, Android part).
 *
 * Commands: getToken, takeLaunchData. Events: "token", "message", "opened".
 * Never logs the token or message contents.
 */
@TauriPlugin
class PushPlugin(private val activity: Activity) : Plugin(activity) {
    companion object {
        @Volatile
        var instance: PushPlugin? = null

        /** Data keys the server sends (server/src/push/native_fcm.rs, fcm_message). */
        private val DATA_KEYS = listOf("v", "type", "noteId", "at", "timeZone", "url")

        /** Extras of an FCM notification tap: the data keys plus google.message_id. */
        fun tapData(extras: Bundle?): JSObject? {
            if (extras == null || !extras.containsKey("google.message_id")) return null
            val data = JSObject()
            for (key in DATA_KEYS) {
                val v = extras.getString(key)
                if (v != null) data.put(key, v)
            }
            return data
        }
    }

    @Volatile
    private var launchData: JSObject? = null

    override fun load(webView: WebView) {
        super.load(webView)
        instance = this
        launchData = tapData(activity.intent?.extras)
    }

    override fun onNewIntent(intent: Intent) {
        val data = tapData(intent.extras) ?: return
        if (hasListener("opened")) {
            trigger("opened", data)
        } else {
            launchData = data
        }
    }

    override fun onDestroy() {
        if (instance === this) instance = null
    }

    private fun firebaseReady(): Boolean =
        FirebaseApp.getApps(activity.applicationContext).isNotEmpty()

    @Command
    fun getToken(invoke: Invoke) {
        if (!firebaseReady()) {
            invoke.reject("Firebase is not configured in this build (google-services.json)", "NOT_CONFIGURED")
            return
        }
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (!task.isSuccessful || task.result.isNullOrEmpty()) {
                invoke.reject("FCM token unavailable", "UNAVAILABLE", task.exception)
                return@addOnCompleteListener
            }
            val result = JSObject()
            result.put("token", task.result)
            invoke.resolve(result)
        }
    }

    @Command
    fun takeLaunchData(invoke: Invoke) {
        val data = launchData
        launchData = null
        val result = JSObject()
        result.put("data", data)
        invoke.resolve(result)
    }

    fun emitToken(token: String) {
        val data = JSObject()
        data.put("token", token)
        trigger("token", data)
    }

    fun emitMessage(values: Map<String, String>, title: String?, body: String?) {
        val data = JSObject()
        for (key in DATA_KEYS) {
            val v = values[key]
            if (v != null) data.put(key, v)
        }
        data.put("title", title)
        data.put("body", body)
        trigger("message", data)
    }
}
