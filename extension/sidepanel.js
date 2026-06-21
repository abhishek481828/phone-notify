/**
 * sidepanel.js — Phone Notify Side Panel Logic
 * ──────────────────────────────────────────────
 *
 * Handles:
 *  1. Loading persisted notifications from chrome.storage.local
 *  2. Rendering notification cards (handles REAL phone data: Unix timestamps,
 *     unknown app names, title/message fields from NotificationService.kt)
 *  3. Live search and app-filter pills
 *  4. Per-card dismiss (with animation) and clear-all
 *  5. Mark-as-read on click
 *  6. Live push from background.js via chrome.runtime.onMessage
 *  7. WebSocket status display
 */

"use strict";

// Keep the background service worker alive while the side panel is open
const port = chrome.runtime.connect({ name: "sidepanel" });
setInterval(() => {
  try {
    port.postMessage({ type: "ping" });
  } catch (e) {}
}, 10_000);

// ─── 1. App Metadata ──────────────────────────────────────────────────────────
//
// Maps Android package name OR display app name → accent color + emoji.
// Used to make known apps look branded. Unknown apps fall back gracefully.

const APP_META = {
  // Common package names sent by NotificationService.kt
  "com.whatsapp":                        { color: "#25D366", rgb: "37,211,102",   emoji: "💬", label: "WhatsApp", url: "https://web.whatsapp.com/"  },
  "com.whatsapp.w4b":                    { color: "#25D366", rgb: "37,211,102",   emoji: "💬", label: "WhatsApp Business", url: "https://web.whatsapp.com/" },
  "org.telegram.messenger":              { color: "#2AABEE", rgb: "42,171,238",   emoji: "✈️", label: "Telegram", url: "https://web.telegram.org/"  },
  "org.telegram.plus":                   { color: "#2AABEE", rgb: "42,171,238",   emoji: "✈️", label: "Telegram", url: "https://web.telegram.org/"  },
  "com.google.android.gm":              { color: "#EA4335", rgb: "234,67,53",     emoji: "📧", label: "Gmail", url: "https://mail.google.com/"     },
  "com.instagram.android":              { color: "#E1306C", rgb: "225,48,108",    emoji: "📸", label: "Instagram", url: "https://www.instagram.com/" },
  "com.discord":                         { color: "#5865F2", rgb: "88,101,242",    emoji: "🎮", label: "Discord", url: "https://discord.com/app"   },
  "com.snapchat.android":               { color: "#FFFC00", rgb: "255,252,0",     emoji: "👻", label: "Snapchat", url: "https://web.snapchat.com/"  },
  "com.twitter.android":                { color: "#1DA1F2", rgb: "29,161,242",    emoji: "🐦", label: "Twitter", url: "https://x.com/"   },
  "com.facebook.katana":                { color: "#1877F2", rgb: "24,119,242",    emoji: "👍", label: "Facebook", url: "https://www.facebook.com/"  },
  "com.facebook.orca":                  { color: "#0084FF", rgb: "0,132,255",     emoji: "💙", label: "Messenger", url: "https://www.messenger.com/" },
  "com.netflix.mediaclient":            { color: "#E50914", rgb: "229,9,20",      emoji: "🎬", label: "Netflix", url: "https://www.netflix.com/"   },
  "com.spotify.music":                  { color: "#1DB954", rgb: "29,185,84",     emoji: "🎵", label: "Spotify", url: "https://open.spotify.com/"   },
  "com.amazon.mShop.android.shopping":  { color: "#FF9900", rgb: "255,153,0",     emoji: "📦", label: "Amazon", url: "https://www.amazon.com/"    },
  "com.google.android.youtube":         { color: "#FF0000", rgb: "255,0,0",       emoji: "▶️", label: "YouTube", url: "https://www.youtube.com/"   },
  "com.linkedin.android":               { color: "#0077B5", rgb: "0,119,181",     emoji: "💼", label: "LinkedIn", url: "https://www.linkedin.com/"  },
  "com.microsoft.office.outlook":       { color: "#0078D4", rgb: "0,120,212",     emoji: "📫", label: "Outlook", url: "https://outlook.live.com/"   },
  "com.microsoft.teams":                { color: "#6264A7", rgb: "98,100,167",    emoji: "💜", label: "Teams", url: "https://teams.microsoft.com/"     },
  "com.slack":                           { color: "#4A154B", rgb: "74,21,75",      emoji: "🔷", label: "Slack", url: "https://slack.com/"     },
  "com.paypal.android.p2pmobile":       { color: "#003087", rgb: "0,48,135",      emoji: "💸", label: "PayPal", url: "https://www.paypal.com/"    },
  "in.amazon.mShop.android.shopping":  { color: "#FF9900", rgb: "255,153,0",     emoji: "🛒", label: "Amazon", url: "https://www.amazon.in/"    },
  // Display name fallbacks (in case NotificationService sends app label)
  "WhatsApp":  { color: "#25D366", rgb: "37,211,102",  emoji: "💬", url: "https://web.whatsapp.com/" },
  "Telegram":  { color: "#2AABEE", rgb: "42,171,238",  emoji: "✈️", url: "https://web.telegram.org/" },
  "Gmail":     { color: "#EA4335", rgb: "234,67,53",   emoji: "📧", url: "https://mail.google.com/" },
  "Instagram": { color: "#E1306C", rgb: "225,48,108",  emoji: "📸", url: "https://www.instagram.com/" },
  "Discord":   { color: "#5865F2", rgb: "88,101,242",  emoji: "🎮", url: "https://discord.com/app" },
  "Snapchat":  { color: "#FFFC00", rgb: "255,252,0",   emoji: "👻", url: "https://web.snapchat.com/" },
  "Spotify":   { color: "#1DB954", rgb: "29,185,84",   emoji: "🎵", url: "https://open.spotify.com/" },
  "Slack":     { color: "#4A154B", rgb: "74,21,75",    emoji: "🔷", url: "https://slack.com/" },
};

