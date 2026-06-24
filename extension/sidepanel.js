/**
 * sidepanel.js — Phone Notify Side Panel Logic v3
 * ────────────────────────────────────────────────
 *
 * v3 additions (over v2):
 *  1. Live incoming-call overlay: showCallOverlay() / hideCallOverlay()
 *  2. Call timer: starts on answer, shows MM:SS
 *  3. Answer / Reject / Silence buttons → SEND_CALL_ACTION to background
 *  4. Call active state: rings stop pulsing, "End Call" replaces "Reject"
 *  5. CALL_UPDATE handler: parses ringing / answered / ended / missed states
 *  6. CALL_ENDED handler: animates overlay out, clears timer
 *  7. Checks chrome.storage for activeCall on panel open (missed ringing)
 *  8. Battery bar: updates from BATTERY_STATUS messages (Part 5 stub)
 */

"use strict";

// Mock chrome APIs for testing/previewing in standard browsers
if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.onMessage) {
  window.isMockChrome = true;
  window.chrome = {
    runtime: {
      connect: () => ({
        postMessage: () => {},
        onDisconnect: { addListener: () => {} },
        onMessage: { addListener: () => {} }
      }),
      sendMessage: async (msg) => {
        console.log("[Mock Chrome] Sent message:", msg);
        return { success: true };
      },
      onMessage: {
        addListener: (listener) => {
          window.addEventListener("message", (event) => {
            if (event.data && event.data.source === "mock-chrome-message") {
              listener(event.data.payload);
            }
          });
        }
      }
    },
    storage: {
      local: {
        get: async (keys) => {
          const res = {};
          for (const key in keys) {
            const val = localStorage.getItem(`mock_chrome_${key}`);
            res[key] = val ? JSON.parse(val) : keys[key];
          }
          return res;
        },
        set: async (obj) => {
          for (const key in obj) {
            localStorage.setItem(`mock_chrome_${key}`, JSON.stringify(obj[key]));
          }
        }
      }
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {}
    }
  };
}

// Keep the background service worker alive while the side panel is open (MV3)
const port = chrome.runtime.connect({ name: "sidepanel" });
setInterval(() => {
  try { port.postMessage({ type: "ping" }); } catch (_) {}
}, 10_000);

// ─── 1. App Metadata ──────────────────────────────────────────────────────────

const APP_META = {
  "com.whatsapp":                        { color: "#25D366", rgb: "37,211,102",   emoji: "💬", label: "WhatsApp",         url: "https://web.whatsapp.com/"  },
  "com.whatsapp.w4b":                    { color: "#25D366", rgb: "37,211,102",   emoji: "💬", label: "WhatsApp Business", url: "https://web.whatsapp.com/"  },
  "org.telegram.messenger":              { color: "#2AABEE", rgb: "42,171,238",   emoji: "✈️", label: "Telegram",         url: "https://web.telegram.org/"  },
  "org.telegram.plus":                   { color: "#2AABEE", rgb: "42,171,238",   emoji: "✈️", label: "Telegram",         url: "https://web.telegram.org/"  },
  "com.google.android.gm":              { color: "#EA4335", rgb: "234,67,53",    emoji: "📧", label: "Gmail",            url: "https://mail.google.com/"   },
  "com.instagram.android":              { color: "#E1306C", rgb: "225,48,108",   emoji: "📸", label: "Instagram",        url: "https://www.instagram.com/" },
  "com.discord":                         { color: "#5865F2", rgb: "88,101,242",   emoji: "🎮", label: "Discord",          url: "https://discord.com/app"    },
  "com.snapchat.android":               { color: "#FFFC00", rgb: "255,252,0",    emoji: "👻", label: "Snapchat",         url: "https://web.snapchat.com/"  },
  "com.twitter.android":                { color: "#1DA1F2", rgb: "29,161,242",   emoji: "🐦", label: "Twitter",          url: "https://x.com/"             },
  "com.facebook.katana":                { color: "#1877F2", rgb: "24,119,242",   emoji: "👍", label: "Facebook",         url: "https://www.facebook.com/"  },
  "com.facebook.orca":                  { color: "#0084FF", rgb: "0,132,255",    emoji: "💙", label: "Messenger",        url: "https://www.messenger.com/" },
  "com.netflix.mediaclient":            { color: "#E50914", rgb: "229,9,20",     emoji: "🎬", label: "Netflix",          url: "https://www.netflix.com/"   },
  "com.spotify.music":                  { color: "#1DB954", rgb: "29,185,84",    emoji: "🎵", label: "Spotify",          url: "https://open.spotify.com/"  },
  "com.amazon.mShop.android.shopping":  { color: "#FF9900", rgb: "255,153,0",    emoji: "📦", label: "Amazon",           url: "https://www.amazon.com/"    },
  "com.google.android.youtube":         { color: "#FF0000", rgb: "255,0,0",      emoji: "▶️", label: "YouTube",          url: "https://www.youtube.com/"   },
  "com.linkedin.android":               { color: "#0077B5", rgb: "0,119,181",    emoji: "💼", label: "LinkedIn",         url: "https://www.linkedin.com/"  },
  "com.microsoft.office.outlook":       { color: "#0078D4", rgb: "0,120,212",    emoji: "📫", label: "Outlook",          url: "https://outlook.live.com/"  },
  "com.microsoft.teams":                { color: "#6264A7", rgb: "98,100,167",   emoji: "💜", label: "Teams",            url: "https://teams.microsoft.com/" },
  "com.slack":                           { color: "#4A154B", rgb: "74,21,75",    emoji: "🔷", label: "Slack",            url: "https://slack.com/"         },
  "com.paypal.android.p2pmobile":       { color: "#003087", rgb: "0,48,135",     emoji: "💸", label: "PayPal",           url: "https://www.paypal.com/"    },
  "in.amazon.mShop.android.shopping":  { color: "#FF9900", rgb: "255,153,0",    emoji: "🛒", label: "Amazon IN",        url: "https://www.amazon.in/"     },
  // Display name fallbacks
  "WhatsApp":  { color: "#25D366", emoji: "💬", url: "https://web.whatsapp.com/" },
  "Telegram":  { color: "#2AABEE", emoji: "✈️", url: "https://web.telegram.org/" },
  "Gmail":     { color: "#EA4335", emoji: "📧", url: "https://mail.google.com/"  },
  "Instagram": { color: "#E1306C", emoji: "📸", url: "https://www.instagram.com/" },
  "Discord":   { color: "#5865F2", emoji: "🎮", url: "https://discord.com/app"   },
  "Snapchat":  { color: "#FFFC00", emoji: "👻", url: "https://web.snapchat.com/" },
  "Spotify":   { color: "#1DB954", emoji: "🎵", url: "https://open.spotify.com/" },
  "Slack":     { color: "#4A154B", emoji: "🔷", url: "https://slack.com/"        },
};

