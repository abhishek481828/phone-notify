/**
 * background.js — Phone Notify Service Worker v2
 * ─────────────────────────────────────────────────
 *
 * CRITICAL MV3 NOTES:
 *
 * 1. Service workers are NOT persistent in Manifest V3. Chrome suspends them
 *    after ~30 seconds of inactivity. Any pending setTimeout is silently
 *    cancelled on suspension. We use chrome.alarms instead of setTimeout for
 *    the reconnect schedule — alarms wake the service worker when they fire.
 *
 * 2. chrome.runtime.sendMessage() throws "Receiving end does not exist" when
 *    the side panel is not open. All notifications are first written to
 *    chrome.storage.local. The side panel reads from storage on open.
 *    sendMessage is a best-effort live push for when the panel is already open.
 *
 * NEW in v2:
 *  - Toolbar badge count (unread notifications)
 *  - Battery / media / call message handling + storage
 *  - Incoming call desktop notification with Answer / Reject buttons
 *  - history_cleared server message → wipes extension storage
 *  - MARK_ALL_READ and CLEAR_BADGE message handlers
 */

"use strict";

console.log("[Phone Notify] Background service worker loaded");

// ─── App URL Map ──────────────────────────────────────────────────────────────

const APP_URLS = {
  "com.whatsapp":                       "https://web.whatsapp.com/",
  "com.whatsapp.w4b":                   "https://web.whatsapp.com/",
  "org.telegram.messenger":             "https://web.telegram.org/",
  "org.telegram.plus":                  "https://web.telegram.org/",
  "com.google.android.gm":             "https://mail.google.com/",
  "com.instagram.android":             "https://www.instagram.com/",
  "com.discord":                        "https://discord.com/app",
  "com.snapchat.android":              "https://web.snapchat.com/",
  "com.twitter.android":               "https://x.com/",
  "com.facebook.katana":               "https://www.facebook.com/",
  "com.facebook.orca":                 "https://www.messenger.com/",
  "com.netflix.mediaclient":           "https://www.netflix.com/",
  "com.spotify.music":                 "https://open.spotify.com/",
  "com.amazon.mShop.android.shopping": "https://www.amazon.com/",
  "com.google.android.youtube":        "https://www.youtube.com/",
  "com.linkedin.android":              "https://www.linkedin.com/",
  "com.microsoft.office.outlook":      "https://outlook.live.com/",
  "com.microsoft.teams":               "https://teams.microsoft.com/",
  "com.slack":                          "https://slack.com/",
  "com.paypal.android.p2pmobile":      "https://www.paypal.com/",
  "in.amazon.mShop.android.shopping":  "https://www.amazon.in/",
  // Display name fallbacks
  "WhatsApp":  "https://web.whatsapp.com/",
  "Telegram":  "https://web.telegram.org/",
  "Gmail":     "https://mail.google.com/",
  "Instagram": "https://www.instagram.com/",
  "Discord":   "https://discord.com/app",
  "Snapchat":  "https://web.snapchat.com/",
  "Spotify":   "https://open.spotify.com/",
  "Slack":     "https://slack.com/",
};

// ID used for the persistent incoming-call desktop notification
const CALL_NOTIFICATION_ID = "phone-notify-incoming-call";

// ─── Side Panel opener ────────────────────────────────────────────────────────

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Phone Notify] Extension installed/updated");
  chrome.action.setBadgeBackgroundColor({ color: "#6366f1" });
  connectWebSocket();
});

// Keep-alive port connection from side panel (keeps worker active in MV3)
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "sidepanel") {
    console.log("[Phone Notify] Side panel connected — keeping service worker alive");
    port.onMessage.addListener((msg) => {
      if (msg.type === "ping") {
        console.log("[Phone Notify] Keep-alive ping received");
      }
    });
    port.onDisconnect.addListener(() => {
      console.log("[Phone Notify] Side panel disconnected — service worker can be suspended");
    });
  }
});