/**
 * getMeta(notif)
 * Returns the APP_META entry for a notification. Tries:
 *  1. notif.package (exact Android package name)
 *  2. notif.app (display label sent by NotificationService)
 *  3. Generates a consistent color from the string hash
 */
function getMeta(notif) {
  if (notif.package && APP_META[notif.package]) return APP_META[notif.package];
  if (notif.app     && APP_META[notif.app])     return APP_META[notif.app];

  // Unknown app — derive a deterministic hue from the package/app name
  const seed = notif.package || notif.app || "unknown";
  const hue  = Math.abs(hashCode(seed)) % 360;
  const color = `hsl(${hue}, 65%, 55%)`;
  // Parse hsl to rgb approximation for the glow (simplified)
  const rgb = hslToRgbStr(hue, 65, 55);
  const emoji = appNameToEmoji(notif.app || "");
  const label = notif.app || notif.package || "App";
  return { color, rgb, emoji, label };
}

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  return h;
}

function hslToRgbStr(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => Math.round((l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))) * 255);
  return `${f(0)},${f(8)},${f(4)}`;
}

function appNameToEmoji(name) {
  const n = name.toLowerCase();
  if (n.includes("phone") || n.includes("call"))  return "📞";
  if (n.includes("mail") || n.includes("email"))  return "📧";
  if (n.includes("message") || n.includes("sms")) return "💬";
  if (n.includes("bank") || n.includes("pay"))    return "💳";
  if (n.includes("music") || n.includes("sound")) return "🎵";
  if (n.includes("photo") || n.includes("cam"))   return "📷";
  if (n.includes("map") || n.includes("nav"))     return "🗺️";
  if (n.includes("shop") || n.includes("store"))  return "🛒";
  if (n.includes("game"))                          return "🎮";
  if (n.includes("news"))                          return "📰";
  return "🔔";
}

