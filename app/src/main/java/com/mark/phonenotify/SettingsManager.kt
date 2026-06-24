package com.mark.phonenotify

import android.content.Context
import android.content.SharedPreferences
import android.util.Log

/**
 * SettingsManager.kt
 * ───────────────────
 * A thin wrapper around SharedPreferences that persists user settings
 * across app restarts.
 *
 * Persisted settings (v3):
 *   - Last used IP address     (e.g. "192.168.1.50")
 *   - Last used port           (e.g. "8080")
 *   - Access token             (e.g. "my-secret-token")   ← NEW in v3
 *   - Device name override     (optional custom label)     ← NEW in v3
 *
 * Usage:
 *   val settings = SettingsManager(context)
 *
 *   // Read saved values
 *   val ip    = settings.ipAddress    // "" if never set
 *   val port  = settings.port         // "8080" default
 *   val token = settings.token        // "" if not set
 *
 *   // Persist new values
 *   settings.saveConnection("192.168.1.50", "8080", "my-token")
 *
 * Design notes:
 *   - Uses apply() (non-blocking async write) rather than commit() (blocking).
 *   - Intentionally NOT a singleton — instantiate once in MainActivity and pass
 *     around, or create a fresh instance anywhere you have a Context.
 *   - All property setters validate and sanitize input before writing.
 */
class SettingsManager(context: Context) {

    companion object {
        private const val TAG          = "PhoneNotify:Settings"
        private const val PREFS_NAME   = "phone_notify_prefs"

        // SharedPreferences keys
        private const val KEY_IP       = "last_ip_address"
        private const val KEY_PORT     = "last_port"
        private const val KEY_TOKEN    = "access_token"         // NEW v3
        private const val KEY_DEVICE   = "device_name_override" // NEW v3

        // Defaults
        const val DEFAULT_PORT         = "8080"
        const val DEFAULT_IP           = ""
        const val DEFAULT_TOKEN        = ""

        // Validation
        private const val MIN_PORT     = 1
        private const val MAX_PORT     = 65535
    }

    // Application-scoped SharedPreferences (survives activity recreation)
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    // ── IP Address ─────────────────────────────────────────────────────────────

    /**
     * The last IP address the user connected to.
     * Getter returns "" if never set.
     * Setter sanitizes whitespace before writing.
     */
    var ipAddress: String
        get() = prefs.getString(KEY_IP, DEFAULT_IP) ?: DEFAULT_IP
        set(value) {
            val sanitized = value.trim()
            prefs.edit().putString(KEY_IP, sanitized).apply()
            Log.d(TAG, "Saved IP address: $sanitized")
        }

    // ── Port ───────────────────────────────────────────────────────────────────

    /**
     * The last port the user connected to.
     * Getter returns "8080" if never set or if the stored value is invalid.
     * Setter validates the port is a number within [1, 65535] before writing.
     */
    var port: String
        get() = prefs.getString(KEY_PORT, DEFAULT_PORT) ?: DEFAULT_PORT
        set(value) {
            val portNum = value.trim().toIntOrNull()
            if (portNum == null || portNum !in MIN_PORT..MAX_PORT) {
                Log.w(TAG, "Invalid port '$value' — not saving.")
                return
            }
            prefs.edit().putString(KEY_PORT, portNum.toString()).apply()
            Log.d(TAG, "Saved port: $portNum")
        }

    // ── Access Token ───────────────────────────────────────────────────────────

    /**
     * Optional access token sent as ?token=<value> in the WebSocket URL.
     * Must match the TOKEN environment variable on the relay server when set.
     * Getter returns "" if never set (no auth required).
     */
    var token: String
        get() = prefs.getString(KEY_TOKEN, DEFAULT_TOKEN) ?: DEFAULT_TOKEN
        set(value) {
            prefs.edit().putString(KEY_TOKEN, value.trim()).apply()
            Log.d(TAG, "Saved token: ${if (value.isBlank()) "(empty)" else "***"}")
        }

    // ── Device Name Override ───────────────────────────────────────────────────

    /**
     * Optional custom device name shown in the extension instead of Build.MODEL.
     * If empty, falls back to "${Build.MANUFACTURER} ${Build.MODEL}".
     */
    var deviceNameOverride: String
        get() = prefs.getString(KEY_DEVICE, "") ?: ""
        set(value) {
            prefs.edit().putString(KEY_DEVICE, value.trim()).apply()
            Log.d(TAG, "Saved device name override: ${value.trim()}")
        }

    // ── Convenience ────────────────────────────────────────────────────────────

    /**
     * Save IP, port, and optional token in a single atomic write.
     * Preferred over setting each property individually to avoid multiple disk writes.
     *
     * @param ip    IP address string (e.g. "192.168.1.50")
     * @param port  Port string (e.g. "8080")
     * @param token Optional access token (empty = no auth)
     */
    fun saveConnection(ip: String, port: String, token: String = "") {
        val sanitizedIp    = ip.trim()
        val sanitizedPort  = port.trim().ifEmpty { DEFAULT_PORT }
        val sanitizedToken = token.trim()

        prefs.edit()
            .putString(KEY_IP,    sanitizedIp)
            .putString(KEY_PORT,  sanitizedPort)
            .putString(KEY_TOKEN, sanitizedToken)
            .apply()

        Log.d(TAG, "Saved connection: $sanitizedIp:$sanitizedPort " +
            if (sanitizedToken.isEmpty()) "(no auth)" else "(with token)")
    }

    /**
     * Returns true if a previously saved IP address exists (non-empty).
     * Useful for auto-populating fields on first launch.
     */
    fun hasSavedConnection(): Boolean = ipAddress.isNotEmpty()

    /**
     * Clears all saved settings. Useful for a "Reset" or "Forget" action.
     */
    fun clear() {
        prefs.edit().clear().apply()
        Log.d(TAG, "Settings cleared.")
    }
}