// ─── Alarm-based reconnect (MV3-safe) ────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "ws-reconnect") {
    console.log("[Phone Notify] Alarm fired — reconnecting WebSocket");
    connectWebSocket();
  }
});

// ─── Badge Sync ───────────────────────────────────────────────────────────────

/**
 * Recalculate the unread count from storage and update the toolbar badge.
 * Call this after every storage mutation that might affect unread state.
 */
async function syncBadge() {
  try {
    const { notifications = [] } = await chrome.storage.local.get({ notifications: [] });
    const unread = notifications.filter(n => n.unread).length;
    const text   = unread > 0 ? (unread > 99 ? "99+" : String(unread)) : "";
    await chrome.action.setBadgeText({ text });
  } catch (err) {
    console.warn("[Phone Notify] Badge sync failed:", err.message);
  }
}

// ─── DND Helper ───────────────────────────────────────────────────────────────

/**
 * Returns true if Do Not Disturb is currently active (within quiet hours).
 * DND settings are stored as { dndEnabled, dndStart: "HH:MM", dndEnd: "HH:MM" }.
 */
async function isDndActive() {
  const { dndEnabled = false, dndStart = "23:00", dndEnd = "07:00" } =
    await chrome.storage.local.get({ dndEnabled: false, dndStart: "23:00", dndEnd: "07:00" });

  if (!dndEnabled) return false;

  const now   = new Date();
  const nowM  = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = dndStart.split(":").map(Number);
  const [eh, em] = dndEnd.split(":").map(Number);
  const startM = sh * 60 + sm;
  const endM   = eh * 60 + em;

  // Handle overnight ranges (e.g. 23:00 – 07:00)
  return startM < endM
    ? nowM >= startM && nowM < endM          // same-day range
    : nowM >= startM || nowM < endM;         // overnight range
}

// ─── Per-App Mute Helper ─────────────────────────────────────────────────────

/**
 * Returns true if the given package/app name is in the user's mute list.
 */
async function isMuted(pkg, appName) {
  const { mutedApps = [] } = await chrome.storage.local.get({ mutedApps: [] });
  return mutedApps.includes(pkg) || mutedApps.includes(appName);
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

let ws = null;

async function connectWebSocket() {
  chrome.alarms.clear("ws-reconnect");

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    console.log("[Phone Notify] Already connected or connecting — skipping");
    return;
  }

  const settings = await chrome.storage.local.get({ serverUrl: "ws://localhost:8080", token: "" });

  let baseUrl = settings.serverUrl.trim() || "ws://localhost:8080";
  if (!baseUrl.startsWith("ws://") && !baseUrl.startsWith("wss://")) {
    if (baseUrl.startsWith("https://"))      baseUrl = baseUrl.replace("https://", "wss://");
    else if (baseUrl.startsWith("http://"))  baseUrl = baseUrl.replace("http://",  "ws://");
    else                                     baseUrl = `ws://${baseUrl}`;
  }

  const delim = baseUrl.includes("?") ? "&" : "?";
  let targetUrl = `${baseUrl}${delim}type=extension`;
  if (settings.token) targetUrl += `&token=${encodeURIComponent(settings.token)}`;

  console.log("[Phone Notify] Connecting to relay server:", baseUrl);
  ws = new WebSocket(targetUrl);

  ws.onopen = () => {
    console.log("[Phone Notify] Connected to relay server ✓");
    chrome.storage.local.set({ wsConnected: true });
    chrome.runtime.sendMessage({ type: "WS_STATUS", connected: true }).catch(() => {});
  };

  ws.onmessage = async (event) => {
    console.log("[Phone Notify] Received:", event.data);
    try {
      const data = JSON.parse(event.data);
      await handleServerMessage(data);
    } catch (err) {
      console.error("[Phone Notify] Message parse error:", err);
    }
  };

  ws.onclose = () => {
    console.log("[Phone Notify] Disconnected. Scheduling reconnect in ~3 s…");
    ws = null;
    chrome.storage.local.set({ wsConnected: false, phoneConnected: false });
    chrome.runtime.sendMessage({ type: "WS_STATUS",   connected: false }).catch(() => {});
    chrome.runtime.sendMessage({ type: "PHONE_STATUS", connected: false }).catch(() => {});
    chrome.alarms.create("ws-reconnect", { delayInMinutes: 0.05 });
  };

  ws.onerror = (err) => {
    console.error("[Phone Notify] WebSocket error:", err);
  };
}

