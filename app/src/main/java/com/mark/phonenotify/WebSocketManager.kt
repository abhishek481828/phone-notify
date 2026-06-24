package com.mark.phonenotify

import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * WebSocketManager.kt
 * ────────────────────
 * Singleton managing the OkHttp WebSocket connection to the Node.js relay server.
 *
 * ── URL format ──
 *   The relay server requires a ?type=phone query parameter to identify this
 *   client as an Android phone:
 *     ws://192.168.1.50:8080?type=phone
 *     ws://192.168.1.50:8080?type=phone&token=my-secret   (with auth)
 *
 * ── v3 additions ──
 *   • Token support in buildUrl() — appends &token=<value> when non-empty
 *   • Incoming message dispatch for: reply, call_action, media_control,
 *     clipboard_to_phone — each has a nullable callback set by MainActivity
 *   • Callbacks: onCallAction, onMediaControl, onClipboardReceived
 *
 * ── Thread safety ──
 *   OkHttp calls WebSocketListener methods on its own dispatcher threads.
 *   The messageQueue and totalSent counter are protected by queueLock.
 *   All callbacks (onStatusChanged, onNotificationSent) are posted to the
 *   main thread via mainHandler so callers can update the UI directly.
 *
 * ── Auto-reconnect with exponential backoff ──
 *   attempt 1 → wait 3 s  →  attempt 2 → wait 6 s  →  …  →  max 30 s
 *   Backoff resets to 3 s after a successful connection.
 *   Intentional disconnect (user presses Disconnect) suppresses reconnect.
 *
 * ── Offline queue ──
 *   Up to MAX_QUEUE_SIZE (100) notification JSON strings are buffered when
 *   disconnected. On reconnect, all queued messages are flushed in order.
 *   When the queue is full, the oldest message is evicted (FIFO eviction).
 */
object WebSocketManager {

    private const val TAG = "PhoneNotify:WS"

    // ── Timing constants ───────────────────────────────────────────────────────

    private const val RECONNECT_INITIAL_MS  = 3_000L
    private const val RECONNECT_MAX_MS      = 30_000L
    private const val RECONNECT_MULTIPLIER  = 2.0
    private const val PING_INTERVAL_SECONDS = 20L
    private const val READ_TIMEOUT_SECONDS  = 45L
    private const val CONNECT_TIMEOUT_SECONDS = 10L
    private const val MAX_QUEUE_SIZE        = 100

