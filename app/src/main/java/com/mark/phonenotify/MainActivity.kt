package com.mark.phonenotify

import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.text.Editable
import android.text.TextWatcher
import android.util.Log
import android.view.View
import android.view.animation.AnimationUtils
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.mark.phonenotify.databinding.ActivityMainBinding

/**
 * MainActivity.kt
 * ────────────────
 * Single-activity UI for Phone Notify.
 *
 * ── What it manages ──
 *   1. Permission banner — shown until Notification Access is granted.
 *   2. IP + Port input fields — restored from SettingsManager on every launch.
 *   3. Live URL preview — shows the ws:// URL as the user types.
 *   4. Connect / Disconnect / Retry button — drives WebSocketManager.
 *   5. Connection status indicator — colored dot + label (main-thread safe).
 *   6. Notifications sent counter — updated by WebSocketManager callback.
 *   7. Notifications captured counter — updated by NotificationService callback.
 *
 * ── Threading model ──
 *   WebSocketManager.onStatusChanged        → posted to main thread internally ✓
 *   WebSocketManager.onNotificationSent     → posted to main thread internally ✓
 *   NotificationService.onCountChanged      → posted to main thread internally ✓
 *   All of the above: UI updates here are directly safe without runOnUiThread{}.
 *
 * ── Settings persistence ──
 *   IP and port are saved to SharedPreferences (via SettingsManager) the moment
 *   the user taps Connect. They are restored via SettingsManager on onCreate().
 */
class MainActivity : AppCompatActivity() {

    // ── View Binding ───────────────────────────────────────────────────────────

    private lateinit var binding: ActivityMainBinding

    // ── Dependencies ───────────────────────────────────────────────────────────

    /** SharedPreferences wrapper. Persists IP + port across sessions. */
    private lateinit var settings: SettingsManager

    // ── Lifecycle ───────────────────────────────────────────────────────────────

    companion object {
        private const val TAG = "PhoneNotify:Main"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Log.d(TAG, "MainActivity.onCreate() — package: ${packageName}")

        binding  = ActivityMainBinding.inflate(layoutInflater)
        settings = SettingsManager(this)
        setContentView(binding.root)

        restoreSavedSettings()
        setupUrlPreview()
        setupClickListeners()
        observeWebSocketStatus()
        observeNotificationSent()
        observeNotificationCaptured()

        // Auto-connect if the user has previously saved settings and
        // notification access is already granted.
        autoConnectIfSaved()
    }

    /**
     * Re-check Notification Access on every resume.
     * Handles the case where the user came back from the Settings screen.
     */
    override fun onResume() {
        super.onResume()
        Log.d(TAG, "MainActivity.onResume()")
        refreshPermissionBanner()
    }

    // ── Settings restore ────────────────────────────────────────────────────────

    /**
     * Populate IP and port inputs with the last-saved values so the user
     * doesn't have to re-type their laptop's IP on every launch.
     */
    private fun restoreSavedSettings() {
        val savedIp   = settings.ipAddress
        val savedPort = settings.port

        Log.d(TAG, "restoreSavedSettings: ip='$savedIp' port='$savedPort'")

        // If no IP is saved yet, pre-fill with 127.0.0.1 (works via adb reverse tcp:8080 tcp:8080)
        if (savedIp.isNotEmpty()) {
            binding.etIpAddress.setText(savedIp)
        } else {
            binding.etIpAddress.setText("127.0.0.1")
        }
        binding.etPort.setText(savedPort)

        // Immediately update the URL preview with the restored values
        updateUrlPreview()
    }

    // ── URL preview ──────────────────────────────────────────────────────────────

