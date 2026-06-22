package com.mark.phonenotify

import android.app.Notification
import android.app.RemoteInput
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import org.json.JSONObject

/**
 * NotificationService.kt
 * ───────────────────────
 * Intercepts every Android status-bar notification and forwards it as JSON
 * to the relay server via WebSocketManager.
 *
 * ── Android lifecycle ──
 *   Android automatically binds/unbinds this service when the user toggles
 *   the Notification Access switch:
 *     Settings → Apps → Special app access → Notification access → Phone Notify
 *
 *   The app must NOT call startService() or bindService() — the OS handles binding.
 *
 * ── Filtering ──
 *   System packages (Android OS, SystemUI, GMS) generate constant low-value
 *   notifications (charging, USB, sync). These are excluded via IGNORED_PACKAGES.
 *   Notifications with no title AND no body text are also skipped.
 *
 * ── JSON schema (type = "notification") ──
 *   {
 *     "type":      "notification",
 *     "app":       "WhatsApp",
 *     "package":   "com.whatsapp",
 *     "title":     "John Doe",
 *     "message":   "Hey! Are you free?",
 *     "timestamp": 1718900000000
 *   }
 *
 * ── JSON schema (type = "notification_removed") ──
 *   {
 *     "type":      "notification_removed",
 *     "package":   "com.whatsapp",
 *     "timestamp": 1718900005000
 *   }
 */
class NotificationService : NotificationListenerService() {

    companion object {
        private const val TAG = "PhoneNotify:NS"

        // ── JSON type field values ──────────────────────────────────────────────

        private const val TYPE_NOTIFICATION = "notification"
        private const val TYPE_REMOVED      = "notification_removed"

        // ── System package filter ───────────────────────────────────────────────

        /**
         * Packages whose notifications are silently dropped.
         * These produce high-volume, low-value system events (charging,
         * USB, Wi-Fi, background sync, etc.) that would clutter the dashboard.
         *
         * Add more entries as needed for your device.
         */
        private val IGNORED_PACKAGES = setOf(
            "android",
            "com.android.systemui",
            "com.android.settings",
            "com.android.phone",
            "com.android.dialer",
            "com.android.bluetooth",
            "com.google.android.gms",         // Google Play Services
            "com.google.android.gsf",         // Google Services Framework
            "com.android.providers.downloads", // Download manager
            "org.kde.kdeconnect_tp",          // KDE Connect
            "org.kde.kdeconnect"              // KDE Connect Fallback
        )

        // ── Shared state ────────────────────────────────────────────────────────

        /**
         * Total notifications captured (not necessarily sent) this session.
         * Incremented every time a valid notification passes all filters.
         * Does not reset if the WebSocket reconnects.
         */
        @Volatile
        var notificationCount: Int = 0
            private set

        /**
         * Callback fired on the **main thread** whenever [notificationCount] changes.
         * Set this in MainActivity.onCreate() to keep the counter widget up to date.
         */
        var onCountChanged: ((Int) -> Unit)? = null

        /** Cache of active notifications for quick replies */
        val activeNotificationsMap = java.util.concurrent.ConcurrentHashMap<String, StatusBarNotification>()

        @Volatile
        var contextRef: android.content.Context? = null

        @Volatile
        var instance: NotificationService? = null

        /**
         * Find and execute the remote input reply action on an active notification.
         */
        fun replyToNotification(key: String, replyText: String): Boolean {
            Log.d(TAG, "replyToNotification: key=$key, text=$replyText")
            val ctx = contextRef ?: run {
                Log.w(TAG, "Cannot send reply: contextRef is null")
                return false
            }

            val sbn = activeNotificationsMap[key] ?: run {
                Log.w(TAG, "Notification key not found in active cache: $key")
                return false
            }

            val actions = sbn.notification?.actions ?: run {
                Log.w(TAG, "Notification has no actions")
                return false
            }

            var replyAction: Notification.Action? = null
            var replyInput: android.app.RemoteInput? = null

            for (action in actions) {
                val inputs = action.remoteInputs ?: continue
                for (input in inputs) {
                    if (input.resultKey != null) {
                        replyAction = action
                        replyInput = input
                        break
                    }
                }
                if (replyAction != null) break
            }

            if (replyAction == null || replyInput == null) {
                Log.w(TAG, "No direct reply action found in notification")
                return false
            }

            try {
                val resultsBundle = Bundle().apply {
                    putCharSequence(replyInput.resultKey, replyText)
                }

                val intent = Intent().apply {
                    addFlags(Intent.FLAG_RECEIVER_FOREGROUND)
                }
                
                android.app.RemoteInput.addResultsToIntent(
                    arrayOf(replyInput),
                    intent,
                    resultsBundle
                )

                replyAction.actionIntent.send(ctx, 0, intent)
                Log.i(TAG, "Successfully triggered reply action for notification: $key")
                return true
            } catch (e: Exception) {
                Log.e(TAG, "Failed to send reply pending intent: ${e.message}", e)
                return false
            }
        }
    }

