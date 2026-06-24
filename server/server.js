/**
 * server.js — Phone Notify WebSocket Relay Server v3
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ROLE:  Acts as a relay hub between an Android phone and one or more Chrome
 *        extension instances running on any browser on the local network.
 *
 * FLOW:
 *   Android Phone  ──ws://──►  This server  ──ws://──►  Chrome Extension(s)
 *
 * CLIENT TYPES:
 *   Clients self-identify via a URL query parameter on connection:
 *     ws://HOST:PORT?type=phone      → Android app
 *     ws://HOST:PORT?type=extension  → Chrome extension background.js
 *
 * MESSAGE TYPES (Phone → Server → Extension):
 *   notification         — new notification from phone
 *   notification_removed — notification dismissed on phone
 *   battery              — phone battery level + charging state
 *   clipboard            — phone clipboard text changed
 *   media_status         — currently playing media info
 *   call                 — incoming / active / ended call info
 *   ping                 — keep-alive (consumed by server, not relayed)
 *
 * MESSAGE TYPES (Extension → Server → Phone):
 *   reply                — quick reply text for a notification
 *   call_action          — answer / reject / silence a call
 *   media_control        — play / pause / next / prev
 *   clipboard_to_phone   — push text to phone clipboard
 *
 * HISTORY PERSISTENCE:
 *   Notifications are cached in memory AND written to history.json so the
 *   cache survives server restarts. Writes are debounced (2 s) to avoid
 *   hammering the disk on bursts.
 *
 * WEBHOOK:
 *   If WEBHOOK_URL env var is set, every incoming notification is HTTP-POSTed
 *   (fire-and-forget) to that URL as JSON. Uses native fetch (Node ≥ 18).
 *
 * HEARTBEAT:
 *   Server pings every client every HEARTBEAT_INTERVAL ms. Non-responsive
 *   clients are terminated (catches silent disconnects).
 *
 * TERMINAL COMMANDS (while running interactively):
 *   test [app]    — send fake notification  (whatsapp/telegram/gmail/instagram/discord)
 *   call          — send fake incoming call notification
 *   battery       — send fake battery status
 *   media         — send fake media status
 *   stats         — show connection counts
 *   history [n]   — print last N cached notifications (default 5)
 *   clear         — clear notification history cache + history.json
 *   webhook [url] — set or clear the webhook URL at runtime
 *   help          — show this list
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */

"use strict";

// ─── Imports ──────────────────────────────────────────────────────────────────

const { WebSocketServer, WebSocket } = require("ws");
const { createServer }               = require("http");
const { URL }                        = require("url");
const readline                       = require("readline");
const os                             = require("os");
const fs                             = require("fs");
const path                           = require("path");

// ─── Configuration ────────────────────────────────────────────────────────────

const CONFIG = {
  /** Port the WebSocket server listens on. Override with PORT env var. */
  PORT: parseInt(process.env.PORT ?? "8080", 10),

  /** How often (ms) to ping every connected client. */
  HEARTBEAT_INTERVAL: 30_000,

  /** Full JSON payload logging. Set DEBUG=true to enable. */
  DEBUG: process.env.DEBUG === "true",

  /**
   * Maximum notification payload size (bytes).
   * Increased from 16 KB → 64 KB to support long Gmail bodies.
   */
  MAX_PAYLOAD_BYTES: 65_536, // 64 KB

  /** Secret token for authentication. Set TOKEN env var to require it. */
  TOKEN: process.env.TOKEN || null,

  /** Max notifications kept in the in-memory + file history. */
  HISTORY_SIZE: 100,

  /** Path to the persistent history file (same directory as server.js). */
  HISTORY_FILE: path.join(__dirname, "history.json"),

  /**
   * Optional webhook URL. Every incoming notification is POST-ed here.
   * Set WEBHOOK_URL env var or use the `webhook` terminal command at runtime.
   * Uses native fetch (Node ≥ 18) — no extra dependencies.
   */
  WEBHOOK_URL: process.env.WEBHOOK_URL || null,

  /** HTTP timeout (ms) for webhook POST requests. */
  WEBHOOK_TIMEOUT_MS: 5_000,
};

// ─── Logger ───────────────────────────────────────────────────────────────────

const ANSI = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  gray:   "\x1b[90m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  red:    "\x1b[31m",
  cyan:   "\x1b[36m",
  blue:   "\x1b[34m",
  magenta:"\x1b[35m",
  white:  "\x1b[37m",
};

function timestamp() {
  return new Date().toISOString().replace("T", " ").slice(0, -1);
}

