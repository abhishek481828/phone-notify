# 📱 Phone Notify

A beautiful, premium, real-time notification mirroring dashboard that clones your Android notifications to your laptop's Chrome browser and system desktop.

This project is built using **Kotlin** (for the Android app), **Node.js** (for the WebSocket relay server), and **JavaScript** (for the Chrome extension sidepanel and background daemon).

---

## ✨ Features

- ⚡ **Real-Time Mirroring**: Instantaneous notification synchronization via a persistent, bi-directional WebSocket pipeline.
- 📧 **Gmail Content Extraction**: Captures the full body of emails, including multi-line emails and inbox line-lists (no truncated snippets).
- 💬 **Quick Replies**: Reply to messages (WhatsApp, Telegram, Slack, etc.) directly from your Chrome extension sidepanel without touching your phone.
- 🔕 **Smart Filtering**: Filters out system notifications, group summary cards, and background services (like KDE Connect) to prevent notification clutter.
- 🌐 **Global Access via Tailscale**: Works automatically across different networks (college Wi-Fi, home Wi-Fi, mobile data) using Tailscale's secure static IP routing.
- 🔔 **Native OS Desktop Popups (Linux/NixOS)**: Integrates directly with your system notification daemon (e.g. Dunst, Mako, GNOME/KDE notification hubs).
- 🔗 **Click-to-Open App Redirects**: Clicking a notification card automatically opens the corresponding web service (Gmail, WhatsApp Web, etc.) in a new Chrome tab.
- ⚙️ **Automatic Server Execution**: Set up as a background service worker on your laptop (via systemd in NixOS or PM2 on Windows/macOS) so it starts automatically on boot.

---

## 📁 Repository Structure

```text
├── app/             # Android Kotlin Application source code
├── server/          # Node.js WebSocket relay server
├── extension/       # Chrome Extension UI (HTML/CSS/JS sidepanel)
├── app-debug.apk    # Pre-built standalone Android app installer
└── .gitignore       # Excludes temporary build artifacts
```

---

## 🚀 Getting Started

### 1. Set up the Relay Server
Navigate to the `server/` directory, install dependencies, and run:
```bash
cd server
npm install
node server.js
```
*(Alternatively, configure it to run on boot via systemd on Linux/NixOS or PM2 on Windows).*

### 2. Load the Chrome Extension
1. Open Google Chrome and go to `chrome://extensions`.
2. Enable **Developer mode** in the top-right.
3. Click **Load unpacked** in the top-left and select the `extension` folder.
4. Click the extension icon to open the side panel, click the **Settings Gear** icon, and enter your server URL (e.g. `ws://localhost:8080?type=extension` or your Tailscale IP `ws://100.91.159.98:8080?type=extension`).

### 3. Install the Android App
- **Using the Pre-built APK**: Copy the `app-debug.apk` file from the root of this repository to your phone and install it directly.
- **Using Source Code**: Open the `app/` folder in Android Studio, connect your phone via USB, and click **Run**.
- **Configure & Connect**: Open the app on your phone, ensure **Notification Access** is granted, input your laptop's Local/Tailscale IP, and tap **Connect**.

---

## 🤝 Contributing
Feel free to open issues or submit pull requests to improve content extraction filters, add more URL app mappings, or improve UI themes!
