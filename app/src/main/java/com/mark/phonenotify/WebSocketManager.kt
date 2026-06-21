package com.mark.phonenotify

import android.os.Handler
import android.os.Looper
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.util.concurrent.TimeUnit

/**
 * WebSocketManager.kt
 * ────────────────────
 * Singleton managing the OkHttp WebSocket connection to the Node.js relay server.
 *
 * ── URL format ──
 *   The relay server requires a ?type=phone query parameter to identify this
 *   client as an Android phone:
 *     ws://192.168.1.50:8080/?type=phone
 *
 * ── Thread safety ──
 *   OkHttp calls WebSocketListener methods on its own dispatcher threads.
 *   The messageQueue and totalSent counter are protected by queueLock.
 *   All callbacks (onStatusChanged, onNotificationSent) are posted to the
 *   main thread via mainHandler so callers can update the UI directly.
 *
 * ── Auto-reconnect with exponential backoff ──
 *   On unexpected disconnect or failure:
 *     attempt 1 → wait 3 s
 *     attempt 2 → wait 6 s
 *     attempt 3 → wait 12 s
 *     …
 *     max       → wait 30 s
 *   Backoff resets to 3 s after a successful connection.
 *   Intentional disconnect (user presses Disconnect) suppresses reconnect.
 *
 * ── Offline queue ──
 *   Up to MAX_QUEUE_SIZE (100) notification JSON strings are buffered when
 *   disconnected. On reconnect, all queued messages are flushed in order.
 *   When the queue is full, the oldest message is evicted (FIFO eviction).
 *
 * ── Heartbeat ──
 *   OkHttp sends a WebSocket ping frame every PING_INTERVAL_SECONDS seconds.
 *   The relay server responds with a pong (standard WebSocket protocol).
 *   If no pong is received within READ_TIMEOUT_SECONDS, OkHttp closes the
 *   connection and triggers onFailure → auto-reconnect.
 */
object WebSocketManager {

    private const val TAG = "PhoneNotify:WS"

    // ── Timing constants ───────────────────────────────────────────────────────

    /** Initial delay before the first reconnect attempt (ms). */
    private const val RECONNECT_INITIAL_MS  = 3_000L

    /** Maximum delay between reconnect attempts (ms). */
    private const val RECONNECT_MAX_MS      = 30_000L

    /** Reconnect delay multiplier for exponential backoff. */
    private const val RECONNECT_MULTIPLIER  = 2.0

    /** WebSocket ping interval (seconds). Sends keep-alive pings to the server. */
    private const val PING_INTERVAL_SECONDS = 20L

    /** How long to wait for any server frame (including pong) before timing out. */
    private const val READ_TIMEOUT_SECONDS  = 45L

    /** TCP/WebSocket handshake timeout. */
    private const val CONNECT_TIMEOUT_SECONDS = 10L

    /** Maximum number of notifications held in the offline queue. */
    private const val MAX_QUEUE_SIZE = 100

    // ── OkHttp client ─────────────────────────────────────────────────────────