// ─── Server Message Router ────────────────────────────────────────────────────

async function handleServerMessage(data) {
  // ── Server control frames ─────────────────────────────────────────────────
  if (data.type === "server_hello" || data.type === "error") return;

  // ── Phone connection status ───────────────────────────────────────────────
  if (data.type === "phone_status") {
    await chrome.storage.local.set({ phoneConnected: data.connected });
    chrome.runtime.sendMessage({ type: "PHONE_STATUS", connected: data.connected }).catch(() => {});
    return;
  }

  // ── Server IPs (for settings panel) ──────────────────────────────────────
  if (data.type === "server_ips") {
    await chrome.storage.local.set({ serverIps: data.ips });
    chrome.runtime.sendMessage({ type: "SERVER_IPS", ips: data.ips }).catch(() => {});
    return;
  }

  // ── Server cleared history ────────────────────────────────────────────────
  if (data.type === "history_cleared") {
    await chrome.storage.local.set({ notifications: [] });
    await chrome.action.setBadgeText({ text: "" });
    chrome.runtime.sendMessage({ type: "HISTORY_RECEIVED" }).catch(() => {});
    return;
  }

  // ── Phone sync start: clear all stale notifications, fresh list incoming ──
  // The phone sends sync_start when it connects, then pushes its currently
  // active notifications, then sends sync_end. This keeps extension in sync
  // with exactly what's on the phone's notification shade.
  if (data.type === "sync_start") {
    console.log("[Phone Notify] SYNC_START — clearing stale notifications for fresh sync");
    await chrome.storage.local.set({ notifications: [] });
    await chrome.action.setBadgeText({ text: "" });
    chrome.runtime.sendMessage({ type: "SYNC_START" }).catch(() => {});
    return;
  }

  // ── Phone sync end: all active notifications have been received ───────────
  if (data.type === "sync_end") {
    console.log("[Phone Notify] SYNC_END — sync complete, rendering final list");
    // Re-read from storage and tell the sidepanel to re-render
    chrome.runtime.sendMessage({ type: "HISTORY_RECEIVED" }).catch(() => {});
    return;
  }

  // ── Phone clear all notifications ─────────────────────────────────────────
  if (data.type === "clear_all_notifications") {
    console.log("[Phone Notify] CLEAR_ALL_NOTIFICATIONS — clearing all notifications");
    await chrome.storage.local.set({ notifications: [] });
    await chrome.action.setBadgeText({ text: "" });
    chrome.runtime.sendMessage({ type: "CLEAR_ALL_NOTIFICATIONS" }).catch(() => {});
    return;
  }

  // ── Phone full sync ───────────────────────────────────────────────────────
  if (data.type === "full_sync") {
    console.log("[Phone Notify] FULL_SYNC — replacing notifications with phone active list");
    const normalized = (data.notifications || []).map(raw => normaliseNotif(raw));
    normalized.sort((a, b) => b.timestamp - a.timestamp);
    if (normalized.length > 200) normalized.length = 200;
    
    await chrome.storage.local.set({ notifications: normalized });
    await syncBadge();
    chrome.runtime.sendMessage({ type: "HISTORY_RECEIVED" }).catch(() => {});
    return;
  }


  // ── Battery status ────────────────────────────────────────────────────────
  if (data.type === "battery") {
    await chrome.storage.local.set({ batteryStatus: data });
    chrome.runtime.sendMessage({ type: "BATTERY_STATUS", level: data.level, charging: data.charging }).catch(() => {});
    return;
  }

  // ── Clipboard from phone ──────────────────────────────────────────────────
  // The Android app forwards clipboard changes to the extension so the user
  // can paste phone content into any browser field with one click.
  if (data.type === "clipboard_from_phone") {
    const entry = { text: data.text, deviceName: data.deviceName || "", ts: Date.now() };
    await chrome.storage.local.set({ phoneClipboard: entry });
    chrome.runtime.sendMessage({
      type: "CLIPBOARD_FROM_PHONE",
      text: data.text,
      deviceName: data.deviceName || "",
    }).catch(() => {});
    return;
  }

  // ── Media status ──────────────────────────────────────────────────────────
  if (data.type === "media_status") {
    await chrome.storage.local.set({ mediaStatus: data });
    chrome.runtime.sendMessage({ type: "MEDIA_STATUS", ...data }).catch(() => {});
    return;
  }

  // ── Incoming / active / ended call ───────────────────────────────────────
  if (data.type === "call") {
    await handleCallMessage(data);
    return;
  }

  // ── Bulk history replay ───────────────────────────────────────────────────
  if (data.type === "history") {
    const result = await chrome.storage.local.get({ notifications: [] });
    let stored = result.notifications;
    let changed = false;

    for (const raw of data.notifications) {
      if (!stored.some(n => n.id === raw.id)) {
        stored.unshift(normaliseNotif(raw));
        changed = true;
      }
    }

    if (changed) {
      stored.sort((a, b) => b.timestamp - a.timestamp);
      if (stored.length > 200) stored.length = 200;
      await chrome.storage.local.set({ notifications: stored });
      await syncBadge();
      chrome.runtime.sendMessage({ type: "HISTORY_RECEIVED" }).catch(() => {});
    }
    return;
  }

  // ── Notification removed ──────────────────────────────────────────────────
  if (data.type === "notification_removed") {
    const result = await chrome.storage.local.get({ notifications: [] });
    let stored = result.notifications;
    const before = stored.length;
    if (data.key) {
      const targetKey = cleanKey(data.key);
      stored = stored.filter(n => cleanKey(n.key) !== targetKey && cleanKey(n.id) !== targetKey);
    } else if (data.package) {
      stored = stored.filter(n => n.package !== data.package);
    }
    if (stored.length !== before) {
      await chrome.storage.local.set({ notifications: stored });
      await syncBadge();
      chrome.runtime.sendMessage({ type: "NOTIFICATION_REMOVED", key: data.key, package: data.package }).catch(() => {});
    }
    return;
  }

  // ── Single notification ───────────────────────────────────────────────────
  if (data.type === "notification") {
    await handleNotification(data);
  }
}

