// src/lt-watchers.js
(() => {
  const LT = globalThis.LT;
  if (!LT) {
    console.error("[LeetTracker] LT namespace missing; ensure lt-global.js loads before lt-watchers.js");
    return;
  }

  const { DAY_S } = LT.consts || {};
  const {
    visitLog: getVisitLogKey,
  } = LT.keys || {};

  /**
   * Append a visit event for the given user and problem slug.
   * Keeps only the last 24 hours of entries (in seconds).
   */
  async function recordProblemVisit(username, slug) {
    if (!username || !slug) return;
    const key = typeof getVisitLogKey === "function"
      ? getVisitLogKey(username)
      : `leettracker_problem_visit_log_${username}`;

    const nowSec = LT.util && typeof LT.util.nowSec === "function"
      ? LT.util.nowSec()
      : Math.floor(Date.now() / 1000);

    const log = (await LT.store.get(key, [])) || [];
    log.push({ slug, ts: nowSec });

    const trimmed = log.filter((e) => nowSec - e.ts <= DAY_S);
    await LT.store.set(key, trimmed);
  }

  /**
   * Wire LC "Submit" button to schedule a background sync shortly after submission.
   * Uses a data attribute to avoid double-binding.
   */
  function hookSubmitButton(username) {
    const selector = '[data-e2e-locator="console-submit-button"]';
    const button = document.querySelector(selector);
    if (!button) return;

    if (button.dataset.leettrackerHooked === "true") return;

    button.addEventListener("click", () => {
      console.log("[LeetTracker] Submit clicked — scheduling sync...");
      // Give LC a moment to process the submission and update their data
      setTimeout(() => {
        try {
          if (LT.ingest && typeof LT.ingest.syncSubmissions === "function") {
            LT.ingest.syncSubmissions(username);
          }
        } catch (e) {
          console.warn("[LeetTracker] syncSubmissions failed after submit:", e);
        }
      }, 5000);
    });

    button.dataset.leettrackerHooked = "true";
  }

  // Internal interval guards so we don't start duplicate timers
  let codeSnapshotInterval = null;
  let navWatcherInterval = null;

  /**
   * Poll current editor code once per second and take a snapshot if the diff threshold is met.
   * The snapshot logic itself is idempotent and cheap when nothing changed.
   */
  function startCodeSnapshotWatcher(username) {
    if (codeSnapshotInterval) return; // already running

    codeSnapshotInterval = setInterval(async () => {
      try {
        if (!window.location.pathname.startsWith("/problems/")) return;

        const slug =
          (LT.lcdb && typeof LT.lcdb.getCurrentProblemSlug === "function"
            ? LT.lcdb.getCurrentProblemSlug()
            : (window.location.pathname.match(/^\/problems\/([^\/]+)\/?/) || [])[1]
          ) || null;

        if (!slug || !LT.snap) return;

        // Acquire latest code (prefers LeetCode IndexedDB; falls back to textareas)
        const codeResult = await LT.snap.getCurrentCode();
        if (!codeResult || !codeResult.bestGuess) return;

        // This will internally check thresholds and store efficiently
        await LT.snap.takeCodeSnapshot(username, slug);
      } catch (e) {
        // Keep watcher resilient
      }
    }, 1000);
  }

  /**
   * Watch for problem slug changes and record recent visits for solve-window derivation.
   */
  function startProblemNavigationWatcher(username) {
    if (navWatcherInterval) return; // already running

    let lastSlug = null;
    navWatcherInterval = setInterval(() => {
      try {
        const m = window.location.pathname.match(/^\/problems\/([^\/]+)\/?/);
        if (!m) return;

        const slug = m[1];
        if (slug && slug !== lastSlug) {
          lastSlug = slug;
          recordProblemVisit(username, slug);
        }
      } catch (e) {
        // Keep watcher resilient
      }
    }, 1000);
  }

  /**
   * Inject a script into the page context (not the content-script context) to observe
   * LC "Run Code" network responses and postMessage back to the content script.
   */
  function injectRunCodeWatcher() {
    try {
      if (window.top !== window) {
        // Many LeetCode subframes are sandboxed; only inject at top
        console.debug("[LeetTracker] injectRunCodeWatcher: not top frame, skipping");
        return;
      }

      const url =
        chrome && chrome.runtime && chrome.runtime.getURL
          ? chrome.runtime.getURL("page-inject.js")
          : null;

      if (!url || url.includes("chrome-extension://invalid")) {
        console.warn("[LeetTracker] injectRunCodeWatcher: computed invalid URL:", url);
        return;
      }

      const s = document.createElement("script");
      s.src = url;
      s.async = false; // deterministic eval order
      s.type = "text/javascript";
      s.onload = () => s.remove();
      (document.head || document.documentElement).appendChild(s);

      console.log("[LeetTracker] page-inject.js injected:", url);
    } catch (e) {
      console.error("[LeetTracker] injectRunCodeWatcher failed:", e);
    }
  }

  /**
   * Bridge page-context messages (posted by page-inject.js) back into the extension,
   * and persist "Run Code" events into IndexedDB for later grouping with submissions.
   */
  function startRunCodeMessageBridge(username) {
    window.addEventListener("message", async (event) => {
      if (event.source !== window) return;
      const d = event.data;
      if (!d || d.source !== "leettracker") return;

      if (d.type === "lt-run-result") {
        try {
          const { interpret_id, data, meta } = d.payload || {};
          const problemSlug =
            (LT.lcdb && typeof LT.lcdb.getCurrentProblemSlug === "function"
              ? LT.lcdb.getCurrentProblemSlug()
              : (window.location.pathname.match(/^\/problems\/([^\/]+)\/?/) || [])[1]
            ) || "unknown";

          // Prefer exact code captured at run time; else fall back to current editor code
          let code = meta?.typed_code;
          if (!code && LT.snap && typeof LT.snap.getCurrentCode === "function") {
            try {
              const cr = await LT.snap.getCurrentCode();
              code = cr?.bestGuess || "";
            } catch {
              code = "";
            }
          }

          const runRecord = {
            timestamp: Date.now(),
            startedAt: meta?.startedAt || null,
            interpretId: interpret_id || null,
            code,
            lang: meta?.lang || data?.lang || null,
            questionId: meta?.question_id || null,
            dataInput: meta?.data_input || null,
            state: data?.state || null, // "SUCCESS" / "FAILURE"
            statusMsg: data?.status_msg || "",
            statusCode: data?.status_code ?? null,
            totalCorrect: data?.total_correct ?? data?.totalCorrect ?? null,
            totalTestcases: data?.total_testcases ?? data?.totalTestcases ?? null,
            fullRuntimeError: data?.full_runtime_error || null,
            runtimeError: data?.runtime_error || null,
            lastTestcase: data?.last_testcase || null,
            runtime: data?.status_runtime || data?.display_runtime || null,
            memory: data?.status_memory || data?.memory || null,
            codeAnswer: data?.code_answer ?? null,
            expectedCodeAnswer: data?.expected_code_answer ?? null,
            compareResult: data?.compare_result ?? null,
          };

          if (LT.dbInstance && typeof LT.dbInstance.storeRunEvent === "function") {
            await LT.dbInstance.storeRunEvent(username, problemSlug, runRecord);
            console.log(
              `[LeetTracker][RunWatcher] Stored run via network intercept for ${problemSlug}: ` +
                `${runRecord.totalCorrect ?? "?"}/${runRecord.totalTestcases ?? "?"} correct, ${runRecord.statusMsg}`
            );
          }
        } catch (e) {
          console.warn("[LeetTracker] Failed to handle lt-run-result:", e);
        }
      }
    });
  }

  // Expose public API
  LT.watch = {
    recordProblemVisit,
    hookSubmitButton,
    startCodeSnapshotWatcher,
    startProblemNavigationWatcher,
    injectRunCodeWatcher,
    startRunCodeMessageBridge,
  };
})();