function getMeta(notif) {
  if (notif.package && APP_META[notif.package]) return APP_META[notif.package];
  if (notif.app     && APP_META[notif.app])     return APP_META[notif.app];
  const seed  = notif.package || notif.app || "unknown";
  const hue   = Math.abs(hashCode(seed)) % 360;
  const color = `hsl(${hue}, 65%, 55%)`;
  const rgb   = hslToRgbStr(hue, 65, 55);
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

let notifications     = [];
let activeFilter      = "All";
let searchQuery       = "";
let wsConnectedState  = false;   // tracks WS connection for empty state context
let clearConfirmTimer = null;
let clearConfirmPending = false;

// Context menu target (the notification the right-click was on)
let contextMenuTarget = null;

// ── Call state ──────────────────────────────────────────────────────────────
let callTimerInterval = null;   // setInterval handle for the on-call timer
let callStartTime     = null;   // Date.now() when call was answered
let callIsActive      = false;  // true after answer (timer running)

// ─── 3. DOM References ────────────────────────────────────────────────────────

const listEl         = document.getElementById("notification-list");
const countEl        = document.getElementById("notif-count");
const searchInput    = document.getElementById("search-input");
const searchWrapper  = document.getElementById("search-wrapper");
const filterBar      = document.getElementById("filter-bar");
const clearBtn       = document.getElementById("clear-btn");
const emptyState     = document.getElementById("empty-state");
const emptyIcon      = document.getElementById("empty-icon");
const emptyTitle     = document.getElementById("empty-title");
const emptySub       = document.getElementById("empty-sub");
const wsDot          = document.getElementById("ws-dot");
const wsLabel        = document.getElementById("ws-label");
const wsStatus       = document.getElementById("ws-status");
const footerDot      = document.getElementById("footer-dot");
const footerText     = document.getElementById("footer-text");
const toastContainer = document.getElementById("toast-container");
const contextMenu    = document.getElementById("context-menu");

const settingsBtn    = document.getElementById("settings-btn");
const settingsPanel  = document.getElementById("settings-panel");
const settingsUrl    = document.getElementById("settings-url");
const settingsToken  = document.getElementById("settings-token");
const settingsCancel = document.getElementById("settings-cancel");
const settingsSave   = document.getElementById("settings-save");
const ipsList        = document.getElementById("settings-ips-list");

// ── Call overlay DOM refs ────────────────────────────────────────────────────
const callOverlay    = document.getElementById("call-overlay");
const callCallerEl   = document.getElementById("call-caller");
const callDeviceEl   = document.getElementById("call-device");
const callTimerEl    = document.getElementById("call-timer");
const callBtnAnswer  = document.getElementById("call-btn-answer");
const callBtnReject  = document.getElementById("call-btn-reject");
const callBtnSilence = document.getElementById("call-btn-silence");

// ── Battery DOM refs ────────────────────────────────────────────────────────────
const batteryWidget  = document.getElementById("battery-widget");
const batteryFill    = document.getElementById("battery-fill");
const batteryPct     = document.getElementById("battery-pct");
const batteryBolt    = document.getElementById("battery-bolt");

// ── Media bar DOM refs ───────────────────────────────────────────────────────
const mediaBarEl     = document.getElementById("media-bar");
const mediaIconEl    = document.getElementById("media-icon");
const mediaTitleEl   = document.getElementById("media-title");
const mediaArtistEl  = document.getElementById("media-artist");
const mediaPlayBtn   = document.getElementById("media-play-pause");
const mediaPlayIcon  = document.getElementById("media-play-icon");
const mediaPrevBtn   = document.getElementById("media-prev");
const mediaNextBtn   = document.getElementById("media-next");

// ── Clipboard DOM refs ────────────────────────────────────────────────────────
const clipboardBtn   = document.getElementById("clipboard-btn");

// ── DND DOM refs ──────────────────────────────────────────────────────────────
const dndToggle      = document.getElementById("dnd-toggle");
const dndTimes       = document.getElementById("dnd-times");
const dndStart       = document.getElementById("dnd-start");
const dndEnd         = document.getElementById("dnd-end");

// ─── 4. Toast ─────────────────────────────────────────────────────────────────

/**
 * Show a transient toast notification.
 * @param {string} message  — text to display
 * @param {'info'|'success'|'warn'|'error'} type — controls the dot color
 * @param {number} duration — auto-dismiss delay in ms (default 3000)
 */
function showToast(message, type = "info", duration = 3000) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `<span class="toast-dot ${type}"></span>${escHtml(message)}`;
  toastContainer.appendChild(toast);

  const dismiss = () => {
    toast.classList.add("exit");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
  };

  const timer = setTimeout(dismiss, duration);
  toast.addEventListener("click", () => { clearTimeout(timer); dismiss(); });
}

// ─── 4.5. Incoming Call Overlay ──────────────────────────────────────────────

/**
 * Format elapsed seconds as MM:SS.
 */
function formatElapsed(seconds) {
  const m = String(Math.floor(seconds / 60)).padStart(2, "0");
  const s = String(seconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

/**
 * Show (or update) the call overlay.
 * @param {object} data  — { callerNumber, callerName, deviceName, state }
 */
function showCallOverlay(data) {
  const caller = data.callerName || data.callerNumber || "Unknown";
  callCallerEl.textContent = caller;
  callDeviceEl.textContent = data.deviceName ? `from ${data.deviceName}` : "";

  // Reset any prior active-call styles
  callOverlay.classList.remove("call-active", "exiting");
  callTimerEl.hidden    = true;
  callTimerEl.textContent = "00:00";

  // Show the overlay
  callOverlay.hidden = false;
  void callOverlay.offsetWidth; // reflow → restart animation

  if (data.state === "answered") {
    // Transition to active-call style (rings stop, timer starts)
    callIsActive  = true;
    callStartTime = Date.now();
    callOverlay.classList.add("call-active");
    callTimerEl.hidden = false;

    clearInterval(callTimerInterval);
    callTimerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
      callTimerEl.textContent = formatElapsed(elapsed);
    }, 1000);
  }
}

/**
 * Hide the call overlay with an exit animation.
 */
function hideCallOverlay() {
  clearInterval(callTimerInterval);
  callTimerInterval = null;
  callIsActive      = false;
  callStartTime     = null;

  if (callOverlay.hidden) return;

  callOverlay.classList.add("exiting");
  callOverlay.addEventListener("animationend", () => {
    callOverlay.hidden = true;
    callOverlay.classList.remove("call-active", "exiting");
    callTimerEl.hidden      = true;
    callTimerEl.textContent = "00:00";
  }, { once: true });
}

// ── Call button event listeners ──────────────────────────────────────────────