    /**
     * A single long-lived OkHttpClient shared across all WebSocket connections.
     * Creating multiple clients is wasteful (each has its own thread pools).
     *
     * pingInterval:
     *   OkHttp will automatically send a WebSocket PING frame every 20 s.
     *   The relay server (Node.js ws library) handles PONG responses automatically.
     *   If no PONG is received within readTimeout, OkHttp closes the socket.
     *
     * retryOnConnectionFailure = false:
     *   We manage reconnect manually with exponential backoff. OkHttp's built-in
     *   retry does not implement backoff and can cause rapid retry storms.
     */
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(CONNECT_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .readTimeout(READ_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .pingInterval(PING_INTERVAL_SECONDS, TimeUnit.SECONDS)
        .retryOnConnectionFailure(false)
        .build()

    // ── Mutable state ──────────────────────────────────────────────────────────

    /** The active WebSocket instance. Null when disconnected. */
    private var webSocket: WebSocket? = null

    /** The full URL used for the current/last connection (for auto-reconnect). */
    private var serverUrl: String = ""

    /** Set to true by disconnect() to suppress auto-reconnect. */
    private var isIntentionalDisconnect = false

    /** Current backoff delay. Reset to RECONNECT_INITIAL_MS after a successful connect. */
    private var reconnectDelayMs = RECONNECT_INITIAL_MS

    // ── Offline message queue ──────────────────────────────────────────────────

    /**
     * FIFO queue of serialized JSON strings buffered while the socket is offline.
     * Protected by queueLock for thread safety.
     *
     * Invariant: queue.size ≤ MAX_QUEUE_SIZE.
     * When full, the head (oldest) is removed before adding the new tail.
     */
    private val messageQueue = ArrayDeque<String>()
    private val queueLock    = Any()

    // ── Stats ──────────────────────────────────────────────────────────────────

    /**
     * Running count of notifications actually delivered to the relay server
     * (immediate sends + flushed queue items). Does NOT count queued-only items.
     * Reset to 0 when the app process restarts.
     */
    @Volatile
    var totalSent: Int = 0
        private set

    // ── Handler ────────────────────────────────────────────────────────────────

    private val mainHandler = Handler(Looper.getMainLooper())

    private val reconnectRunnable = Runnable {
        Log.i(TAG, "Auto-reconnect: attempting connection to $serverUrl (delay was ${reconnectDelayMs}ms)")
        performConnect()
    }

    // ── Callbacks ──────────────────────────────────────────────────────────────

    /**
     * Invoked on the **main thread** whenever the connection status changes.
     * Safe to update UI directly inside this lambda.
     *
     * Set in MainActivity.onCreate() before any connect() call.
     */
    var onStatusChanged: ((ConnectionStatus) -> Unit)? = null

    /**
     * Invoked on the **main thread** every time a notification is successfully
     * delivered to the server (either immediately or via queue flush).
     * The Int parameter is the new [totalSent] value.
     *
     * Set in MainActivity.onCreate().
     */
    var onNotificationSent: ((totalSent: Int) -> Unit)? = null

    // ── Observable status ──────────────────────────────────────────────────────

    /** Always read this property to get the current state. Never set externally. */
    var currentStatus: ConnectionStatus = ConnectionStatus.Disconnected
        private set(value) {
            field = value
            mainHandler.post { onStatusChanged?.invoke(value) }
        }

    // ── Public API ──────────────────────────────────────────────────────────────

    /**
     * Initiate a WebSocket connection to the relay server.
     *
     * Builds the URL automatically: ws://[ip]:[port]/?type=phone
     * The ?type=phone query parameter is required by the Node.js relay server
     * to register this client as an Android phone (vs. a Chrome extension).
     *
     * @param ip   Laptop's LAN IP address (e.g. "192.168.1.50")
     * @param port Relay server port (e.g. "8080")
     */
    fun connect(ip: String, port: String) {
        val url = buildUrl(ip, port)
        Log.d(TAG, "connect($ip, $port) → $url")
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
     * Thread-safe. Can be called from any thread (NotificationService, OkHttp
     * dispatcher, main thread — all safe).
     *
     * Behaviour:
     *   - Connected → sends immediately via WebSocket frame
     *   - Disconnected/Connecting → enqueues for delivery after reconnect
     *
     * @param json Serialized JSON payload (from org.json.JSONObject.toString())
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
                    // OkHttp's outgoing buffer is full (extremely rare) — queue it
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

    /** Returns true iff the WebSocket handshake is complete and the socket is open. */
    fun isConnected(): Boolean = currentStatus == ConnectionStatus.Connected

    /** Number of messages currently waiting in the offline queue. */
    fun queueSize(): Int = synchronized(queueLock) { messageQueue.size }

    fun buildUrl(ip: String, port: String): String {
        val trimmedIp = ip.trim()
        if (trimmedIp.startsWith("ws://") || trimmedIp.startsWith("wss://")) {
            val delimiter = if (trimmedIp.contains("?")) "&" else "?"
            return if (trimmedIp.contains("type=")) {
                trimmedIp
            } else {
                "$trimmedIp${delimiter}type=phone"
            }
        }
        val trimmedPort = port.trim().ifEmpty { "8080" }
        return "ws://$trimmedIp:$trimmedPort?type=phone"
    }

    // ── Private: connection ────────────────────────────────────────────────────

    private fun connectInternal(url: String) {
        if (url.isBlank()) return

        serverUrl              = url
        isIntentionalDisconnect = false
        reconnectDelayMs       = RECONNECT_INITIAL_MS

        mainHandler.removeCallbacks(reconnectRunnable)

        // Cancel any existing socket before opening a fresh one
        webSocket?.cancel()
        webSocket = null

        currentStatus = ConnectionStatus.Connecting
        performConnect()
    }

    /**
     * Creates the OkHttp Request and hands it to the shared client.
     * OkHttp opens the TCP connection and performs the WebSocket upgrade
     * on its own dispatcher thread — no blocking on the calling thread.
     */
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

    /**
     * Add a message to the tail of the queue.
     * MUST be called with queueLock held (use synchronized(queueLock) at the call site).
     * Evicts the oldest message if at capacity.
     */
    private fun enqueueLocked(json: String) {
        if (messageQueue.size >= MAX_QUEUE_SIZE) {
            messageQueue.removeFirst()
            Log.w(TAG, "Queue at capacity ($MAX_QUEUE_SIZE) — evicted oldest message.")
        }
        messageQueue.addLast(json)
        Log.d(TAG, "Queued notification (queue size: ${messageQueue.size}/$MAX_QUEUE_SIZE)")
    }

    /**
     * Drain the offline queue after a successful reconnect.
     * Sends each queued message in FIFO order over the now-open socket.
     * Removes successfully sent items; leaves failed items for the next flush.
     */
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
                    // Buffer full — stop flushing; retry on next reconnect
                    Log.w(TAG, "ws.send() returned false during flush — stopping early.")
                    break
                }
            }

            Log.i(TAG, "Flush complete: sent=$flushed, remaining=${messageQueue.size}")
        }
    }

    // ── Private: reconnect ─────────────────────────────────────────────────────

    /**
     * Schedule the next reconnect attempt using the current backoff delay,
     * then increase the delay for the next potential attempt (exponential backoff).
     *
     * Does nothing if the disconnect was intentional or no URL has been set yet.
     */
    private fun scheduleReconnect() {
        if (isIntentionalDisconnect || serverUrl.isBlank()) {
            Log.d(TAG, "Reconnect suppressed (intentional=$isIntentionalDisconnect, url=$serverUrl)")
            return
        }

        Log.i(TAG, "Scheduling reconnect in ${reconnectDelayMs}ms…")
        mainHandler.removeCallbacks(reconnectRunnable)
        mainHandler.postDelayed(reconnectRunnable, reconnectDelayMs)

        // Exponential backoff: 3 → 6 → 12 → 24 → 30 → 30 → …
        reconnectDelayMs = minOf(
            (reconnectDelayMs * RECONNECT_MULTIPLIER).toLong(),
            RECONNECT_MAX_MS
        )
    }

    // ── WebSocket listener ─────────────────────────────────────────────────────

    private val socketListener = object : WebSocketListener() {

        /**
         * TCP connection established and WebSocket handshake complete.
         * The server (Node.js relay) registers this client as type=phone.
         */
        override fun onOpen(webSocket: WebSocket, response: Response) {
            Log.i(TAG, "✓ Connected to $serverUrl (HTTP ${response.code})")
            reconnectDelayMs = RECONNECT_INITIAL_MS // reset backoff on success
            currentStatus    = ConnectionStatus.Connected
            flushQueue()

            // Sync active notifications on connection
            NotificationService.instance?.sendActiveNotifications()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            Log.d(TAG, "← Server message: $text")
            try {
                val json = org.json.JSONObject(text)
                if (json.optString("type") == "reply") {
                    val key = json.getString("key")
                    val message = json.getString("message")
                    NotificationService.replyToNotification(key, message)
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error handling server message: ${e.message}")
            }
        }

        /** Binary frame — unexpected; log and ignore. */
        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            Log.d(TAG, "← Server (binary, ignored): ${bytes.size} bytes")
        }

        /**
         * Server sent a CLOSE frame — complete the handshake by closing from our side.
         * This triggers onClosed() next.
         */
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            Log.d(TAG, "Server closing: code=$code reason=\"$reason\"")
            if (webSocket === this@WebSocketManager.webSocket) {
                webSocket.close(1000, null)
            }
        }

        /** Connection cleanly closed (both sides exchanged CLOSE frames). */
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            Log.i(TAG, "Connection closed: code=$code reason=\"$reason\"")
            if (webSocket === this@WebSocketManager.webSocket) {
                currentStatus = ConnectionStatus.Disconnected
                scheduleReconnect()
            } else {
                Log.d(TAG, "Ignored onClosed for old socket")
            }
        }

        /**
         * Connection failed — covers DNS errors, connection refused, handshake failure,
         * timeout, and ping/pong timeout (when pingInterval is set on the client).
         * OkHttp does NOT call onClosed after onFailure.
         */
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            val httpCode = response?.code?.let { " (HTTP $it)" } ?: ""
            Log.e(TAG, "✗ Connection failure$httpCode: ${t.message}")
            if (webSocket === this@WebSocketManager.webSocket) {
                currentStatus = ConnectionStatus.Error(t.message ?: "Connection failed")
                scheduleReconnect()
            } else {
                Log.d(TAG, "Ignored onFailure for old socket")
            }
        }
    }
}

