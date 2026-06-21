/**
 * background.js — Phone Notify Service Worker
 * ─────────────────────────────────────────────
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
 */

"use strict";

console.log("[Phone Notify] Background service worker loaded");

const APP_URLS = {
  "com.whatsapp": "https://web.whatsapp.com/",
  "com.whatsapp.w4b": "https://web.whatsapp.com/",
  "org.telegram.messenger": "https://web.telegram.org/",
  "org.telegram.plus": "https://web.telegram.org/",
  "com.google.android.gm": "https://mail.google.com/",
  "com.instagram.android": "https://www.instagram.com/",
  "com.discord": "https://discord.com/app",
  "com.snapchat.android": "https://web.snapchat.com/",
  "com.twitter.android": "https://x.com/",
  "com.facebook.katana": "https://www.facebook.com/",
  "com.facebook.orca": "https://www.messenger.com/",
  "com.netflix.mediaclient": "https://www.netflix.com/",
  "com.spotify.music": "https://open.spotify.com/",
  "com.amazon.mShop.android.shopping": "https://www.amazon.com/",
  "com.google.android.youtube": "https://www.youtube.com/",
  "com.linkedin.android": "https://www.linkedin.com/",
  "com.microsoft.office.outlook": "https://outlook.live.com/",
  "com.microsoft.teams": "https://teams.microsoft.com/",
  "com.slack": "https://slack.com/",
  "com.paypal.android.p2pmobile": "https://www.paypal.com/",
  "in.amazon.mShop.android.shopping": "https://www.amazon.in/",
  "WhatsApp": "https://web.whatsapp.com/",
  "Telegram": "https://web.telegram.org/",
  "Gmail": "https://mail.google.com/",
  "Instagram": "https://www.instagram.com/",
  "Discord": "https://discord.com/app",
  "Snapchat": "https://web.snapchat.com/",
  "Spotify": "https://open.spotify.com/",
  "Slack": "https://slack.com/",
};

// ─── Side Panel opener ────────────────────────────────────────────────────────

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Phone Notify] Extension installed");
  connectWebSocket();
});

// Keep-alive port connection from side panel (keeps worker active in MV3)
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "sidepanel") {
    console.log("[Phone Notify] Side panel connected — keeping service worker alive");
    port.onMessage.addListener((msg) => {
      if (msg.type === "ping") {
        // Receive ping to reset idle timer
        console.log("[Phone Notify] Keep-alive ping received");
      }
    });
    port.onDisconnect.addListener(() => {
      console.log("[Phone Notify] Side panel disconnected — service worker can be suspended");
    });
  }
});

// ─── Alarm-based reconnect (MV3-safe) ────────────────────────────────────────
//
// setTimeout does NOT keep a service worker alive and is cancelled when the
// worker is suspended by Chrome. chrome.alarms are guaranteed to fire and
// will restart the service worker if needed.

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "ws-reconnect") {
    console.log("[Phone Notify] Alarm fired — reconnecting WebSocket");
    connectWebSocket();
  }
});

// ─── WebSocket ────────────────────────────────────────────────────────────────

let ws = null;

