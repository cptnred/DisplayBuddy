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

    /** Stores the account; a different server or token starts with an empty state. */
    fun configure(baseUrl: String, token: String) {
        val same = this.baseUrl == baseUrl && token() == token
        val editor = prefs.edit().putString(KEY_URL, baseUrl).putString(KEY_TOKEN, encrypt(token))
        if (!same) editor.remove(KEY_CURSOR).remove(KEY_TITLES)
        editor.apply()
    }

    fun clear() {
        prefs.edit().clear().apply()
    }

    var cursor: Long
        get() = prefs.getLong(KEY_CURSOR, 0L)
        set(value) = prefs.edit().putLong(KEY_CURSOR, value).apply()

    /** noteId → title of the notification. */
    fun titles(): JSONObject = readObject(KEY_TITLES)

    fun saveTitles(value: JSONObject) = prefs.edit().putString(KEY_TITLES, value.toString()).apply()

    fun resetState() {
        prefs.edit().remove(KEY_CURSOR).remove(KEY_TITLES).apply()
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