// ─── 2. State ─────────────────────────────────────────────────────────────────

let notifications = [];
let activeFilter  = "All";
let searchQuery   = "";

// ─── 3. DOM References ────────────────────────────────────────────────────────

const listEl      = document.getElementById("notification-list");
const countEl     = document.getElementById("notif-count");
const searchInput = document.getElementById("search-input");
const filterBar   = document.getElementById("filter-bar");
const clearBtn    = document.getElementById("clear-btn");
const emptyState  = document.getElementById("empty-state");
const wsDot       = document.getElementById("ws-dot");
const wsLabel     = document.getElementById("ws-label");
const wsStatus    = document.getElementById("ws-status");
const footerDot   = document.getElementById("footer-dot");
const footerText  = document.getElementById("footer-text");

const settingsBtn    = document.getElementById("settings-btn");
const settingsPanel  = document.getElementById("settings-panel");
const settingsUrl    = document.getElementById("settings-url");
const settingsToken  = document.getElementById("settings-token");
const settingsCancel = document.getElementById("settings-cancel");
const settingsSave   = document.getElementById("settings-save");

// ─── 4. Timestamp Formatting ──────────────────────────────────────────────────

/**
 * formatTime(ts)
 * Accepts a Unix timestamp in ms OR a pre-formatted string.
 * Returns a human-friendly relative time string ("2m ago", "3h ago", etc.)
 */
function formatTime(ts) {
  // If already a string (e.g. sample data), pass through
  if (typeof ts === "string") return ts;
  if (!ts) return "";

  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 5)   return "just now";
  if (s < 60)  return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7)   return `${d}d ago`;
  // Older than a week — show actual date
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Auto-refresh relative times every minute
setInterval(() => {
  document.querySelectorAll(".card-time[data-ts]").forEach(el => {
    const ts = parseInt(el.dataset.ts, 10);
    el.textContent = formatTime(ts);
  });
}, 60_000);

// ─── 5. Rendering ─────────────────────────────────────────────────────────────

function buildFilteredList() {
  return notifications.filter(n => {
    const matchesApp = activeFilter === "All" || getDisplayApp(n) === activeFilter;
    const q = searchQuery.toLowerCase();
    const title   = (n.title   || n.sender  || "").toLowerCase();
    const message = (n.message || "").toLowerCase();
    const app     = (n.app     || "").toLowerCase();
    const pkg     = (n.package || "").toLowerCase();
    const matchesSearch = !q || title.includes(q) || message.includes(q) ||
                          app.includes(q) || pkg.includes(q);
    return matchesApp && matchesSearch;
  });
}

/** Returns the display-friendly app name for a notification. */
function getDisplayApp(n) {
  const meta = getMeta(n);
  return meta.label || n.app || n.package || "App";
}

/**
 * createCard(n, index)
 * Builds one notification <article> element for a real notification object.
 *
 * Real notification fields from NotificationService.kt:
 *   n.type      = "notification"
 *   n.app       = resolved app label ("WhatsApp") or package fallback
 *   n.package   = "com.whatsapp"
 *   n.title     = notification title (the sender name / subject)
 *   n.message   = notification body text
 *   n.timestamp = Unix ms (number)
 *   n.id        = unique string
 *   n.unread    = boolean
 */