    // Main-thread handler for delivering callbacks
    private val mainHandler = Handler(Looper.getMainLooper())

    // ── Lifecycle ───────────────────────────────────────────────────────────────

    override fun onListenerConnected() {
        super.onListenerConnected()
        Log.i(TAG, "NotificationListenerService connected — capturing notifications.")
        contextRef = applicationContext
        instance = this

        // Auto-connect to relay server using saved settings if not already connected
        val settings = SettingsManager(this)
        val ip = settings.ipAddress
        val port = settings.port
        if (ip.isNotEmpty() && !WebSocketManager.isConnected()) {
            Log.i(TAG, "Auto-connecting to $ip:$port from NotificationService")
            WebSocketManager.connect(ip, port)
        }
    }

    /**
     * Called if the listener is forcibly unbound by Android (rare, e.g. after
     * a system permission change). The OS will rebind automatically if the
     * permission is still active.
     */
    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        Log.w(TAG, "NotificationListenerService disconnected — rebind expected.")
        contextRef = null
        instance = null
    }

    // ── Notification events ─────────────────────────────────────────────────────

    /**
     * Fired by Android every time a new notification is posted (or updated) in
     * the status bar. This is the main capture point.
     *
     * Processing pipeline:
     *   1. Null guard on the StatusBarNotification
     *   2. Skip ignored system packages
     *   3. Extract title + body from Notification.extras
     *   4. Skip empty notifications (silent background updates)
     *   5. Resolve human-readable app name via PackageManager
     *   6. Build JSON payload
     *   7. Send via WebSocketManager (queued if offline)
     *   8. Increment capture counter → notify MainActivity
     *
     * @param sbn The notification that was just posted. Never call sbn.cancel() here.
     */
    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        sbn ?: return // null safety

        val packageName = sbn.packageName ?: return

        // ── Step 2: Package filter ────────────────────────────────────────────
        if (packageName in IGNORED_PACKAGES) {
            Log.v(TAG, "Ignored: $packageName")
            return
        }

        // ── Step 3: Extract content ───────────────────────────────────────────
        val extras  = sbn.notification?.extras ?: return
        val title   = extras.getString(Notification.EXTRA_TITLE)?.trim().orEmpty()
        
        var message = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim().orEmpty()
        
        // 1. Try Big Text (expanded body)
        val bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()?.trim().orEmpty()
        if (bigText.isNotEmpty() && bigText.length > message.length) {
            message = bigText
        }
        
        // 2. Try Text Lines (Inbox style with multiple emails list)
        val textLines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)
        if (textLines != null && textLines.isNotEmpty()) {
            val joinedLines = textLines.joinToString("\n") { it.toString().trim() }
            if (joinedLines.length > message.length) {
                message = joinedLines
            }
        }

        // Skip group summaries to prevent duplicate group cards
        if (sbn.notification?.flags?.and(Notification.FLAG_GROUP_SUMMARY) != 0) {
            Log.v(TAG, "Skipped (group summary): $packageName")
            return
        }

        // ── Step 4: Empty content filter ──────────────────────────────────────
        if (title.isEmpty() && message.isEmpty()) {
            Log.v(TAG, "Skipped (empty): $packageName")
            return
        }

        // ── Cache notification in active registry for quick replies ───────────
        activeNotificationsMap[sbn.key] = sbn

        // Check if notification has a Direct Reply remote input action
        val replyable = sbn.notification?.actions?.any { action ->
            action.remoteInputs?.any { input -> input.resultKey != null } == true
        } == true

        // ── Step 5: Resolve app name ──────────────────────────────────────────
        val appName   = resolveAppName(packageName)
        val timestamp = sbn.postTime

        Log.i(TAG, "Captured [$appName] \"$title\" — \"${message.take(60)}\" (replyable=$replyable)")

        // ── Step 6: Build JSON payload ────────────────────────────────────────
        val payload = JSONObject().apply {
            put("type",      TYPE_NOTIFICATION)
            put("key",       sbn.key)
            put("app",       appName)
            put("package",   packageName)
            put("title",     title)
            put("message",   message)
            put("timestamp", timestamp)
            put("replyable", replyable)
        }

        // ── Step 7: Send via WebSocketManager ────────────────────────────────
        val sent = WebSocketManager.send(payload.toString())
        Log.d(TAG, if (sent) "→ Sent immediately" else "→ Queued (offline, queue=${WebSocketManager.queueSize()})")

        // ── Step 8: Increment capture counter ────────────────────────────────
        notificationCount++
        val currentCount = notificationCount
        mainHandler.post { onCountChanged?.invoke(currentCount) }
    }

    /**
     * Fired when a notification is dismissed (swiped, auto-cancelled, or removed
     * programmatically by the originating app).
     *
     * Sends a lightweight removal event so the Chrome extension dashboard can
     * remove the corresponding card from its notification list.
     *
     * @param sbn The notification that was removed.
     */
    override fun onNotificationRemoved(sbn: StatusBarNotification?) {
        sbn ?: return
        val packageName = sbn.packageName ?: return
        if (packageName in IGNORED_PACKAGES) return

        // Remove from our active cache
        activeNotificationsMap.remove(sbn.key)

        val payload = JSONObject().apply {
            put("type",      TYPE_REMOVED)
            put("key",       sbn.key)
            put("package",   packageName)
            put("timestamp", System.currentTimeMillis())
        }

        val sent = WebSocketManager.send(payload.toString())
        Log.d(TAG, "Removed [$packageName] ${if (sent) "→ sent" else "→ queued"}")
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    /**
     * Resolves a human-readable application label from a package name.
     *
     * Examples:
     *   "com.whatsapp"               → "WhatsApp"
     *   "org.telegram.messenger"     → "Telegram"
     *   "com.google.android.gm"      → "Gmail"
     *   "com.unknown.app"            → "com.unknown.app"  (fallback)
     *
     * Handles the breaking API change in Android 13 (API 33) where
     * getApplicationInfo() requires ApplicationInfoFlags instead of an int.
     *
     * @param packageName Package name from StatusBarNotification.getPackageName()
     * @return Human-readable app label, or the raw package name as fallback.
     */
    private fun resolveAppName(packageName: String): String {
        return try {
            val pm: PackageManager = applicationContext.packageManager

            val appInfo: ApplicationInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                // Android 13+: use the new flags-based overload
                pm.getApplicationInfo(
                    packageName,
                    PackageManager.ApplicationInfoFlags.of(0L)
                )
            } else {
                // Android 8–12: legacy overload (deprecated in API 33 but still works)
                @Suppress("DEPRECATION")
                pm.getApplicationInfo(packageName, 0)
            }

            pm.getApplicationLabel(appInfo).toString()

        } catch (e: PackageManager.NameNotFoundException) {
            // App was uninstalled between notification arriving and this call — very rare.
            Log.w(TAG, "Could not resolve app name for '$packageName': ${e.message}")
            packageName
        }
    }

    fun sendActiveNotifications() {
        try {
            val activeNotifs = activeNotifications
            if (activeNotifs != null) {
                Log.i(TAG, "Syncing ${activeNotifs.size} active notifications...")
                for (sbn in activeNotifs) {
                    onNotificationPosted(sbn)
                }
            } else {
                Log.d(TAG, "No active notifications to sync")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error syncing active notifications: ${e.message}", e)
        }
    }
}