const log = {
  info:    (...a) => console.log(`${ANSI.gray}[${timestamp()}]${ANSI.reset} ${ANSI.white}ℹ${ANSI.reset}`, ...a),
  ok:      (...a) => console.log(`${ANSI.gray}[${timestamp()}]${ANSI.reset} ${ANSI.green}✓${ANSI.reset}`, ...a),
  warn:    (...a) => console.warn(`${ANSI.gray}[${timestamp()}]${ANSI.reset} ${ANSI.yellow}⚠${ANSI.reset}`, ...a),
  error:   (...a) => console.error(`${ANSI.gray}[${timestamp()}]${ANSI.reset} ${ANSI.red}✗${ANSI.reset}`, ...a),
  debug:   (...a) => { if (CONFIG.DEBUG) console.log(`${ANSI.gray}[${timestamp()}] ◦`, ...a, ANSI.reset); },
  phone:   (...a) => console.log(`${ANSI.gray}[${timestamp()}]${ANSI.reset} ${ANSI.cyan}📱${ANSI.reset}`, ...a),
  ext:     (...a) => console.log(`${ANSI.gray}[${timestamp()}]${ANSI.reset} ${ANSI.blue}🖥${ANSI.reset}`, ...a),
  divider: ()    => console.log(`${ANSI.gray}${"─".repeat(72)}${ANSI.reset}`),
};

// ─── Server start time (for uptime tracking) ──────────────────────────────────
const SERVER_START_TIME = Date.now();

// ─── Client Registry ──────────────────────────────────────────────────────────

const phones     = new Set(); // Android app connections
const extensions = new Set(); // Chrome extension connections

/** Returns a snapshot of current connection counts for logging. */
function stats() {
  return `📱 ${phones.size} phone(s)  🖥  ${extensions.size} extension(s)`;
}

function getNetworkIps() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === "IPv4" && !net.internal) {
        ips.push({ ip: net.address, name });
      }
    }
  }
  return ips;
}

function broadcastPhoneStatus() {
  broadcastToExtensions({ type: "phone_status", connected: phones.size > 0 });
}

// ─── History Persistence ──────────────────────────────────────────────────────

/**
 * In-memory notification cache.
 * Mirrors history.json on disk so the cache survives server restarts.
 * Only "notification" type entries are persisted (not battery/media/clipboard).
 */
let notificationHistory = [];

/** Debounce timer for disk writes — avoids hammering disk on bursts. */
let persistTimer = null;

/**
 * Load history from history.json on startup.
 * Silently ignores missing or corrupt files.
 */
function loadHistory() {
  try {
    if (!fs.existsSync(CONFIG.HISTORY_FILE)) {
      log.info("No history.json found — starting with empty history.");
      return;
    }
    const raw = fs.readFileSync(CONFIG.HISTORY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      notificationHistory = parsed.slice(0, CONFIG.HISTORY_SIZE);
      log.ok(`Loaded ${notificationHistory.length} notification(s) from history.json`);
    }
  } catch (err) {
    log.warn("Failed to load history.json:", err.message, "— starting fresh.");
    notificationHistory = [];
  }
}

/**
 * Schedule a debounced write of notificationHistory to history.json.
 * Uses a 2-second debounce to coalesce rapid bursts into a single write.
 */
function scheduleHistoryWrite() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      fs.writeFileSync(CONFIG.HISTORY_FILE, JSON.stringify(notificationHistory, null, 2), "utf8");
      log.debug(`history.json updated (${notificationHistory.length} entries)`);
    } catch (err) {
      log.error("Failed to write history.json:", err.message);
    }
  }, 2_000);
}

/**
 * Clear notification history from memory and disk.
 */
function clearHistory() {
  notificationHistory = [];
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  try {
    fs.writeFileSync(CONFIG.HISTORY_FILE, "[]", "utf8");
    log.ok("History cleared (memory + history.json).");
  } catch (err) {
    log.error("Failed to clear history.json:", err.message);
  }
}

/**
 * Add a notification to the history cache, with deduplication.
 * A notification is considered a duplicate if its id OR key already exists.
 */
function cleanKey(key) {
  if (typeof key !== "string") return key;
  return key.trim().replace(/[\s\r\n]/g, "");
}

/**
 * Append a notification to the in-memory history cache, capped at HISTORY_SIZE.
 *
 * @param {object} payload — parsed notification JSON
 * @returns {boolean} true if added, false if it was a duplicate
 */
function addToHistory(payload) {
  // Deduplication: skip if id or key matches an existing entry (using robust key cleaning)
  const cleanPayloadId = cleanKey(payload.id);
  const cleanPayloadKey = cleanKey(payload.key);
  const isDuplicate = notificationHistory.some(n =>
    (payload.id  && cleanKey(n.id) === cleanPayloadId)  ||
    (payload.key && cleanKey(n.key) === cleanPayloadKey)
  );

  if (isDuplicate) {
    log.debug(`Duplicate notification dropped (id=${payload.id}, key=${payload.key})`);
    return false;
  }

  notificationHistory.unshift(payload);
  if (notificationHistory.length > CONFIG.HISTORY_SIZE) {
    notificationHistory.length = CONFIG.HISTORY_SIZE;
  }

  scheduleHistoryWrite();
  return true;
}

