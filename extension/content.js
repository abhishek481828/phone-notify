/**
 * content.js
 * ─────────────────
 * Listens for copy events on the webpage and automatically broadcasts
 * the selected/copied text to the background worker to sync with the phone.
 */
document.addEventListener("copy", () => {
  // Small timeout to allow the browser copy action to complete/finalize
  setTimeout(() => {
    let text = "";
    const activeEl = document.activeElement;
    
    // Check if copy was from an input or textarea
    if (activeEl && (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA")) {
      try {
        const start = activeEl.selectionStart;
        const end = activeEl.selectionEnd;
        if (start !== null && end !== null) {
          text = activeEl.value.substring(start, end);
        }
      } catch (_) {}
    }
    
    // Fallback to normal window text selection
    if (!text || !text.trim()) {
      try {
        text = window.getSelection().toString();
      } catch (_) {}
    }

    if (text && text.trim()) {
      chrome.runtime.sendMessage({
        type: "AUTO_COPY_CLIPBOARD",
        text: text.trim()
      }).catch(() => {});
    }
  }, 50);
});
