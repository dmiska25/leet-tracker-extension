// toast.js - standalone toast for Chrome extension (no dependencies).
// Usage: showSyncToast({ solvesCount, solveSlug, durationMs, solveDuration, leetTrackerUrl, isBackfill })
// Returns Promise that resolves after hide.

// Import CSS so Vite bundles it
import "./toast.css";

(function (global) {
  // Avoid re-defining
  if (global.__lt_toast_installed) return;
  global.__lt_toast_installed = true;

  // Create container lazily
  function getContainer(doc = document) {
    let c = doc.querySelector(".lt-toast-container");
    if (c) return c;
    c = doc.createElement("div");
    c.className = "lt-toast-container";
    doc.body.appendChild(c);
    return c;
  }

  function formatDuration(seconds) {
    if (!seconds || seconds <= 0) return "—";

    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}h ${mins}m ${secs}s`;
    } else if (mins > 0) {
      return `${mins}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  }

  function createToastElement(opts) {
    const { solvesCount, solveSlug, solveDuration, leetTrackerUrl } = opts;

    const el = document.createElement("div");
    el.className = "lt-toast";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");

    // Header with logo, message, and close button
    const header = document.createElement("div");
    header.className = "lt-toast-header";

    // Logo
    const logo = document.createElement("img");
    logo.className = "lt-toast-logo";
    logo.src = chrome.runtime.getURL("assets/images/icon48.png");
    logo.alt = "LeetTracker";
    header.appendChild(logo);

    // Message content
    const msg = document.createElement("div");
    msg.className = "lt-toast-message";
    const title = document.createElement("div");
    title.className = "lt-toast-title";

    const sub = document.createElement("div");
    sub.className = "lt-toast-sub";

    if (solvesCount === 1 && solveSlug && solveDuration) {
      title.textContent = `Captured ${solveSlug}`;
      const formatted = formatDuration(solveDuration);
      sub.textContent = `solve time: ${formatted}`;
    } else {
      title.textContent = `Completed sync`;
      sub.textContent = `${solvesCount} solve${
        solvesCount !== 1 ? "s" : ""
      } added`;
    }

    msg.appendChild(title);
    msg.appendChild(sub);
    header.appendChild(msg);

    // Close button in header
    const close = document.createElement("button");
    close.className = "lt-close";
    close.setAttribute("aria-label", "Dismiss notification");
    close.innerHTML = "&#10005;";
    header.appendChild(close);

    // Actions (feedback button)
    const actions = document.createElement("div");
    actions.className = "lt-toast-actions";

    if (leetTrackerUrl) {
      const link = document.createElement("a");
      link.className = "lt-btn";
      link.href = leetTrackerUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "View & get feedback";
      actions.appendChild(link);
    }

    // Timer bar
    const timer = document.createElement("div");
    timer.className = "lt-timer";
    const timerBar = document.createElement("div");
    timerBar.className = "lt-timer-bar";
    timer.appendChild(timerBar);

    el.appendChild(header);
    el.appendChild(actions);
    el.appendChild(timer);

    return { el, close, timerBar };
  }

  // Main API
  async function showSyncToast(options = {}) {
    const {
      isBackfill = false,
      container = document.body,
      durationMs = 10000,
      solvesCount = 0,
    } = options;

    if (isBackfill) return Promise.resolve(); // don't show for backfill
    if (solvesCount === 0) return Promise.resolve(); // don't show if no solves

    const doc = container.ownerDocument || document;
    const c = getContainer(doc);

    const { el, close, timerBar } = createToastElement(options);
    // Insert newest on top (right aligned)
    c.insertBefore(el, c.firstChild);

    // Force a small layout so transitions can run
    requestAnimationFrame(() => {
      el.classList.add("show");
    });

    // Timer animation: use CSS transition by setting width from 0% -> 100%
    timerBar.style.transition = `width ${durationMs}ms linear`;
    // start at 0 then grow to full width next frame
    timerBar.style.width = "0%";
    requestAnimationFrame(() => {
      timerBar.style.width = "100%";
    });

    // Promise-based resolution
    let resolvePromise;
    const hiddenPromise = new Promise((resolve) => {
      resolvePromise = resolve;
    });

    let hideTimer;
    let resolved = false;
    const hide = (reason) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(hideTimer);
      // animate out
      el.classList.remove("show");
      // remove after transition
      setTimeout(() => {
        try {
          el.remove();
        } catch (e) {}
        resolvePromise(reason);
      }, 260);
    };

    // Close button
    close.addEventListener("click", () => hide("closed"));

    // Auto-hide
    hideTimer = setTimeout(() => {
      hide("timeout");
    }, durationMs);

    return hiddenPromise;
  }

  // Expose globally under a namespaced key to avoid collisions
  global.leetTrackerToast = {
    showSyncToast,
  };
})(window);
