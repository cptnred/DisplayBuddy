package de.displaybuddy.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Reference values computed with src/web/notify/native-plan.ts (`notificationId`). */
class ReminderMathTest {
    @Test
    fun idsMatchTheWebLayer() {
        assertEquals(-74450345, ReminderMath.notificationId("208dc874-1ad3-4f0d-9018-c20b1ca378fb", "2026-11-05T13:30:00.000Z"))
        assertEquals(-1818038797, ReminderMath.notificationId("abc", "2026-01-01T00:00:00Z"))
        assertEquals(-1375985082, ReminderMath.notificationId("abc", "2026-07-01T12:00:00.123456+02:00"))
        assertEquals(-795218331, ReminderMath.notificationId("äöü", "2026-11-07T09:15:32.5Z"))
    }

    @Test
    fun parsesInstantsLikeJavaScript() {
        assertEquals(1793885400000L, ReminderMath.parseInstant("2026-11-05T13:30:00.000Z"))
        assertEquals(1782900000123L, ReminderMath.parseInstant("2026-07-01T12:00:00.123456+02:00"))
        assertEquals(1794042932500L, ReminderMath.parseInstant("2026-11-07T09:15:32.5Z"))
    }

    @Test
    fun rejectsMalformedInstants() {
        assertNull(ReminderMath.parseInstant("tomorrow"))
        assertNull(ReminderMath.parseInstant("2026-11-05 13:30:00Z"))
        assertNull(ReminderMath.notificationId("abc", "nope"))
    }
}
