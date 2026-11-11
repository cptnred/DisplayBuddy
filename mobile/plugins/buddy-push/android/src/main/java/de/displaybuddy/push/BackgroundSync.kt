package de.displaybuddy.push

import android.content.Context
import androidx.core.app.NotificationManagerCompat
import app.tauri.notification.Notification
import app.tauri.notification.NotificationStorage
import app.tauri.notification.TauriNotificationManager
import app.tauri.notification.notificationMapper
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

enum class SyncResult { OK, OFFLINE, ERROR, UNAUTHORIZED, UNCONFIGURED }

/**
 * Background sync without Firebase: reads `GET /api/v1/sync/changes` with the device token and
 * plans every reminder as a local alarm through the notification plugin (same classes, storage,
 * channel „reminders“, buttons and ids as src/web/notify/native.ts). The web layer later diffs
 * against exactly this storage, so both planners never ring twice. The cursor here is the
 * service's own: it does not move the app's cursor and needs no running WebView.
 *
 * Only reads from the server; never sends notes or the device state. Logs no tokens, titles or
 * note content.
 *
 * Records it cannot read (e.g. a future encrypted content format, D-101) are skipped: no alarm is
 * set or cancelled for them, the cursor still moves on (the app handles them itself), and the
 * run reports [SyncResult.ERROR] (PLAN_V4 §7.2).
 */
internal object BackgroundSync {
    private const val CHANNEL_ID = "reminders"
    private const val ACTION_TYPE_ID = "buddy-reminder"
    private const val PAGE_LIMIT = 500
    private const val TITLE_MAX = 60
    private const val TIMEOUT_MS = 6_000

    /** The receiver that runs this has only a few seconds; the rest follows with the next tick. */
    private const val DEADLINE_MS = 8_000L

    @Synchronized
    fun syncOnce(context: Context): SyncResult {
        val settings = BackgroundSettings(context)
        val base = settings.baseUrl ?: return SyncResult.UNCONFIGURED
        val token = settings.token() ?: return SyncResult.UNCONFIGURED
        // state of a run belongs to the account it started with
        val generation = settings.generation()
        val deadline = System.currentTimeMillis() + DEADLINE_MS
        var resynced = false
        var skipped = 0
        while (true) {
            if (System.currentTimeMillis() >= deadline) return SyncResult.ERROR
            val response = try {
                get("$base/api/v1/sync/changes?since=${settings.cursor}&limit=$PAGE_LIMIT", token, deadline)
            } catch (_: IOException) {
                return SyncResult.OFFLINE
            }
            if (settings.generation() != generation) return SyncResult.OK
            when (response.first) {
                200 -> Unit
                401, 403 -> {
                    settings.clearIf(generation)
                    return SyncResult.UNAUTHORIZED
                }
                410 -> {
                    // cursor older than the server's change log: start over once
                    if (resynced) return SyncResult.ERROR
                    resynced = true
                    if (!settings.resetState(generation)) return SyncResult.OK
                    continue
                }
                else -> return SyncResult.ERROR
            }
            val page = try {
                JSONObject(response.second)
            } catch (_: Exception) {
                return SyncResult.ERROR
            }
            val cursor = page.optLong("cursor", -1L)
            if (cursor < 0) return SyncResult.ERROR
            val applied = try {
                apply(context, settings, page)
            } catch (_: Exception) {
                return SyncResult.ERROR
            }
            skipped += applied.skipped
            if (!settings.commit(generation, cursor, applied.titles)) return SyncResult.OK
            if (!page.optBoolean("hasMore")) return if (skipped > 0) SyncResult.ERROR else SyncResult.OK
        }
    }

