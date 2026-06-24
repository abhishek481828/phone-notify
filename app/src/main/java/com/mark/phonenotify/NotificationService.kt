package com.mark.phonenotify

import android.app.Notification
import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import android.content.Intent
import android.os.BatteryManager
import android.content.ClipData
import android.content.ClipboardManager
import android.widget.Toast
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import androidx.core.app.NotificationCompat

/**
 * NotificationService.kt — v3
 * ────────────────────────────
 * Intercepts every Android status-bar notification and forwards it as JSON
 * to the relay server via WebSocketManager.
 *
 * ── v3 changes ──
 *   1. Call packages (com.android.phone, com.android.dialer) REMOVED from
 *      IGNORED_PACKAGES — calls now appear as notification cards in the extension.
 *   2. deviceName and androidVersion added to every notification payload so the
 *      extension can show which device sent the notification.
 *   3. Companion-object helpers sendBatteryStatus() and sendCallStatus() added
 *      so MainActivity can relay phone state events without accessing this service.
 *   4. Group summary filter tightened to allow call-related summaries through.
 *
 * ── JSON schema (type = "notification") v3 ──
 *   {
 *     "type":           "notification",
 *     "app":            "WhatsApp",
 *     "package":        "com.whatsapp",
 *     "title":          "John Doe",
 *     "message":        "Hey! Are you free?",
 *     "timestamp":      1718900000000,
 *     "replyable":      true,
 *     "deviceName":     "Samsung Galaxy S23",   ← NEW
 *     "androidVersion": "14"                    ← NEW
 *   }
 *
 * ── JSON schema (type = "battery") ──
 *   { "type": "battery", "level": 72, "charging": true,
 *     "deviceName": "…", "timestamp": … }
 *
 * ── JSON schema (type = "call") ──
 *   { "type": "call", "state": "ringing",
 *     "callerNumber": "+91 98765 43210",
 *     "callerName": "Jane Doe",              (if in contacts, else empty)
 *     "deviceName": "…", "timestamp": … }
 */
class NotificationService : NotificationListenerService() {