// ─── Webhook ──────────────────────────────────────────────────────────────────

/**
 * Fire-and-forget HTTP POST of a notification payload to CONFIG.WEBHOOK_URL.
 * Uses native fetch (Node ≥ 18). Logs success/failure, never throws.
 * @param {object} payload — the notification object to POST
 */
async function fireWebhook(payload) {
  if (!CONFIG.WEBHOOK_URL) return;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.WEBHOOK_TIMEOUT_MS);

    const res = await fetch(CONFIG.WEBHOOK_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
      signal:  controller.signal,
    });

    clearTimeout(timeout);

    if (res.ok) {
      log.ok(`Webhook delivered → ${CONFIG.WEBHOOK_URL} (HTTP ${res.status})`);
    } else {
      log.warn(`Webhook responded with HTTP ${res.status} from ${CONFIG.WEBHOOK_URL}`);
    }
  } catch (err) {
    if (err.name === "AbortError") {
      log.warn(`Webhook timed out after ${CONFIG.WEBHOOK_TIMEOUT_MS}ms`);
    } else {
      log.error("Webhook delivery failed:", err.message);
    }
  }
}

// ─── WebSocket Server ─────────────────────────────────────────────────────────

/**
 * HTTP server wrapping the WebSocket server.
 * GET /         → plain-text status (human readable)
 * GET /status   → JSON status (machine readable, for dashboards / health checks)
 * All other requests → 404
 */
const httpServer = createServer((req, res) => {
  const url = req.url?.split("?")[0] ?? "/";

  if (url === "/status") {
    // ── JSON status endpoint ──────────────────────────────────────────────────
    const uptimeSec = Math.floor((Date.now() - SERVER_START_TIME) / 1000);
    const status = {
      service:           "Phone Notify Relay",
      version:           "3.0.0",
      uptime_seconds:    uptimeSec,
      port:              CONFIG.PORT,
      connections: {
        phones:     phones.size,
        extensions: extensions.size,
        total:      wss.clients.size,
      },
      history: {
        cached: notificationHistory.length,
        max:    CONFIG.HISTORY_SIZE,
        last:   notificationHistory[0] ?? null,
      },
      webhook: {
        enabled: !!CONFIG.WEBHOOK_URL,
        url:     CONFIG.WEBHOOK_URL ?? null,
      },
      auth_required: !!CONFIG.TOKEN,
      network_ips:   getNetworkIps(),
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status, null, 2));
    return;
  }

  if (url === "/") {
    // ── Human-readable status page ───────────────────────────────────────────
    const uptimeSec = Math.floor((Date.now() - SERVER_START_TIME) / 1000);
    const h = Math.floor(uptimeSec / 3600);
    const m = Math.floor((uptimeSec % 3600) / 60);
    const s = uptimeSec % 60;
    const uptimeStr = `${h}h ${m}m ${s}s`;
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(
      `╔══════════════════════════════════════════╗\n` +
      `║       Phone Notify Relay Server v3       ║\n` +
      `╚══════════════════════════════════════════╝\n\n` +
      `  Port:        ${CONFIG.PORT}\n` +
      `  Uptime:      ${uptimeStr}\n` +
      `  Phones:      ${phones.size}\n` +
      `  Extensions:  ${extensions.size}\n` +
      `  Cached:      ${notificationHistory.length} / ${CONFIG.HISTORY_SIZE} notifications\n` +
      `  Webhook:     ${CONFIG.WEBHOOK_URL ?? "disabled"}\n` +
      `  Auth:        ${CONFIG.TOKEN ? "required" : "disabled"}\n\n` +
      `  JSON status: http://localhost:${CONFIG.PORT}/status\n`
    );
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found\n");
});

const wss = new WebSocketServer({ server: httpServer });

// ─── Connection Handler ───────────────────────────────────────────────────────

