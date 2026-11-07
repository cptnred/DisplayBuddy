package de.displaybuddy.push

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.util.concurrent.Executors

/**
 * Foreground service of the background sync (no Firebase): keeps the process alive and, driven
 * by an exact alarm every [INTERVAL_MS] (works in Doze, `setExactAndAllowWhileIdle`) and by
 * „network available“, lets [BackgroundSync] fetch new or changed reminders and plan them as
 * local alarms. Started by the web layer after the login ([PushPlugin]), after a reboot and
 * after an update ([BackgroundBootReceiver]).
 *
 * Foreground service type `specialUse` (no time limit unlike `dataSync` on Android 15; the
 * app is sideloaded, see mobile/README.md).
 */
class SyncService : Service() {
    private val worker = Executors.newSingleThreadExecutor()
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // must follow startForegroundService within a few seconds, so before anything else
        startInForeground()
        if (!BackgroundSettings(this).isConfigured()) {
            stopSelf()
            return START_NOT_STICKY
        }
        watchNetwork()
        scheduleNextTick(this)
        runSync()
        return START_STICKY
    }

    override fun onDestroy() {
        networkCallback?.let {
            try {
                (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(it)
            } catch (_: Exception) {
                // already gone
            }
        }
        networkCallback = null
        worker.shutdown()
        super.onDestroy()
    }

    private fun startInForeground() {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Hintergrundabgleich", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Zeigt an, dass Display Buddy neue Erinnerungen im Hintergrund abgleicht."
                    setShowBadge(false)
                },
            )
        }
        val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("Display Buddy")
            .setContentText("Erinnerungen werden im Hintergrund abgeglichen")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(open)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun watchNetwork() {
        if (networkCallback != null) return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                runSync()
            }
        }
        try {
            (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).registerDefaultNetworkCallback(callback)
            networkCallback = callback
        } catch (_: Exception) {
            // the alarm still drives the sync
        }
    }

    private fun runSync() {
        val context = applicationContext
        try {
            worker.execute {
                val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
                val lock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "displaybuddy:sync")
                lock.acquire(WAKE_LOCK_MS)
                try {
                    if (BackgroundSync.syncOnce(context) == SyncResult.UNAUTHORIZED) {
                        // token revoked: the user has to log in again in the app
                        BackgroundSettings(context).clear()
                        cancelTick(context)
                        stopSelf()
                    }
                } finally {
                    if (lock.isHeld) lock.release()
                }
            }
        } catch (_: Exception) {
            // service is shutting down
        }
    }

    companion object {
        const val INTERVAL_MS = 3 * 60 * 1000L
        private const val CHANNEL_ID = "background-sync"
        private const val NOTIFICATION_ID = 2_000_000_100
        private const val WAKE_LOCK_MS = 2 * 60 * 1000L
        private const val TICK_REQUEST = 7_001

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, SyncService::class.java))
        }

        fun stop(context: Context) {
            cancelTick(context)
            context.stopService(Intent(context, SyncService::class.java))
        }

        internal fun scheduleNextTick(context: Context) {
            val alarms = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val at = System.currentTimeMillis() + INTERVAL_MS
            val pending = tickIntent(context, PendingIntent.FLAG_UPDATE_CURRENT)!!
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !alarms.canScheduleExactAlarms()) {
                    alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending)
                } else {
                    alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending)
                }
            } catch (_: SecurityException) {
                alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending)
            }
        }

        internal fun cancelTick(context: Context) {
            val alarms = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            tickIntent(context, PendingIntent.FLAG_NO_CREATE)?.let { alarms.cancel(it) }
        }

        private fun tickIntent(context: Context, flag: Int): PendingIntent? =
            PendingIntent.getBroadcast(
                context,
                TICK_REQUEST,
                Intent(context, BackgroundTickReceiver::class.java),
                flag or PendingIntent.FLAG_IMMUTABLE,
            )
    }
}

/** The periodic alarm: wakes the service, or syncs directly if it may not be started. */
class BackgroundTickReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (!BackgroundSettings(context).isConfigured()) return
        try {
            SyncService.start(context)
        } catch (_: Exception) {
            val pending = goAsync()
            val app = context.applicationContext
            Thread {
                try {
                    BackgroundSync.syncOnce(app)
                } finally {
                    SyncService.scheduleNextTick(app)
                    pending.finish()
                }
            }.start()
        }
    }
}

/** Restarts the service after a reboot or an app update (alarms and the service are gone then). */
class BackgroundBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (!BackgroundSettings(context).isConfigured()) return
        try {
            SyncService.start(context)
        } catch (_: Exception) {
            SyncService.scheduleNextTick(context)
        }
    }
}