    companion object {
        private const val TAG = "PhoneNotify:NS"

        private const val TYPE_NOTIFICATION = "notification"
        private const val TYPE_REMOVED      = "notification_removed"

        // ── System package filter ───────────────────────────────────────────────
        //
        // NOTE v3: "com.android.phone" and "com.android.dialer" are NO LONGER
        // ignored. This allows incoming call notifications to appear as cards in
        // the Chrome extension. Call state is also sent separately via
        // sendCallStatus() from MainActivity's TelephonyManager listener.

        private val IGNORED_PACKAGES = setOf(
            "android",
            "com.android.systemui",
            "com.android.settings",
            // "com.android.phone"   — REMOVED in v3 (send call notifications)
            // "com.android.dialer"  — REMOVED in v3 (send call notifications)
            "com.android.bluetooth",
            "com.google.android.gms",          // Google Play Services
            "com.google.android.gsf",          // Google Services Framework
            "com.android.providers.downloads", // Download manager
            "org.kde.kdeconnect_tp",           // KDE Connect
            "org.kde.kdeconnect"               // KDE Connect Fallback
        )

        // ── Shared state ────────────────────────────────────────────────────────

        @Volatile
        var notificationCount: Int = 0
            private set

        var onCountChanged: ((Int) -> Unit)? = null

        val activeNotificationsMap = java.util.concurrent.ConcurrentHashMap<String, StatusBarNotification>()

        @Volatile
        var contextRef: android.content.Context? = null

        @Volatile
        var instance: NotificationService? = null

        // ── Device identity (computed once, cached) ────────────────────────────

        private val deviceName: String by lazy {
            val mfr   = Build.MANUFACTURER.replaceFirstChar { it.uppercase() }
            val model = Build.MODEL
            // Avoid redundant manufacturer prefix (e.g. "Samsung Samsung S23")
            if (model.startsWith(mfr, ignoreCase = true)) model else "$mfr $model"
        }

        private val androidVersion: String = Build.VERSION.RELEASE

        private const val CLIPBOARD_CHANNEL_ID = "clipboard_channel"
        private const val CLIPBOARD_NOTIF_ID = 9999

        fun createNotificationChannel(context: android.content.Context) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val name = "Clipboard Sync"
                val descriptionText = "Notifications for clipboard sync from laptop"
                val importance = android.app.NotificationManager.IMPORTANCE_HIGH
                val channel = android.app.NotificationChannel(CLIPBOARD_CHANNEL_ID, name, importance).apply {
                    description = descriptionText
                }
                val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
                notificationManager.createNotificationChannel(channel)
            }
        }

        fun showClipboardNotification(context: android.content.Context, text: String) {
            createNotificationChannel(context)

            val copyIntent = Intent("com.mark.phonenotify.ACTION_COPY").apply {
                `package` = context.packageName
                putExtra("text", text)
                putExtra("notification_id", CLIPBOARD_NOTIF_ID)
            }
            
            val flag = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
            } else {
                android.app.PendingIntent.FLAG_UPDATE_CURRENT
            }

            val pendingCopyIntent = android.app.PendingIntent.getBroadcast(
                context,
                0,
                copyIntent,
                flag
            )

            val builder = NotificationCompat.Builder(context, CLIPBOARD_CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_menu_save)
                .setContentTitle("Clipboard from Laptop")
                .setContentText(if (text.length > 60) text.take(60) + "…" else text)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setContentIntent(pendingCopyIntent)
                .addAction(android.R.drawable.ic_menu_save, "Copy to Clipboard", pendingCopyIntent)

            val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
            notificationManager.notify(CLIPBOARD_NOTIF_ID, builder.build())
        }

        fun handleClipboardReceived(text: String) {
            val ctx = contextRef ?: return
            
            // 1. Try to set clipboard directly (this works if the app is currently in the foreground/active)
            try {
                val clipboard = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                clipboard.setPrimaryClip(ClipData.newPlainText("Phone Notify", text))
                
                Handler(Looper.getMainLooper()).post {
                    Toast.makeText(ctx, "📋 Clipboard synced from browser", Toast.LENGTH_SHORT).show()
                }
                Log.i(TAG, "📋 Clipboard set directly in foreground: ${text.take(40)}")
                return
            } catch (e: Exception) {
                Log.d(TAG, "Direct background clipboard set denied: ${e.message}")
            }

            // 2. Fallback: Show a system notification so the user can tap to copy
            showClipboardNotification(ctx, text)
        }

        fun handleMediaControl(action: String) {
            val ctx = contextRef ?: run {
                Log.w(TAG, "Cannot handle media control: contextRef is null")
                return
            }
            val keyCode = when (action.lowercase()) {
                "play_pause", "play", "pause", "toggle" -> android.view.KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
                "next"                                   -> android.view.KeyEvent.KEYCODE_MEDIA_NEXT
                "prev", "previous"                       -> android.view.KeyEvent.KEYCODE_MEDIA_PREVIOUS
                "stop"                                   -> android.view.KeyEvent.KEYCODE_MEDIA_STOP
                else -> {
                    Log.w(TAG, "Unknown media action: $action")
                    return
                }
            }

            try {
                val am = ctx.getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager
                val now = android.os.SystemClock.uptimeMillis()

                am.dispatchMediaKeyEvent(android.view.KeyEvent(now, now, android.view.KeyEvent.ACTION_DOWN, keyCode, 0))
                android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                    am.dispatchMediaKeyEvent(android.view.KeyEvent(now, android.os.SystemClock.uptimeMillis(), android.view.KeyEvent.ACTION_UP, keyCode, 0))
                }, 100)

                Log.i(TAG, "Media key dispatched via service: $action → keyCode=$keyCode")
            } catch (e: Exception) {
                Log.e(TAG, "handleMediaControl failed: ${e.message}", e)
            }
        }

        // ── Static senders (called from MainActivity) ──────────────────────────

        /**
         * Send current battery status to the relay server.
         * Called by MainActivity's BroadcastReceiver when battery state changes.
         *
         * @param level     Battery percentage 0–100
         * @param charging  True if plugged in and charging (or full)
         */
        fun sendBatteryStatus(level: Int, charging: Boolean) {
            val json = JSONObject().apply {
                put("type",           "battery")
                put("level",          level)
                put("charging",       charging)
                put("deviceName",     deviceName)
                put("androidVersion", androidVersion)
                put("timestamp",      System.currentTimeMillis())
            }
            val sent = WebSocketManager.send(json.toString())
            Log.d(TAG, "Battery status: ${level}% charging=$charging ${if (sent) "→ sent" else "→ queued"}")
        }

        /**
         * Fetch current sticky battery status and transmit it to the server.
         */
        fun sendCurrentBatteryStatus(context: android.content.Context) {
            try {
                val filter = android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED)
                val batteryStatusIntent = context.registerReceiver(null, filter)
                if (batteryStatusIntent != null) {
                    val level = batteryStatusIntent.getIntExtra(android.os.BatteryManager.EXTRA_LEVEL, -1)
                    val scale = batteryStatusIntent.getIntExtra(android.os.BatteryManager.EXTRA_SCALE, 100)
                    val status = batteryStatusIntent.getIntExtra(android.os.BatteryManager.EXTRA_STATUS, -1)
                    val charging = status == android.os.BatteryManager.BATTERY_STATUS_CHARGING ||
                                   status == android.os.BatteryManager.BATTERY_STATUS_FULL
                    if (level >= 0 && scale > 0) {
                        val pct = (level * 100) / scale
                        sendBatteryStatus(pct, charging)
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to send current battery status: ${e.message}")
            }
        }

        /**
         * Send a call state update to the relay server.
         * Called by MainActivity's PhoneStateListener / TelephonyCallback.
         *
         * @param state         "ringing" | "answered" | "ended" | "missed"
         * @param callerNumber  Raw phone number string (may be empty for private numbers)
         * @param callerName    Resolved contact name, or empty if not in contacts
         */
        fun sendCallStatus(state: String, callerNumber: String = "", callerName: String = "") {
            val json = JSONObject().apply {
                put("type",           "call")
                put("state",          state)
                put("callerNumber",   callerNumber)
                put("callerName",     callerName)
                put("deviceName",     deviceName)
                put("androidVersion", androidVersion)
                put("timestamp",      System.currentTimeMillis())
            }
            val sent = WebSocketManager.send(json.toString())
            Log.i(TAG, "Call status: state=$state caller=$callerNumber ${if (sent) "→ sent" else "→ queued"}")
        }

        /**
         * Send current media playback status to the relay server.
         * Called from onNotificationPosted() when a MediaSession token is found
         * in the notification extras. Uses MediaController to read live metadata.
         *
         * Requires no extra permissions — NotificationListenerService already has
         * access to MediaSession tokens attached to visible notifications.
         *
         * @param token    MediaSession.Token from notification extras
         * @param pkg      Package name of the media app
         * @param appName  Human-readable app name
         * @param context  Context for MediaController constructor
         */
        @Suppress("DEPRECATION")
        fun sendMediaStatus(
            token: android.media.session.MediaSession.Token,
            pkg: String,
            appName: String,
            context: android.content.Context
        ) {
            try {
                val controller = android.media.session.MediaController(context, token)
                val metadata   = controller.metadata ?: return

                val title  = metadata.getString(android.media.MediaMetadata.METADATA_KEY_TITLE)
                if (title.isNullOrBlank()) return   // skip if no title

                val artist = metadata.getString(android.media.MediaMetadata.METADATA_KEY_ARTIST)
                           ?: metadata.getString(android.media.MediaMetadata.METADATA_KEY_ALBUM_ARTIST)
                           ?: ""
                val album  = metadata.getString(android.media.MediaMetadata.METADATA_KEY_ALBUM) ?: ""

                val pbState   = controller.playbackState
                val isPlaying = pbState?.state == android.media.session.PlaybackState.STATE_PLAYING

                val json = JSONObject().apply {
                    put("type",      "media_status")
                    put("title",     title)
                    put("artist",    artist)
                    put("album",     album)
                    put("isPlaying", isPlaying)
                    put("app",       appName)
                    put("package",   pkg)
                    put("deviceName", deviceName)
                    put("timestamp", System.currentTimeMillis())
                }

                val sent = WebSocketManager.send(json.toString())
                Log.i(TAG, "Media: '$title' by '$artist' playing=$isPlaying ${if (sent) "→ sent" else "→ queued"}")

            } catch (e: Exception) {
                Log.e(TAG, "sendMediaStatus error: ${e.message}")
            }
        }

        /**
         * Find and execute the remote input reply action on an active notification.
         */
        fun replyToNotification(key: String, replyText: String): Boolean {
            Log.d(TAG, "replyToNotification: key=$key, text=$replyText")
            val ctx = contextRef ?: run {
                Log.w(TAG, "Cannot send reply: contextRef is null")
                return false
            }

            // Robust key lookup: clean both lookup key and cache keys to prevent spacing/newline issues
            val cleanTargetKey = key.trim().replace("\\s".toRegex(), "")
            var matchedSbn: StatusBarNotification? = null
            for ((cacheKey, cachedSbn) in activeNotificationsMap) {
                val cleanCacheKey = cacheKey.trim().replace("\\s".toRegex(), "")
                if (cleanCacheKey == cleanTargetKey) {
                    matchedSbn = cachedSbn
                    break
                }
            }

            val sbn = matchedSbn ?: run {
                Log.w(TAG, "Notification key not found in active cache: $key (cleaned: $cleanTargetKey)")
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
                        replyInput  = input
                        break
                    }
                }
                if (replyAction != null) break
            }

            if (replyAction == null || replyInput == null) {
                Log.w(TAG, "No direct reply action found in notification")
                return false
            }

            return try {
                val resultsBundle = Bundle().apply {
                    putCharSequence(replyInput.resultKey, replyText)
                }
                val intent = Intent().apply { addFlags(Intent.FLAG_RECEIVER_FOREGROUND) }
                android.app.RemoteInput.addResultsToIntent(arrayOf(replyInput), intent, resultsBundle)
                replyAction.actionIntent.send(ctx, 0, intent)
                Log.i(TAG, "Successfully triggered reply action for: $key")
                true
            } catch (e: Exception) {
                Log.e(TAG, "Failed to send reply pending intent: ${e.message}", e)
                false
            }
        }
    }

    private val mainHandler = Handler(Looper.getMainLooper())

    private val batteryReceiver = object : BroadcastReceiver() {
        private var lastLevel   = -1
        private var lastCharging = false

        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action != Intent.ACTION_BATTERY_CHANGED) return

            val level    = intent.getIntExtra(BatteryManager.EXTRA_LEVEL,  -1)
            val scale    = intent.getIntExtra(BatteryManager.EXTRA_SCALE,  100)
            val status   = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
            val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                           status == BatteryManager.BATTERY_STATUS_FULL

            val pct = if (scale > 0) (level * 100 / scale) else level

            // Only send if something actually changed (avoid spam on ticker events)
            if (pct != lastLevel || charging != lastCharging) {
                lastLevel   = pct
                lastCharging = charging
                sendBatteryStatus(pct, charging)
                Log.d(TAG, "Battery changed (service): ${pct}% charging=$charging")
            }
        }
    }

    private val clipboardReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == "com.mark.phonenotify.ACTION_COPY") {
                val text = intent.getStringExtra("text") ?: return
                val notifId = intent.getIntExtra("notification_id", -1)
                
                try {
                    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    clipboard.setPrimaryClip(ClipData.newPlainText("Phone Notify", text))
                    Toast.makeText(context, "📋 Copied to phone clipboard", Toast.LENGTH_SHORT).show()
                    Log.i(TAG, "Successfully copied to phone clipboard via broadcast")
                    
                    if (notifId != -1) {
                        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
                        manager.cancel(notifId)
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to copy to clipboard in receiver: ${e.message}")
                }
            }
        }
    }

    private val checkClearAllRunnable = Runnable {
        val activeNotifs = activeNotifications
        val hasActiveUnignored = activeNotifs?.any { sbn ->
            sbn.packageName != null && sbn.packageName !in IGNORED_PACKAGES && 
            sbn.notification?.flags?.and(Notification.FLAG_GROUP_SUMMARY) == 0 &&
            (sbn.notification?.extras?.getString(Notification.EXTRA_TITLE)?.trim().orEmpty().isNotEmpty() ||
             sbn.notification?.extras?.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim().orEmpty().isNotEmpty())
        } == true
        
        if (!hasActiveUnignored) {
            Log.i(TAG, "No unignored active notifications remaining. Sending clear_all_notifications.")
            val clearAllPayload = JSONObject().apply {
                put("type", "clear_all_notifications")
                put("timestamp", System.currentTimeMillis())
            }
            WebSocketManager.send(clearAllPayload.toString())
        }
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────────

    override fun onListenerConnected() {
        super.onListenerConnected()
        Log.i(TAG, "NotificationListenerService connected.")
        contextRef = applicationContext
        instance   = this

        // Register battery receiver in service for background tracking
        try {
            val filter = IntentFilter(Intent.ACTION_BATTERY_CHANGED)
            registerReceiver(batteryReceiver, filter)
            Log.d(TAG, "Registered battery receiver in NotificationService")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to register battery receiver in service: ${e.message}")
        }

        // Register clipboard receiver
        try {
            val filter = IntentFilter("com.mark.phonenotify.ACTION_COPY")
            registerReceiver(clipboardReceiver, filter)
            Log.d(TAG, "Registered clipboard copy receiver in NotificationService")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to register clipboard copy receiver: ${e.message}")
        }

        // Auto-connect using saved settings if not already connected
        val settings = SettingsManager(this)
        val ip    = settings.ipAddress
        val port  = settings.port
        val token = settings.token
        if (ip.isNotEmpty() && !WebSocketManager.isConnected()) {
            Log.i(TAG, "Auto-connecting to $ip:$port from NotificationService")
            WebSocketManager.connect(ip, port, token)
        }
    }

    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        Log.w(TAG, "NotificationListenerService disconnected — rebind expected.")
        contextRef = null
        instance   = null

        // Unregister battery receiver
        try {
            unregisterReceiver(batteryReceiver)
            Log.d(TAG, "Unregistered battery receiver in NotificationService")
        } catch (e: Exception) {
            Log.w(TAG, "Failed to unregister battery receiver in service: ${e.message}")
        }

        // Unregister clipboard receiver
        try {
            unregisterReceiver(clipboardReceiver)
            Log.d(TAG, "Unregistered clipboard copy receiver in NotificationService")
        } catch (e: Exception) {
            Log.w(TAG, "Failed to unregister clipboard copy receiver in service: ${e.message}")
        }
    }

    // ── Notification events ─────────────────────────────────────────────────────

    /**
     * Fired by Android every time a new notification is posted or updated.
     *
     * Processing pipeline:
     *   1. Null guard on the StatusBarNotification
     *   2. Skip ignored system packages
     *   3. Extract title + body from Notification.extras
     *   4. Skip empty notifications (silent background updates)
     *   5. Skip group summaries (to avoid duplicate group-summary cards)
     *   6. Resolve human-readable app name via PackageManager
     *   7. Build JSON payload (now includes deviceName + androidVersion)
     *   8. Send via WebSocketManager (queued if offline)
     *   9. Increment capture counter → notify MainActivity
     */
    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        sbn ?: return

        val packageName = sbn.packageName ?: return

        // ── Step 2: Package filter ────────────────────────────────────────────
        if (packageName in IGNORED_PACKAGES) {
            Log.v(TAG, "Ignored: $packageName")
            return
        }

        val extras = sbn.notification?.extras ?: return

        // Resolve app name
        val appName = resolveAppName(packageName)

        // Media session check
        val mediaToken = extras.get("android.media.session.MediaSession.Token")
        if (mediaToken is android.media.session.MediaSession.Token) {
            sendMediaStatus(mediaToken, packageName, appName, applicationContext)
        }

        val payload = buildNotificationJson(sbn) ?: return

        val sent = WebSocketManager.send(payload.toString())
        Log.d(TAG, if (sent) "→ Sent immediately" else "→ Queued (offline, queue=${WebSocketManager.queueSize()})")

        notificationCount++
        val currentCount = notificationCount
        mainHandler.post { onCountChanged?.invoke(currentCount) }
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification?) {
        sbn ?: return
        val packageName = sbn.packageName ?: return
        if (packageName in IGNORED_PACKAGES) return

        activeNotificationsMap.remove(sbn.key)

        val payload = JSONObject().apply {
            put("type",      TYPE_REMOVED)
            put("key",       sbn.key)
            put("package",   packageName)
            put("timestamp", System.currentTimeMillis())
        }

        val sent = WebSocketManager.send(payload.toString())
        Log.d(TAG, "Removed [$packageName] ${if (sent) "→ sent" else "→ queued"}")

        // Schedule check to see if the notification panel is now empty
        mainHandler.removeCallbacks(checkClearAllRunnable)
        mainHandler.postDelayed(checkClearAllRunnable, 150)
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private fun buildNotificationJson(sbn: StatusBarNotification): JSONObject? {
        val packageName = sbn.packageName ?: return null
        if (packageName in IGNORED_PACKAGES) return null

        val extras = sbn.notification?.extras ?: return null
        val title  = extras.getString(Notification.EXTRA_TITLE)?.trim().orEmpty()

        var message = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim().orEmpty()

        val bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()?.trim().orEmpty()
        if (bigText.isNotEmpty() && bigText.length > message.length) message = bigText

        val textLines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)
        if (textLines != null && textLines.isNotEmpty()) {
            val joined = textLines.joinToString("\n") { it.toString().trim() }
            if (joined.length > message.length) message = joined
        }

        // Try to extract messages list for chat notifications (MessagingStyle apps like WhatsApp/Telegram)
        val messagingStyle = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(sbn.notification)
        if (messagingStyle != null) {
            val messages = messagingStyle.messages
            if (messages.isNotEmpty()) {
                val sb = java.lang.StringBuilder()
                for (msg in messages) {
                    val sender = msg.person?.name?.toString() ?: msg.sender?.toString() ?: ""
                    val text = msg.text?.toString() ?: ""
                    if (text.isNotEmpty()) {
                        if (sb.isNotEmpty()) sb.append("\n")
                        if (sender.isNotEmpty()) {
                            sb.append("$sender: $text")
                        } else {
                            sb.append(text)
                        }
                    }
                }
                val messagingText = sb.toString()
                if (messagingText.length > message.length) {
                    message = messagingText
                }
            }
        }

        // Skip group summaries (except call packages)
        val isCallPackage = packageName == "com.android.phone" ||
                            packageName == "com.android.dialer" ||
                            packageName.contains("dialer", ignoreCase = true)

        if (!isCallPackage) {
            if (sbn.notification?.flags?.and(Notification.FLAG_GROUP_SUMMARY) != 0) {
                return null
            }
        }

        if (title.isEmpty() && message.isEmpty()) {
            return null
        }

        // Cache for quick replies
        activeNotificationsMap[sbn.key] = sbn

        val replyable = sbn.notification?.actions?.any { action ->
            action.remoteInputs?.any { input -> input.resultKey != null } == true
        } == true

        val appName   = resolveAppName(packageName)
        val timestamp = sbn.postTime

        return JSONObject().apply {
            put("type",           TYPE_NOTIFICATION)
            put("key",            sbn.key)
            put("id",             sbn.key)
            put("app",            appName)
            put("package",        packageName)
            put("title",          title)
            put("message",        message)
            put("timestamp",      timestamp)
            put("replyable",      replyable)
            put("deviceName",     deviceName)
            put("androidVersion", androidVersion)
        }
    }

    private fun resolveAppName(packageName: String): String {
        return try {
            val pm: PackageManager = applicationContext.packageManager
            val appInfo: ApplicationInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                pm.getApplicationInfo(packageName, PackageManager.ApplicationInfoFlags.of(0L))
            } else {
                @Suppress("DEPRECATION")
                pm.getApplicationInfo(packageName, 0)
            }
            pm.getApplicationLabel(appInfo).toString()
        } catch (e: PackageManager.NameNotFoundException) {
            Log.w(TAG, "Could not resolve app name for '$packageName': ${e.message}")
            packageName
        }
    }

    fun sendActiveNotifications() {
        try {
            // Send current battery status immediately on sync/connection
            sendCurrentBatteryStatus(applicationContext)
            
            val activeNotifs = activeNotifications
            val jsonArray = JSONArray()
            
            if (activeNotifs != null) {
                for (sbn in activeNotifs) {
                    val notifJson = buildNotificationJson(sbn)
                    if (notifJson != null) {
                        jsonArray.put(notifJson)
                    }
                }
            }

            val count = jsonArray.length()
            Log.i(TAG, "Syncing $count active notification(s) via full_sync…")

            // Build full_sync event
            val syncPayload = JSONObject().apply {
                put("type",          "full_sync")
                put("notifications", jsonArray)
                put("timestamp",     System.currentTimeMillis())
            }
            
            val sent = WebSocketManager.send(syncPayload.toString())
            Log.i(TAG, "Full sync complete: sent $count active notification(s) (sent=$sent)")
        } catch (e: Exception) {
            Log.e(TAG, "Error syncing active notifications: ${e.message}", e)
        }
    }
}