function createCard(n, index) {
  const meta    = getMeta(n);
  const title   = n.title   || n.sender  || "Notification";
  const message = n.message || "";
  const appName = getDisplayApp(n);
  const timeStr = formatTime(n.timestamp);
  const tsNum   = typeof n.timestamp === "number" ? n.timestamp : null;

  const article = document.createElement("article");
  article.className = `notif-card${n.unread ? " unread" : ""}`;
  article.dataset.id = n.id;
  article.style.setProperty("--accent",     meta.color);
  article.style.setProperty("--card-index", index);

  if (meta.url) {
    article.title = `Click to open ${appName}`;
  }

  // Avatar background is accent color at ~15% opacity
  const avatarBg     = `${meta.color}28`;
  const avatarBorder = `${meta.color}45`;

  // Build innerHTML — flat flex row: avatar | text | dismiss
  article.innerHTML = `
    <div class="app-avatar" style="background:${avatarBg}; border:1px solid ${avatarBorder};">
      ${escHtml(meta.emoji)}
    </div>
    <div class="card-text">
      <div class="card-row1">
        <span class="card-app" style="color:${meta.color};">${escHtml(appName)}</span>
        <span class="card-time"${tsNum ? ` data-ts="${tsNum}"` : ""}>${escHtml(timeStr)}</span>
      </div>
      <div style="display:flex;align-items:center;min-width:0;">
        <span class="card-title">${escHtml(title)}</span>
        ${n.unread ? '<span class="card-unread-dot"></span>' : ""}
      </div>
      ${message ? `<p class="card-message">${escHtml(message)}</p>` : ""}
      
      ${n.replyable ? `
        <div class="card-reply-container">
          <button class="card-reply-btn" title="Reply to message">Reply</button>
          <div class="card-reply-box" hidden>
            <input type="text" class="card-reply-input" placeholder="Type a reply…" autocomplete="off" />
            <button class="card-reply-send" title="Send reply">Send</button>
          </div>
        </div>
      ` : ""}
    </div>
    <button class="card-dismiss" title="Dismiss">×</button>
  `;

  // Click anywhere on card → mark read (dismiss button is pointer-events:none when hidden)
  article.addEventListener("click", e => {
    if (e.target.closest(".card-reply-container") || e.target.matches(".card-dismiss")) return;
    markRead(n.id, article);
    if (meta.url) {
      window.open(meta.url, "_blank");
    }
  });

  // Dismiss button
  article.querySelector(".card-dismiss").addEventListener("click", e => {
    e.stopPropagation();
    dismissCard(n.id, article);
  });

  // Quick Reply handler
  if (n.replyable) {
    const replyContainer = article.querySelector(".card-reply-container");
    const replyBtn       = replyContainer.querySelector(".card-reply-btn");
    const replyBox       = replyContainer.querySelector(".card-reply-box");
    const replyInput     = replyContainer.querySelector(".card-reply-input");
    const replySend      = replyContainer.querySelector(".card-reply-send");

    replyBtn.addEventListener("click", e => {
      e.stopPropagation();
      replyBtn.style.display = "none";
      replyBox.hidden = false;
      replyInput.focus();
    });

    const triggerSend = async () => {
      const text = replyInput.value.trim();
      if (!text) return;

      replyInput.disabled = true;
      replySend.disabled = true;
      replySend.textContent = "Sending…";

      // Send to background service worker
      chrome.runtime.sendMessage({
        type: "SEND_REPLY",
        key: n.key || n.id,
        message: text
      });

      // Reset and hide
      replyInput.value = "";
      replyInput.disabled = false;
      replySend.disabled = false;
      replySend.textContent = "Send";
      replyBox.hidden = true;
      replyBtn.style.display = "inline-flex";

      // Auto-dismiss the card since we replied!
      dismissCard(n.id, article);
    };

    replySend.addEventListener("click", e => {
      e.stopPropagation();
      triggerSend();
    });

    replyInput.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") {
        triggerSend();
      }
      if (e.key === "Escape") {
        replyBox.hidden = true;
        replyBtn.style.display = "inline-flex";
      }
    });
  }

  return article;
}

function renderNotifications() {
  const filtered = buildFilteredList();
  listEl.innerHTML = "";

  if (filtered.length === 0) {
    emptyState.hidden = false;
    listEl.hidden     = true;
  } else {
    emptyState.hidden = true;
    listEl.hidden     = false;

    const frag = document.createDocumentFragment();
    filtered.forEach((n, i) => frag.appendChild(createCard(n, i)));
    listEl.appendChild(frag);
  }

  updateBadge();
}

