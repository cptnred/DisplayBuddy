package de.displaybuddy.push

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * What the background sync needs between runs: server address, the device token
 * (AES-GCM with a non-exportable Android Keystore key, never logged), the sync cursor,
 * the note titles and the occurrences already planned. App-private storage only.
 */
internal class BackgroundSettings(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    val baseUrl: String? get() = prefs.getString(KEY_URL, null)

    fun token(): String? {
        val stored = prefs.getString(KEY_TOKEN, null) ?: return null
        return try {
            decrypt(stored)
        } catch (_: Exception) {
            null
        }
    }

    fun isConfigured(): Boolean = baseUrl != null && token() != null

    /**
     * Changes with every new or removed account. A sync that started under an older generation
     * must not write its cursor/titles or clear credentials any more ([commit], [clearIf]).
     */
    fun generation(): Long = generation

    /** Stores the account; a different server or token starts with an empty state. */
    fun configure(baseUrl: String, token: String) = synchronized(lock) {
        val same = this.baseUrl == baseUrl && token() == token
        val editor = prefs.edit().putString(KEY_URL, baseUrl).putString(KEY_TOKEN, encrypt(token))
        if (!same) {
            editor.remove(KEY_CURSOR).remove(KEY_TITLES)
            generation++
        }
        editor.apply()
    }

    fun clear() = synchronized(lock) {
        prefs.edit().clear().apply()
        generation++
    }

    /** Clears the account only if it is still the one generation [gen] belongs to. */
    fun clearIf(gen: Long) = synchronized(lock) {
        if (gen == generation) {
            prefs.edit().clear().apply()
            generation++
        }
    }

    val cursor: Long get() = prefs.getLong(KEY_CURSOR, 0L)

    /** noteId → title of the notification. */
    fun titles(): JSONObject = readObject(KEY_TITLES)

    /** Stores the progress of a sync run; false (and nothing written) if the account changed meanwhile. */
    fun commit(gen: Long, cursor: Long?, titles: JSONObject?): Boolean = synchronized(lock) {
        if (gen != generation) return false
        val editor = prefs.edit()
        if (cursor != null) editor.putLong(KEY_CURSOR, cursor)
        if (titles != null) editor.putString(KEY_TITLES, titles.toString())
        editor.apply()
        true
    }

    /** Forgets cursor and titles (cursor too old for the server); false if the account changed meanwhile. */
    fun resetState(gen: Long): Boolean = synchronized(lock) {
        if (gen != generation) return false
        prefs.edit().remove(KEY_CURSOR).remove(KEY_TITLES).apply()
        true
    }

    private fun readObject(key: String): JSONObject =
        try {
            JSONObject(prefs.getString(key, null) ?: "{}")
        } catch (_: Exception) {
            JSONObject()
        }

    private fun secretKey(): SecretKey {
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val sealed = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(cipher.iv + sealed, Base64.NO_WRAP)
    }

    private fun decrypt(stored: String): String {
        val bytes = Base64.decode(stored, Base64.NO_WRAP)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, bytes, 0, IV_BYTES))
        return String(cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES), Charsets.UTF_8)
    }

    private companion object {
        val lock = Any()

        @Volatile
        var generation = 0L

        const val FILE = "buddy_background_sync"
        const val KEY_URL = "baseUrl"
        const val KEY_TOKEN = "token"
        const val KEY_CURSOR = "cursor"
        const val KEY_TITLES = "titles"
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "buddy_background_sync_token"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
    }
}
