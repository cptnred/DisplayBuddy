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
 */
internal object BackgroundSync {
    private const val CHANNEL_ID = "reminders"
    private const val ACTION_TYPE_ID = "buddy-reminder"
    private const val PAGE_LIMIT = 500
    private const val TITLE_MAX = 60
    private const val TIMEOUT_MS = 20_000

    @Synchronized
    fun syncOnce(context: Context): SyncResult {
        val settings = BackgroundSettings(context)
        val base = settings.baseUrl ?: return SyncResult.UNCONFIGURED
        val token = settings.token() ?: return SyncResult.UNCONFIGURED
        var resynced = false
        while (true) {
            val response = try {
                get("$base/api/v1/sync/changes?since=${settings.cursor}&limit=$PAGE_LIMIT", token)
            } catch (_: IOException) {
                return SyncResult.OFFLINE
            }
            when (response.first) {
                200 -> Unit
                401, 403 -> return SyncResult.UNAUTHORIZED
                410 -> {
                    // cursor older than the server's change log: start over once
                    if (resynced) return SyncResult.ERROR
                    resynced = true
                    settings.resetState()
                    continue
                }
                else -> return SyncResult.ERROR
            }
            val page = try {
                JSONObject(response.second)
            } catch (_: Exception) {
                return SyncResult.ERROR
            }
            try {
                apply(context, settings, page)
            } catch (_: Exception) {
                return SyncResult.ERROR
            }
            settings.cursor = page.getLong("cursor")
            if (!page.optBoolean("hasMore")) return SyncResult.OK
        }
    }

    private fun get(url: String, token: String): Pair<Int, String> {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "GET"
            connection.connectTimeout = TIMEOUT_MS
            connection.readTimeout = TIMEOUT_MS
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

    private fun apply(context: Context, settings: BackgroundSettings, page: JSONObject) {
        val storage = NotificationStorage(context, notificationMapper())
        val manager = TauriNotificationManager(storage, null, context, null)
        val enabled = NotificationManagerCompat.from(context).areNotificationsEnabled()
        val now = System.currentTimeMillis()

        val titles = settings.titles()
        val renamed = HashSet<String>()
        val notes: JSONArray = page.optJSONArray("notes") ?: JSONArray()
        for (i in 0 until notes.length()) {
            val record = notes.getJSONObject(i)
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
        settings.saveTitles(titles)

        val reminders: JSONArray = page.optJSONArray("reminders") ?: JSONArray()
        val touched = HashSet<String>()
        for (i in 0 until reminders.length()) {
            val record = reminders.getJSONObject(i)
            val noteId = record.getString("noteId")
            touched.add(noteId)
            val reminder = record.optJSONObject("reminder")
            val state = if (record.optBoolean("deleted")) null else reminder?.optString("state")
            val at = reminder?.optString("at") ?: ""
            val wantedId = if (state == "scheduled") ReminderMath.notificationId(noteId, at) else null
            val saved = savedFor(storage, noteId)

            // fired and waiting for the user: leave the visible notification alone
            if (state == "due") continue
            for ((id, _) in saved) if (id != wantedId) manager.cancel(listOf(id))
            if (state == "done") ReminderMath.notificationId(noteId, at)?.let { manager.cancel(listOf(it)) }

            val atMs = ReminderMath.parseInstant(at)
            if (wantedId != null && atMs != null && atMs > now && enabled && saved.none { it.first == wantedId }) {
                schedule(manager, storage, wantedId, noteId, at, atMs, titles.optString(noteId, ""))
            }
        }

        // a title that arrived after its reminder (or changed): re-plan with the new text
        if (enabled) {
            for (noteId in renamed - touched) {
                for ((id, at) in savedFor(storage, noteId)) {
                    val atMs = ReminderMath.parseInstant(at) ?: continue
                    if (atMs > now) schedule(manager, storage, id, noteId, at, atMs, titles.optString(noteId, ""))
                }
            }
        }
    }

    /** (notification id, reminder `at`) of the alarms stored for a note. */
    private fun savedFor(storage: NotificationStorage, noteId: String): List<Pair<Int, String>> =
        storage.getSavedNotifications().mapNotNull { n ->
            val extra = n.extra ?: return@mapNotNull null
            if (extra.optString("noteId") != noteId) null else n.id to extra.optString("at")
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