// ─── 6. Filter Pills ──────────────────────────────────────────────────────────

function buildFilterPills() {
  filterBar.innerHTML = "";

  // Derive unique display app names
  const apps = ["All", ...new Set(notifications.map(n => getDisplayApp(n)))];

  apps.forEach(app => {
    const pill = document.createElement("button");
    pill.className = `filter-pill${app === activeFilter ? " active" : ""}`;
    pill.textContent = app;
    pill.setAttribute("aria-pressed", app === activeFilter);

    // Tint active pill with the app color
    if (app !== "All") {
      const sample = notifications.find(n => getDisplayApp(n) === app);
      if (sample) {
        const meta = getMeta(sample);
        if (app === activeFilter) {
          pill.style.cssText = `
            background: ${meta.color}22;
            border-color: ${meta.color}55;
            color: ${meta.color};
          `;
        }
      }
    }

    pill.addEventListener("click", () => {
      activeFilter = app;
      buildFilterPills();
      renderNotifications();
    });

    filterBar.appendChild(pill);
  });
}

// ─── 7. Actions ───────────────────────────────────────────────────────────────

function markRead(id, cardEl) {
  const notif = notifications.find(n => n.id === id);
  if (!notif || !notif.unread) return;
  notif.unread = false;
  cardEl.classList.remove("unread");
  cardEl.querySelector(".card-unread-dot")?.remove();
  persistNotifications();
  updateBadge();
}

function dismissCard(id, cardEl) {
  cardEl.classList.add("dismissing");
  cardEl.addEventListener("animationend", () => {
    notifications = notifications.filter(n => n.id !== id);
    cardEl.remove();
    persistNotifications();
    buildFilterPills();
    updateBadge();
    // Show empty state if list is now empty
    if (listEl.querySelectorAll(".notif-card:not(.dismissing)").length === 0) {
      emptyState.hidden = false;
      listEl.hidden     = true;
    }
  }, { once: true });
}

function clearAllNotifications() {
  notifications = [];
  activeFilter  = "All";
  searchQuery   = "";
  searchInput.value = "";
  persistNotifications();
  buildFilterPills();
  renderNotifications();
}

function updateBadge() {
  const unread = notifications.filter(n => n.unread).length;
  countEl.textContent = unread;
  countEl.classList.toggle("has-count", unread > 0);
}

function persistNotifications() {
  // Cap storage at 200 to avoid quota issues
  const toSave = notifications.slice(0, 200);
  chrome.storage.local.set({ notifications: toSave });
}

// ─── 8. Add Live Notification ─────────────────────────────────────────────────

/**
 * addNotification(notif)
 * Prepends a new notification to the top of the list.
 * Called from the chrome.runtime.onMessage listener when background.js
 * pushes a real-time WebSocket payload.
 */
function addNotification(notif) {
  notifications.unshift(notif);
  buildFilterPills();

  // If there's an active filter that doesn't match this app, switch to All
  if (activeFilter !== "All" && getDisplayApp(notif) !== activeFilter) {
    // Don't switch — just let the badge show there are new ones
  }

  renderNotifications();

  // Flash the newest card
  const newest = listEl.querySelector(".notif-card");
  if (newest) {
    newest.classList.add("new-card");
    newest.addEventListener("animationend", () => {
      newest.classList.remove("new-card");
    }, { once: true });
  }
}

// ─── 9. WebSocket Status ──────────────────────────────────────────────────────

/**
 * Update the WS status indicator in the header and footer.
 * Called from background.js message OR detected via storage changes.
 */
