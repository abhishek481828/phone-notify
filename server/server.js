/**
 * server.js — Phone Notify WebSocket Relay Server
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
 * HEARTBEAT:
 *   The server pings every connected client every HEARTBEAT_INTERVAL ms.
 *   If a client does not respond with a pong within that window, it is
 *   considered dead and its socket is terminated. This catches silent
 *   disconnects (e.g. phone screen off, Wi-Fi switched, app killed).
 *
 * TEST COMMAND (interactive):
 *   While the server is running, type  test  in the terminal and press Enter.
 *   The server will fabricate a WhatsApp notification and broadcast it to all
 *   connected extension clients — useful for development without a real phone.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */

"use strict";

// ─── Imports ──────────────────────────────────────────────────────────────────

const { WebSocketServer, WebSocket } = require("ws");
const { createServer } = require("http");
const { URL } = require("url");
const readline = require("readline");

// ─── Configuration ────────────────────────────────────────────────────────────

const CONFIG = {
  /** Port the WebSocket server listens on. Override with PORT env var. */
  PORT: parseInt(process.env.PORT ?? "8080", 10),

  /**
   * How often (ms) to send a ping to every connected client.
   * Clients that don't pong within this window are disconnected.
   */
  HEARTBEAT_INTERVAL: 30_000,

  /**
   * If true, full JSON payloads are logged to the console.
   * Set DEBUG=true in the environment to enable.
   */
  DEBUG: process.env.DEBUG === "true",

  /**
   * Maximum notification payload size (bytes).
   * Prevents memory abuse from malformed giant messages.
   */
  MAX_PAYLOAD_BYTES: 16_384, // 16 KB

  /**
   * Secret token to authenticate connections.
   * If set, clients must connect with ?token=YOUR_TOKEN
   */
  TOKEN: process.env.TOKEN || null,
};

// ─── Logger ───────────────────────────────────────────────────────────────────

/**
 * Minimal structured logger with ANSI colours and ISO timestamps.
 * Every log line is prefixed with the current UTC time so server logs
 * are easy to correlate with device-side logs.
 *
 * Levels:
 *   info  (white)  — normal operations
 *   ok    (green)  — successful events
 *   warn  (yellow) — non-fatal issues (invalid JSON, unexpected messages)
 *   error (red)    — errors that need attention
 *   debug (gray)   — verbose payload dumps (CONFIG.DEBUG only)
 */
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  gray: "\x1b[90m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
};

function timestamp() {
  return new Date().toISOString().replace("T", " ").slice(0, -1);
}

const log = {
  info: (...args) => console.log(`${ANSI.gray}[${timestamp()}]${ANSI.reset} ${ANSI.white}ℹ${ANSI.reset}`, ...args),
  ok: (...args) => console.log(`${ANSI.gray}[${timestamp()}]${ANSI.reset} ${ANSI.green}✓${ANSI.reset}`, ...args),
  warn: (...args) => console.warn(`${ANSI.gray}[${timestamp()}]${ANSI.reset} ${ANSI.yellow}⚠${ANSI.reset}`, ...args),
  error: (...args) => console.error(`${ANSI.gray}[${timestamp()}]${ANSI.reset} ${ANSI.red}✗${ANSI.reset}`, ...args),
  debug: (...args) => { if (CONFIG.DEBUG) console.log(`${ANSI.gray}[${timestamp()}] ◦`, ...args, ANSI.reset); },
  divider: () => console.log(`${ANSI.gray}${"─".repeat(72)}${ANSI.reset}`),
};

// ─── Client Registry ──────────────────────────────────────────────────────────

/**
 * Two separate Sets for each client type.
 * Keeping them separate lets us broadcast to extensions without an O(n)
 * type-check on every message and makes the stats output trivial.
 */
const phones = new Set(); // Android app connections
const extensions = new Set(); // Chrome extension connections

// Cache the last 50 notifications to prevent loss during Extension suspensions
const notificationHistory = [];

/** Returns a snapshot of current connection counts for logging. */
function stats() {
  return `📱 ${phones.size} phone(s)  🖥  ${extensions.size} extension(s)`;
}

function broadcastPhoneStatus() {
  broadcastToExtensions({
    type: "phone_status",
    connected: phones.size > 0
  });
}

// ─── WebSocket Server ─────────────────────────────────────────────────────────

/**
 * We wrap our WebSocketServer in a plain http.Server so that:
 *  a) We can listen on the same port for future HTTP health checks.
 *  b) We get the upgrade event for proper URL parsing.
 *
 * The http.Server itself returns a 426 Upgrade Required for any plain HTTP
 * request (handled implicitly by the ws library).
 */