wss.on("connection", (ws, req) => {
  // ── 1. Parse URL & identify client ───────────────────────────────────────────
  const requestUrl = new URL(req.url ?? "/", `ws://localhost:${CONFIG.PORT}`);
  const clientType = requestUrl.searchParams.get("type"); // "phone" | "extension" | null
  const clientIp   = req.socket.remoteAddress ?? "unknown";

  // ── 2. Token authentication ───────────────────────────────────────────────────
  if (CONFIG.TOKEN) {
    const clientToken = requestUrl.searchParams.get("token");
    if (clientToken !== CONFIG.TOKEN) {
      log.warn(`Unauthorized connection from ${clientIp} (bad/missing token) — closing.`);
      safeJsonSend(ws, { type: "error", message: "Unauthorized: Invalid or missing token" });
      ws.close(4001, "Unauthorized");
      return;
    }
  }

  // ── 3. Register in the correct Set ───────────────────────────────────────────
  if (clientType === "phone") {
    // Close any existing connection from the same IP to prevent duplicates
    for (const old of phones) {
      if (old.remoteIp === clientIp) {
        log.info(`Deduplicating PHONE connection from ${clientIp} — closing old socket.`);
        try { old.close(1000, "Superseded"); } catch (_) {}
        phones.delete(old);
      }
    }
    ws.remoteIp = clientIp;
    phones.add(ws);
    log.ok(`PHONE connected       ${ANSI.gray}${clientIp}${ANSI.reset}  —  ${stats()}`);
    broadcastPhoneStatus();

  } else if (clientType === "extension") {
    extensions.add(ws);
    log.ok(`EXTENSION connected   ${ANSI.gray}${clientIp}${ANSI.reset}  —  ${stats()}`);

    // Greet the new extension
    safeJsonSend(ws, {
      type:      "server_hello",
      message:   "Phone Notify relay connected. Waiting for notifications…",
      version:   "3.0.0",
      timestamp: Date.now(),
    });

    // Send current phone status
    safeJsonSend(ws, { type: "phone_status", connected: phones.size > 0 });

    // Send laptop network IPs
    safeJsonSend(ws, { type: "server_ips", ips: getNetworkIps() });

    // Replay cached notification history
    if (notificationHistory.length > 0) {
      safeJsonSend(ws, { type: "history", notifications: notificationHistory });
    }

  } else {
    log.warn(`Unknown client type "${clientType}" from ${clientIp} — closing.`);
    safeJsonSend(ws, {
      type:    "error",
      message: "Identify yourself: connect with ?type=phone or ?type=extension",
    });
    ws.close(1008, "Missing client type");
    return;
  }

  // ── 4. Heartbeat state ────────────────────────────────────────────────────────
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
    log.debug(`Pong from ${clientIp} (${clientType})`);
  });

  // ── 5. Message handler ────────────────────────────────────────────────────────
  ws.on("message", (rawData, isBinary) => {
    if (isBinary) { log.warn(`Binary frame from ${clientIp} ignored.`); return; }

    const raw = rawData.toString("utf8");

    if (Buffer.byteLength(raw, "utf8") > CONFIG.MAX_PAYLOAD_BYTES) {
      log.warn(`Oversized payload (${Buffer.byteLength(raw, "utf8")} bytes) from ${clientIp} — dropped.`);
      safeJsonSend(ws, { type: "error", message: "Payload too large (max 64 KB)" });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      log.warn(`Invalid JSON from ${clientIp} (${clientType}) — ignored.`);
      safeJsonSend(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    log.debug(`Payload from ${clientIp} (${clientType}):`, raw);

    if (clientType === "phone") {
      handlePhoneMessage(payload, clientIp);
    } else if (clientType === "extension") {
      handleExtensionMessage(payload, clientIp);
    }
  });

  // ── 6. Disconnect handler ─────────────────────────────────────────────────────
  ws.on("close", (code, reason) => {
    const hadPhone = phones.has(ws);
    phones.delete(ws);
    extensions.delete(ws);

    const reasonStr = reason?.toString() || "no reason";
    log.info(
      `${(clientType ?? "UNKNOWN").toUpperCase()} disconnected  ` +
      `${ANSI.gray}${clientIp}  code=${code}  reason="${reasonStr}"${ANSI.reset}  —  ${stats()}`
    );
    if (hadPhone) broadcastPhoneStatus();
  });

  // ── 7. Error handler ──────────────────────────────────────────────────────────
  ws.on("error", (err) => {
    log.error(`Socket error from ${clientIp} (${clientType}):`, err.message);
  });
});

// ─── Phone Message Handler ────────────────────────────────────────────────────

/**
 * Valid message types from the Android phone.
 * - notification         : new notification posted
 * - notification_removed : notification dismissed on phone
 * - battery              : battery level + charging state
 * - clipboard            : phone clipboard content changed
 * - media_status         : currently playing media track info
 * - call                 : incoming / active / ended phone call
 * - ping                 : keep-alive heartbeat (consumed, not relayed)
 */
const VALID_PHONE_TYPES = new Set([
  "notification",
  "notification_removed",
  "battery",
  "clipboard",
  "media_status",
  "call",
  "ping",
  "sync_start",
  "sync_end",
  "clear_all_notifications",
  "full_sync",
]);

