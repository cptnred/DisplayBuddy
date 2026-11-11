package de.displaybuddy.push

/**
 * Address rule of the background sync, identical to `server_url::normalize` in
 * mobile/src-tauri/src/server_url.rs (PLAN_V4 §7.2, D-107 „Folgen für v4“): an origin without
 * path, query, fragment or user info; `https://`, plain `http://` only for loopback hosts and the
 * emulator's host alias 10.0.2.2. The service talks to the server with HttpURLConnection, past
 * the Tauri HTTP scope – this check is its only protection. Pure Kotlin (JVM unit test).
 */
internal object ServerUrl {
    private val PLAIN_HTTP_HOSTS = setOf("localhost", "127.0.0.1", "[::1]", "10.0.2.2")

    /** Normalised origin (`scheme://host[:port]`, lower case, no trailing slash) or null. */
    fun normalize(raw: String): String? {
        val url = raw.trim().trimEnd('/')
        val sep = url.indexOf("://")
        if (sep < 0) return null
        val scheme = url.substring(0, sep).lowercase()
        val rest = url.substring(sep + 3)
        if (rest.isEmpty() || rest.any { it in "/?#@*" || it.isWhitespace() }) return null
        val host = rest.lowercase()
        val hostOnly: String
        val port: String?
        if (host.startsWith("[")) {
            val end = host.indexOf(']')
            if (end < 0) return null
            hostOnly = host.substring(0, end + 1)
            val after = host.substring(end + 1)
            port = when {
                after.startsWith(":") -> after.substring(1)
                after.isEmpty() -> null
                else -> return null
            }
        } else {
            val colon = host.lastIndexOf(':')
            hostOnly = if (colon < 0) host else host.substring(0, colon)
            port = if (colon < 0) null else host.substring(colon + 1)
        }
        if (port != null && (port.isEmpty() || port.length > 5 || !port.all { it in '0'..'9' })) return null
        if (!hostOnly.startsWith("[") && hostOnly.contains(':')) return null
        if (hostOnly.isEmpty()) return null
        val allowed = scheme == "https" || (scheme == "http" && hostOnly in PLAIN_HTTP_HOSTS)
        return if (allowed) "$scheme://$host" else null
    }
}