    private fun get(url: String, token: String, deadline: Long): Pair<Int, String> {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            val remaining = (deadline - System.currentTimeMillis()).toInt().coerceIn(1_000, TIMEOUT_MS)
            connection.requestMethod = "GET"
            connection.connectTimeout = remaining
            connection.readTimeout = remaining
            connection.useCaches = false
            // the token must never follow a redirect to another host
            connection.instanceFollowRedirects = false
            connection.setRequestProperty("Authorization", "Bearer $token")
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("X-Buddy-Request", "1")
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val body = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            return code to body
        } finally {
            connection.disconnect()
        }
    }

    private class Applied(val titles: JSONObject, val skipped: Int)

    /** A note record this service understands: id + deleted, or a note object. */
    private fun readableNote(record: JSONObject?): Boolean {
        if (record == null || record.optString("id").isEmpty()) return false
        return record.optBoolean("deleted") || record.optJSONObject("note") != null
    }

    /** A reminder record this service understands: noteId + deleted, or a reminder with a known state and instant. */
    private fun readableReminder(record: JSONObject?): Boolean {
        if (record == null || record.optString("noteId").isEmpty()) return false
        if (record.optBoolean("deleted")) return true
        val reminder = record.optJSONObject("reminder") ?: return false
        return reminder.optString("state") in setOf("scheduled", "due", "done") &&
            ReminderMath.parseInstant(reminder.optString("at")) != null
    }

    /**
     * Applies one page and returns the updated note titles (stored by the caller together with the
     * cursor) and the number of records it could not read.
     */
    private fun apply(context: Context, settings: BackgroundSettings, page: JSONObject): Applied {
        val storage = NotificationStorage(context, notificationMapper())
        val manager = TauriNotificationManager(storage, null, context, null)
        val enabled = NotificationManagerCompat.from(context).areNotificationsEnabled()
        val now = System.currentTimeMillis()

        val titles = settings.titles()
        val renamed = HashSet<String>()
        var skipped = 0
        val notes: JSONArray = page.optJSONArray("notes") ?: JSONArray()
        for (i in 0 until notes.length()) {
            val record = notes.optJSONObject(i)
            if (record == null || !readableNote(record)) {
                skipped++
                continue
            }
            val id = record.getString("id")
            val note = record.optJSONObject("note")
            if (record.optBoolean("deleted") || note == null) {
                titles.remove(id)
            } else {
                val title = noteTitle(note)
                if (titles.optString(id, "\u0000") != title) renamed.add(id)
                titles.put(id, title)
            }
        }

        // stored alarms per note, read once (every read parses all of them)
        val saved = HashMap<String, MutableList<Pair<Int, String>>>()
        for (n in storage.getSavedNotifications()) {
            val extra = n.extra ?: continue
            val noteId = extra.optString("noteId")
            if (noteId.isNotEmpty()) saved.getOrPut(noteId) { mutableListOf() }.add(n.id to extra.optString("at"))
        }

        val reminders: JSONArray = page.optJSONArray("reminders") ?: JSONArray()
        val touched = HashSet<String>()
        for (i in 0 until reminders.length()) {
            val record = reminders.optJSONObject(i)
            if (record == null || !readableReminder(record)) {
                skipped++
                continue
            }
            val noteId = record.getString("noteId")
            touched.add(noteId)
            val reminder = record.optJSONObject("reminder")
            val state = if (record.optBoolean("deleted")) null else reminder?.optString("state")
            val at = reminder?.optString("at") ?: ""
            val wantedId = if (state == "scheduled") ReminderMath.notificationId(noteId, at) else null
            val mine = saved.getOrPut(noteId) { mutableListOf() }

            // fired and waiting for the user: leave the visible notification alone
            if (state == "due") continue
            val stale = mine.filter { it.first != wantedId }
            for ((id, _) in stale) manager.cancel(listOf(id))
            mine.removeAll(stale.toSet())
            if (state == "done") ReminderMath.notificationId(noteId, at)?.let { manager.cancel(listOf(it)) }

            val atMs = ReminderMath.parseInstant(at)
            if (wantedId != null && atMs != null && atMs > now && enabled && mine.none { it.first == wantedId }) {
                schedule(manager, storage, wantedId, noteId, at, atMs, titles.optString(noteId, ""))
                mine.add(wantedId to at)
            }
        }

        // a title that arrived after its reminder (or changed): re-plan with the new text
        if (enabled) {
            for (noteId in renamed - touched) {
                for ((id, at) in saved[noteId].orEmpty()) {
                    val atMs = ReminderMath.parseInstant(at) ?: continue
                    if (atMs > now) schedule(manager, storage, id, noteId, at, atMs, titles.optString(noteId, ""))
                }
            }
        }
        return Applied(titles, skipped)
    }

    private fun schedule(
        manager: TauriNotificationManager,
        storage: NotificationStorage,
        id: Int,
        noteId: String,
        at: String,
        atMs: Long,
        noteTitle: String,
    ) {
        val date = utc().format(Date((atMs + 999) / 1000 * 1000))
        val wall = SimpleDateFormat("HH:mm", Locale.GERMANY).format(Date(atMs))
        val request = JSONObject()
            .put("id", id)
            .put("channelId", CHANNEL_ID)
            .put("title", noteTitle.ifEmpty { "Erinnerung" })
            .put("body", "Erinnerung um $wall")
            .put(
                "schedule",
                JSONObject().put(
                    "at",
                    JSONObject().put("date", date).put("repeating", false).put("allowWhileIdle", true),
                ),
            )
            .put("actionTypeId", ACTION_TYPE_ID)
            .put("extra", JSONObject().put("noteId", noteId).put("at", at))
            .put("autoCancel", true)
        val json = request.toString()
        val notification = notificationMapper().readValue(json, Notification::class.java)
        notification.sourceJson = json
        manager.schedule(notification)
        storage.appendNotifications(listOf(notification))
    }

    private fun utc(): SimpleDateFormat =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT).apply { timeZone = TimeZone.getTimeZone("UTC") }

    /** Title of the note, else the start of its text (like noteTitle in native-plan.ts). */
    private fun noteTitle(note: JSONObject): String {
        val title = note.optString("title").trim()
        val text = if (title.isNotEmpty()) title else collectText(note.optJSONObject("content")).trim()
        if (text.isEmpty()) return ""
        return if (text.length > TITLE_MAX) text.take(TITLE_MAX - 1) + "…" else text
    }

    private fun collectText(node: JSONObject?): String {
        if (node == null) return ""
        val out = StringBuilder()
        fun walk(n: JSONObject) {
            n.optString("text").takeIf { it.isNotEmpty() }?.let { out.append(it).append(' ') }
            val children = n.optJSONArray("content") ?: return
            for (i in 0 until children.length()) {
                children.optJSONObject(i)?.let(::walk)
                if (out.length > TITLE_MAX * 2) return
            }
        }
        walk(node)
        return out.toString().replace(Regex("\\s+"), " ")
    }
}