    // ── OkHttp client ─────────────────────────────────────────────────────────

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(CONNECT_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .readTimeout(READ_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .pingInterval(PING_INTERVAL_SECONDS, TimeUnit.SECONDS)
        .retryOnConnectionFailure(false)
        .build()

    // ── Mutable state ──────────────────────────────────────────────────────────

    private var webSocket: WebSocket? = null
    private var serverUrl: String = ""
    private var isIntentionalDisconnect = false
    private var reconnectDelayMs = RECONNECT_INITIAL_MS

    // ── Offline message queue ──────────────────────────────────────────────────

    private val messageQueue = ArrayDeque<String>()
    private val queueLock    = Any()

    // ── Stats ──────────────────────────────────────────────────────────────────

    @Volatile
    var totalSent: Int = 0
        private set

    // ── Handler ────────────────────────────────────────────────────────────────

    private val mainHandler = Handler(Looper.getMainLooper())

    private val reconnectRunnable = Runnable {
        Log.i(TAG, "Auto-reconnect: attempting connection to $serverUrl")
        performConnect()
    }

    // ── Callbacks — status ─────────────────────────────────────────────────────

    /**
     * Invoked on the **main thread** whenever the connection status changes.
     * Set in MainActivity.onCreate() before any connect() call.
     */
    var onStatusChanged: ((ConnectionStatus) -> Unit)? = null

    /**
     * Invoked on the **main thread** every time a notification is successfully
     * delivered to the server. The Int parameter is the new [totalSent] value.
     */
    var onNotificationSent: ((totalSent: Int) -> Unit)? = null

    // ── Callbacks — incoming messages from server ──────────────────────────────

    /**
     * Fired when the server (relaying from the extension) sends a call_action.
     * action: "answer" | "reject" | "silence"
     * Called on the **main thread**.
     */
    var onCallAction: ((action: String) -> Unit)? = null

    /**
     * Fired when the server relays a media_control command from the extension.
     * action: "play" | "pause" | "next" | "prev"
     * Called on the **main thread**.
     */
    var onMediaControl: ((action: String) -> Unit)? = null

    /**
     * Fired when the extension pushes clipboard text to the phone.
     * Called on the **main thread**.
     */
    var onClipboardReceived: ((text: String) -> Unit)? = null

    // ── Observable status ──────────────────────────────────────────────────────

    var currentStatus: ConnectionStatus = ConnectionStatus.Disconnected
        private set(value) {
            field = value
            mainHandler.post { onStatusChanged?.invoke(value) }
        }

    // ── Public API ──────────────────────────────────────────────────────────────

    /**
     * Initiate a WebSocket connection to the relay server.
     *
     * @param ip    Laptop's LAN IP address (e.g. "192.168.1.50")
     * @param port  Relay server port (e.g. "8080")
     * @param token Optional access token. Appended as &token=<value> when non-empty.
     */
    fun connect(ip: String, port: String, token: String = "") {
        val url = buildUrl(ip, port, token)
        Log.d(TAG, "connect($ip, $port, token=${token.isNotEmpty()}) → $url")
        connectInternal(url)
    }

    /**
     * Disconnect the active socket and suppress auto-reconnect.
     * Safe to call when already disconnected (no-op).
     */
    fun disconnect() {
        Log.i(TAG, "Disconnect requested by user.")
        isIntentionalDisconnect = true
        mainHandler.removeCallbacks(reconnectRunnable)
        webSocket?.close(1000, "User disconnected")
        webSocket = null
        currentStatus = ConnectionStatus.Disconnected
    }

    /**
     * Send a JSON string to the relay server.
     *
     * Thread-safe. Can be called from any thread.
     *   - Connected → sends immediately via WebSocket frame
     *   - Disconnected/Connecting → enqueues for delivery after reconnect
     *
     * @param json Serialized JSON payload
     * @return true if sent immediately; false if queued or buffer full
     */
    fun send(json: String): Boolean {
        synchronized(queueLock) {
            val ws = webSocket
            return if (ws != null && currentStatus == ConnectionStatus.Connected) {
                val ok = ws.send(json)
                if (ok) {
                    val newTotal = ++totalSent
                    Log.i(TAG, "→ Sent notification #$newTotal")
                    mainHandler.post { onNotificationSent?.invoke(newTotal) }
                } else {
                    Log.w(TAG, "ws.send() returned false (buffer full?) — queuing.")
                    enqueueLocked(json)
                }
                ok
            } else {
                enqueueLocked(json)
                false
            }
        }
    }

    fun isConnected(): Boolean = currentStatus == ConnectionStatus.Connected
    fun queueSize(): Int = synchronized(queueLock) { messageQueue.size }

    /**
     * Build the WebSocket URL with required ?type=phone and optional &token=.
     *
     * Handles three input formats:
     *   1. Plain IP → "ws://192.168.1.50:8080?type=phone[&token=…]"
     *   2. ws:// URL  → appends ?type=phone if not already present
     *   3. wss:// URL → same as (2)
     */
    fun buildUrl(ip: String, port: String, token: String = ""): String {
        val trimmedIp = ip.trim()

        val base: String = if (trimmedIp.startsWith("ws://") || trimmedIp.startsWith("wss://")) {
            val delim = if (trimmedIp.contains("?")) "&" else "?"
            if (trimmedIp.contains("type=")) trimmedIp else "$trimmedIp${delim}type=phone"
        } else {
            val trimmedPort = port.trim().ifEmpty { "8080" }
            "ws://$trimmedIp:$trimmedPort?type=phone"
        }

        // Append token if provided (and not already in the URL)
        return if (token.isNotBlank() && !base.contains("token=")) {
            "$base&token=${token.trim()}"
        } else {
            base
        }
    }

    // ── Private: connection ────────────────────────────────────────────────────

    private fun connectInternal(url: String) {
        if (url.isBlank()) return
        serverUrl               = url
        isIntentionalDisconnect = false
        reconnectDelayMs        = RECONNECT_INITIAL_MS
        mainHandler.removeCallbacks(reconnectRunnable)
        webSocket?.cancel()
        webSocket     = null
        currentStatus = ConnectionStatus.Connecting
        performConnect()
    }

    private fun performConnect() {
        try {
            val request = Request.Builder().url(serverUrl).build()
            webSocket = httpClient.newWebSocket(request, socketListener)
            Log.d(TAG, "OkHttp connecting to $serverUrl…")
        } catch (e: IllegalArgumentException) {
            Log.e(TAG, "Malformed WebSocket URL: $serverUrl — ${e.message}")
            currentStatus = ConnectionStatus.Error("Bad URL: ${e.message}")
        }
    }

    // ── Private: queue ─────────────────────────────────────────────────────────

    private fun enqueueLocked(json: String) {
        if (messageQueue.size >= MAX_QUEUE_SIZE) {
            messageQueue.removeFirst()
            Log.w(TAG, "Queue at capacity ($MAX_QUEUE_SIZE) — evicted oldest message.")
        }
        messageQueue.addLast(json)
        Log.d(TAG, "Queued notification (queue size: ${messageQueue.size}/$MAX_QUEUE_SIZE)")
    }

    private fun flushQueue() {
        synchronized(queueLock) {
            if (messageQueue.isEmpty()) return
            val ws = webSocket ?: return
            Log.i(TAG, "Flushing offline queue (${messageQueue.size} message(s))…")
            val iterator = messageQueue.iterator()
            var flushed  = 0
            while (iterator.hasNext()) {
                val json = iterator.next()
                if (ws.send(json)) {
                    iterator.remove()
                    val newTotal = ++totalSent
                    mainHandler.post { onNotificationSent?.invoke(newTotal) }
                    flushed++
                } else {
                    Log.w(TAG, "ws.send() returned false during flush — stopping early.")
                    break
                }
            }
            Log.i(TAG, "Flush complete: sent=$flushed, remaining=${messageQueue.size}")
        }
    }

    // ── Private: reconnect ─────────────────────────────────────────────────────

    private fun scheduleReconnect() {
        if (isIntentionalDisconnect || serverUrl.isBlank()) {
            Log.d(TAG, "Reconnect suppressed (intentional=$isIntentionalDisconnect)")
            return
        }
        Log.i(TAG, "Scheduling reconnect in ${reconnectDelayMs}ms…")
        mainHandler.removeCallbacks(reconnectRunnable)
        mainHandler.postDelayed(reconnectRunnable, reconnectDelayMs)
        reconnectDelayMs = minOf(
            (reconnectDelayMs * RECONNECT_MULTIPLIER).toLong(),
            RECONNECT_MAX_MS
        )
    }

    // ── WebSocket listener ─────────────────────────────────────────────────────

    private val socketListener = object : WebSocketListener() {

        override fun onOpen(webSocket: WebSocket, response: Response) {
            Log.i(TAG, "✓ Connected to $serverUrl (HTTP ${response.code})")
            reconnectDelayMs = RECONNECT_INITIAL_MS
            currentStatus    = ConnectionStatus.Connected
            flushQueue()

            // Sync active notifications on connection via full_sync payload
            NotificationService.instance?.sendActiveNotifications()
        }

        /**
         * Incoming text message from the relay server.
         * Routes to the appropriate handler based on the "type" field.
         *
         * Supported incoming types (sent by the extension via the relay):
         *   reply            — quick reply to a notification
         *   call_action      — answer / reject / silence a ringing call
         *   media_control    — play / pause / next / prev
         *   clipboard_to_phone — push text to the phone's clipboard
         */
        override fun onMessage(webSocket: WebSocket, text: String) {
            Log.d(TAG, "← Server message: $text")
            try {
                val json = JSONObject(text)
                when (val type = json.optString("type")) {

                    "reply" -> {
                        val key     = json.optString("key")
                        val message = json.optString("message")
                        if (key.isNotBlank() && message.isNotBlank()) {
                            NotificationService.replyToNotification(key, message)
                        }
                    }

                    "dismiss" -> {
                        val key = json.optString("key")
                        if (key.isNotBlank()) {
                            Log.i(TAG, "← dismiss notification: $key")
                            mainHandler.post {
                                NotificationService.dismissNotification(key)
                            }
                        }
                    }

                    "clear_all" -> {
                        Log.i(TAG, "← clear all notifications")
                        mainHandler.post {
                            NotificationService.dismissAllNotifications()
                        }
                    }

                    "call_action" -> {
                        val action = json.optString("action")
                        if (action.isNotBlank()) {
                            Log.i(TAG, "← call_action: $action")
                            mainHandler.post { onCallAction?.invoke(action) }
                        }
                    }

                    "media_control" -> {
                        val action = json.optString("action")
                        if (action.isNotBlank()) {
                            Log.i(TAG, "← media_control: $action")
                            mainHandler.post {
                                NotificationService.handleMediaControl(action)
                                onMediaControl?.invoke(action)
                            }
                        }
                    }

                    "clipboard_to_phone" -> {
                        val clipText = json.optString("text")
                        if (clipText.isNotBlank()) {
                            Log.i(TAG, "← clipboard_to_phone: ${clipText.take(40)}")
                            mainHandler.post {
                                onClipboardReceived?.invoke(clipText)
                                NotificationService.handleClipboardReceived(clipText)
                            }
                        }
                    }

                    else -> Log.d(TAG, "← Unknown message type: '$type' — ignored")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error handling server message: ${e.message}", e)
            }
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            Log.d(TAG, "← Server (binary, ignored): ${bytes.size} bytes")
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            Log.d(TAG, "Server closing: code=$code reason=\"$reason\"")
            if (webSocket === this@WebSocketManager.webSocket) {
                webSocket.close(1000, null)
            }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            Log.i(TAG, "Connection closed: code=$code reason=\"$reason\"")
            if (webSocket === this@WebSocketManager.webSocket) {
                currentStatus = ConnectionStatus.Disconnected
                scheduleReconnect()
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            val httpCode = response?.code?.let { " (HTTP $it)" } ?: ""
            Log.e(TAG, "✗ Connection failure$httpCode: ${t.message}")
            if (webSocket === this@WebSocketManager.webSocket) {
                currentStatus = ConnectionStatus.Error(t.message ?: "Connection failed")
                scheduleReconnect()
            }
        }
    }
}

// ─── ConnectionStatus sealed class ────────────────────────────────────────────

/**
 * Models every possible state of the WebSocket connection.
 */
sealed class ConnectionStatus {
    object Connecting   : ConnectionStatus()
    object Connected    : ConnectionStatus()
    object Disconnected : ConnectionStatus()
    data class Error(val message: String) : ConnectionStatus()

    fun displayText(): String = when (this) {
        is Connecting   -> "Connecting…"
        is Connected    -> "Connected ✓"
        is Disconnected -> "Disconnected"
        is Error        -> "Error: ${message.take(60)}"
    }
}