const httpServer = createServer((_req, res) => {
  // Respond to plain HTTP GET requests with a simple status page.
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(
    `Phone Notify Relay — WebSocket server running\n` +
    `Port: ${CONFIG.PORT}\n` +
    stats() + "\n"
  );
});

const wss = new WebSocketServer({ server: httpServer });

// ─── Connection Handler ───────────────────────────────────────────────────────

wss.on("connection", (ws, req) => {
  // ── 1. Identify client type from URL query parameter ──────────────────────

  /**
   * Parse the full URL from the upgrade request.
   * req.url is only the path + query, so we prepend a dummy base.
   * e.g.  /?type=phone  or  /?type=extension
   */
  const requestUrl = new URL(req.url ?? "/", `ws://localhost:${CONFIG.PORT}`);
  const clientType = requestUrl.searchParams.get("type"); // "phone" | "extension" | null
  const clientIp = req.socket.remoteAddress ?? "unknown";

  // ── 1.5. Validate Token if configured ─────────────────────────────────────
  const clientToken = requestUrl.searchParams.get("token");
  if (CONFIG.TOKEN && clientToken !== CONFIG.TOKEN) {
    log.warn(`Unauthorized connection attempt from ${clientIp} (invalid or missing token) — closing.`);
    safeJsonSend(ws, {
      type: "error",
      message: "Unauthorized: Invalid or missing token",
    });
    ws.close(4001, "Unauthorized");
    return;
  }

  // ── 2. Register client in the correct Set ─────────────────────────────────

  if (clientType === "phone") {
    // Close and remove any existing phone connections from the same IP to prevent duplicates
    for (const oldPhone of phones) {
      if (oldPhone.remoteIp === clientIp) {
        log.info(`Deduplicating PHONE connection from ${clientIp} — closing old socket.`);
        try {
          oldPhone.close(1000, "Superceded by new connection");
        } catch (e) { }
        phones.delete(oldPhone);
      }
    }
    ws.remoteIp = clientIp;
    phones.add(ws);
    log.ok(`PHONE connected       ${ANSI.gray}${clientIp}${ANSI.reset}  —  ${stats()}`);
    broadcastPhoneStatus();
  } else if (clientType === "extension") {
    extensions.add(ws);
    log.ok(`EXTENSION connected   ${ANSI.gray}${clientIp}${ANSI.reset}  —  ${stats()}`);

    // Greet the new extension so its console shows the connection is alive.
    safeJsonSend(ws, {
      type: "server_hello",
      message: "Phone Notify relay connected. Waiting for notifications…",
      timestamp: Date.now(),
    });

    // Send the current phone connection status to the new extension
    safeJsonSend(ws, {
      type: "phone_status",
      connected: phones.size > 0
    });

    // Send history if we have any cached notifications
    if (notificationHistory.length > 0) {
      safeJsonSend(ws, {
        type: "history",
        notifications: notificationHistory,
      });
    }
  } else {
    // Unknown client type — reject with a clear error message and close.
    log.warn(`Unknown client type "${clientType}" from ${clientIp} — closing.`);
    safeJsonSend(ws, {
      type: "error",
      message: 'Identify yourself: connect with ?type=phone or ?type=extension',
    });
    ws.close(1008, "Missing client type");
    return;
  }

  // ── 3. Heartbeat state ────────────────────────────────────────────────────

  /**
   * ws.isAlive is set to true on connection and on every pong event.
   * The heartbeat interval (set up below) sets it to false before each ping.
   * If it's still false at the next interval, the client is dead → terminate.
   */
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
    log.debug(`Pong from ${clientIp} (${clientType})`);
  });

  // ── 4. Message handler ─────────────────────────────────────────────────────

  ws.on("message", (rawData, isBinary) => {
    // Ignore binary frames — all our payloads are UTF-8 text.
    if (isBinary) {
      log.warn(`Binary frame from ${clientIp} ignored.`);
      return;
    }

    const raw = rawData.toString("utf8");

    // ── 4a. Size guard ────────────────────────────────────────────────────────
    if (Buffer.byteLength(raw, "utf8") > CONFIG.MAX_PAYLOAD_BYTES) {
      log.warn(`Oversized payload (${Buffer.byteLength(raw, "utf8")} bytes) from ${clientIp} — dropped.`);
      safeJsonSend(ws, { type: "error", message: "Payload too large" });
      return;
    }

    // ── 4b. JSON parse & validate ─────────────────────────────────────────────
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      log.warn(`Invalid JSON from ${clientIp} (${clientType}) — ignored.`);
      safeJsonSend(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    log.debug(`Raw payload from ${clientIp}:`, raw);

    // ── 4c. Route by client type ──────────────────────────────────────────────

    if (clientType === "phone") {
      handlePhoneMessage(payload, clientIp);
    } else if (clientType === "extension") {
      handleExtensionMessage(payload, clientIp);
    }
  });

  // ── 5. Disconnect handler ─────────────────────────────────────────────────

  ws.on("close", (code, reason) => {
    // Remove from whichever Set this client was in
    const hadPhone = phones.has(ws);
    phones.delete(ws);
    extensions.delete(ws);

    const reasonStr = reason?.toString() || "no reason";
    log.info(
      `${clientType?.toUpperCase() ?? "UNKNOWN"} disconnected  ${ANSI.gray}${clientIp}  code=${code}  reason="${reasonStr}"${ANSI.reset}  —  ${stats()}`
    );

    if (hadPhone) {
      broadcastPhoneStatus();
    }
  });

  // ── 6. Error handler ──────────────────────────────────────────────────────

  ws.on("error", (err) => {
    // Errors are followed by a 'close' event, so no manual cleanup needed here.
    log.error(`Socket error from ${clientIp} (${clientType}):`, err.message);
  });
});