// ─── Notification Handler ─────────────────────────────────────────────────────

async function handleNotification(data) {
  // Per-app mute check
  if (await isMuted(data.package, data.app)) {
    console.log("[Phone Notify] Notification from muted app — suppressed:", data.app);
    return;
  }

  const notif = normaliseNotif(data);

  // Persist to storage
  const result = await chrome.storage.local.get({ notifications: [] });
  let stored = result.notifications;

  // Look for existing notification with same id or key to update (using robust key cleaning)
  const cleanNotifId = cleanKey(notif.id);
  const cleanNotifKey = cleanKey(notif.key);
  const existingIndex = stored.findIndex(n => {
    const cleanNId = cleanKey(n.id);
    const cleanNKey = cleanKey(n.key);
    return cleanNId === cleanNotifId || (notif.key && cleanNKey === cleanNotifKey);
  });

  if (existingIndex !== -1) {
    const existing = stored[existingIndex];

    // If title and message are exactly identical, skip to avoid spam (like progress bars)
    if (existing.title === notif.title && existing.message === notif.message) {
      console.log("[Phone Notify] Duplicate content for existing notification — skipped:", notif.id);
      return;
    }

    // Update existing notification with new content
    existing.title = notif.title;
    existing.message = notif.message;
    existing.timestamp = notif.timestamp;
    existing.receivedAt = Date.now();
    existing.unread = true; // Mark as unread again for new message/track
    existing.replyable = notif.replyable;

    // Move to top of the list
    stored.splice(existingIndex, 1);
    stored.unshift(existing);

    await chrome.storage.local.set({ notifications: stored });
    await syncBadge();

    // Broadcast update to the side panel
    chrome.runtime.sendMessage({ type: "UPDATE_NOTIFICATION", payload: existing }).catch(() => {});
  } else {
    // Brand new notification
    stored.unshift(notif);
    if (stored.length > 200) stored.length = 200;

    await chrome.storage.local.set({ notifications: stored });
    await syncBadge();

    // Broadcast new notification to the side panel
    chrome.runtime.sendMessage({ type: "NEW_NOTIFICATION", payload: notif }).catch(() => {});
  }

  // Desktop notification (skip if DND is active)
  if (!(await isDndActive())) {
    chrome.notifications.create(notif.id, {
      type:     "basic",
      iconUrl:  chrome.runtime.getURL("icons/icon128.png"),
      title:    `${notif.app}: ${notif.title}`,
      message:  notif.message,
      priority: 2,
    }, (id) => {
      if (chrome.runtime.lastError) {
        console.error("[Phone Notify] Native notification failed:", chrome.runtime.lastError.message);
      }
    });
  }
}