// ─── ConnectionStatus sealed class ────────────────────────────────────────────

/**
 * Models every possible state of the WebSocket connection.
 *
 * Used by:
 *  - WebSocketManager (internal state machine)
 *  - MainActivity (drives UI colors, button text, input enable/disable)
 *  - NotificationService (decides whether to send directly or queue)
 */
sealed class ConnectionStatus {

    /** TCP handshake in progress. UI: amber dot, disabled inputs. */
    object Connecting : ConnectionStatus()

    /** Socket open and ready. UI: green dot, "Disconnect" button. */
    object Connected : ConnectionStatus()

    /** Cleanly closed or not yet connected. UI: gray dot, "Connect" button. */
    object Disconnected : ConnectionStatus()

    /**
     * Failure (DNS, refused, timeout, etc.).
     * [message]: short OkHttp error string, shown in the UI status label.
     * UI: red dot, "Retry" button.
     */
    data class Error(val message: String) : ConnectionStatus()

    /**
     * A short label suitable for the status TextView.
     * Long error messages are truncated to 60 chars so they fit the layout.
     */
    fun displayText(): String = when (this) {
        is Connecting   -> "Connecting…"
        is Connected    -> "Connected ✓"
        is Disconnected -> "Disconnected"
        is Error        -> "Error: ${message.take(60)}"
    }
}