// ─── Phone Message Handler ────────────────────────────────────────────────────

/**
 * handlePhoneMessage(payload, senderIp)
 * ──────────────────────────────────────
 * Validates a notification payload received from the Android app and
 * broadcasts it to all currently connected extension clients.
 *
 * Required fields (per the Phone Notify protocol):
 *   type      — must be "notification" or "notification_removed"
 *   timestamp — must be a number (Unix ms)
 *
 * Optional but expected for "notification":
 *   app, package, title, message
 *
 * @param {object} payload  — parsed JSON object from the phone
 * @param {string} senderIp — IP address of the sending phone (for logs)
 */
function handlePhoneMessage(payload, senderIp) {
  // ── Validate required fields ──────────────────────────────────────────────

  const validTypes = ["notification", "notification_removed", "ping"];

  if (!payload.type || !validTypes.includes(payload.type)) {
    log.warn(`Phone message missing/invalid "type" field from ${senderIp} — dropped.`);
    return;
  }

  if (typeof payload.timestamp !== "number") {
    log.warn(`Phone message missing numeric "timestamp" from ${senderIp} — dropped.`);
    return;
  }

  // ── Handle phone-side ping (keep-alive from Android) ─────────────────────

  if (payload.type === "ping") {
    log.debug(`Keep-alive ping from phone ${senderIp}`);
    return;
  }

  // ── Log the incoming notification ─────────────────────────────────────────

  if (payload.type === "notification") {
    // Generate deterministic id if not present
    const uniqueStr = (payload.package ?? "") + (payload.title ?? "") + (payload.message ?? "");
    payload.id = payload.id || `n-${payload.timestamp}-${Math.abs(hashCode(uniqueStr))}`;

    // Add to history cache
    notificationHistory.push(payload);
    if (notificationHistory.length > 50) {
      notificationHistory.shift();
    }

    log.info(
      `📨 NOTIFICATION  ${ANSI.cyan}[${payload.app ?? "?"}]${ANSI.reset}` +
      `  "${payload.title ?? ""}"  "${payload.message ?? ""}"`
    );
  } else if (payload.type === "notification_removed") {
    // Remove matches from history cache
    const key = payload.key;
    const pkg = payload.package;

    if (key) {
      for (let i = notificationHistory.length - 1; i >= 0; i--) {
        if (notificationHistory[i].key === key) {
          notificationHistory.splice(i, 1);
        }
      }
    } else if (pkg) {
      for (let i = notificationHistory.length - 1; i >= 0; i--) {
        if (notificationHistory[i].package === pkg) {
          notificationHistory.splice(i, 1);
        }
      }
    }
    log.info(`🗑  REMOVED  key=${payload.key ?? "?"} package=${payload.package ?? "?"}`);
  }

  // ── Broadcast to all extensions ───────────────────────────────────────────

  broadcastToExtensions(payload);
}

// ─── Extension Message Handler ────────────────────────────────────────────────

/**
 * handleExtensionMessage(payload, senderIp)
 * Forward reply events from Chrome extensions to active phone client(s)
 */