callBtnAnswer.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "SEND_CALL_ACTION", action: "answer" }).catch(() => {});
  // Transition overlay to active (answered) state immediately for snappy UX
  showCallOverlay({ state: "answered",
    callerName:   callCallerEl.textContent,
    callerNumber: "",
    deviceName:   callDeviceEl.textContent.replace("from ", ""),
  });
  showToast("📞 Answering call…", "success");
});

callBtnReject.addEventListener("click", () => {
  const label = callIsActive ? "Ending" : "Rejecting";
  chrome.runtime.sendMessage({ type: "SEND_CALL_ACTION", action: "reject" }).catch(() => {});
  showToast(`${label} call…`, "warn");
  hideCallOverlay();
});

callBtnSilence.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "SEND_CALL_ACTION", action: "silence" }).catch(() => {});
  showToast("🔕 Silenced", "info");
  // Keep overlay open but stop the pulsing rings via CSS class
  callOverlay.classList.add("call-active");
  // Actually for silence we just want to mute the ringer but keep ringing state
  // Remove call-active (it hides Answer btn) — just suppress the pulse
  callOverlay.classList.remove("call-active");
  callBtnSilence.disabled = true;
  callBtnSilence.style.opacity = "0.4";
});

// ─── 4.6. Battery Widget ───────────────────────────────────────────────

/**
 * Update the battery widget in the footer.
 * @param {number} level     0–100
 * @param {boolean} charging true if plugged in
 */
function updateBatteryWidget(level, charging) {
  // Clamp level
  const pct = Math.min(100, Math.max(0, Math.round(level)));

  // Show the widget on first call
  batteryWidget.hidden = false;

  // Update percentage text
  batteryPct.textContent = `${pct}%`;

  // Update fill bar width
  batteryFill.style.width = `${pct}%`;

  // Update fill colour based on level
  batteryFill.classList.remove("warn", "danger");
  if (pct <= 15)      batteryFill.classList.add("danger");
  else if (pct <= 30) batteryFill.classList.add("warn");

  // Bolt icon
  batteryBolt.hidden = !charging;
}

// ─── 4.7. Media Control Bar ─────────────────────────────────────────────

// Map Android package names to media source emoji
const MEDIA_APP_ICONS = {
  "com.spotify.music":            "🟢", // Spotify green circle
  "com.google.android.music":    "🎵",
  "com.google.android.youtube":  "📺",
  "com.soundcloud.android":      "☁️",
  "com.amazon.music":            "🎵",
  "com.apple.android.music":     "🎵",
  "com.zhiliaoapp.musically":    "🎵", // TikTok
  "com.netflix.mediaclient":     "🎥",
  // fallback for any other
};

let mediaIsPlaying = false; // track last known play/pause state

/**
 * Show and update the media bar with current track info.
 * @param {object} data  — { title, artist, app, package, isPlaying }
 */
function updateMediaBar(data) {
  const title    = data.title  || "Unknown Track";
  const artist   = data.artist || (data.app ? `via ${data.app}` : "Unknown Artist");
  const icon     = MEDIA_APP_ICONS[data.package || ""] || "🎵";
  const playing  = data.isPlaying !== false; // default true if not specified

  mediaTitleEl.textContent  = title;
  mediaArtistEl.textContent = artist;
  mediaIconEl.textContent   = icon;
  mediaIsPlaying            = playing;

  // Sync pause icon vs play icon
  setMediaPlayIcon(playing);

  // Playing vs paused CSS state
  mediaBarEl.classList.toggle("paused", !playing);

  // Animate in
  mediaBarEl.classList.remove("exiting");
  mediaBarEl.hidden = false;
  void mediaBarEl.offsetWidth; // restart animation
}

/**
 * Hide the media bar with an exit animation.
 */
function hideMediaBar() {
  if (mediaBarEl.hidden) return;
  mediaBarEl.classList.add("exiting");
  mediaBarEl.addEventListener("animationend", () => {
    mediaBarEl.hidden = true;
    mediaBarEl.classList.remove("exiting");
  }, { once: true });
}

// SVG paths for pause (two bars) and play (triangle)
const PAUSE_SVG = `<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>`;
const PLAY_SVG  = `<polygon points="5 3 19 12 5 21 5 3"/>`;

function setMediaPlayIcon(isPlaying) {
  mediaPlayIcon.innerHTML = isPlaying ? PAUSE_SVG : PLAY_SVG;
  mediaPlayBtn.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
  mediaPlayBtn.setAttribute("title",      isPlaying ? "Pause" : "Play");
}

// Media button listeners
mediaPrevBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "SEND_MEDIA_CONTROL", action: "prev" }).catch(() => {});
  showToast("⏮️ Previous", "info", 1500);
});

mediaNextBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "SEND_MEDIA_CONTROL", action: "next" }).catch(() => {});
  showToast("⏭️ Next", "info", 1500);
});

mediaPlayBtn.addEventListener("click", () => {
  const action = mediaIsPlaying ? "pause" : "play";
  chrome.runtime.sendMessage({ type: "SEND_MEDIA_CONTROL", action }).catch(() => {});
  mediaIsPlaying = !mediaIsPlaying;
  setMediaPlayIcon(mediaIsPlaying);
  mediaBarEl.classList.toggle("paused", !mediaIsPlaying);
});

// ─── 4.8. Clipboard Send to Phone ────────────────────────────────────────

/**
 * Read the browser clipboard and send the text to the phone.
 * Requires the 'clipboardRead' permission declared in manifest.json.
 */
async function sendClipboardToPhone() {
  if (clipboardBtn.disabled) return;

  try {
    const text = await navigator.clipboard.readText();
    if (!text || !text.trim()) {
      showToast("Clipboard is empty", "warn");
      return;
    }

    // Visual feedback
    clipboardBtn.classList.add("sending");
    clipboardBtn.disabled = true;
    setTimeout(() => {
      clipboardBtn.classList.remove("sending");
      clipboardBtn.disabled = false;
    }, 1200);

    chrome.runtime.sendMessage({ type: "SEND_CLIPBOARD_TO_PHONE", text }).catch(() => {});
    showToast(`📋 Sent ${text.length} chars to phone`, "success");
  } catch (err) {
    if (err.name === "NotAllowedError") {
      showToast("Clipboard read blocked — click the page first", "warn");
    } else {
      showToast(`Clipboard error: ${err.message}`, "error");
    }
    console.error("[Phone Notify] Clipboard read error:", err);
  }
}

clipboardBtn.addEventListener("click", sendClipboardToPhone);

// ─── 4.9. Clipboard Received from Phone ───────────────────────────────────

/**
 * Show the clipboard-from-phone toast with a Copy button.
 * @param {string} text        Full clipboard text
 * @param {string} deviceName  Source device label
 */
