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
 * Persisted settings:
 *   - Last used IP address (e.g. "192.168.1.50")
 *   - Last used port      (e.g. "8080")
 *
 * Usage:
 *   val settings = SettingsManager(context)
 *
 *   // Read saved values
 *   val ip   = settings.ipAddress    // "" if never set
 *   val port = settings.port         // "8080" default
 *
 *   // Persist new values
 *   settings.ipAddress = "192.168.1.50"
 *   settings.port      = "9090"
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

        // Defaults
        const val DEFAULT_PORT         = "8080"
        const val DEFAULT_IP           = ""

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

    // ── Convenience ────────────────────────────────────────────────────────────

    /**
     * Save both IP and port in a single call.
     * Preferred over setting each property individually to avoid two disk writes.
     *
     * @param ip   IP address string (e.g. "192.168.1.50")
     * @param port Port string (e.g. "8080")
     */
    fun saveConnection(ip: String, port: String) {
        val sanitizedIp   = ip.trim()
        val sanitizedPort = port.trim().ifEmpty { DEFAULT_PORT }
        prefs.edit()
            .putString(KEY_IP,   sanitizedIp)
            .putString(KEY_PORT, sanitizedPort)
            .apply()
        Log.d(TAG, "Saved connection: $sanitizedIp:$sanitizedPort")
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
