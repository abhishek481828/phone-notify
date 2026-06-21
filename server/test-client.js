/**
 * test-client.js — Phone Notify CLI Test Client
 * ══════════════════════════════════════════════
 *
 * PURPOSE:
 *   Connects to the relay server as a "phone" client and sends a single fake
 *   notification. Useful for automated testing and CI without a real Android device.
 *
 * USAGE:
 *   node test-client.js [app] [port]
 *
 *   app  — whatsapp (default), telegram, gmail, instagram, discord
 *   port — server port (default: 8080)
 *
 * Or via npm:
 *   npm run test:notify           → send a WhatsApp notification
 *   npm run test:notify telegram  → send a Telegram notification
 *
 * EXIT CODES:
 *   0 — notification sent successfully
 *   1 — connection failed or server rejected the payload
 */

"use strict";

const { WebSocket } = require("ws");

// ─── CLI Arguments ─────────────────────────────────────────────────────────────

const appArg  = process.argv[2] ?? "whatsapp";
const portArg = parseInt(process.argv[3] ?? "8080", 10);
const HOST    = process.env.WS_HOST ?? "localhost";
const URL     = `ws://${HOST}:${portArg}?type=phone`;

// ─── Test Payloads ─────────────────────────────────────────────────────────────

const PAYLOADS = {
  whatsapp: {
    type:      "notification",
    app:       "WhatsApp",
    package:   "com.whatsapp",
    title:     "Alex Rivera",
    message:   "Hey! Sending a test from the CLI tool 🧪",
    timestamp: Date.now(),
  },
  telegram: {
    type:      "notification",
    app:       "Telegram",
    package:   "org.telegram.messenger",
    title:     "Phone Notify Bot",
    message:   "Test notification from test-client.js 🤖",
    timestamp: Date.now(),
  },
  gmail: {
    type:      "notification",
    app:       "Gmail",
    package:   "com.google.android.gm",
    title:     "test@example.com",
    message:   "This is a test email notification from test-client.js",
    timestamp: Date.now(),
  },
  instagram: {
    type:      "notification",
    app:       "Instagram",
    package:   "com.instagram.android",
    title:     "phone_notify_test",
    message:   "Test like from test-client.js ❤️",
    timestamp: Date.now(),
  },
  discord: {
    type:      "notification",
    app:       "Discord",
    package:   "com.discord",
    title:     "#test-channel",
    message:   "test-client.js: notification relay is working! 🎉",
    timestamp: Date.now(),
  },
};

const payload = PAYLOADS[appArg] ?? PAYLOADS.whatsapp;

// ─── Connection ─────────────────────────────────────────────────────────────────

console.log(`\n📱 Phone Notify Test Client`);
console.log(`   Connecting to: ${URL}`);
console.log(`   App:           ${payload.app}`);
console.log(`   Title:         ${payload.title}`);
console.log(`   Message:       ${payload.message}\n`);

const ws = new WebSocket(URL);

// Set a connection timeout — don't hang forever if the server is down.
const connectionTimeout = setTimeout(() => {
  console.error("✗ Connection timed out after 5 s. Is the server running?");
  ws.terminate();
  process.exit(1);
}, 5_000);

ws.on("open", () => {
  clearTimeout(connectionTimeout);
  console.log("✓ Connected to relay server.");

  // Send the test notification
  ws.send(JSON.stringify(payload), (err) => {
    if (err) {
      console.error("✗ Failed to send:", err.message);
      ws.terminate();
      process.exit(1);
    }

    console.log("✓ Notification sent successfully.");
    console.log("  Closing connection…");

    // Give the server a moment to process before closing.
    setTimeout(() => ws.close(1000, "Test complete"), 200);
  });
});

ws.on("message", (data) => {
  // Log any server response (e.g. server_hello, error frames)
  try {
    const msg = JSON.parse(data.toString());
    console.log("← Server:", JSON.stringify(msg, null, 2));
  } catch {
    console.log("← Server (raw):", data.toString());
  }
});

ws.on("close", (code) => {
  console.log(`\n✓ Connection closed (code ${code}). Done.\n`);
  process.exit(0);
});

ws.on("error", (err) => {
  clearTimeout(connectionTimeout);
  console.error(`\n✗ WebSocket error: ${err.message}`);
  console.error("  Make sure the server is running: npm start\n");
  process.exit(1);
});