function setWsStatus(connected, phoneConnected = false) {
  if (connected) {
    wsDot.className   = "ws-dot connected";
    wsLabel.textContent = "Live";
    wsStatus.className  = "ws-status connected";
    
    if (phoneConnected) {
      footerDot.className = "footer-live-dot connected";
      footerText.textContent = "Connected to phone";
    } else {
      footerDot.className = "footer-live-dot phone-offline";
      footerText.textContent = "Phone offline";
    }
  } else {
    wsDot.className   = "ws-dot";
    wsLabel.textContent = "Offline";
    wsStatus.className  = "ws-status";
    footerDot.className = "footer-live-dot";
    footerText.textContent = "Server offline";
  }
}

// ─── 10. Event Listeners ─────────────────────────────────────────────────────

searchInput.addEventListener("input", e => {
  searchQuery = e.target.value.trim();
  renderNotifications();
});

clearBtn.addEventListener("click", clearAllNotifications);

// Listen for notifications pushed from background.js
chrome.runtime.onMessage.addListener(message => {
  if (message.type === "NEW_NOTIFICATION") {
    const exists = notifications.some(n => n.id === message.payload.id);
    if (!exists) addNotification(message.payload);
  }
  if (message.type === "WS_STATUS") {
    chrome.storage.local.get({ phoneConnected: false }).then(result => {
      setWsStatus(message.connected, result.phoneConnected);
    });
  }
  if (message.type === "PHONE_STATUS") {
    chrome.storage.local.get({ wsConnected: false }).then(result => {
      setWsStatus(result.wsConnected, message.connected);
    });
  }
  if (message.type === "HISTORY_RECEIVED") {
    chrome.storage.local.get({ notifications: [] }).then(result => {
      notifications = result.notifications || [];
      buildFilterPills();
      renderNotifications();
    });
  }
  if (message.type === "NOTIFICATION_REMOVED") {
    const match = notifications.find(n => n.key === message.key || n.id === message.key || n.id === `n-${message.key}`);
    if (match) {
      const cardEl = listEl.querySelector(`.notif-card[data-id="${match.id}"]`);
      if (cardEl) {
        dismissCard(match.id, cardEl);
      } else {
        notifications = notifications.filter(n => n.id !== match.id);
        buildFilterPills();
        renderNotifications();
      }
    } else if (message.package) {
      notifications = notifications.filter(n => n.package !== message.package);
      buildFilterPills();
      renderNotifications();
    }
  }
  return false;
});

// ─── 11. Init ─────────────────────────────────────────────────────────────────

(async function init() {
  // Load persisted notifications from storage
  const result = await chrome.storage.local.get({ notifications: [], wsConnected: false, phoneConnected: false });
  notifications = result.notifications || [];

  // Set initial WS status indicator
  setWsStatus(result.wsConnected === true, result.phoneConnected === true);

  buildFilterPills();
  renderNotifications();

  console.log(`[Phone Notify] Panel loaded. ${notifications.length} notification(s).`);
})();

// ─── Settings Panel Logic ──────────────────────────────────────────────────

async function openSettings() {
  const result = await chrome.storage.local.get({
    serverUrl: "ws://localhost:8080",
    token: ""
  });
  settingsUrl.value = result.serverUrl;
  settingsToken.value = result.token;
  settingsPanel.hidden = false;
}

function closeSettings() {
  settingsPanel.hidden = true;
}

async function saveSettings() {
  const url = settingsUrl.value.trim();
  const token = settingsToken.value;
  
  await chrome.storage.local.set({
    serverUrl: url || "ws://localhost:8080",
    token: token
  });
  
  closeSettings();
  
  // Ask background worker to reconnect with the new settings
  chrome.runtime.sendMessage({ type: "RECONNECT_WS" }).catch(() => {});
}

settingsBtn.addEventListener("click", openSettings);
settingsCancel.addEventListener("click", closeSettings);
settingsSave.addEventListener("click", saveSettings);
settingsPanel.addEventListener("click", e => {
  if (e.target === settingsPanel) closeSettings();
});

// ─── 12. Utility ─────────────────────────────────────────────────────────────

function escHtml(str) {
  const d = document.createElement("div");
  d.textContent = String(str);
  return d.innerHTML;
}
