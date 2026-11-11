package de.displaybuddy.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Same cases as the Rust tests in mobile/src-tauri/src/server_url.rs (+ PLAN_V4 §13 no. 31). */
class ServerUrlTest {
    @Test
    fun acceptsHttpsOrigins() {
        assertEquals("https://buddy.example.org", ServerUrl.normalize(" https://Buddy.Example.org/ "))
        assertEquals("https://buddy.example.org:8443", ServerUrl.normalize("https://buddy.example.org:8443"))
        assertEquals("https://beispiel.de", ServerUrl.normalize("https://beispiel.de"))
    }

    @Test
    fun plainHttpOnlyForLoopbackAndEmulatorHost() {
        assertEquals("http://10.0.2.2:8080", ServerUrl.normalize("http://10.0.2.2:8080"))
        assertEquals("http://localhost:8080", ServerUrl.normalize("http://localhost:8080"))
        assertEquals("http://[::1]:8080", ServerUrl.normalize("http://[::1]:8080"))
        assertNull(ServerUrl.normalize("http://buddy.example.org"))
        assertNull(ServerUrl.normalize("http://192.168.1.2:8080"))
        assertNull(ServerUrl.normalize("http://beispiel.de"))
    }

    @Test
    fun rejectsPathsCredentialsWildcardsAndGarbage() {
        for (bad in listOf(
            "",
            "buddy.example.org",
            "https://",
            "https://buddy.example.org/api",
            "https://beispiel.de/pfad",
            "https://buddy.example.org?x=1",
            "https://buddy.example.org#c=1",
            "https://user@buddy.example.org",
            "https://*.example.org",
            "https://buddy.example.org:abc",
            "ftp://buddy.example.org",
            "https://buddy example.org",
        )) {
            assertNull(bad, ServerUrl.normalize(bad))
        }
    }
}