    /**
     * Wire up TextWatchers on both input fields so the URL preview below the
     * port field updates in real time as the user types.
     *
     * The preview shows exactly what URL will be used to connect, including
     * the ?type=phone query parameter required by the relay server.
     */
    private fun setupUrlPreview() {
        val watcher = object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?,  start: Int, before: Int, count: Int)  = Unit
            override fun afterTextChanged(s: Editable?) = updateUrlPreview()
        }
        binding.etIpAddress.addTextChangedListener(watcher)
        binding.etPort.addTextChangedListener(watcher)
    }

    private fun updateUrlPreview() {
        val ip   = binding.etIpAddress.text.toString().trim()
        val port = binding.etPort.text.toString().trim().ifEmpty { SettingsManager.DEFAULT_PORT }

        binding.tvUrlPreview.text = if (ip.isEmpty()) {
            "ws://127.0.0.1:8080?type=phone"
        } else {
            WebSocketManager.buildUrl(ip, port)
        }
    }

    // ── Click listeners ──────────────────────────────────────────────────────────

    private fun setupClickListeners() {

        // ── Connect / Disconnect / Retry button ─────────────────────────────────
        binding.btnConnect.setOnClickListener {
            if (WebSocketManager.isConnected()) {
                // Currently connected → user wants to disconnect
                Log.i(TAG, "User tapped Disconnect")
                WebSocketManager.disconnect()
            } else {
                // Disconnected / errored → validate and connect
                val ip   = binding.etIpAddress.text.toString().trim()
                val port = binding.etPort.text.toString().trim().ifEmpty { SettingsManager.DEFAULT_PORT }

                // Validate IP
                if (ip.isEmpty()) {
                    binding.etIpAddress.error = "Enter your laptop's IP address"
                    binding.etIpAddress.requestFocus()
                    return@setOnClickListener
                }

                // Validate port
                val portNum = port.toIntOrNull()
                if (portNum == null || portNum !in 1..65535) {
                    binding.etPort.error = "Invalid port (1–65535)"
                    binding.etPort.requestFocus()
                    return@setOnClickListener
                }

                Log.i(TAG, "User tapped Connect → $ip:$port")

                // Persist settings before connecting
                settings.saveConnection(ip, port)

                // Initiate connection (WebSocketManager appends ?type=phone)
                WebSocketManager.connect(ip, port)
            }
        }

        // ── Grant Permission button (inside the amber banner) ───────────────────
        binding.btnGrantPermission.setOnClickListener {
            openNotificationAccessSettings()
        }
    }

    /**
     * Auto-connect on launch if:
     *   1. The user has previously saved an IP address.
     *   2. Notification Access is already granted.
     *   3. We are not already connected (guards against activity recreation).
     *
     * Uses 127.0.0.1 (tunnelled via `adb reverse tcp:8080 tcp:8080`) if the
     * saved IP is blank — meaning first-run with adb reverse active just works.
     */
    private fun autoConnectIfSaved() {
        if (WebSocketManager.isConnected()) {
            Log.d(TAG, "autoConnectIfSaved: already connected — skipping")
            return
        }

        val ip   = settings.ipAddress.ifEmpty { "127.0.0.1" }
        val port = settings.port

        Log.d(TAG, "autoConnectIfSaved: ip='$ip' port='$port' notificationAccess=${isNotificationServiceEnabled()}")

        if (isNotificationServiceEnabled()) {
            Log.i(TAG, "Auto-connecting to $ip:$port…")
            settings.saveConnection(ip, port)
            binding.etIpAddress.setText(ip)
            WebSocketManager.connect(ip, port)
        } else {
            Log.w(TAG, "Auto-connect skipped: Notification Access not granted yet")
        }
    }

    // ── WebSocket status observer ────────────────────────────────────────────────

    /**
     * Register for status changes from WebSocketManager.
     * Delivered on the main thread — UI updates are safe directly.
     */
    private fun observeWebSocketStatus() {
        WebSocketManager.onStatusChanged = { status ->
            applyConnectionStatus(status)
        }
    }

    /**
     * Apply the new [ConnectionStatus] to all status-related UI elements:
     *   - Status dot color
     *   - Status label text + color
     *   - Button text + color + enabled state
     *   - Input fields enabled/disabled
     *   - Queue size badge
     */
    private fun applyConnectionStatus(status: ConnectionStatus) {
        // Always update the status label first
        binding.tvStatus.text = status.displayText()

        when (status) {

            is ConnectionStatus.Connected -> {
                binding.tvStatus.setTextColor(color(R.color.status_connected))
                binding.viewStatusDot.setBackgroundResource(R.drawable.dot_connected)
                binding.btnConnect.text = getString(R.string.btn_disconnect)
                binding.btnConnect.setBackgroundColor(color(R.color.btn_disconnect))
                binding.btnConnect.isEnabled  = true
                binding.etIpAddress.isEnabled = false
                binding.etPort.isEnabled      = false
                binding.tvQueueSize.visibility = View.GONE
            }

            is ConnectionStatus.Connecting -> {
                binding.tvStatus.setTextColor(color(R.color.status_connecting))
                binding.viewStatusDot.setBackgroundResource(R.drawable.dot_connecting)
                binding.btnConnect.text      = getString(R.string.btn_connecting)
                binding.btnConnect.isEnabled = false   // prevent double-tap during handshake
                binding.tvQueueSize.visibility = View.GONE
            }

            is ConnectionStatus.Disconnected -> {
                binding.tvStatus.setTextColor(color(R.color.status_disconnected))
                binding.viewStatusDot.setBackgroundResource(R.drawable.dot_disconnected)
                binding.btnConnect.text = getString(R.string.btn_connect)
                binding.btnConnect.setBackgroundColor(color(R.color.btn_connect))
                binding.btnConnect.isEnabled  = isNotificationServiceEnabled()
                binding.etIpAddress.isEnabled = true
                binding.etPort.isEnabled      = true
                showQueueSizeIfNeeded()
            }

            is ConnectionStatus.Error -> {
                binding.tvStatus.setTextColor(color(R.color.status_error))
                binding.viewStatusDot.setBackgroundResource(R.drawable.dot_error)
                binding.tvStatus.text = "Error: ${status.message.take(55)}"
                binding.btnConnect.text = getString(R.string.btn_retry)
                binding.btnConnect.setBackgroundColor(color(R.color.btn_connect))
                binding.btnConnect.isEnabled  = true
                binding.etIpAddress.isEnabled = true
                binding.etPort.isEnabled      = true
                showQueueSizeIfNeeded()
            }
        }
    }

    /** Shows the queue size badge when there are pending offline messages. */
    private fun showQueueSizeIfNeeded() {
        val q = WebSocketManager.queueSize()
        if (q > 0) {
            binding.tvQueueSize.text = "📦 $q notification(s) queued"
            binding.tvQueueSize.visibility = View.VISIBLE
        } else {
            binding.tvQueueSize.visibility = View.GONE
        }
    }

    // ── Notification counters ────────────────────────────────────────────────────

    /**
     * Observe WebSocketManager.onNotificationSent — fires when a notification
     * is actually delivered to the relay server (immediately or from queue flush).
     * Updates the "Sent" counter with a bump animation.
     */
    private fun observeNotificationSent() {
        WebSocketManager.onNotificationSent = { totalSent ->
            binding.tvNotifSentCount.text = totalSent.toString()
            binding.tvNotifSentCount.startAnimation(
                AnimationUtils.loadAnimation(this, R.anim.count_bump)
            )
            // After a flush the queue size badge should disappear
            showQueueSizeIfNeeded()
        }
    }

    /**
     * Observe NotificationService.onCountChanged — fires whenever a notification
     * passes filters and is captured (may be queued, not yet sent).
     * Updates the "Captured" counter with a bump animation.
     */
    private fun observeNotificationCaptured() {
        NotificationService.onCountChanged = { captured ->
            binding.tvNotifCount.text = captured.toString()
            binding.tvNotifCount.startAnimation(
                AnimationUtils.loadAnimation(this, R.anim.count_bump)
            )
        }
    }

    // ── Notification Access permission ───────────────────────────────────────────

    /**
     * Show or hide the amber permission banner.
     * Called on every onResume() so the UI immediately reflects a newly-granted
     * permission without requiring an app restart.
     */
    private fun refreshPermissionBanner() {
        val hasPermission = isNotificationServiceEnabled()

        // Hide banner when permission is granted
        binding.cardPermission.visibility = if (hasPermission) View.GONE else View.VISIBLE

        // Dim the main card to signal it's unusable without permission
        binding.cardMain.alpha = if (hasPermission) 1.0f else 0.45f

        // Disable Connect if permission is missing (and not already connected)
        if (!WebSocketManager.isConnected()) {
            binding.btnConnect.isEnabled = hasPermission
        }
    }

    /**
     * Checks whether PhoneNotify's NotificationListenerService is active.
     * Uses the "enabled_notification_listeners" Secure Settings value —
     * there is no runtime permission constant for notification access.
     */
    private fun isNotificationServiceEnabled(): Boolean {
        val flat = Settings.Secure.getString(
            contentResolver,
            "enabled_notification_listeners"
        ) ?: return false

        val target = ComponentName(this, NotificationService::class.java)

        return flat.split(":").any { entry ->
            ComponentName.unflattenFromString(entry) == target
        }
    }

    /** Opens the system Notification Listener Settings page. */
    private fun openNotificationAccessSettings() {
        startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
    }

    // ── Utilities ────────────────────────────────────────────────────────────────

    /** Concise [ContextCompat.getColor] alias. */
    private fun color(resId: Int): Int = ContextCompat.getColor(this, resId)
}