function handlePhoneMessage(payload, senderIp) {
  // ── Validate required fields ──────────────────────────────────────────────────
  if (!payload.type || !VALID_PHONE_TYPES.has(payload.type)) {
    log.warn(`Phone: invalid type "${payload.type}" from ${senderIp} — dropped.`);
    return;
  }
  if (typeof payload.timestamp !== "number") {
    log.warn(`Phone: missing numeric timestamp from ${senderIp} — dropped.`);
    return;
  }

  // ── Ping: consume, don't relay ────────────────────────────────────────────────
  if (payload.type === "ping") {
    log.debug(`Keep-alive ping from ${senderIp}`);
    return;
  }

  // ── Sync start: phone is about to send its current active notifications ────────
  // Clear the server-side history so the extension gets a fresh, accurate list.
  if (payload.type === "sync_start") {
    log.phone(`SYNC_START — clearing history and syncing active notifications`);
    clearHistory();
    broadcastToExtensions({ type: "sync_start" });
    return;
  }

  // ── Sync end: phone has finished sending its active notifications ─────────────
  if (payload.type === "sync_end") {
    log.phone(`SYNC_END — active notification sync complete`);
    broadcastToExtensions({ type: "sync_end" });
    return;
  }

  // ── Clear all notifications: clear history and broadcast ───────────────────────
  if (payload.type === "clear_all_notifications") {
    log.phone(`CLEAR_ALL_NOTIFICATIONS — clearing history and broadcasting`);
    clearHistory();
    broadcastToExtensions({ type: "clear_all_notifications", timestamp: payload.timestamp });
    return;
  }

  // ── Full sync: replace history with the phone's active notifications ───────────
  if (payload.type === "full_sync") {
    const notifs = payload.notifications || [];
    log.phone(`FULL_SYNC — replacing history with ${notifs.length} active notification(s)`);
    
    // Ensure all received notifications have deterministic IDs
    for (const notif of notifs) {
      if (!notif.id) {
        if (notif.key) {
          notif.id = notif.key;
        } else {
          const seed = (notif.package ?? "") + (notif.title ?? "") + (notif.message ?? "");
          notif.id = `n-${notif.timestamp || Date.now()}-${Math.abs(hashCode(seed))}`;
        }
      }
    }
    
    // Replace history
    notificationHistory = notifs.slice(0, CONFIG.HISTORY_SIZE);
    scheduleHistoryWrite();
    
    broadcastToExtensions(payload);
    return;
  }

  // ── Notification: add to history, dedup, webhook ──────────────────────────────
  if (payload.type === "notification") {
    // Generate deterministic id if not present
    if (!payload.id) {
      if (payload.key) {
        payload.id = payload.key;
      } else {
        const seed = (payload.package ?? "") + (payload.title ?? "") + (payload.message ?? "");
        payload.id = `n-${payload.timestamp}-${Math.abs(hashCode(seed))}`;
      }
    }

    const added = addToHistory(payload);

    log.phone(
      `NOTIFICATION  ${ANSI.cyan}[${payload.app ?? "?"}]${ANSI.reset}` +
      `  device="${payload.deviceName ?? "?"}"` +
      `  "${payload.title ?? ""}"  "${(payload.message ?? "").slice(0, 60)}"`
    );

    // Only fire webhook for genuinely new (non-duplicate) notifications
    if (added) fireWebhook(payload);
  }

  // ── Notification removed: sync history ───────────────────────────────────────
  if (payload.type === "notification_removed") {
    const key = payload.key;
    const pkg = payload.package;

    if (key) {
      const targetKey = cleanKey(key);
      const before = notificationHistory.length;
      notificationHistory = notificationHistory.filter(n => cleanKey(n.key) !== targetKey && cleanKey(n.id) !== targetKey);
      if (notificationHistory.length !== before) scheduleHistoryWrite();
    } else if (pkg) {
      const before = notificationHistory.length;
      notificationHistory = notificationHistory.filter(n => n.package !== pkg);
      if (notificationHistory.length !== before) scheduleHistoryWrite();
    }

    log.phone(`REMOVED  key=${key ?? "?"} package=${pkg ?? "?"}`);
  }

  // ── Battery: log and relay ────────────────────────────────────────────────────
  if (payload.type === "battery") {
    log.phone(`BATTERY  level=${payload.level ?? "?"}%  charging=${payload.charging ?? "?"}`);
  }

  // ── Clipboard: log and relay ──────────────────────────────────────────────────
  if (payload.type === "clipboard") {
    log.phone(`CLIPBOARD  "${(payload.text ?? "").slice(0, 60)}"`);
  }

  // ── Media status: log and relay ───────────────────────────────────────────────
  if (payload.type === "media_status") {
    log.phone(
      `MEDIA  ${payload.playing ? "▶" : "⏸"}  ` +
      `"${payload.title ?? "?"}" — ${payload.artist ?? "?"}`
    );
  }

  // ── Call: log and relay ───────────────────────────────────────────────────────
  if (payload.type === "call") {
    log.phone(
      `CALL  state=${payload.state ?? "?"}  ` +
      `caller="${payload.callerName ?? payload.callerNumber ?? "Unknown"}"`
    );
  }

  // ── Relay all non-ping messages to extensions ────────────────────────────────
  broadcastToExtensions(payload);
}

