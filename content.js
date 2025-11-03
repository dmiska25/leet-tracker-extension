(function () {
  if (
    !globalThis.LT ||
    !LT.consts ||
    !LT.keys ||
    !LT.store ||
    !LT.lcdb ||
    !LT.locks ||
    !LT.net ||
    !LT.snap ||
    !LT.ingest ||
    !LT.watch
  ) {
    console.error(
      "[LeetTracker] Required LT globals missing (LT.consts/keys/store/lcdb/locks/net/snap/ingest/watch). Aborting content script init."
    );
    return;
  }
  const { getUserInfoWithCache } = LT.net;
  const { startFreshStartWatcher } = LT.snap;
  const { syncSubmissions } = LT.ingest;
  const {
    hookSubmitButton,
    startCodeSnapshotWatcher,
    startProblemNavigationWatcher,
    injectRunCodeWatcher,
    startRunCodeMessageBridge,
  } = LT.watch;

  // Initialize IndexedDB via LT.db (defined in src/lt-db.js)
  if (!globalThis.LT || !LT.db || typeof LT.db.create !== "function") {
    console.error("[LeetTracker] LT.db.create is missing; aborting");
    return;
  }
  const leetTrackerDB = LT.db.create();
  LT.dbInstance = leetTrackerDB; // Expose for other modules (e.g., lt-snapshots.js, lt-ingest.js)

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
})();
