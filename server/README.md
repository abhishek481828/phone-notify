# Phone Notify — WebSocket Relay Server

A lightweight WebSocket relay that bridges Android notifications to Chrome extensions on your local network.

```
Android Phone  ──ws://──►  This server  ──ws://──►  Chrome Extension
```

---

## Requirements

- **Node.js** ≥ 18
- **npm** ≥ 9
- Both your phone and laptop must be on the **same Wi-Fi network**

---

## Installation

### Standard (Ubuntu / Debian / Arch / any distro with Node installed)

```bash
cd server/
npm install
```

### NixOS

**Option A — nix-shell (no permanent install)**

```bash
nix-shell -p nodejs_20 --run "npm install"
```

Or create a `shell.nix` in the server directory:

```nix
{ pkgs ? import <nixpkgs> {} }:
pkgs.mkShell {
  buildInputs = [ pkgs.nodejs_20 ];
}
```

Then:

```bash
nix-shell
npm install
```

**Option B — nix develop (flake)**

Add to your flake inputs or run:

```bash
nix run nixpkgs#nodejs_20 -- npm install
```

---

## Running the Server

```bash
npm start
```

Expected output:

```
────────────────────────────────────────────────────────────────────────
  Phone Notify Relay Server

  WebSocket  ws://0.0.0.0:8080
  HTTP       http://0.0.0.0:8080  (status page)

  Find your LAN IP:  ip addr show | grep "inet 192"
  Android app URL:   ws://<LAN-IP>:8080?type=phone
  Extension URL:     ws://localhost:8080?type=extension
────────────────────────────────────────────────────────────────────────
```

### Debug mode (verbose payload logging)

```bash
npm run start:debug
# or
DEBUG=true node server.js
```

### Custom port

```bash
PORT=9090 npm start
```

---

## Client Connection URLs

| Client | URL |
|--------|-----|
| Android App | `ws://192.168.x.x:8080?type=phone` |
| Chrome Extension | `ws://localhost:8080?type=extension` |

> **Important:** Replace `192.168.x.x` with your laptop's actual LAN IP.
> Find it with: `ip addr show | grep "inet 192"`

---

## Testing Without a Phone

### Interactive (while server is running)

Type commands directly in the server terminal:

```
test              → send a fake WhatsApp notification
test telegram     → send a fake Telegram notification
test gmail        → send a fake Gmail notification
test instagram    → send a fake Instagram notification
test discord      → send a fake Discord notification
stats             → show connection counts
help              → show all commands
```

### CLI (separate terminal, requires server running)

```bash
# Send WhatsApp notification (default)
npm run test:notify

# Send specific app notifications
npm run test:whatsapp
npm run test:telegram
npm run test:gmail
npm run test:instagram
npm run test:discord

# Or directly:
node test-client.js discord
```

---

## Message Protocol

### Phone → Server → Extension (`notification`)

```json
{
  "type":      "notification",
  "app":       "WhatsApp",
  "package":   "com.whatsapp",
  "title":     "John Doe",
  "message":   "Hey! Are you free?",
  "timestamp": 1718900000000
}
```

### Phone → Server → Extension (`notification_removed`)

```json
{
  "type":      "notification_removed",
  "package":   "com.whatsapp",
  "timestamp": 1718900005000
}
```

### Server → Extension (on first connect)

```json
{
  "type":      "server_hello",
  "message":   "Phone Notify relay connected. Waiting for notifications…",
  "timestamp": 1718900000000
}
```

### Server → Client (on error)

```json
{
  "type":    "error",
  "message": "Invalid JSON"
}
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│              Phone Notify Relay (server.js)             │
│                                                         │
│  phones     = Set<WebSocket>  ← Android app(s)          │
│  extensions = Set<WebSocket>  ← Chrome extension(s)     │
│                                                         │
│  Flow:                                                  │
│    phone.send(json)                                     │
│      → handlePhoneMessage(payload)                      │
│        → validate type + timestamp                      │
│          → broadcastToExtensions(payload)               │
│            → for each ext in extensions                 │
│                 ext.send(json)                          │
│                                                         │
│  Heartbeat (every 30s):                                 │
│    for each ws in wss.clients:                          │
│      if !ws.isAlive → ws.terminate()                    │
│      else           → ws.ping()                         │
└─────────────────────────────────────────────────────────┘
```

---

## Running as a Background Service (systemd)

Create `/etc/systemd/system/phone-notify.service`:

```ini
[Unit]
Description=Phone Notify WebSocket Relay
After=network.target

[Service]
Type=simple
User=<your-username>
WorkingDirectory=/path/to/PhoneNotify/server
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
Environment=PORT=8080

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable phone-notify
sudo systemctl start phone-notify
sudo systemctl status phone-notify
```

---

## Running as a Background Service (NixOS)

Add to your `/etc/nixos/configuration.nix`:

```nix
systemd.services.phone-notify = {
  description = "Phone Notify WebSocket Relay";
  after       = [ "network.target" ];
  wantedBy    = [ "multi-user.target" ];

  serviceConfig = {
    ExecStart   = "${pkgs.nodejs_20}/bin/node /path/to/PhoneNotify/server/server.js";
    WorkingDirectory = "/path/to/PhoneNotify/server";
    Restart     = "on-failure";
    RestartSec  = "5s";
    User        = "<your-username>";
    Environment = "PORT=8080";
  };
};
```

```bash
sudo nixos-rebuild switch
```

---

## Connecting the Chrome Extension

In `background.js` of the Chrome extension, uncomment and update:

```javascript
function connectWebSocket() {
  const ws = new WebSocket("ws://localhost:8080?type=extension");

  ws.onopen = () => console.log("[Phone Notify] Connected to relay.");

  ws.onmessage = (event) => {
    const notification = JSON.parse(event.data);
    if (notification.type === "notification") {
      chrome.runtime.sendMessage({ type: "NEW_NOTIFICATION", payload: notification });
    }
  };

  ws.onclose = () => setTimeout(connectWebSocket, 3000); // auto-reconnect
}

connectWebSocket();
```

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `EADDRINUSE` | Port 8080 already in use | `PORT=9090 npm start` or kill the process |
| `ECONNREFUSED` on phone | Server not running or wrong IP | Run `npm start`, verify LAN IP |
| Phone connects but no notifications | Notification Access not granted | Android → Settings → Notification Access |
| `test` command shows "No extension clients" | Extension not connected yet | Open Chrome extension first |
| Server exits after Ctrl+C mid-send | Normal graceful shutdown | Expected behavior |
| NixOS: `node: command not found` | Node not in PATH | Use `nix-shell -p nodejs_20` |

---

## Project Structure

```
server/
├── package.json       ← dependencies + npm scripts
├── server.js          ← main relay server (this file)
├── test-client.js     ← CLI test tool (simulates the Android phone)
└── README.md          ← this file
```