// ─── Extension Message Handler ────────────────────────────────────────────────

/**
 * Messages from the Chrome extension → forwarded to the phone(s).
 *
 * reply              → quick reply text for a notification
 * call_action        → answer / reject / silence a call
 * media_control      → play / pause / next / previous track
 * clipboard_to_phone → push clipboard text to phone
 */
function handleExtensionMessage(payload, senderIp) {
  log.debug(`Extension message from ${senderIp}:`, payload);

  const type = payload.type;

  if (type === "reply") {
    log.ext(`REPLY  key="${payload.key}"  message="${payload.message}"`);
    forwardToPhones(payload, senderIp, "reply");
    return;
  }

  if (type === "call_action") {
    log.ext(`CALL ACTION  action="${payload.action}"`);
    forwardToPhones(payload, senderIp, "call_action");
    return;
  }

  if (type === "media_control") {
    log.ext(`MEDIA CONTROL  action="${payload.action}"`);
    forwardToPhones(payload, senderIp, "media_control");
    return;
  }

  if (type === "clipboard_to_phone") {
    log.ext(`CLIPBOARD → PHONE  "${(payload.text ?? "").slice(0, 60)}"`);
    forwardToPhones(payload, senderIp, "clipboard_to_phone");
    return;
  }

  if (type === "dismiss") {
    log.ext(`DISMISS  key="${payload.key}"  id="${payload.id}"`);
    const key = payload.key;
    const id = payload.id;
    
    const cleanId = id ? cleanKey(id) : null;
    const cleanKeyVal = key ? cleanKey(key) : null;
    
    const before = notificationHistory.length;
    notificationHistory = notificationHistory.filter(n => {
      const nKeyCleaned = n.key ? cleanKey(n.key) : null;
      const nIdCleaned = n.id ? cleanKey(n.id) : null;
      
      if (cleanKeyVal && (nKeyCleaned === cleanKeyVal || nIdCleaned === cleanKeyVal)) {
        return false;
      }
      if (cleanId && (nKeyCleaned === cleanId || nIdCleaned === cleanId)) {
        return false;
      }
      return true;
    });
    if (notificationHistory.length !== before) scheduleHistoryWrite();

    forwardToPhones(payload, senderIp, "dismiss");
    broadcastToExtensions({ type: "notification_removed", key: payload.key, id: payload.id });
    return;
  }

  if (type === "clear_all") {
    log.ext(`CLEAR ALL`);
    clearHistory();
    forwardToPhones(payload, senderIp, "clear_all");
    broadcastToExtensions({ type: "clear_all_notifications", timestamp: Date.now() });
    return;
  }

  log.warn(`Extension sent unknown message type "${type}" from ${senderIp} — ignored.`);
}

/**
 * Forward a payload from an extension to all connected phones.
 * @param {object} payload   — the message to forward
 * @param {string} senderIp  — extension IP (for logging)
 * @param {string} label     — human label for the log line
 */
function forwardToPhones(payload, senderIp, label) {
  const json = JSON.stringify(payload);
  let sent = 0;

  for (const phone of phones) {
    if (phone.readyState === WebSocket.OPEN) {
      phone.send(json, (err) => {
        if (err) log.error(`Failed to forward ${label} to phone:`, err.message);
      });
      sent++;
    }
  }

  log.ok(`Forwarded ${label} from extension ${senderIp} to ${sent}/${phones.size} phone(s)`);
}

// ─── Broadcast ────────────────────────────────────────────────────────────────

/**
 * Serialise [payload] to JSON and send it to every OPEN extension.
 * @param {object} payload
 * @returns {number} number of extensions delivered to
 */
function broadcastToExtensions(payload) {
  if (extensions.size === 0) {
    log.warn("No extensions connected — notification may be lost.");
    return 0;
  }

  const json = JSON.stringify(payload);
  let count  = 0;

  for (const ext of extensions) {
    if (ext.readyState === WebSocket.OPEN) {
      ext.send(json, (err) => {
        if (err) log.error("Send to extension failed:", err.message);
      });
      count++;
    }
  }

  log.ok(`Relayed [${payload.type}] to ${count}/${extensions.size} extension(s)`);
  return count;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/** djb2-like hash: string → 32-bit signed integer. */
function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  return h;
}

/** Send JSON to a single WebSocket, safe (ignores closed sockets). */
function safeJsonSend(ws, obj) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch (err) {
    log.error("safeJsonSend failed:", err.message);
  }
}

// ─── Heartbeat ────────────────────────────────────────────────────────────────

const heartbeatInterval = setInterval(() => {
  let terminated = 0;
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); terminated++; continue; }
    ws.isAlive = false;
    ws.ping();
  }
  if (terminated > 0) {
    log.warn(`Heartbeat: terminated ${terminated} dead connection(s)  —  ${stats()}`);
  } else {
    log.debug(`Heartbeat: all ${wss.clients.size} client(s) alive`);
  }
}, CONFIG.HEARTBEAT_INTERVAL);

