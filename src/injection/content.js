import { getUserInfoWithCache } from "../leetcode/api.js";
import { startFreshStartWatcher } from "../tracking/snapshots.js";
import { syncSubmissions } from "../leetcode/sync.js";
import {
  hookSubmitButton,
  startCodeSnapshotWatcher,
  startProblemNavigationWatcher,
  injectRunCodeWatcher,
  startRunCodeMessageBridge,
} from "../tracking/watchers.js";
import { getDBInstance } from "../core/db-instance.js";
import { initAnalytics, getAnalytics } from "../core/analytics.js";
import { getExtensionVersion } from "../core/utils.js";

// Initialize IndexedDB singleton on load
getDBInstance();

// Initialize analytics on load (async but don't block)
initAnalytics().catch((error) => {
  console.error("[LeetTracker] Failed to initialize analytics:", error);
});

function showToastAfterSync(result, username) {
  // Don't show toast if sync failed or didn't add new solves
  if (!result || !result.success || result.newSolves === 0) {
    return;
  }

  // Don't show toast for backfill
  if (result.isBackfill) {
    return;
  }

  const solves = result.solves || [];
  const solvesCount = result.newSolves;

  // LeetTracker URL (global for now until routing is set up)
  const leetTrackerUrl = "https://leet-tracker-log.vercel.app/";

  // Show the toast
  if (
    window.leetTrackerToast &&
    typeof window.leetTrackerToast.showSyncToast === "function"
  ) {
    try {
      window.leetTrackerToast.showSyncToast({
        isBackfill: false,
        solvesCount,
        solveSlug: solvesCount === 1 ? solves[0]?.slug : undefined,
        solveDuration: solvesCount === 1 ? solves[0]?.duration : undefined,
        leetTrackerUrl,
        durationMs: 5000,
      });
    } catch (e) {
      console.warn("[LeetTracker] Failed to show sync toast:", e);
      const analytics = getAnalytics();
      analytics.captureError("toast_display_error", e, {
        username,
        solves_count: solvesCount,
      });
    }
  }
}

function trySyncIfLoggedIn() {
  const SELECTOR = '[data-e2e-locator="console-submit-button"]';

  // We'll try to get user info first. Eventually we'll just stop.
  // When a user logs in, currently, leetcode resets the page and
  // we reload this entire script anyway so we don't need to retry
  // forever.
  getUserInfoWithCache().then(async ({ userId, username }) => {
    const analytics = getAnalytics();

    if (username && userId) {
      console.log(`[LeetTracker] Detected login as ${username}, starting.`);

      // Identify user with PostHog (safe to call multiple times)
      await analytics.identify(username, {
        leetcode_user_id: userId,
        extension_version: getExtensionVersion(),
      });

      // Capture extension session started
      analytics.capture("extension_session_started", {
        page: window.location.pathname,
        referrer: document.referrer,
      });

      // Initial sync with toast
      syncSubmissions(username).then((result) => {
        showToastAfterSync(result, username);
      });

      // Periodic sync with toast
      setInterval(() => {
        syncSubmissions(username).then((result) => {
          showToastAfterSync(result, username);
        });
      }, 1 * 60 * 1000);
      setInterval(() => {
        if (!window.location.pathname.startsWith("/problems/")) return;

        const btn = document.querySelector(SELECTOR);
        if (btn && btn.dataset.leettrackerHooked !== "true") {
          hookSubmitButton(username, showToastAfterSync);
        }
      }, 5000); // 5 s poll

      startProblemNavigationWatcher(username);
      startCodeSnapshotWatcher(username);
      startFreshStartWatcher(username);
      injectRunCodeWatcher();
      startRunCodeMessageBridge(username);

      return true;
    } else {
      console.log("[LeetTracker] Not logged in, exiting.");

      // Track anonymous session
      analytics.capture("extension_session_started_anonymous", {
        page: window.location.pathname,
      });
    }
    return false;
  });
}

if (window.location.hostname === "leetcode.com") {
  trySyncIfLoggedIn();
}