function handleExtensionMessage(payload, senderIp) {
  log.debug(`Message from extension ${senderIp}:`, payload);

  if (payload.type === "reply") {
    log.info(`📤 Forwarding REPLY from extension ${senderIp} to phone: key=${payload.key} message="${payload.message}"`);
    const json = JSON.stringify(payload);
    let sentCount = 0;

    for (const phone of phones) {
      if (phone.readyState === WebSocket.OPEN) {
        phone.send(json, (err) => {
          if (err) log.error("Send reply to phone failed:", err.message);
        });
        sentCount++;
      }
    }
    log.ok(`📤 Forwarded reply to ${sentCount}/${phones.size} phone(s)`);
  }
}

// ─── Broadcast ────────────────────────────────────────────────────────────────

/**
 * broadcastToExtensions(payload)
 * ──────────────────────────────
 * Serialises [payload] to JSON and sends it to every extension in the registry
 * whose socket is in the OPEN state.
 *
 * Skips extensions whose socket has closed or errored since registration.
 *
 * @param {object} payload — object to serialise and send
 * @returns {number} number of extension clients the message was delivered to
 */
function broadcastToExtensions(payload) {
  if (extensions.size === 0) {
    log.warn("No extensions connected — notification will be queued by the Android app.");
    return 0;
  }

  const json = JSON.stringify(payload);
  let deliveredCount = 0;

  for (const ext of extensions) {
    if (ext.readyState === WebSocket.OPEN) {
      ext.send(json, (err) => {
        if (err) log.error("Send to extension failed:", err.message);
      });
      deliveredCount++;
    }
  }

  log.ok(`📤 Forwarded to ${deliveredCount}/${extensions.size} extension(s)`);
  return deliveredCount;
}

/**
 * hashCode(str)
 * Hash a string to a 32-bit signed integer.
 */
function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  return h;
}

// ─── Safe Send Utility ────────────────────────────────────────────────────────

/**
 * safeJsonSend(ws, obj)
 * ──────────────────────
 * Serialises [obj] to JSON and sends it over [ws], only if the socket is open.
 * Swallows the error (logs it) so callers don't need try/catch.
 *
 * @param {WebSocket} ws   — target socket
 * @param {object}    obj  — object to send
 */
function safeJsonSend(ws, obj) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch (err) {
    log.error("safeJsonSend failed:", err.message);
  }
}

// ─── Heartbeat ────────────────────────────────────────────────────────────────

/**
 * Heartbeat interval — runs every CONFIG.HEARTBEAT_INTERVAL milliseconds.
 *
 * Algorithm (standard ws library pattern):
 *   1. For every client in wss.clients:
 *      a. If isAlive is false → the client didn't respond to the LAST ping.
 *         Terminate the socket (triggers 'close' event → Set cleanup).
 *      b. Mark isAlive = false, then send a ping.
 *   2. The client's 'pong' event handler sets isAlive back to true.
 *   3. At the next interval, living clients pass check (a); dead ones are culled.
 *
 * This catches:
 *   - Phone screen turning off (TCP keep-alive may not fire in time)
 *   - Wi-Fi network change on the phone
 *   - Browser tab with extension closed
 *   - Process kill / OOM
 */
const heartbeatInterval = setInterval(() => {
  let terminated = 0;

  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      // Client missed the last ping — assume dead, terminate
      ws.terminate();
      terminated++;
      continue;
    }

    ws.isAlive = false;
    ws.ping(); // triggers ws.on("pong") on the client side if alive
  }

  if (terminated > 0) {
    log.warn(`Heartbeat: terminated ${terminated} dead connection(s)  —  ${stats()}`);
  } else {
    log.debug(`Heartbeat: all ${wss.clients.size} client(s) alive`);
  }
}, CONFIG.HEARTBEAT_INTERVAL);

// Prevent the interval from keeping the process alive after intentional shutdown.
heartbeatInterval.unref();

// ─── Test Command (stdin) ─────────────────────────────────────────────────────

/**
 * Interactive test command.
 *
 * While the server is running in a terminal, type:
 *   test        → sends a fake WhatsApp notification to all connected extensions
 *   test gmail  → sends a fake Gmail notification
 *   stats       → prints current connection counts
 *   help        → prints available commands
 *
 * This is for development only — lets you verify the Chrome extension renders
 * cards correctly without needing a real phone.
 */