heartbeatInterval.unref();

// ─── Test Notification Templates ──────────────────────────────────────────────

const TEST_NOTIFICATIONS = {
  whatsapp: {
    type: "notification", app: "WhatsApp", package: "com.whatsapp",
    title: "Alex Rivera", message: "Hey! Are you coming to the meetup tonight? 🎉",
    deviceName: "Test Device",
  },
  telegram: {
    type: "notification", app: "Telegram", package: "org.telegram.messenger",
    title: "Design Hub", message: "🔥 New Figma plugin just dropped — check the pinned message!",
    deviceName: "Test Device",
  },
  gmail: {
    type: "notification", app: "Gmail", package: "com.google.android.gm",
    title: "GitHub", message: "Your pull request #42 'feat: dark mode' was merged into main ✅\n\nCongratulatons! Your contribution to the project has been accepted by the maintainer.",
    deviceName: "Test Device",
  },
  instagram: {
    type: "notification", app: "Instagram", package: "com.instagram.android",
    title: "Jordan Lee", message: "Liked your photo: 'Golden hour at the coast 🌅'",
    deviceName: "Test Device",
  },
  discord: {
    type: "notification", app: "Discord", package: "com.discord",
    title: "dev-general", message: "neon: anyone tried the new Bun 1.2 release? insanely fast 🚀",
    deviceName: "Test Device",
  },
};

const TEST_CALL = {
  type: "call", state: "ringing",
  callerName: "Mom",
  callerNumber: "+1 (555) 123-4567",
  deviceName: "Test Device",
};

const TEST_BATTERY = {
  type: "battery", level: 42, charging: false,
  deviceName: "Test Device",
};

const TEST_MEDIA = {
  type: "media_status", playing: true,
  title: "Blinding Lights",
  artist: "The Weeknd",
  album: "After Hours",
  deviceName: "Test Device",
};

// ─── Terminal Commands ────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
${ANSI.cyan}Phone Notify Server v3 — Interactive Commands${ANSI.reset}

  ${ANSI.bold}test [app]${ANSI.reset}       Send a fake notification.
                   app: whatsapp (default), telegram, gmail, instagram, discord

  ${ANSI.bold}call${ANSI.reset}             Send a fake incoming call notification.

  ${ANSI.bold}battery${ANSI.reset}          Send a fake battery status (42%, not charging).

  ${ANSI.bold}media${ANSI.reset}            Send a fake media status (Blinding Lights ▶).

  ${ANSI.bold}stats${ANSI.reset}            Show current connection counts.

  ${ANSI.bold}history [n]${ANSI.reset}      Print the last N cached notifications (default: 5).

  ${ANSI.bold}clear${ANSI.reset}            Clear notification history (memory + history.json).

  ${ANSI.bold}webhook [url]${ANSI.reset}    Set the webhook URL at runtime. Pass no URL to disable.

  ${ANSI.bold}help${ANSI.reset}             Show this help message.

  ${ANSI.bold}Ctrl+C${ANSI.reset}           Graceful shutdown.
