package de.displaybuddy.push

import android.app.Activity
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging

@InvokeArg
class BackgroundArgs {
    lateinit var baseUrl: String
    lateinit var token: String
}

/**
 * Minimal FCM plugin (Tauri „Mobile Plugin Development“, Android part).
 *
 * Commands: getToken, takeLaunchData, startBackgroundSync, stopBackgroundSync,
 * backgroundSyncState, requestBatteryExemption. Events: "token", "message", "opened".
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
        // channel of the former foreground service (no longer used): remove it from the settings
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            (activity.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .deleteNotificationChannel("background-sync")
        }
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

    /**
     * Server address + device token for the background sync (see [BackgroundScheduler]); starts it.
     * The address must pass the same rule as `server_url::normalize` ([ServerUrl], PLAN_V4 §7.2).
     */
    @Command
    fun startBackgroundSync(invoke: Invoke) {
        val args = invoke.parseArgs(BackgroundArgs::class.java)
        val origin = ServerUrl.normalize(args.baseUrl)
        if (origin == null || args.token.isBlank()) {
            invoke.reject("invalid background sync configuration", "INVALID")
            return
        }
        try {
            BackgroundSettings(activity).configure(origin, args.token)
            BackgroundScheduler.start(activity)
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("background sync could not be started", "UNAVAILABLE", e)
        }
    }

    /** Signed out: forget the account and stop the sync. */
    @Command
    fun stopBackgroundSync(invoke: Invoke) {
        BackgroundSettings(activity).clear()
        BackgroundScheduler.stop(activity)
        invoke.resolve()
    }

    @Command
    fun backgroundSyncState(invoke: Invoke) {
        val result = JSObject()
        result.put("configured", BackgroundSettings(activity).isConfigured())
        result.put("batteryUnrestricted", batteryUnrestricted())
        invoke.resolve(result)
    }

    /** Shows the system dialog „Akku-Optimierung ignorieren“ (network access in Doze). */
    @Command
    fun requestBatteryExemption(invoke: Invoke) {
        if (!batteryUnrestricted()) {
            try {
                activity.startActivity(
                    Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${activity.packageName}")),
                )
            } catch (e: Exception) {
                invoke.reject("battery settings unavailable", "UNAVAILABLE", e)
                return
            }
        }
        invoke.resolve()
    }

    private fun batteryUnrestricted(): Boolean {
        val power = activity.getSystemService(Context.POWER_SERVICE) as PowerManager
        return power.isIgnoringBatteryOptimizations(activity.packageName)
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
