package com.mark.phonenotify

import android.Manifest
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.AudioManager
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.telecom.TelecomManager
import android.telephony.PhoneStateListener
import android.telephony.TelephonyManager
import android.text.Editable
import android.text.TextWatcher
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.animation.AnimationUtils
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.mark.phonenotify.databinding.ActivityMainBinding
import org.json.JSONObject

/**
 * MainActivity.kt — v3
 * ─────────────────────
 * Single-activity UI for Phone Notify.
 *
 * ── v3 additions ──
 *   1. Token input field — saved to SettingsManager and appended to WebSocket URL
 *   2. Battery receiver — fires sendBatteryStatus() on battery change events
 *   3. Phone state listener — fires sendCallStatus() on RINGING/OFFHOOK/IDLE
 *   4. Call control — answerCall() / rejectCall() via TelecomManager
 *   5. Runtime permission requests — READ_PHONE_STATE, ANSWER_PHONE_CALLS, CALL_PHONE
 *   6. Clipboard receiver — sets phone clipboard when extension sends clipboard_to_phone
 *
 * ── Thread model ──
 *   WebSocketManager.onStatusChanged        → main thread ✓
 *   WebSocketManager.onNotificationSent     → main thread ✓
 *   WebSocketManager.onCallAction           → main thread ✓
 *   WebSocketManager.onMediaControl         → main thread ✓
 *   WebSocketManager.onClipboardReceived    → main thread ✓
 *   NotificationService.onCountChanged      → main thread ✓
 *   BatteryReceiver.onReceive               → main thread ✓
 *   PhoneStateListener.onCallStateChanged   → main thread ✓
 */
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var settings: SettingsManager

    companion object {
        private const val TAG = "PhoneNotify:Main"

        // Runtime permission request codes
        private const val REQ_PHONE_PERMISSIONS = 1001
    }

    // ── Clipboard listener (phone → extension) ───────────────────────────────
    //
    // When the user copies something on the phone, we automatically forward
    // the clipboard text to the extension via WebSocket. The extension then
    // shows a dismissible toast with a "Copy" button so the user can paste
    // it into any browser field instantly.
    //
    // Limits: 8 000 chars max to avoid large frames; only when WS is connected.
    //
    private val clipboardListener = ClipboardManager.OnPrimaryClipChangedListener {
        try {
            val cm   = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val text = cm.primaryClip?.getItemAt(0)?.coerceToText(this)?.toString()
                ?: return@OnPrimaryClipChangedListener
            if (text.isBlank()) return@OnPrimaryClipChangedListener

            if (!WebSocketManager.isConnected()) {
                Log.d(TAG, "Clipboard changed but WS offline — not forwarding")
                return@OnPrimaryClipChangedListener
            }

            val payload = JSONObject().apply {
                put("type",       "clipboard_from_phone")
                put("text",       text.take(8_000))
                put("deviceName", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
                put("timestamp",  System.currentTimeMillis())
            }
            val sent = WebSocketManager.send(payload.toString())
            Log.i(TAG, "📋 Clipboard → extension: ${text.take(40)} ${if (sent) "→ sent" else "→ queued"}")

        } catch (e: Exception) {
            Log.e(TAG, "Clipboard listener error: ${e.message}")
        }
    }


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
                NotificationService.sendBatteryStatus(pct, charging)
                Log.d(TAG, "Battery changed: ${pct}% charging=$charging")
            }
        }
    }

    // ── Phone State Listener ───────────────────────────────────────────────────
    //
    // PhoneStateListener is deprecated in API 31 in favour of TelephonyCallback,
    // but PhoneStateListener is still functional on all API levels and is the
    // simplest cross-version approach for a personal project.

    @Suppress("DEPRECATION")
    private val phoneStateListener = object : PhoneStateListener() {

        private var lastState    = TelephonyManager.CALL_STATE_IDLE
        private var lastNumber   = ""

        @Deprecated("Deprecated in Java")
        override fun onCallStateChanged(state: Int, incomingNumber: String?) {
            if (state == lastState) return
            lastState = state
            val number = incomingNumber ?: ""
            if (number.isNotBlank()) lastNumber = number

            val callNumber = if (number.isNotBlank()) number else lastNumber

            when (state) {
                TelephonyManager.CALL_STATE_RINGING -> {
                    Log.i(TAG, "📞 RINGING: $callNumber")
                    NotificationService.sendCallStatus("ringing", callNumber)
                }
                TelephonyManager.CALL_STATE_OFFHOOK -> {
                    Log.i(TAG, "📞 OFFHOOK (answered)")
                    NotificationService.sendCallStatus("answered", callNumber)
                }
                TelephonyManager.CALL_STATE_IDLE -> {
                    Log.i(TAG, "📞 IDLE (ended/missed)")
                    NotificationService.sendCallStatus("ended", callNumber)
                    lastNumber = ""
                }
            }
        }
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────────

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding  = ActivityMainBinding.inflate(layoutInflater)
        settings = SettingsManager(this)
        setContentView(binding.root)

        if (NotificationService.contextRef == null) {
            NotificationService.contextRef = applicationContext
        }

        restoreSavedSettings()
        setupUrlPreview()
        setupClickListeners()
        observeWebSocketStatus()
        observeNotificationSent()
        observeNotificationCaptured()
        observeIncomingCommands()

        requestPhonePermissionsIfNeeded()
        autoConnectIfSaved()
    }

    override fun onResume() {
        super.onResume()
        refreshPermissionBanner()

        // Register battery receiver — sticky intent fires immediately with current level
        registerReceiver(batteryReceiver, IntentFilter(Intent.ACTION_BATTERY_CHANGED))

        // Register phone state listener if we have the required permission
        if (hasPermission(Manifest.permission.READ_PHONE_STATE)) {
            registerPhoneStateListener()
        }

        // Register clipboard listener (phone → extension sync)
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.addPrimaryClipChangedListener(clipboardListener)
    }

    override fun onPause() {
        super.onPause()

        try { unregisterReceiver(batteryReceiver) } catch (_: Exception) {}
        unregisterPhoneStateListener()

        // Unregister clipboard listener
        try {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.removePrimaryClipChangedListener(clipboardListener)
        } catch (_: Exception) {}
    }

    override fun onDestroy() {
        super.onDestroy()
        WebSocketManager.onStatusChanged = null
        WebSocketManager.onNotificationSent = null
        WebSocketManager.onCallAction = null
        WebSocketManager.onMediaControl = null
        WebSocketManager.onClipboardReceived = null
        if (NotificationService.contextRef == applicationContext) {
            NotificationService.contextRef = null
        }
    }

    // ── Phone permission helpers ───────────────────────────────────────────────

    private fun hasPermission(permission: String): Boolean =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun requestPhonePermissionsIfNeeded() {
        val needed = mutableListOf<String>()
        if (!hasPermission(Manifest.permission.READ_PHONE_STATE)) needed += Manifest.permission.READ_PHONE_STATE
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (!hasPermission(Manifest.permission.ANSWER_PHONE_CALLS)) needed += Manifest.permission.ANSWER_PHONE_CALLS
        }
        if (!hasPermission(Manifest.permission.CALL_PHONE)) needed += Manifest.permission.CALL_PHONE

        if (needed.isNotEmpty()) {
            Log.i(TAG, "Requesting phone permissions: $needed")
            ActivityCompat.requestPermissions(this, needed.toTypedArray(), REQ_PHONE_PERMISSIONS)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int, permissions: Array<out String>, grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_PHONE_PERMISSIONS) {
            val phoneGranted = grantResults.zip(permissions.toList())
                .find { (_, p) -> p == Manifest.permission.READ_PHONE_STATE }
                ?.first == PackageManager.PERMISSION_GRANTED

            if (phoneGranted) {
                Log.i(TAG, "READ_PHONE_STATE granted — registering phone state listener")
                registerPhoneStateListener()
            } else {
                Log.w(TAG, "READ_PHONE_STATE denied — call state detection disabled")
            }
        }
    }

    // ── Phone state listener registration ─────────────────────────────────────

    @Suppress("DEPRECATION")
    private fun registerPhoneStateListener() {
        try {
            val tm = getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
            tm.listen(phoneStateListener, PhoneStateListener.LISTEN_CALL_STATE)
            Log.d(TAG, "Phone state listener registered")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to register phone state listener: ${e.message}")
        }
    }

    @Suppress("DEPRECATION")
    private fun unregisterPhoneStateListener() {
        try {
            val tm = getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
            tm.listen(phoneStateListener, PhoneStateListener.LISTEN_NONE)
        } catch (_: Exception) {}
    }

    // ── Call control ───────────────────────────────────────────────────────────

    /**
     * Answer the currently ringing call.
     *
     * Uses TelecomManager.acceptRingingCall() which requires ANSWER_PHONE_CALLS
     * (API 26+). This method is deprecated in API 29 but still functional up to
     * at least API 33. A full InCallService implementation would be the correct
     * long-term solution for API 29+ devices.
     */
    @Suppress("DEPRECATION")
    private fun answerCall() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            Log.w(TAG, "answerCall(): requires API 26+")
            return
        }
        if (!hasPermission(Manifest.permission.ANSWER_PHONE_CALLS)) {
            Log.w(TAG, "answerCall(): ANSWER_PHONE_CALLS not granted")
            Toast.makeText(this, "Answer Calls permission not granted", Toast.LENGTH_SHORT).show()
            return
        }
        try {
            val telecom = getSystemService(Context.TELECOM_SERVICE) as TelecomManager
            telecom.acceptRingingCall()
            Log.i(TAG, "📞 Call answered via TelecomManager")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to answer call: ${e.message}")
        }
    }

    /**
     * Reject/end the currently active or ringing call.
     *
     * Uses TelecomManager.endCall() which is deprecated in API 28.
     * On API 29+ this may silently fail — the proper solution is InCallService.
     * CALL_PHONE permission is required.
     */
    @Suppress("DEPRECATION")
    private fun rejectCall() {
        if (!hasPermission(Manifest.permission.CALL_PHONE)) {
            Log.w(TAG, "rejectCall(): CALL_PHONE not granted")
            Toast.makeText(this, "Call Phone permission not granted", Toast.LENGTH_SHORT).show()
            return
        }
        try {
            val telecom = getSystemService(Context.TELECOM_SERVICE) as TelecomManager
            val ended   = telecom.endCall()
            Log.i(TAG, "📞 endCall() returned: $ended")
            if (!ended) {
                Log.w(TAG, "rejectCall(): endCall() returned false — may require InCallService on API 29+")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to reject call: ${e.message}")
        }
    }

    // ── Clipboard (phone receives text from extension) ─────────────────────────

    private fun setPhoneClipboard(text: String) {
        try {
            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("Phone Notify", text))
            Log.i(TAG, "📋 Clipboard set: ${text.take(40)}")
            Toast.makeText(this, "📋 Clipboard updated from browser", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to set clipboard: ${e.message}")
        }
    }

    // ── Incoming command observer ──────────────────────────────────────────────

    /**
     * Wire up WebSocketManager callbacks for commands the extension sends TO the phone.
     * All callbacks arrive on the main thread (posted by WebSocketManager).
     */
    private fun observeIncomingCommands() {
        WebSocketManager.onCallAction = { action ->
            Log.i(TAG, "call_action received: $action")
            when (action) {
                "answer"  -> answerCall()
                "reject"  -> rejectCall()
                "silence" -> {
                    // Silence is a best-effort audio duck — Android doesn't expose a
                    // public API to silence the ringer without MODIFY_AUDIO_SETTINGS.
                    // For now, reject silently achieves "silence + end call".
                    rejectCall()
                }
            }
        }

        WebSocketManager.onMediaControl = { action ->
            Log.i(TAG, "media_control received: $action")
        }

        WebSocketManager.onClipboardReceived = { text ->
            Log.i(TAG, "clipboard_to_phone: ${text.take(40)}")
            setPhoneClipboard(text)
        }
    }

    // ── Settings restore ────────────────────────────────────────────────────────

    private fun restoreSavedSettings() {
        val savedIp    = settings.ipAddress
        val savedPort  = settings.port
        val savedToken = settings.token

        binding.etIpAddress.setText(if (savedIp.isNotEmpty()) savedIp else "127.0.0.1")
        binding.etPort.setText(savedPort)
        binding.etToken.setText(savedToken)

        updateUrlPreview()
    }

    // ── URL preview ──────────────────────────────────────────────────────────────

    private fun setupUrlPreview() {
        val watcher = object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?,  start: Int, before: Int, count: Int)  = Unit
            override fun afterTextChanged(s: Editable?) = updateUrlPreview()
        }
        binding.etIpAddress.addTextChangedListener(watcher)
        binding.etPort.addTextChangedListener(watcher)
        // Token doesn't change the visible URL preview — it's appended internally
    }

    private fun updateUrlPreview() {
        val ip    = binding.etIpAddress.text.toString().trim()
        val port  = binding.etPort.text.toString().trim().ifEmpty { SettingsManager.DEFAULT_PORT }
        val token = binding.etToken.text.toString().trim()

        binding.tvUrlPreview.text = if (ip.isEmpty()) {
            "ws://127.0.0.1:8080?type=phone"
        } else {
            WebSocketManager.buildUrl(ip, port, token)
        }
    }

    // ── Click listeners ──────────────────────────────────────────────────────────

    private fun setupClickListeners() {

        binding.btnConnect.setOnClickListener {
            if (WebSocketManager.isConnected()) {
                Log.i(TAG, "User tapped Disconnect")
                WebSocketManager.disconnect()
            } else {
                val ip    = binding.etIpAddress.text.toString().trim()
                val port  = binding.etPort.text.toString().trim().ifEmpty { SettingsManager.DEFAULT_PORT }
                val token = binding.etToken.text.toString().trim()

                if (ip.isEmpty()) {
                    binding.etIpAddress.error = "Enter your laptop's IP address"
                    binding.etIpAddress.requestFocus()
                    return@setOnClickListener
                }

                val portNum = port.toIntOrNull()
                if (portNum == null || portNum !in 1..65535) {
                    binding.etPort.error = "Invalid port (1–65535)"
                    binding.etPort.requestFocus()
                    return@setOnClickListener
                }

                Log.i(TAG, "User tapped Connect → $ip:$port token=${token.isNotEmpty()}")
                settings.saveConnection(ip, port, token)
                WebSocketManager.connect(ip, port, token)
            }
        }

        binding.btnGrantPermission.setOnClickListener {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
    }

    private fun autoConnectIfSaved() {
        if (WebSocketManager.isConnected()) return

        val ip    = settings.ipAddress.ifEmpty { "127.0.0.1" }
        val port  = settings.port
        val token = settings.token

        if (isNotificationServiceEnabled()) {
            Log.i(TAG, "Auto-connecting to $ip:$port…")
            settings.saveConnection(ip, port, token)
            binding.etIpAddress.setText(ip)
            WebSocketManager.connect(ip, port, token)
        }
    }

    // ── WebSocket status ─────────────────────────────────────────────────────────

    private fun observeWebSocketStatus() {
        WebSocketManager.onStatusChanged = { status -> applyConnectionStatus(status) }
    }

    private fun applyConnectionStatus(status: ConnectionStatus) {
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
                binding.etToken.isEnabled     = false
                binding.tvQueueSize.visibility = View.GONE
            }
            is ConnectionStatus.Connecting -> {
                binding.tvStatus.setTextColor(color(R.color.status_connecting))
                binding.viewStatusDot.setBackgroundResource(R.drawable.dot_connecting)
                binding.btnConnect.text      = getString(R.string.btn_connecting)
                binding.btnConnect.isEnabled = false
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
                binding.etToken.isEnabled     = true
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
                binding.etToken.isEnabled     = true
                showQueueSizeIfNeeded()
            }
        }
    }

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

    private fun observeNotificationSent() {
        WebSocketManager.onNotificationSent = { totalSent ->
            binding.tvNotifSentCount.text = totalSent.toString()
            binding.tvNotifSentCount.startAnimation(AnimationUtils.loadAnimation(this, R.anim.count_bump))
            showQueueSizeIfNeeded()
        }
    }

    private fun observeNotificationCaptured() {
        NotificationService.onCountChanged = { captured ->
            binding.tvNotifCount.text = captured.toString()
            binding.tvNotifCount.startAnimation(AnimationUtils.loadAnimation(this, R.anim.count_bump))
        }
    }

    // ── Permission banner ────────────────────────────────────────────────────────

    private fun refreshPermissionBanner() {
        val hasPermission = isNotificationServiceEnabled()
        binding.cardPermission.visibility = if (hasPermission) View.GONE else View.VISIBLE
        binding.cardMain.alpha = if (hasPermission) 1.0f else 0.45f
        if (!WebSocketManager.isConnected()) {
            binding.btnConnect.isEnabled = hasPermission
        }
    }

    private fun isNotificationServiceEnabled(): Boolean {
        val flat   = Settings.Secure.getString(contentResolver, "enabled_notification_listeners") ?: return false
        val target = ComponentName(this, NotificationService::class.java)
        return flat.split(":").any { entry ->
            ComponentName.unflattenFromString(entry) == target
        }
    }

    // ── Utilities ────────────────────────────────────────────────────────────────

    private fun color(resId: Int): Int = ContextCompat.getColor(this, resId)
}