`);
}

if (process.stdin.isTTY) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  process.stdout.write(`${ANSI.gray}Type "help" for available commands.\n${ANSI.reset}`);

  rl.on("line", (line) => {
    const parts   = line.trim().split(/\s+/);
    const command = parts[0].toLowerCase();
    const arg     = parts[1] ?? "";

    switch (command) {

      case "test": {
        const key      = arg.toLowerCase() || "whatsapp";
        const template = TEST_NOTIFICATIONS[key] ?? TEST_NOTIFICATIONS.whatsapp;
        const payload  = { ...template, timestamp: Date.now() };

        // Generate id
        const seed = (payload.package ?? "") + (payload.title ?? "") + (payload.message ?? "");
        payload.id = `n-${payload.timestamp}-${Math.abs(hashCode(seed))}`;

        log.info(`🧪 TEST: sending fake ${payload.app} notification…`);
        const count = broadcastToExtensions(payload);
        if (count === 0) log.warn("No extensions connected. Open the Chrome extension first.");
        break;
      }

      case "call": {
        const payload = { ...TEST_CALL, timestamp: Date.now() };
        log.info("🧪 TEST: sending fake incoming call…");
        const count = broadcastToExtensions(payload);
        if (count === 0) log.warn("No extensions connected.");
        break;
      }

      case "battery": {
        const payload = { ...TEST_BATTERY, timestamp: Date.now() };
        log.info("🧪 TEST: sending fake battery status…");
        broadcastToExtensions(payload);
        break;
      }

      case "media": {
        const payload = { ...TEST_MEDIA, timestamp: Date.now() };
        log.info("🧪 TEST: sending fake media status…");
        broadcastToExtensions(payload);
        break;
      }

      case "stats":
        console.log(`\n  ${stats()}\n  Cached: ${notificationHistory.length}/${CONFIG.HISTORY_SIZE}\n  Webhook: ${CONFIG.WEBHOOK_URL ?? "disabled"}\n`);
        break;

      case "history": {
        const n = parseInt(arg, 10) || 5;
        const slice = notificationHistory.slice(0, n);
        if (slice.length === 0) {
          console.log(`  ${ANSI.gray}(no notifications in history)${ANSI.reset}`);
        } else {
          console.log(`\n  ${ANSI.cyan}Last ${slice.length} notification(s):${ANSI.reset}`);
          slice.forEach((notif, i) => {
            console.log(
              `  ${ANSI.gray}${i + 1}.${ANSI.reset}` +
              `  ${ANSI.cyan}[${notif.app ?? "?"}]${ANSI.reset}` +
              `  "${notif.title ?? ""}"` +
              `  ${ANSI.gray}${new Date(notif.timestamp).toLocaleTimeString()}${ANSI.reset}` +
              (notif.deviceName ? `  ${ANSI.gray}(${notif.deviceName})${ANSI.reset}` : "")
            );
          });
          console.log();
        }
        break;
      }

      case "clear":
        clearHistory();
        // Also notify connected extensions to clear their display
        broadcastToExtensions({ type: "history_cleared", timestamp: Date.now() });
        break;

      case "webhook": {
        if (arg) {
          CONFIG.WEBHOOK_URL = arg;
          log.ok(`Webhook set to: ${CONFIG.WEBHOOK_URL}`);
        } else {
          CONFIG.WEBHOOK_URL = null;
          log.ok("Webhook disabled.");
        }
        break;
      }

      case "help":
      case "":
        printHelp();
        break;

      default:
        log.warn(`Unknown command: "${command}". Type "help" for available commands.`);
    }
  });

  rl.on("close", () => shutdown("stdin closed"));
}

// ─── Start ────────────────────────────────────────────────────────────────────

// Load persisted notification history before accepting connections
loadHistory();

httpServer.listen(CONFIG.PORT, () => {
  log.divider();
  console.log(`\n  ${ANSI.bold}${ANSI.green}Phone Notify Relay Server${ANSI.reset}  ${ANSI.gray}v3.0.0${ANSI.reset}\n`);
  console.log(`  ${ANSI.cyan}WebSocket${ANSI.reset}  ws://0.0.0.0:${CONFIG.PORT}`);
  console.log(`  ${ANSI.cyan}HTTP${ANSI.reset}       http://0.0.0.0:${CONFIG.PORT}  (status page)`);
  console.log(`  ${ANSI.cyan}JSON API${ANSI.reset}   http://0.0.0.0:${CONFIG.PORT}/status\n`);

  const localIps = getNetworkIps();
  if (localIps.length > 0) {
    console.log(`  ${ANSI.gray}Android App URLs:${ANSI.reset}`);
    localIps.forEach(item =>
      console.log(`    ws://${item.ip}:${CONFIG.PORT}?type=phone  ${ANSI.gray}(${item.name})${ANSI.reset}`)
    );
  }
  console.log(`\n  ${ANSI.gray}Extension URL:  ws://localhost:${CONFIG.PORT}?type=extension${ANSI.reset}`);
  console.log(`  ${ANSI.gray}History file:   ${CONFIG.HISTORY_FILE}${ANSI.reset}`);
  if (CONFIG.WEBHOOK_URL) {
    console.log(`  ${ANSI.yellow}Webhook:        ${CONFIG.WEBHOOK_URL}${ANSI.reset}`);
  }
  if (CONFIG.TOKEN) {
    console.log(`  ${ANSI.yellow}Auth:           token required${ANSI.reset}`);
  }
  console.log();
  log.divider();
  printHelp();
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

function shutdown(reason) {
  log.info(`Shutting down: ${reason}`);
  clearInterval(heartbeatInterval);

  // Flush any pending history write immediately
  if (persistTimer) {
    clearTimeout(persistTimer);
    try {
      fs.writeFileSync(CONFIG.HISTORY_FILE, JSON.stringify(notificationHistory, null, 2), "utf8");
      log.ok("history.json flushed on shutdown.");
    } catch (err) {
      log.error("Failed to flush history.json:", err.message);
    }
  }

  for (const ws of wss.clients) ws.close(1001, "Server shutting down");

  wss.close(() => {
    httpServer.close(() => {
      log.info("Server closed cleanly. Goodbye.");
      process.exit(0);
    });
  });

  setTimeout(() => { log.warn("Forced exit."); process.exit(1); }, 5_000).unref();
}

process.on("SIGINT",  () => shutdown("SIGINT (Ctrl+C)"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => log.error("Unhandled rejection:", reason));