// ─── Call Handler ─────────────────────────────────────────────────────────────

async function handleCallMessage(data) {
  await chrome.storage.local.set({ activeCall: data });
  chrome.runtime.sendMessage({ type: "CALL_UPDATE", ...data }).catch(() => {});

  if (data.state === "ringing") {
    const callerDisplay = data.callerName || data.callerNumber || "Unknown";

    // Show a persistent desktop notification with Answer / Reject buttons
    if (!(await isDndActive())) {
      chrome.notifications.create(CALL_NOTIFICATION_ID, {
        type:              "basic",
        iconUrl:           chrome.runtime.getURL("icons/icon128.png"),
        title:             "📞 Incoming Call",
        message:           callerDisplay,
        priority:          2,
        requireInteraction: true,
        buttons: [
          { title: "✅ Answer" },
          { title: "❌ Reject" },
        ],
      }, () => {
        if (chrome.runtime.lastError) {
          console.error("[Phone Notify] Call notification error:", chrome.runtime.lastError.message);
        }
      });
    }
  } else if (data.state === "ended" || data.state === "answered" || data.state === "missed") {
    // Clear the call notification and active call state
    chrome.notifications.clear(CALL_NOTIFICATION_ID);
    await chrome.storage.local.remove("activeCall");
    chrome.runtime.sendMessage({ type: "CALL_ENDED" }).catch(() => {});
  }
}

// ─── Notification button clicks (Answer / Reject call) ───────────────────────

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (notificationId !== CALL_NOTIFICATION_ID) return;
  chrome.notifications.clear(CALL_NOTIFICATION_ID);
  const action = buttonIndex === 0 ? "answer" : "reject";
  sendToPhone({ type: "call_action", action });
});

// ─── Desktop notification click → open web app ───────────────────────────────

chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (notificationId === CALL_NOTIFICATION_ID) return;
  const result = await chrome.storage.local.get({ notifications: [] });
  let stored = result.notifications;
  const notif = stored.find(n => n.id === notificationId);
  if (notif) {
    notif.unread = false;
    await chrome.storage.local.set({ notifications: stored });
    await syncBadge();
    chrome.runtime.sendMessage({ type: "HISTORY_RECEIVED" }).catch(() => {});

    const appKey = notif.package || notif.app || "";
    const url    = APP_URLS[appKey];
    if (url) chrome.tabs.create({ url });
  }
  chrome.notifications.clear(notificationId);
});