/** Test notification templates keyed by short name. */
const TEST_NOTIFICATIONS = {
  whatsapp: {
    type: "notification",
    app: "WhatsApp",
    package: "com.whatsapp",
    title: "Alex Rivera",
    message: "Hey! Are you coming to the meetup tonight? 🎉",
    timestamp: Date.now(),
  },
  telegram: {
    type: "notification",
    app: "Telegram",
    package: "org.telegram.messenger",
    title: "Design Hub",
    message: "🔥 New Figma plugin just dropped — check the pinned message!",
    timestamp: Date.now(),
  },
  gmail: {
    type: "notification",
    app: "Gmail",
    package: "com.google.android.gm",
    title: "GitHub",
    message: "Your pull request #42 'feat: dark mode' was merged into main ✅",
    timestamp: Date.now(),
  },
  instagram: {
    type: "notification",
    app: "Instagram",
    package: "com.instagram.android",
    title: "Jordan Lee",
    message: "Liked your photo: 'Golden hour at the coast 🌅'",
    timestamp: Date.now(),
  },
  discord: {
    type: "notification",
    app: "Discord",
    package: "com.discord",
    title: "dev-general",
    message: "neon: anyone tried the new Bun 1.2 release? insanely fast 🚀",
    timestamp: Date.now(),
  },
};

/** Print available commands to the terminal. */
function printHelp() {
  console.log(`
${ANSI.cyan}Phone Notify Server — Interactive Commands${ANSI.reset}

  ${ANSI.bold}test [app]${ANSI.reset}   Send a fake notification to all extensions.
               app: whatsapp (default), telegram, gmail, instagram, discord

  ${ANSI.bold}stats${ANSI.reset}        Show current connection counts.

  ${ANSI.bold}help${ANSI.reset}         Show this help message.

  ${ANSI.bold}Ctrl+C${ANSI.reset}       Graceful shutdown.
`);
}

// Only attach stdin handler when running interactively (not piped).
if (process.stdin.isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  // Prompt style
  process.stdout.write(`${ANSI.gray}Type "help" for available commands.\n${ANSI.reset}`);

  rl.on("line", (line) => {
    const parts = line.trim().toLowerCase().split(/\s+/);
    const command = parts[0];
    const arg = parts[1] ?? "whatsapp";

    switch (command) {

      case "test": {
        const template = TEST_NOTIFICATIONS[arg] ?? TEST_NOTIFICATIONS.whatsapp;
        // Always refresh the timestamp
        const payload = { ...template, timestamp: Date.now() };

        log.info(`🧪 TEST: sending fake ${payload.app} notification…`);
        const count = broadcastToExtensions(payload);

        if (count === 0) {
          log.warn("No extension clients connected. Open the Chrome extension first.");
        }
        break;
      }

      case "stats":
        console.log(`\n  ${stats()}\n`);
        break;

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

// ─── Start Server ─────────────────────────────────────────────────────────────

httpServer.listen(CONFIG.PORT, () => {
  log.divider();
  console.log(`\n  ${ANSI.bold}${ANSI.green}Phone Notify Relay Server${ANSI.reset}\n`);
  console.log(`  ${ANSI.cyan}WebSocket${ANSI.reset}  ws://0.0.0.0:${CONFIG.PORT}`);
  console.log(`  ${ANSI.cyan}HTTP${ANSI.reset}       http://0.0.0.0:${CONFIG.PORT}  (status page)\n`);
  console.log(`  ${ANSI.gray}Find your LAN IP:  ip addr show | grep "inet 192"${ANSI.reset}`);
  console.log(`  ${ANSI.gray}Android app URL:   ws://<LAN-IP>:${CONFIG.PORT}?type=phone${ANSI.reset}`);
  console.log(`  ${ANSI.gray}Extension URL:     ws://localhost:${CONFIG.PORT}?type=extension${ANSI.reset}\n`);
  log.divider();
  printHelp();
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

/**
 * shutdown(reason)
 * ─────────────────
 * Cleanly closes all WebSocket connections, stops the heartbeat, and shuts down
 * the HTTP server. Called on SIGINT (Ctrl+C) and SIGTERM (systemd / Docker stop).
 *
 * @param {string} reason — description for the log
 */
function shutdown(reason) {
  log.info(`Shutting down: ${reason}`);

  clearInterval(heartbeatInterval);

  // Close all open sockets with a 1001 "going away" close frame
  for (const ws of wss.clients) {
    ws.close(1001, "Server shutting down");
  }

  wss.close(() => {
    httpServer.close(() => {
      log.info("Server closed cleanly. Goodbye.");
      process.exit(0);
    });
  });

  // Force-exit after 5 s if something hangs
  setTimeout(() => {
    log.warn("Forced exit after 5 s timeout.");
    process.exit(1);
  }, 5_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT (Ctrl+C)"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Catch unhandled promise rejections to prevent silent crashes
process.on("unhandledRejection", (reason) => {
  log.error("Unhandled rejection:", reason);
});
