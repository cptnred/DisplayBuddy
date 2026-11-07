package de.displaybuddy.push

import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * Pure helpers of the background sync. They must stay identical to the web layer
 * (src/web/notify/native-plan.ts, src/lib/schedule.ts): the same occurrence (noteId, at)
 * gets the same notification id there and here, so a notification planned by the service
 * and one planned by the app replace each other instead of ringing twice.
 */
internal object ReminderMath {
    /** Id of the „in 2 min“ test notification; never produced by [notificationId]. */
    const val TEST_NOTIFICATION_ID = 2_000_000_001

    private val RFC3339 = Regex("""^(\d{4}-\d{2}-\d{2})[Tt](\d{2}:\d{2}:\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$""")

    /** FNV-1a (32 bit) over the UTF-16 code units, as unsigned value in a Long. */
    fun fnv1a32(s: String): Long {
        var h = 0x811c9dc5L
        for (ch in s) {
            h = h xor ch.code.toLong()
            h = (h * 0x01000193L) and 0xFFFFFFFFL
        }
        return h
    }

    /** RFC 3339 instant → Unix ms (fraction truncated to ms like JS `Date.parse`), null if malformed. */
    fun parseInstant(text: String): Long? {
        val m = RFC3339.matchEntire(text.trim()) ?: return null
        val (date, time, fraction, zone) = m.destructured
        val millis = fraction.removePrefix(".").padEnd(3, '0').take(3).ifEmpty { "0" }.toLong()
        val tz = if (zone.equals("z", ignoreCase = true)) "Z" else zone
        return try {
            val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.ROOT)
            format.isLenient = false
            format.timeZone = TimeZone.getTimeZone("UTC")
            val base = format.parse("${date}T$time$tz") ?: return null
            base.time + millis
        } catch (_: Exception) {
            null
        }
    }

    /** Stable signed 32-bit id of the occurrence; null if `at` is unreadable. */
    fun notificationId(noteId: String, at: String): Int? {
        val ms = parseInstant(at) ?: return null
        val id = fnv1a32("$noteId|$ms").toInt()
        return if (id == TEST_NOTIFICATION_ID) id xor 1 else id
    }
}
