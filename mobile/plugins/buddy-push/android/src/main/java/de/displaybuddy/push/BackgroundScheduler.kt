package de.displaybuddy.push

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PowerManager

/**
 * Drives the background sync without Firebase and without a foreground service (no permanent
 * notification): an exact alarm every [INTERVAL_MS] (`setExactAndAllowWhileIdle`, works in
 * Doze; `USE_EXACT_ALARM` is granted to this app) wakes [BackgroundTickReceiver], which lets
 * [BackgroundSync] fetch new or changed reminders and plan them as local alarms. Each run
 * schedules the next one. Started by the web layer after the login ([PushPlugin]) and by
 * [BackgroundBootReceiver] after a reboot or an app update.
 */
internal object BackgroundScheduler {
    const val INTERVAL_MS = 3 * 60 * 1000L
    private const val WAKE_LOCK_MS = 2 * 60 * 1000L
    private const val TICK_REQUEST = 7_001

    /** After the account was stored: first sync now, then every [INTERVAL_MS]. */
    fun start(context: Context) {
        run(context.applicationContext, null)
    }

    fun stop(context: Context) {
        cancelTick(context)
    }

    /**
     * Schedules the next tick, then syncs on a worker thread (the process stays alive while
     * [finish] has not been called; [PowerManager] wake lock for the CPU). [finish] ends the
     * receiver's `goAsync()`.
     */
    fun run(context: Context, finish: (() -> Unit)?) {
        scheduleNextTick(context)
        Thread {
            val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            val lock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "displaybuddy:sync")
            lock.acquire(WAKE_LOCK_MS)
            try {
                if (BackgroundSync.syncOnce(context) == SyncResult.UNAUTHORIZED) {
                    // token revoked: the user has to log in again in the app
                    BackgroundSettings(context).clear()
                    cancelTick(context)
                }
            } catch (_: Exception) {
                // the next tick retries
            } finally {
                if (lock.isHeld) lock.release()
                finish?.invoke()
            }
        }.start()
    }

    fun scheduleNextTick(context: Context) {
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

    private fun cancelTick(context: Context) {
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

/** The periodic alarm. */
class BackgroundTickReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = syncFrom(context)
}

/** Re-arms the sync after a reboot or an app update (alarms are gone then). */
class BackgroundBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = syncFrom(context)
}

private fun BroadcastReceiver.syncFrom(context: Context) {
    val app = context.applicationContext
    if (!BackgroundSettings(app).isConfigured()) return
    val pending = goAsync()
    BackgroundScheduler.run(app) { pending.finish() }
}
