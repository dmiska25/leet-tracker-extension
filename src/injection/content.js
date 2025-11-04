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

// Initialize IndexedDB singleton on load
getDBInstance();

function trySyncIfLoggedIn() {
  const SELECTOR = '[data-e2e-locator="console-submit-button"]';

  // We'll try to get user info first. Eventually we'll just stop.
  // When a user logs in, currently, leetcode resets the page and
  // we reload this entire script anyway so we don't need to retry
  // forever.
  getUserInfoWithCache().then(({ userId, username }) => {
    if (username && userId) {
      console.log(`[LeetTracker] Detected login as ${username}, starting.`);
      syncSubmissions(username);
      setInterval(() => {
        syncSubmissions(username);
      }, 1 * 60 * 1000);
      setInterval(() => {
        if (!window.location.pathname.startsWith("/problems/")) return;

        const btn = document.querySelector(SELECTOR);
        if (btn && btn.dataset.leettrackerHooked !== "true") {
          hookSubmitButton(username);
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
    }
    return false;
  });
}

if (window.location.hostname === "leetcode.com") {
  trySyncIfLoggedIn();
}