async function connectWebSocket() {
  // Cancel any pending reconnect alarm to avoid double-connects
  chrome.alarms.clear("ws-reconnect");

  // Don't open a second socket if one is already open or connecting
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    console.log("[Phone Notify] Already connected or connecting — skipping");
    return;
  }

  // Load custom connection settings
  const settings = await chrome.storage.local.get({
    serverUrl: "ws://localhost:8080",
    token: ""
  });

  let baseUrl = settings.serverUrl.trim() || "ws://localhost:8080";

  // Auto-prepend ws:// or wss:// if protocol is missing
  if (!baseUrl.startsWith("ws://") && !baseUrl.startsWith("wss://")) {
    if (baseUrl.startsWith("https://")) {
      baseUrl = baseUrl.replace("https://", "wss://");
    } else if (baseUrl.startsWith("http://")) {
      baseUrl = baseUrl.replace("http://", "ws://");
    } else {
      baseUrl = `ws://${baseUrl}`;
    }
  }

  const delimiter = baseUrl.includes("?") ? "&" : "?";
  let targetUrl = `${baseUrl}${delimiter}type=extension`;
  if (settings.token) {
    targetUrl += `&token=${encodeURIComponent(settings.token)}`;
  }

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

      // Ignore server control frames
      if (data.type === "server_hello" || data.type === "error") return;

      // ── Handle phone status ───────────────────────────────────────────────
      if (data.type === "phone_status") {
        await chrome.storage.local.set({ phoneConnected: data.connected });
        chrome.runtime.sendMessage({ type: "PHONE_STATUS", connected: data.connected }).catch(() => {});
        return;
      }

      // ── Handle bulk history ────────────────────────────────────────────────
      if (data.type === "history") {
        const result = await chrome.storage.local.get({ notifications: [] });
        let stored = result.notifications;
        let changed = false;

        for (const rawNotif of data.notifications) {
          const exists = stored.some(n => n.id === rawNotif.id);
          if (!exists) {
            const notif = {
              ...rawNotif,
              receivedAt: Date.now(),
              unread: true,
              timestamp: rawNotif.timestamp || Date.now(),
              app:     rawNotif.app     || "Unknown",
              title:   rawNotif.title   || "",
              message: rawNotif.message || "",
              sender:  rawNotif.title   || rawNotif.app || "Unknown",
            };
            stored.unshift(notif);
            changed = true;
          }
        }

        if (changed) {
          stored.sort((a, b) => b.timestamp - a.timestamp);
          if (stored.length > 200) stored.length = 200;
          await chrome.storage.local.set({ notifications: stored });
          chrome.runtime.sendMessage({ type: "HISTORY_RECEIVED" }).catch(() => {});
        }
        return;
      }

      // ── Handle notification removal ────────────────────────────────────────
      if (data.type === "notification_removed") {
        const result = await chrome.storage.local.get({ notifications: [] });
        let stored = result.notifications;
        const key = data.key;
        const pkg = data.package;

        let initialLength = stored.length;
        if (key) {
          stored = stored.filter(n => n.key !== key);
        } else if (pkg) {
          stored = stored.filter(n => n.package !== pkg);
        }

        if (stored.length !== initialLength) {
          await chrome.storage.local.set({ notifications: stored });
          chrome.runtime.sendMessage({ type: "NOTIFICATION_REMOVED", key: key, package: pkg }).catch(() => {});
        }
        return;
      }

      // ── Handle single notification ─────────────────────────────────────────
      const notif = {
        ...data,
        id: data.id || `n-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        receivedAt: Date.now(),
        unread: true,
        // Normalise the timestamp field — server sends Unix ms
        timestamp: data.timestamp || Date.now(),
        // Ensure display fields exist
        app:     data.app     || "Unknown",
        title:   data.title   || "",
        message: data.message || "",
        sender:  data.title   || data.app || "Unknown",  // sidepanel uses 'sender'
      };

      // ── Persist to storage ────────────────────────────────────────────────
      // This is the primary delivery mechanism. The side panel reads from
      // storage on every open, so notifications are never lost.
      const result = await chrome.storage.local.get({ notifications: [] });
      const stored = result.notifications;
      stored.unshift(notif);
      if (stored.length > 200) stored.length = 200; // cap at 200
      await chrome.storage.local.set({ notifications: stored });

      // ── Show native desktop notification ──────────────────────────────────
      chrome.notifications.create(notif.id, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: `${notif.app}: ${notif.title}`,
        message: notif.message,
        priority: 2
      }, (id) => {
        if (chrome.runtime.lastError) {
          console.error("[Phone Notify] Native notification failed:", chrome.runtime.lastError.message);
        } else {
          console.log("[Phone Notify] Native notification shown with ID:", id);
        }
      });

      // ── Live push to side panel (best-effort) ─────────────────────────────
      // Only succeeds when the side panel is currently open. The catch
      // suppresses the "Receiving end does not exist" error that fires
      // when the panel is closed — that is expected and harmless.
      chrome.runtime.sendMessage({ type: "NEW_NOTIFICATION", payload: notif })
        .catch(() => {});

    } catch (err) {
      console.error("[Phone Notify] Message parse error:", err);
    }
  };

  ws.onclose = () => {
    console.log("[Phone Notify] Disconnected. Scheduling reconnect in ~3s...");
    ws = null;
    chrome.storage.local.set({ wsConnected: false, phoneConnected: false });
    chrome.runtime.sendMessage({ type: "WS_STATUS", connected: false }).catch(() => {});
    chrome.runtime.sendMessage({ type: "PHONE_STATUS", connected: false }).catch(() => {});
    chrome.alarms.create("ws-reconnect", { delayInMinutes: 0.05 });
  };

  ws.onerror = (err) => {
    console.error("[Phone Notify] WebSocket error:", err);
    // onclose fires after onerror and handles scheduling the reconnect
  };
}

// Listen for connection configuration changes from the UI
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "RECONNECT_WS") {
    console.log("[Phone Notify] RECONNECT_WS message received. Reconnecting now...");
    if (ws) {
      ws.onclose = null; // Detach to avoid double triggers
      try {
        ws.close();
      } catch (e) {}
      ws = null;
      chrome.storage.local.set({ wsConnected: false, phoneConnected: false });
      chrome.runtime.sendMessage({ type: "WS_STATUS", connected: false }).catch(() => {});
      chrome.runtime.sendMessage({ type: "PHONE_STATUS", connected: false }).catch(() => {});
    }
    connectWebSocket();
  }
  if (message.type === "SEND_REPLY") {
    console.log("[Phone Notify] Sending reply via WebSocket:", message.key);
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({
          type: "reply",
          key: message.key,
          message: message.message
        }));
      } catch (e) {
        console.error("[Phone Notify] Failed to send reply through WebSocket:", e);
      }
    } else {
      console.warn("[Phone Notify] Cannot send reply: WebSocket is closed");
    }
  }
  return false;
});

// Handle desktop notification click to mark read and open URL
chrome.notifications.onClicked.addListener(async (notificationId) => {
  const result = await chrome.storage.local.get({ notifications: [] });
  let stored = result.notifications;
  const notif = stored.find(n => n.id === notificationId);
  if (notif) {
    // Mark as read
    notif.unread = false;
    await chrome.storage.local.set({ notifications: stored });
    // Notify sidepanel to refresh
    chrome.runtime.sendMessage({ type: "HISTORY_RECEIVED" }).catch(() => {});

    // Open corresponding URL if mapping exists
    const appKey = notif.package || notif.app || "";
    const url = APP_URLS[appKey];
    if (url) {
      chrome.tabs.create({ url: url });
    }
  }
  chrome.notifications.clear(notificationId);
});

// Initiate connection when the service worker first loads
connectWebSocket();