function showClipboardToast(text, deviceName) {
  const preview = text.length > 55 ? text.slice(0, 55) + "…" : text;
  const from    = deviceName ? ` from ${deviceName}` : " from phone";

  const toast   = document.createElement("div");
  toast.className = "toast toast-clipboard";
  toast.innerHTML = `
    <span class="toast-dot info"></span>
    <div class="toast-clipboard-body">
      <span class="toast-clipboard-label">📋 Clipboard${escHtml(from)}</span>
      <span class="toast-clipboard-text">${escHtml(preview)}</span>
    </div>
    <button class="toast-copy-btn">Copy</button>
  `;

  toastContainer.prepend(toast);

  const copyBtn = toast.querySelector(".toast-copy-btn");
  let timer = setTimeout(() => toast.remove(), 12000);

  copyBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = "✓ Copied";
      copyBtn.style.color = "var(--green)";
      copyBtn.style.borderColor = "rgba(16,185,129,0.5)";
      clearTimeout(timer);
      setTimeout(() => toast.remove(), 1200);
    } catch {
      copyBtn.textContent = "Failed";
    }
  });

  toast.addEventListener("click", () => { clearTimeout(timer); toast.remove(); });
}

// ─── 4.10. DND Settings ───────────────────────────────────────────────────

/**
 * Load DND settings from storage and update the toggle + time inputs.
 * @param {{ dndEnabled: boolean, dndStart: string, dndEnd: string }} s
 */
function applyDndSettings(s) {
  dndToggle.checked  = s.dndEnabled || false;
  dndStart.value     = s.dndStart   || "23:00";
  dndEnd.value       = s.dndEnd     || "07:00";
  dndTimes.hidden    = !dndToggle.checked;
}

// Show/hide time range when toggle changes
dndToggle.addEventListener("change", () => {
  dndTimes.hidden = !dndToggle.checked;
});

// ─── 5. Timestamp Formatting ──────────────────────────────────────────────────

function formatTime(ts) {
  if (typeof ts === "string") return ts;
  if (!ts) return "";
  const diff = Date.now() - ts;
  const s    = Math.floor(diff / 1000);
  if (s < 5)   return "just now";
  if (s < 60)  return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7)   return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Auto-refresh relative times every 60 seconds
setInterval(() => {
  document.querySelectorAll(".card-time[data-ts]").forEach(el => {
    const ts = parseInt(el.dataset.ts, 10);
    if (!isNaN(ts)) el.textContent = formatTime(ts);
  });
}, 60_000);

// ─── 6. Rendering ─────────────────────────────────────────────────────────────

function buildFilteredList() {
  return notifications.filter(n => {
    const matchesApp = activeFilter === "All" || getDisplayApp(n) === activeFilter;
    const q          = searchQuery.toLowerCase();
    const title      = (n.title   || n.sender  || "").toLowerCase();
    const message    = (n.message || "").toLowerCase();
    const app        = (n.app     || "").toLowerCase();
    const pkg        = (n.package || "").toLowerCase();
    const matchesSearch = !q || title.includes(q) || message.includes(q) ||
                          app.includes(q) || pkg.includes(q);
    return matchesApp && matchesSearch;
  });
}

function getDisplayApp(n) {
  const meta = getMeta(n);
  return meta.label || n.app || n.package || "App";
}

/**
 * Show a context-aware empty state based on current conditions.
 * - Not connected to server → connection prompt
 * - Active search with no results → "no search results"
 * - Active filter with no results → "no [App] notifications"
 * - Genuinely empty → default welcome message
 */
function showContextualEmpty() {
  emptyState.hidden = false;
  listEl.hidden     = true;

  if (!wsConnectedState && !window.isMockChrome) {
    emptyIcon.textContent  = "🔌";
    emptyTitle.textContent = "Not connected";
    emptySub.innerHTML     = "Open <strong>Settings</strong> ⚙️ and enter your relay<br>server URL to start receiving notifications.";
  } else if (searchQuery) {
    emptyIcon.textContent  = "🔍";
    emptyTitle.textContent = "No results";
    emptySub.innerHTML     = `No notifications matching<br>"${escHtml(searchQuery)}"`;
  } else if (activeFilter !== "All") {
    emptyIcon.textContent  = "🔕";
    emptyTitle.textContent = `No ${escHtml(activeFilter)} notifications`;
    emptySub.innerHTML     = "Try selecting a different filter<br>or clearing the search.";
  } else {
    emptyIcon.textContent  = "🔔";
    emptyTitle.textContent = "No notifications yet";
    emptySub.innerHTML     = "Notifications from your Android phone<br>will appear here in real time.";
  }
}

/**
 * Helper: safely escape HTML and convert \n to <br> for inline display.
 */
function escHtmlBr(str) {
  const d = document.createElement("div");
  d.textContent = String(str);
  return d.innerHTML.replace(/\n/g, "<br>");
}

const LONG_MSG_THRESHOLD = 200; // chars — show "Show more" button above this

/**
 * createCard(n, index, animate)
 * Builds one notification <article> element.
 *
 * @param {object}  n       — notification object
 * @param {number}  index   — position in the filtered list (for stagger delay)
 * @param {boolean} animate — whether to play the card-in stagger animation
 */