// ─── Message Router (from side panel / popup) ─────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {

  // Sidepanel queries live WS + phone status on open
  if (message.type === "GET_WS_STATUS") {
    const wsOpen = ws !== null && ws.readyState === WebSocket.OPEN;
    chrome.storage.local.get({ phoneConnected: false }).then(r => {
      sendResponse({ wsConnected: wsOpen, phoneConnected: r.phoneConnected });
    });
    return true; // keep message channel open for async sendResponse
  }

  if (message.type === "RECONNECT_WS") {
    console.log("[Phone Notify] RECONNECT_WS — reconnecting");
    if (ws) {
      ws.onclose = null;
      try { ws.close(); } catch (_) {}
      ws = null;
      chrome.storage.local.set({ wsConnected: false, phoneConnected: false });
      chrome.runtime.sendMessage({ type: "WS_STATUS",   connected: false }).catch(() => {});
      chrome.runtime.sendMessage({ type: "PHONE_STATUS", connected: false }).catch(() => {});
    }
    connectWebSocket();
  }

  if (message.type === "SEND_REPLY") {
    console.log("[Phone Notify] Sending reply via WebSocket:", message.key);
    sendToPhone({ type: "reply", key: message.key, message: message.message });
  }

  if (message.type === "SEND_CALL_ACTION") {
    sendToPhone({ type: "call_action", action: message.action });
  }

  if (message.type === "SEND_MEDIA_CONTROL") {
    sendToPhone({ type: "media_control", action: message.action });
  }

  if (message.type === "SEND_CLIPBOARD_TO_PHONE" || message.type === "AUTO_COPY_CLIPBOARD") {
    sendToPhone({ type: "clipboard_to_phone", text: message.text });
  }

  if (message.type === "UPDATE_DND") {
    // Cache DND settings in storage immediately so isInDndWindow() uses the
    // updated values on the very next notification — no restart required.
    chrome.storage.local.set({
      dndEnabled: message.dndEnabled,
      dndStart:   message.dndStart,
      dndEnd:     message.dndEnd,
    });
    console.log(`[Phone Notify] DND updated: enabled=${message.dndEnabled} ${message.dndStart}–${message.dndEnd}`);
  }

  if (message.type === "MARK_ALL_READ") {
    (async () => {
      const result = await chrome.storage.local.get({ notifications: [] });
      const stored = result.notifications.map(n => ({ ...n, unread: false }));
      await chrome.storage.local.set({ notifications: stored });
      await syncBadge();
    })();
  }

  if (message.type === "SYNC_BADGE") {
    syncBadge();
  }

  return false;
});

// ─── Send to Phone Helper ─────────────────────────────────────────────────────

function sendToPhone(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(payload));
    } catch (err) {
      console.error("[Phone Notify] Failed to send to phone:", err.message);
    }
  } else {
    console.warn("[Phone Notify] Cannot send to phone: WebSocket is not open");
  }
}

// ─── Key Cleaning Helper ──────────────────────────────────────────────────────

/**
 * Normalise keys by trimming and stripping all whitespace and newlines to prevent
 * mismatches when notifications are swiped away on the phone.
 */
function cleanKey(key) {
  if (typeof key !== "string") return key;
  return key.trim().replace(/[\s\r\n]/g, "");
}

// ─── Normalise Notification ───────────────────────────────────────────────────

/**
 * Normalise a raw server payload into a consistent object for storage.
 */
function normaliseNotif(raw) {
  return {
    ...raw,
    id:         raw.id || raw.key || `n-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    receivedAt: Date.now(),
    unread:     true,
    timestamp:  raw.timestamp || Date.now(),
    app:        raw.app     || "Unknown",
    title:      raw.title   || "",
    message:    raw.message || "",
    sender:     raw.title   || raw.app || "Unknown",
  };
}

// ─── Init ─────────────────────────────────────────────────────────────────────

connectWebSocket();