function createCard(n, index, animate = false) {
  const meta    = getMeta(n);
  const title   = n.title   || n.sender || "Notification";
  const message = n.message || "";
  const appName = getDisplayApp(n);
  const timeStr = formatTime(n.timestamp);
  const tsNum   = typeof n.timestamp === "number" ? n.timestamp : null;
  const isLong  = message.length > LONG_MSG_THRESHOLD;

  const article = document.createElement("article");
  article.className = `notif-card${n.unread ? " unread" : ""}`;
  article.dataset.id = n.id;
  article.dataset.pkg = n.package || "";
  article.dataset.app = appName;
  article.style.setProperty("--accent", meta.color);

  // Control animation
  if (animate) {
    article.style.setProperty("--card-index", index);
  } else {
    article.style.animation = "none"; // no stagger on re-renders
  }

  if (meta.url) article.title = `Click to open ${appName}`;

  const avatarBg     = `${meta.color}28`;
  const avatarBorder = `${meta.color}45`;

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
      ${message ? `<p class="card-message${isLong ? "" : " expanded"}">${escHtmlBr(message)}</p>` : ""}
      ${message && isLong ? `<button class="show-more-btn" aria-label="Toggle full message">Show more ↓</button>` : ""}

      ${n.replyable ? `
        <div class="card-reply-container">
          <button class="card-reply-btn" title="Reply to message">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px; vertical-align: middle;">
              <polyline points="9 17 4 12 9 7"></polyline>
              <path d="M20 18v-2a4 4 0 0 0-4-4H4"></path>
            </svg>
            Reply
          </button>
          <div class="card-reply-box" hidden>
            <input type="text" class="card-reply-input" placeholder="Type a reply…" autocomplete="off" />
            <button class="card-reply-send" title="Send reply" aria-label="Send reply">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="22" y1="2" x2="11" y2="13"></line>
                <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
              </svg>
            </button>
          </div>
        </div>
      ` : ""}
    </div>
    <button class="card-dismiss" title="Dismiss" aria-label="Dismiss">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    </button>
  `;

  // ── Show more / Show less ────────────────────────────────────────────────────
  if (message && isLong) {
    const msgEl       = article.querySelector(".card-message");
    const showMoreBtn = article.querySelector(".show-more-btn");

    showMoreBtn.addEventListener("click", e => {
      e.stopPropagation();
      const expanded = msgEl.classList.toggle("expanded");
      showMoreBtn.textContent = expanded ? "Show less ↑" : "Show more ↓";
    });
  }

  // ── Main click: mark read + open web app ─────────────────────────────────────
  article.addEventListener("click", e => {
    if (e.target.closest(".card-reply-container") ||
        e.target.closest(".card-dismiss") ||
        e.target.closest(".show-more-btn")) return;
    markRead(n.id, article);
    
    const isWhatsApp = n.package === "com.whatsapp" || 
                       n.package === "com.whatsapp.w4b" || 
                       (n.app && n.app.toLowerCase().includes("whatsapp"));

    if (isWhatsApp) {
      // Expand the message to show all context/history
      const msgEl = article.querySelector(".card-message");
      const showMoreBtn = article.querySelector(".show-more-btn");
      if (msgEl) {
        msgEl.classList.add("expanded");
        if (showMoreBtn) showMoreBtn.textContent = "Show less ↑";
      }

      // Open the reply box immediately if replyable
      if (n.replyable) {
        const replyBtn = article.querySelector(".card-reply-btn");
        const replyBox = article.querySelector(".card-reply-box");
        const replyInput = article.querySelector(".card-reply-input");
        if (replyBtn && replyBox && replyInput) {
          replyBtn.style.display = "none";
          replyBox.hidden = false;
          replyInput.focus();
        }
      }
    } else {
      if (meta.url) window.open(meta.url, "_blank");
    }
  });

  // ── Right-click: context menu ────────────────────────────────────────────────
  article.addEventListener("contextmenu", e => {
    e.preventDefault();
    contextMenuTarget = { n, article };
    showContextMenu(e.clientX, e.clientY);
  });

  // ── Dismiss button ───────────────────────────────────────────────────────────
  article.querySelector(".card-dismiss").addEventListener("click", e => {
    e.stopPropagation();
    dismissCard(n.id, article);
  });

  // ── Quick Reply ──────────────────────────────────────────────────────────────
  if (n.replyable) {
    const replyContainer = article.querySelector(".card-reply-container");
    const replyBtn       = replyContainer.querySelector(".card-reply-btn");
    const replyBox       = replyContainer.querySelector(".card-reply-box");
    const replyInput     = replyContainer.querySelector(".card-reply-input");
    const replySend      = replyContainer.querySelector(".card-reply-send");

    const spinnerSvg = `
      <svg width="12" height="12" class="spin-loading" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line>
        <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line>
        <line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line>
        <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line>
      </svg>`;

    const sendSvg = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="22" y1="2" x2="11" y2="13"></line>
        <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
      </svg>`;

    replyBtn.addEventListener("click", e => {
      e.stopPropagation();
      replyBtn.style.display = "none";
      replyBox.hidden        = false;
      replyInput.focus();
    });

    const triggerSend = async () => {
      const text = replyInput.value.trim();
      if (!text) return;

      // Check WS status before sending
      const { wsConnected = false } = await chrome.storage.local.get({ wsConnected: false });
      if (!wsConnected && !window.isMockChrome) {
        replyInput.style.borderColor = "var(--red)";
        replyInput.style.boxShadow   = "0 0 8px rgba(244,63,94,0.3)";
        showToast("Not connected to relay server", "error");
        setTimeout(() => {
          replyInput.style.borderColor = "";
          replyInput.style.boxShadow   = "";
        }, 2500);
        return;
      }

      replyInput.disabled  = true;
      replySend.disabled   = true;
      replySend.innerHTML  = spinnerSvg;

      chrome.runtime.sendMessage({
        type: "SEND_REPLY",
        key:  n.key || n.id,
        message: text,
      });

      // Brief delay so spinner is visible, then show success
      await new Promise(r => setTimeout(r, 350));

      replySend.innerHTML  = sendSvg;
      replyInput.disabled  = false;
      replySend.disabled   = false;
      replyInput.value     = "";
      replyBox.hidden      = true;
      replyBtn.style.display = "inline-flex";

      showToast("✓ Reply sent", "success");
      dismissCard(n.id, article);
    };

    replySend.addEventListener("click", e => { e.stopPropagation(); triggerSend(); });
    replyInput.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter")  triggerSend();
      if (e.key === "Escape") { replyBox.hidden = true; replyBtn.style.display = "inline-flex"; }
    });
  }

  return article;
}

/**
 * Re-render the notification list.
 * @param {boolean} animate — play card-in stagger (only on initial load)
 */
function renderNotifications(animate = false) {
  const filtered = buildFilteredList();
  listEl.innerHTML = "";

  if (filtered.length === 0) {
    showContextualEmpty();
    return;
  }

  emptyState.hidden = false; // hide it while building
  emptyState.hidden = true;
  listEl.hidden     = false;

  const frag = document.createDocumentFragment();
  filtered.forEach((n, i) => frag.appendChild(createCard(n, i, animate)));
  listEl.appendChild(frag);

  updateBadge();
}

// ─── 7. Filter Pills ──────────────────────────────────────────────────────────

function buildFilterPills() {
  filterBar.innerHTML = "";

  // Count notifications per display app
  const appCounts = new Map();
  notifications.forEach(n => {
    const app = getDisplayApp(n);
    appCounts.set(app, (appCounts.get(app) || 0) + 1);
  });

  const apps = ["All", ...new Set(notifications.map(n => getDisplayApp(n)))];

  apps.forEach(app => {
    const pill     = document.createElement("button");
    const isActive = app === activeFilter;
    const count    = app === "All" ? notifications.length : (appCounts.get(app) || 0);

    pill.className = `filter-pill${isActive ? " active" : ""}`;
    pill.setAttribute("aria-pressed", isActive);

    // Build pill content: label + count badge
    const countBadge = `<span class="pill-count">${count}</span>`;
    pill.innerHTML   = escHtml(app) + countBadge;

    // Tint active pill with the app's brand color
    if (app !== "All") {
      const sample = notifications.find(n => getDisplayApp(n) === app);
      if (sample) {
        const meta = getMeta(sample);
        if (isActive) {
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
      renderNotifications(false); // no stagger on filter change
    });

    filterBar.appendChild(pill);
  });
}

// ─── 8. Actions ───────────────────────────────────────────────────────────────

function markRead(id, cardEl) {
  const notif = notifications.find(n => n.id === id);
  if (!notif || !notif.unread) return;
  notif.unread = false;
  cardEl.classList.remove("unread");
  cardEl.querySelector(".card-unread-dot")?.remove();
  persistNotifications();
  updateBadge();
}

function markAllRead() {
  let changed = false;
  notifications.forEach(n => { if (n.unread) { n.unread = false; changed = true; } });
  if (!changed) { showToast("All already read", "info"); return; }
  persistNotifications();
  renderNotifications(false);
  showToast("All marked as read ✓", "success");
}

function dismissCard(id, cardEl) {
  cardEl.classList.add("dismissing");
  cardEl.addEventListener("animationend", () => {
    notifications = notifications.filter(n => n.id !== id);
    cardEl.remove();
    persistNotifications();
    buildFilterPills();
    updateBadge();
    if (listEl.querySelectorAll(".notif-card:not(.dismissing)").length === 0) {
      showContextualEmpty();
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
  renderNotifications(false);
  showToast("All notifications cleared", "info");

  // Reset confirm state
  clearConfirmPending = false;
  if (clearConfirmTimer) { clearTimeout(clearConfirmTimer); clearConfirmTimer = null; }
  clearBtn.classList.remove("confirm-pending");
  clearBtn.title = "Clear all notifications";
}

function updateBadge() {
  const unread = notifications.filter(n => n.unread).length;
  countEl.textContent = unread;
  countEl.classList.toggle("has-count", unread > 0);

  // Update the toolbar badge icon
  try {
    const text = unread > 0 ? (unread > 99 ? "99+" : String(unread)) : "";
    chrome.action.setBadgeText({ text });
    if (unread > 0) chrome.action.setBadgeBackgroundColor({ color: "#6366f1" });
  } catch (_) {}
}

function persistNotifications() {
  chrome.storage.local.set({ notifications: notifications.slice(0, 200) });
}

// ─── 9. Add Live Notification ─────────────────────────────────────────────────

/**
 * Called when background.js pushes a live notification.
 * Prepends the card directly to the DOM — only the new card animates.
 */
function addNotification(notif) {
  notifications.unshift(notif);
  buildFilterPills();

  const matchesFilter = activeFilter === "All" || getDisplayApp(notif) === activeFilter;
  const matchesSearch = !searchQuery ||
    ((notif.title   || "").toLowerCase().includes(searchQuery) ||
     (notif.message || "").toLowerCase().includes(searchQuery));

  if (matchesFilter && matchesSearch) {
    // Prepend directly — skip full re-render to avoid re-animating old cards
    if (listEl.hidden) {
      emptyState.hidden = true;
      listEl.hidden     = false;
    }

    const card = createCard(notif, 0, false); // no stagger
    card.style.animation = "none";            // reset any residual animation
    listEl.prepend(card);

    // Trigger the glow-arrival animation on the new card only
    void card.offsetWidth; // force reflow so the animation restarts
    card.style.animation = "";
    card.classList.add("new-card");
    card.addEventListener("animationend", () => card.classList.remove("new-card"), { once: true });
  }

  updateBadge();
}

/**
 * Called when background.js updates an existing notification.
 * Removes the old card from the DOM and prepends the updated card.
 */
function updateNotification(notif) {
  // Update state array (using robust key cleaning)
  const cleanNotifId = cleanKey(notif.id);
  const cleanNotifKey = cleanKey(notif.key);
  const index = notifications.findIndex(n => {
    const cleanNId = cleanKey(n.id);
    const cleanNKey = cleanKey(n.key);
    return cleanNId === cleanNotifId || (notif.key && cleanNKey === cleanNotifKey);
  });
  if (index !== -1) {
    notifications.splice(index, 1);
    notifications.unshift(notif);
  } else {
    notifications.unshift(notif);
  }

  buildFilterPills();

  // Find existing card in DOM
  const cardEl = listEl.querySelector(`article[data-id="${notif.id}"]`) || 
                 (notif.key ? listEl.querySelector(`article[data-id="${notif.key}"]`) : null);

  const matchesFilter = activeFilter === "All" || getDisplayApp(notif) === activeFilter;
  const matchesSearch = !searchQuery ||
    ((notif.title   || "").toLowerCase().includes(searchQuery) ||
     (notif.message || "").toLowerCase().includes(searchQuery));

  if (matchesFilter && matchesSearch) {
    if (listEl.hidden) {
      emptyState.hidden = true;
      listEl.hidden     = false;
    }

    const newCard = createCard(notif, 0, false); // no stagger

    // Remove old card if it was present
    if (cardEl) {
      cardEl.remove();
    }
    
    // Prepend updated card to the top
    listEl.prepend(newCard);

    // Trigger update glow effect
    newCard.style.animation = "none";
    void newCard.offsetWidth; // force reflow
    newCard.style.animation = "";
    newCard.classList.add("new-card");
    newCard.addEventListener("animationend", () => newCard.classList.remove("new-card"), { once: true });
  } else {
    // If it no longer matches current filter/search, remove it from DOM
    if (cardEl) {
      cardEl.remove();
      if (listEl.children.length === 0) {
        listEl.hidden     = true;
        emptyState.hidden = false;
      }
    }
  }

  updateBadge();
}

// ─── 10. Context Menu ─────────────────────────────────────────────────────────

function showContextMenu(x, y) {
  contextMenu.hidden = false;

  // Position — keep inside viewport
  const menuW  = 160;
  const menuH  = 110;
  const left   = Math.min(x, window.innerWidth  - menuW - 8);
  const top    = Math.min(y, window.innerHeight - menuH - 8);
  contextMenu.style.left = `${left}px`;
  contextMenu.style.top  = `${top}px`;
}

function hideContextMenu() {
  contextMenu.hidden   = true;
  contextMenuTarget    = null;
}

document.getElementById("ctx-copy").addEventListener("click", () => {
  if (!contextMenuTarget) return;
  const { n } = contextMenuTarget;
  const text = [n.title, n.message].filter(Boolean).join("\n");
  navigator.clipboard.writeText(text).then(() => {
    showToast("Copied to clipboard ✓", "success");
  }).catch(() => showToast("Copy failed", "error"));
  hideContextMenu();
});

document.getElementById("ctx-mute").addEventListener("click", async () => {
  if (!contextMenuTarget) return;
  const { n } = contextMenuTarget;
  const appId = n.package || n.app || "unknown";

  const { mutedApps = [] } = await chrome.storage.local.get({ mutedApps: [] });
  if (!mutedApps.includes(appId)) mutedApps.push(appId);
  await chrome.storage.local.set({ mutedApps });

  showToast(`${getDisplayApp(n)} muted 🔕`, "warn");
  hideContextMenu();
});

document.getElementById("ctx-open").addEventListener("click", () => {
  if (!contextMenuTarget) return;
  const { n } = contextMenuTarget;
  const meta  = getMeta(n);
  if (meta.url) window.open(meta.url, "_blank");
  else showToast("No web app for this notification", "warn");
  hideContextMenu();
});

// Close context menu on outside click
document.addEventListener("click", e => {
  if (!contextMenu.hidden && !contextMenu.contains(e.target)) {
    hideContextMenu();
  }
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape") hideContextMenu();
});

// ─── 11. WebSocket Status ─────────────────────────────────────────────────────

function setWsStatus(connected, phoneConnected = false) {
  wsConnectedState = connected;

  if (connected) {
    wsDot.className     = "ws-dot connected";
    wsLabel.textContent = "Live";
    wsStatus.className  = "ws-status connected";
    if (phoneConnected) {
      footerDot.className    = "footer-live-dot connected";
      footerText.textContent = "Connected to phone";
    } else {
      footerDot.className    = "footer-live-dot phone-offline";
      footerText.textContent = "Phone offline";
    }
  } else {
    wsDot.className     = "ws-dot";
    wsLabel.textContent = "Offline";
    wsStatus.className  = "ws-status";
    footerDot.className    = "footer-live-dot";
    footerText.textContent = "Server offline";
  }

  // Refresh empty state if it's visible (may need to update offline message)
  if (!listEl.hidden === false || buildFilteredList().length === 0) {
    showContextualEmpty();
  }
}

// ─── 12. Event Listeners ──────────────────────────────────────────────────────

// Search
searchInput.addEventListener("focus",  () => searchWrapper.classList.add("focused"));
searchInput.addEventListener("blur",   () => searchWrapper.classList.remove("focused"));
searchInput.addEventListener("input",  e => {
  searchQuery = e.target.value.trim();
  renderNotifications(false); // no stagger on search re-render
});


// Clear all — instant one-tap clear
clearBtn.addEventListener("click", () => {
  clearAllNotifications();
});

// Background.js message listener
chrome.runtime.onMessage.addListener(message => {
  if (message.type === "NEW_NOTIFICATION") {
    const cleanPayloadId = cleanKey(message.payload.id);
    const cleanPayloadKey = cleanKey(message.payload.key);
    const exists = notifications.some(n => {
      const cleanNId = cleanKey(n.id);
      const cleanNKey = cleanKey(n.key);
      return cleanNId === cleanPayloadId || (message.payload.key && cleanNKey === cleanPayloadKey);
    });
    if (!exists) addNotification(message.payload);
  }

  if (message.type === "UPDATE_NOTIFICATION") {
    updateNotification(message.payload);
  }

  if (message.type === "WS_STATUS") {
    chrome.storage.local.get({ phoneConnected: false }).then(r =>
      setWsStatus(message.connected, r.phoneConnected)
    );
  }

  if (message.type === "CALL_UPDATE") {
    // A call state change arrived from the phone
    const state = message.state || "";
    if (state === "ringing") {
      showCallOverlay(message);
      showToast(`📞 Incoming call from ${message.callerName || message.callerNumber || "Unknown"}`, "info", 5000);
    } else if (state === "answered") {
      showCallOverlay({ ...message, state: "answered" });
    } else if (state === "ended" || state === "missed") {
      if (state === "missed") showToast("📵 Missed call", "warn", 5000);
      hideCallOverlay();
    }
    return;
  }

  if (message.type === "CALL_ENDED") {
    hideCallOverlay();
    return;
  }

  if (message.type === "CLIPBOARD_FROM_PHONE") {
    showClipboardToast(message.text, message.deviceName);
    return;
  }

  if (message.type === "BATTERY_STATUS") {
    updateBatteryWidget(message.level, message.charging);
    return;
  }

  if (message.type === "MEDIA_STATUS") {
    if (message.isPlaying === false && !mediaTitleEl.textContent) {
      // Don't show bar for a paused event if we have no track info yet
      return;
    }
    updateMediaBar(message);
    return;
  }

  if (message.type === "PHONE_STATUS") {
    chrome.storage.local.get({ wsConnected: false }).then(r =>
      setWsStatus(r.wsConnected, message.connected)
    );
  }

  if (message.type === "CLEAR_ALL_NOTIFICATIONS") {
    notifications = [];
    buildFilterPills();
    renderNotifications(false);
    updateBadge();
    return;
  }

  if (message.type === "SYNC_START") {
    // Phone is syncing its current active notifications — clear the stale list now
    notifications = [];
    buildFilterPills();
    renderNotifications(false);
    return;
  }

  if (message.type === "HISTORY_RECEIVED") {
    chrome.storage.local.get({ notifications: [] }).then(r => {
      notifications = r.notifications || [];
      buildFilterPills();
      renderNotifications(false);
    });
  }

  if (message.type === "NOTIFICATION_REMOVED") {
    const targetKey = cleanKey(message.key);
    const match = notifications.find(n =>
      cleanKey(n.key) === targetKey || cleanKey(n.id) === targetKey
    );
    if (match) {
      const cardEl = listEl.querySelector(`.notif-card[data-id="${match.id}"]`);
      if (cardEl) dismissCard(match.id, cardEl);
      else {
        notifications = notifications.filter(n => cleanKey(n.id) !== targetKey && cleanKey(n.key) !== targetKey);
        buildFilterPills();
        renderNotifications(false);
      }
    } else if (message.package) {
      notifications = notifications.filter(n => n.package !== message.package);
      buildFilterPills();
      renderNotifications(false);
    }
  }

  if (message.type === "SERVER_IPS") {
    renderIpsList(message.ips);
  }

  return false;
});

// ─── 13. Settings Panel ───────────────────────────────────────────────────────

function renderIpsList(ips) {
  const ipsGroup = document.getElementById("settings-ips-group");
  if (!ipsGroup || !ipsList) return;
  if (ips && ips.length > 0) {
    ipsList.innerHTML = ips.map(item => `
      <div class="ip-item" title="Click to use this IP">
        <span class="ip-address">${escHtml(item.ip)}</span>
        <span class="ip-name">${escHtml(item.name)}</span>
      </div>
    `).join("");
    ipsGroup.style.display = "flex";
  } else {
    ipsGroup.style.display = "none";
  }
}

async function openSettings() {
  const result = await chrome.storage.local.get({
    serverUrl: "ws://localhost:8080",
    token:     "",
    serverIps: [],
  });

  let ips = result.serverIps || [];
  if (window.isMockChrome && ips.length === 0) {
    ips = [
      { ip: "192.168.1.42", name: "Wi-Fi (wlan0)" },
      { ip: "10.0.0.12",    name: "Ethernet (eth0)" },
    ];
  }

  settingsUrl.value   = result.serverUrl;
  settingsToken.value = result.token;
  renderIpsList(ips);
  settingsPanel.hidden = false;
}

function closeSettings() {
  settingsPanel.hidden = true;
}

async function saveSettings() {
  const url   = settingsUrl.value.trim();
  const token = settingsToken.value.trim();

  await chrome.storage.local.set({
    serverUrl:  url || "ws://localhost:8080",
    token,
    dndEnabled: dndToggle.checked,
    dndStart:   dndStart.value  || "23:00",
    dndEnd:     dndEnd.value    || "07:00",
  });

  // Push DND state to background.js so it can suppress desktop notifications
  chrome.runtime.sendMessage({
    type:       "UPDATE_DND",
    dndEnabled: dndToggle.checked,
    dndStart:   dndStart.value  || "23:00",
    dndEnd:     dndEnd.value    || "07:00",
  }).catch(() => {});

  closeSettings();
  chrome.runtime.sendMessage({ type: "RECONNECT_WS" }).catch(() => {});
  showToast("Settings saved, reconnecting…", "info");
}

settingsBtn.addEventListener("click", openSettings);
settingsCancel.addEventListener("click", closeSettings);
settingsSave.addEventListener("click", saveSettings);
settingsPanel.addEventListener("click", e => {
  if (e.target === settingsPanel) closeSettings();
});

// IP item click — BUG FIX: extract port from current URL field, not hardcode 8080
if (ipsList) {
  ipsList.addEventListener("click", e => {
    const item = e.target.closest(".ip-item");
    if (!item) return;

    const ip = item.querySelector(".ip-address").textContent.trim();

    // Extract existing port from the current URL field (default 8080)
    let port = "8080";
    try {
      const existing = settingsUrl.value.trim();
      const match    = existing.match(/:(\d{2,5})(\/|\?|$)/);
      if (match) port = match[1];
    } catch (_) {}

    settingsUrl.value = `ws://${ip}:${port}`;
    settingsUrl.focus();
    settingsUrl.classList.add("highlight-flash");
    setTimeout(() => settingsUrl.classList.remove("highlight-flash"), 800);
  });
}

// ─── 14. Init ─────────────────────────────────────────────────────────────────

(async function init() {
  // Clear toolbar badge — user has the panel open
  try { chrome.action.setBadgeText({ text: "" }); } catch (_) {}

  // Load persisted state
  const result = await chrome.storage.local.get({
    notifications:  [],
    wsConnected:    false,
    phoneConnected: false,
    batteryStatus:  null,
    mediaStatus:    null,
    dndEnabled:     false,
    dndStart:       "23:00",
    dndEnd:         "07:00",
    phoneClipboard: null,  // last clipboard pushed from phone
  });

  notifications = result.notifications || [];

  // Seed mock data when running outside Chrome for dev preview
  if (window.isMockChrome && notifications.length === 0) {
    const now = Date.now();
    notifications = [
      {
        id: "mock-1", package: "com.whatsapp", app: "WhatsApp",
        title: "Jane Doe",
        message: "Hey! Are we still meeting for lunch at 1 PM today? Let me know! 🍕",
        timestamp: now - 120_000, unread: true, replyable: true,
      },
      {
        id: "mock-2", package: "com.google.android.gm", app: "Gmail",
        title: "GitHub",
        message: "Your pull request #42 'feat: dark mode' was merged into main ✅\n\nCongratulations! Your contribution has been accepted by the repository maintainer.",
        timestamp: now - 900_000, unread: true, replyable: false,
      },
      {
        id: "mock-3", package: "com.spotify.music", app: "Spotify",
        title: "Now Playing",
        message: "Blinding Lights by The Weeknd",
        timestamp: now - 2_700_000, unread: false, replyable: false,
      },
      {
        id: "mock-4", package: "com.discord", app: "Discord",
        title: "#general - TechTalk",
        message: "Alex: The new Chrome sidepanel layout looks sick! 🔥",
        timestamp: now - 10_800_000, unread: false, replyable: true,
      },
    ];
    await chrome.storage.local.set({ notifications });
  }

  // Query background.js for the LIVE WebSocket state, not the (potentially stale) storage value.
  // Storage only reflects the last persisted state, which may be 'false' even while the
  // service worker is actively connected (e.g. the panel opened before the storage write flushed).
  if (window.isMockChrome) {
    // Dev preview: always show connected
    setWsStatus(true, true);
  } else {
    try {
      const liveStatus = await chrome.runtime.sendMessage({ type: "GET_WS_STATUS" });
      setWsStatus(
        liveStatus.wsConnected    === true,
        liveStatus.phoneConnected === true,
      );
    } catch (_) {
      // Background not ready yet — fall back to storage value
      setWsStatus(
        result.wsConnected    === true,
        result.phoneConnected === true,
      );
    }
  }

  buildFilterPills();
  renderNotifications(true); // animate on initial load only

  // Check if a call was already in progress when the panel opened
  // (e.g. user opened the panel after a call started ringing)
  const callCheck = await chrome.storage.local.get({ activeCall: null });
  if (callCheck.activeCall && callCheck.activeCall.state === "ringing") {
    showCallOverlay(callCheck.activeCall);
  }

  // Restore battery widget from last known state
  if (result.batteryStatus && typeof result.batteryStatus.level === "number") {
    updateBatteryWidget(result.batteryStatus.level, result.batteryStatus.charging);
  }

  // Restore media bar if music was playing
  if (result.mediaStatus && result.mediaStatus.title) {
    updateMediaBar(result.mediaStatus);
  }

  // Restore DND settings
  applyDndSettings(result);

  // Show phone clipboard toast if it arrived while panel was closed
  if (result.phoneClipboard && result.phoneClipboard.text) {
    const age = Date.now() - (result.phoneClipboard.ts || 0);
    if (age < 60_000) {  // only show if less than 60 s old
      showClipboardToast(result.phoneClipboard.text, result.phoneClipboard.deviceName);
    }
    // Clear so it doesn't show again on next open
    chrome.storage.local.remove("phoneClipboard").catch(() => {});
  }

  console.log(`[Phone Notify] Panel loaded. ${notifications.length} notification(s).`);
})();

// ─── 15. Utility ─────────────────────────────────────────────────────────────

function escHtml(str) {
  const d = document.createElement("div");
  d.textContent = String(str);
  return d.innerHTML;
}

function cleanKey(key) {
  if (typeof key !== "string") return key;
  return key.trim().replace(/[\s\r\n]/g, "");
}
