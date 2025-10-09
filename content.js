(function () {
  const GRAPHQL_URL = "https://leetcode.com/graphql/";
  const HEARTBEAT_KEY = "leettracker_sync_heartbeat";
  const HEARTBEAT_INTERVAL_MS = 5000;
  const HEARTBEAT_TIMEOUT_MS = 10000;
  const DAY_S = 86400;

  const getVisitLogKey = (u) => `leettracker_problem_visit_log_${u}`;
  const getManifestKey = (username) => `leettracker_sync_manifest_${username}`;
  const getSeenProblemsKey = (username) =>
    `leettracker_seen_problems_${username}`;
  const getChunkKey = (username, index) =>
    `leettracker_leetcode_chunk_${username}_${index}`;
  const getSnapshotsKey = (username, problemSlug) =>
    `leettracker_snapshots_${username}_${problemSlug}`;
  const getTemplatesKey = (problemSlug) =>
    `leettracker_templates_${problemSlug}`;
  const getRecentJourneysKey = (username) =>
    `leettracker_recent_journeys_${username}`;
  const getRecentRunsKey = (username) => `leettracker_recent_runs_${username}`;

  // Lock mechanism to prevent concurrent snapshot/reset operations
  const snapshotLocks = new Map(); // Map of `${username}_${problemSlug}` -> Promise

  async function withSnapshotLock(username, problemSlug, operation) {
    const lockKey = `${username}_${problemSlug}`;

    // Skip if already locked - perfect for scheduled operations
    if (snapshotLocks.has(lockKey)) {
      return null; // Indicate the operation was skipped
    }

    // Install a sentinel immediately so concurrent callers skip
    let release;
    const sentinel = new Promise((resolve) => (release = resolve));
    snapshotLocks.set(lockKey, sentinel);

    try {
      return await operation();
    } finally {
      release();
      snapshotLocks.delete(lockKey);
    }
  }

  // IndexedDB wrapper for larger data storage
  class LeetTrackerDB {
    constructor() {
      this.db = null;
      this.initPromise = this.init();
    }

    async init() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open("LeetTrackerDB", 1);

        request.onerror = () => {
          console.error("[LeetTracker] IndexedDB init failed:", request.error);
          reject(request.error);
        };

        request.onblocked = () => {
          console.error(
            "[LeetTracker] IndexedDB upgrade blocked by another tab/window. Please close other LeetCode tabs and refresh."
          );
          reject(
            new Error(
              "IndexedDB upgrade blocked - close other LeetCode tabs and refresh"
            )
          );
        };

        request.onsuccess = () => {
          this.db = request.result;

          // Handle version change events (when another tab tries to upgrade)
          this.db.onversionchange = () => {
            console.warn(
              "[LeetTracker] IndexedDB version change detected. Closing database connection to allow upgrade."
            );
            this.db.close();
            this.db = null;

            // Optionally dispatch event to notify the page
            window.dispatchEvent(
              new CustomEvent("leettracker-db-versionchange", {
                detail: {
                  message: "Database version changed, connection closed",
                },
              })
            );
          };

          console.log("[LeetTracker] IndexedDB initialized successfully");
          resolve();
        };

        request.onupgradeneeded = (event) => {
          const db = event.target.result;

          // Templates store
          if (!db.objectStoreNames.contains("templates")) {
            const templateStore = db.createObjectStore("templates", {
              keyPath: "problemSlug",
            });
            templateStore.createIndex("timestamp", "timestamp");
          }

          // Active snapshots store
          if (!db.objectStoreNames.contains("snapshots")) {
            const snapshotStore = db.createObjectStore("snapshots", {
              keyPath: "id",
            });
            snapshotStore.createIndex("username", "username");
            snapshotStore.createIndex("problemSlug", "problemSlug");
          }

          // Journey archive store - permanent backup of all coding journeys
          if (!db.objectStoreNames.contains("journeys")) {
            const journeyStore = db.createObjectStore("journeys", {
              keyPath: "id",
            });
            journeyStore.createIndex("username", "username");
            journeyStore.createIndex("titleSlug", "titleSlug");
            journeyStore.createIndex("timestamp", "timestamp");
            journeyStore.createIndex("archivedAt", "archivedAt");
          }

          // Run events store
          if (!db.objectStoreNames.contains("runs")) {
            const runStore = db.createObjectStore("runs", {
              keyPath: "id",
            });
            runStore.createIndex("username", "username");
            runStore.createIndex("problemSlug", "problemSlug");
            runStore.createIndex("timestamp", "timestamp");
          }

          // Run groups archive store - permanent backup of grouped runs by submission
          if (!db.objectStoreNames.contains("runGroups")) {
            const groupStore = db.createObjectStore("runGroups", {
              keyPath: "id",
            });
            groupStore.createIndex("username", "username");
            groupStore.createIndex("titleSlug", "titleSlug");
            groupStore.createIndex("timestamp", "timestamp");
            groupStore.createIndex("archivedAt", "archivedAt");
          }
        };
      });
    }

    // Helper method to ensure database is available (reinitialize if closed)
    async ensureDB() {
      await this.initPromise;

      // If the database was closed due to version change, reinitialize
      if (!this.db) {
        console.log("[LeetTracker] Database was closed, reinitializing...");
        this.initPromise = this.init();
        await this.initPromise;
      }

      return this.db;
    }

    async storeTemplates(problemSlug, templates) {
      const db = await this.ensureDB();

      return new Promise((resolve, reject) => {
        const transaction = db.transaction(["templates"], "readwrite");
        const store = transaction.objectStore("templates");

        const data = {
          problemSlug,
          templates,
          timestamp: Date.now(),
        };

        const request = store.put(data);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    }

    async getTemplates(problemSlug) {
      const db = await this.ensureDB();

      return new Promise((resolve, reject) => {
        const transaction = db.transaction(["templates"], "readonly");
        const store = transaction.objectStore("templates");

        const request = store.get(problemSlug);
        request.onsuccess = () => {
          const result = request.result;
          if (result && Date.now() - result.timestamp < 86400000) {
            // 24 hours
            resolve(result.templates);
          } else {
            resolve(null); // Expired or not found
          }
        };
        request.onerror = () => reject(request.error);
      });
    }

    // --- Run Code Event Management ---
    async storeRunEvent(username, problemSlug, runData) {
      const db = await this.ensureDB();
      const id = `${username}_${problemSlug}_${
        runData.timestamp || Date.now()
      }`;
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(["runs"], "readwrite");
        const store = transaction.objectStore("runs");
        const data = {
          id,
          username,
          problemSlug,
          ...runData,
        };
        const request = store.put(data);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    }

    async getRunEventsInWindow(username, problemSlug, startMs, endMs) {
      const db = await this.ensureDB();

      return new Promise((resolve, reject) => {
        const tx = db.transaction(["runs"], "readonly");
        const store = tx.objectStore("runs");
        const idx = store.index("timestamp");

        const range =
          startMs != null && endMs != null
            ? IDBKeyRange.bound(startMs, endMs)
            : startMs != null
            ? IDBKeyRange.lowerBound(startMs)
            : endMs != null
            ? IDBKeyRange.upperBound(endMs)
            : null;

        const runs = [];
        const req = range ? idx.openCursor(range) : idx.openCursor();

        req.onsuccess = (ev) => {
          const cursor = ev.target.result;
          if (cursor) {
            const v = cursor.value;
            if (v.username === username && v.problemSlug === problemSlug) {
              runs.push(v);
            }
            cursor.continue();
          } else {
            runs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
            resolve(runs);
          }
        };
        req.onerror = () => reject(req.error);
      });
    }

    async storeSnapshots(username, problemSlug, snapshotData) {
      const db = await this.ensureDB();

      return new Promise((resolve, reject) => {
        const transaction = db.transaction(["snapshots"], "readwrite");
        const store = transaction.objectStore("snapshots");

        const data = {
          id: `${username}_${problemSlug}`,
          username,
          problemSlug,
          snapshots: snapshotData.snapshots,
          lastFinalCode: snapshotData.lastFinalCode,
          lastUpdated: Date.now(),
        };

        const request = store.put(data);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    }

    async getSnapshots(username, problemSlug) {
      const db = await this.ensureDB();

      return new Promise((resolve, reject) => {
        const transaction = db.transaction(["snapshots"], "readonly");
        const store = transaction.objectStore("snapshots");

        const request = store.get(`${username}_${problemSlug}`);
        request.onsuccess = () => {
          const result = request.result;
          if (result) {
            resolve({
              snapshots: result.snapshots || [],
              lastFinalCode: result.lastFinalCode || null,
            });
          } else {
            resolve({ snapshots: [], lastFinalCode: null });
          }
        };
        request.onerror = () => reject(request.error);
      });
    }

    async storeJourneyArchive(username, submission) {
      const db = await this.ensureDB();

      return new Promise((resolve, reject) => {
        const transaction = db.transaction(["journeys"], "readwrite");
        const store = transaction.objectStore("journeys");

        const data = {
          id: `${username}_${submission.id}`,
          username,
          submissionId: submission.id,
          titleSlug: submission.titleSlug,
          timestamp: submission.timestamp,
          codingJourney: submission.codingJourney,
          archivedAt: Date.now(),
        };

        const request = store.put(data);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    }

    async storeRunGroupArchive(username, submission) {
      const db = await this.ensureDB();

      return new Promise((resolve, reject) => {
        const transaction = db.transaction(["runGroups"], "readwrite");
        const store = transaction.objectStore("runGroups");

        const data = {
          id: `${username}_${submission.id}`,
          username,
          submissionId: submission.id,
          titleSlug: submission.titleSlug,
          timestamp: submission.timestamp,
          runEvents: submission.runEvents, // expect detailed grouping if present on submission at archive time
          archivedAt: Date.now(),
        };

        const request = store.put(data);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    }
  }

  // Initialize IndexedDB
  const leetTrackerDB = new LeetTrackerDB();

  // Text normalization utilities for robust diff handling
  function normalizeText(raw) {
    if (!raw) return "\n";

    // Strip common zero-width characters + BOM
    const ZW = /[\u200B-\u200D\uFEFF]/g;
    let s = raw.replace(ZW, "");

    // Normalize line endings to LF
    s = s.replace(/\r\n?/g, "\n");

    // NFC Unicode normalization
    s = s.normalize("NFC");

    // Ensure trailing newline for stable diffs
    if (!s.endsWith("\n")) s += "\n";

    return s;
  }

  function createChecksum(text) {
    // Simple hash function for checksums (you could use crypto.subtle for SHA-256 in the future)
    let hash = 0;
    if (text.length === 0) return hash.toString();
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString();
  }

  function makePatch(beforeRaw, afterRaw) {
    const before = normalizeText(beforeRaw);
    const after = normalizeText(afterRaw);

    if (!window.diff_match_patch) {
      console.error("[LeetTracker] diff_match_patch not available");
      return null;
    }

    const dmp = new window.diff_match_patch();
    // Optional tuning for fewer tiny edits
    dmp.Diff_Timeout = 1; // seconds
    dmp.Patch_DeleteThreshold = 0.5; // be less eager to delete

    const diffs = dmp.diff_main(before, after);
    dmp.diff_cleanupSemantic(diffs); // human-friendlier chunks

    const patches = dmp.patch_make(before, diffs);
    const patchText = dmp.patch_toText(patches);

    return {
      patchText,
      beforeNorm: before,
      afterNorm: after,
      checksumBefore: createChecksum(before),
      checksumAfter: createChecksum(after),
    };
  }

  function applyPatch(baseRaw, patchText, expectedChecksum = null) {
    const base = normalizeText(baseRaw);

    // Verify checksum if provided
    if (expectedChecksum && createChecksum(base) !== expectedChecksum) {
      console.warn(
        "[LeetTracker] Checksum mismatch detected during patch application"
      );
    }

    if (!window.diff_match_patch) {
      console.error("[LeetTracker] diff_match_patch not available");
      return { text: base, applied: false };
    }

    const dmp = new window.diff_match_patch();
    const patches = dmp.patch_fromText(patchText);
    const [result, results] = dmp.patch_apply(patches, base);

    return {
      text: result,
      applied: results.every((r) => r), // true if all patches applied successfully
      partialResults: results,
    };
  }

  // Fresh start detection functions with IndexedDB template caching
  async function cacheTemplatesForProblem(problemSlug) {
    let idbResult = null;

    try {
      // Try IndexedDB first (larger capacity)
      idbResult = await leetTrackerDB.getTemplates(problemSlug);
      if (idbResult) {
        return idbResult;
      }
    } catch (error) {
      console.warn(
        "[LeetTracker] IndexedDB read failed, trying chrome.storage fallback:",
        error
      );
    }

    // Fallback to chrome.storage
    const templatesKey = getTemplatesKey(problemSlug);
    const storageCached = await getFromStorage(templatesKey, null);

    // Return cached if it's fresh (less than 1 day old)
    if (storageCached && Date.now() - storageCached.timestamp < 86400000) {
      return storageCached.templates;
    }

    try {
      const templates = await fetchProblemCodeTemplate(problemSlug);

      if (templates.length > 0) {
        // Try to store in IndexedDB first
        try {
          await leetTrackerDB.storeTemplates(problemSlug, templates);
        } catch (indexError) {
          console.warn(
            "[LeetTracker] IndexedDB store failed, using chrome.storage fallback:",
            indexError
          );
          // Fallback to chrome.storage
          await saveToStorage(templatesKey, {
            templates: templates,
            timestamp: Date.now(),
            problemSlug: problemSlug,
          });
        }
      }

      return templates;
    } catch (error) {
      console.error("❌ [Template Cache] Failed to fetch templates:", error);
      return storageCached?.templates || [];
    }
  }

  async function checkForFreshStart(currentCode, problemSlug) {
    try {
      // Get cached templates (fast!)
      const templates = await cacheTemplatesForProblem(problemSlug);
      if (templates.length === 0) {
        return false;
      }

      // Get current language (fast - localStorage)
      const currentLang = await detectCurrentLanguage(currentCode, problemSlug);

      const template = templates.find((t) => t.langSlug === currentLang);

      if (!template) {
        return false;
      }

      // Fast similarity check with very strict threshold (near 100%)
      const similarity = calculateCodeSimilarity(template.code, currentCode);
      const isSimilarToTemplate = similarity >= 0.98; // 98% threshold

      return isSimilarToTemplate;
    } catch (error) {
      console.error("❌ [Fresh Start] Error during check:", error);
      return false;
    }
  }

  // Fast reset logic - runs independently every 0.5 seconds
  async function handleFreshStartReset(username, problemSlug, currentCode) {
    return await withSnapshotLock(username, problemSlug, async () => {
      // Get snapshots from IndexedDB
      let snapshots = [];
      try {
        const snapshotData = await leetTrackerDB.getSnapshots(
          username,
          problemSlug
        );
        snapshots = snapshotData.snapshots || [];
      } catch (error) {
        return false; // No fallback - just skip reset check if IndexedDB fails
      }

      // Only need at least 1 snapshot to consider reset
      if (snapshots.length < 1) return false;

      // Fast template check with very strict similarity (near 100%)
      const matchesTemplate = await checkForFreshStart(
        currentCode,
        problemSlug
      );

      if (matchesTemplate) {
        // If the template matches but we only have 1 snapshot, we're already done
        if (snapshots.length == 1) return false;

        // add a new navigation so reset the start time too
        recordProblemVisit(username, problemSlug);

        // Clear snapshots from IndexedDB
        try {
          await leetTrackerDB.storeSnapshots(username, problemSlug, {
            snapshots: [],
            lastFinalCode: null,
          });
          return true;
        } catch (error) {
          console.warn(
            "[LeetTracker] Failed to clear snapshots during reset:",
            error
          );
          return false;
        }
      }

      return false;
    });
  }

  // Continuous fresh start checker - runs every 0.5 seconds
  function startFreshStartWatcher(username) {
    setInterval(async () => {
      const match = window.location.pathname.match(/^\/problems\/([^\/]+)\/?/);
      if (!match) return;

      const problemSlug = match[1];
      const codeResult = await getCurrentCode();
      if (!codeResult || !codeResult.bestGuess) return;

      // Check for fresh start reset independently
      await handleFreshStartReset(username, problemSlug, codeResult.bestGuess);
    }, 500); // Check every 0.5 seconds
  }

  // Fresh start detection functions
  async function fetchProblemCodeTemplate(titleSlug) {
    const body = {
      query: `
        query questionEditorData($titleSlug: String!) {
          question(titleSlug: $titleSlug) {
            codeSnippets {
              lang
              langSlug
              code
            }
          }
        }
      `,
      variables: { titleSlug },
    };

    try {
      const res = await fetch(GRAPHQL_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Referer: "https://leetcode.com/problemset/all/",
        },
        body: JSON.stringify(body),
        credentials: "include",
      });

      const json = await res.json();
      return json.data?.question?.codeSnippets || [];
    } catch (error) {
      console.error("[LeetTracker] Failed to fetch problem template:", error);
      return [];
    }
  }

  // Helper: Get selected language for a problem from localStorage
  function getSelectedLanguageForProblem(problemId, userId) {
    if (!problemId || !userId) return null;
    const key = `${problemId}_${userId}_lang`;
    return localStorage.getItem(key);
  }

  async function detectCurrentLanguage(code, problemSlug = null) {
    // 1. Try per-problem language from localStorage
    try {
      const { userId } = await getUserInfoWithCache();
      const problemId = problemSlug
        ? await getProblemIdFromSlug(problemSlug)
        : null;
      if (problemId && userId) {
        const lang = getSelectedLanguageForProblem(problemId, userId);
        if (lang) return lang;
      }
    } catch (e) {
      // continue to fallback
    }

    // 2. Fallback to global_lang from localStorage
    try {
      const savedLang = localStorage.getItem("global_lang");
      if (savedLang) {
        let cleanLang = savedLang;
        if (savedLang.startsWith('"') && savedLang.endsWith('"')) {
          cleanLang = JSON.parse(savedLang);
        }
        const normalizedLang = cleanLang.toLowerCase().trim();
        return normalizedLang;
      }
    } catch (e) {
      // continue to fallback
    }

    // Default fallback
    return "python3";
  }

  function calculateCodeSimilarity(code1, code2) {
    // Normalize both texts for comparison
    const norm1 = normalizeText(code1);
    const norm2 = normalizeText(code2);

    if (norm1.length === 0 && norm2.length === 0) return 1;
    if (norm1.length === 0 || norm2.length === 0) return 0;

    if (!window.diff_match_patch) {
      // Fallback to simple string comparison if diff-match-patch not available
      return norm1 === norm2 ? 1 : 0;
    }

    const dmp = new window.diff_match_patch();
    const diffs = dmp.diff_main(norm1, norm2);

    let totalLength = Math.max(norm1.length, norm2.length);
    let changedLength = 0;

    diffs.forEach(([operation, text]) => {
      if (operation !== 0) {
        // 0 = EQUAL, 1 = INSERT, -1 = DELETE
        changedLength += text.length;
      }
    });

    return Math.max(0, (totalLength - changedLength) / totalLength);
  }

  // Enhanced submission verification for recent submissions
  async function verifyRecentSubmissionStatus(submissionId, maxWaitMs = 15000) {
    const checkUrl = `https://leetcode.com/submissions/detail/${submissionId}/check/`;
    const startTime = Date.now();
    const pollInterval = 1000;

    console.log(
      `[LeetTracker] Verifying submission ${submissionId} processing status...`
    );

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(checkUrl, {
          method: "GET",
          credentials: "include",
          headers: {
            Referer: window.location.href,
          },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          console.warn(
            `[LeetTracker] Check endpoint returned ${response.status} for ${submissionId}, assuming processed`
          );
          return { verified: true, state: "ASSUMED_SUCCESS" };
        }

        const data = await response.json();

        // Still processing
        if (data.state === "STARTED" || data.state === "PENDING") {
          console.log(
            `[LeetTracker] Submission ${submissionId} still processing (${data.state})...`
          );
          await new Promise((resolve) => setTimeout(resolve, pollInterval));
          continue;
        }

        // Completed (success or failure)
        if (data.state === "SUCCESS" || data.state === "FAILURE") {
          console.log(
            `[LeetTracker] Submission ${submissionId} completed with state: ${data.state}`
          );
          return {
            verified: true,
            state: data.state,
            statusMsg: data.status_msg,
            finished: data.finished,
          };
        }

        // Unknown state - assume completed to avoid infinite polling
        console.warn(
          `[LeetTracker] Unknown state for ${submissionId}: ${data.state}, assuming completed`
        );
        return { verified: true, state: "UNKNOWN" };
      } catch (error) {
        console.warn(
          `[LeetTracker] Error checking submission ${submissionId}:`,
          error
        );
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }
    }

    // Timeout - assume it's processed
    console.warn(
      `[LeetTracker] Timeout verifying submission ${submissionId}, assuming processed`
    );
    return { verified: false, state: "TIMEOUT" };
  }

  async function fetchAllSubmissions(lastTimestamp) {
    const submissions = [];
    let offset = 0;
    const limit = 20;
    let hasMore = true;
    let shouldContinue = true;

    while (hasMore && shouldContinue) {
      const body = {
        query: `
        query submissionList($offset: Int!, $limit: Int!) {
          submissionList(offset: $offset, limit: $limit) {
            hasNext
            submissions {
              id
              titleSlug
              statusDisplay
              timestamp
              lang
            }
          }
        }
      `,
        variables: { offset, limit },
      };

      let retryDelay = 5000;
      let attempt = 0;
      let success = false;
      let json = null;

      while (!success && retryDelay < 60000) {
        try {
          const res = await fetch(GRAPHQL_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Referer: "https://leetcode.com/problemset/all/",
            },
            body: JSON.stringify(body),
            credentials: "include",
          });

          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          json = await res.json();
          if (!json?.data?.submissionList?.submissions) {
            throw new Error("Missing submissions data");
          }

          success = true;
        } catch (err) {
          console.warn(
            `[LeetTracker] Failed fetch at offset=${offset}, retrying in ${
              retryDelay / 1000
            }s... (${err.message})`
          );
          await new Promise((r) => setTimeout(r, retryDelay));
          retryDelay = Math.min(retryDelay * 2, 60000);
          attempt++;
        }
      }

      if (!success) {
        throw new Error(
          `[LeetTracker] Submission fetch failed after ${attempt} retries at offset ${offset}`
        );
      }

      const data = json.data.submissionList;

      for (const s of data.submissions) {
        if (s.timestamp <= lastTimestamp) {
          shouldContinue = false;
          break;
        }
        submissions.push(s);
      }

      hasMore = data.hasNext;
      offset += limit;
    }

    const newSubmissions = Array.from(
      new Map(submissions.map((s) => [s.id, s])).values()
    ).sort((a, b) => a.timestamp - b.timestamp);

    // Verify recent submissions (submitted within last 60 seconds) are fully processed
    const now = Math.floor(Date.now() / 1000);
    const recentSubmissions = newSubmissions.filter(
      (s) => now - s.timestamp < 60
    );

    if (recentSubmissions.length > 0) {
      console.log(
        `[LeetTracker] Found ${recentSubmissions.length} recent submissions, verifying processing status...`
      );

      // Only verify the most recent submission
      if (recentSubmissions.length > 0) {
        const mostRecent = recentSubmissions[recentSubmissions.length - 1];
        const verification = await verifyRecentSubmissionStatus(mostRecent.id);
        if (!verification.verified) {
          console.warn(
            `[LeetTracker] Could not verify submission ${mostRecent.id}, but proceeding anyway`
          );
        }
      }
    }

    return newSubmissions;
  }

  async function fetchProblemDescription(titleSlug) {
    const body = {
      query: `
        query getQuestionDetail($titleSlug: String!) {
          question(titleSlug: $titleSlug) {
            questionId
            content
          }
        }
      `,
      variables: { titleSlug },
    };

    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Referer: "https://leetcode.com/problemset/all/",
      },
      body: JSON.stringify(body),
      credentials: "include",
    });

    const json = await res.json();
    return json.data?.question || null;
  }

  async function fetchProblemNote(titleSlug) {
    const body = {
      query: `
        query questionNote($titleSlug: String!) {
          question(titleSlug: $titleSlug) {
            questionId
            note
          }
        }
      `,
      variables: { titleSlug },
      operationName: "questionNote",
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000); // 8s timeout
    let res;
    try {
      res = await fetch(GRAPHQL_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Referer: "https://leetcode.com/problemset/all/",
        },
        body: JSON.stringify(body),
        credentials: "include",
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      if (error.name === "AbortError") {
        console.warn("[LeetTracker] fetchProblemNote timed out");
      } else {
        console.warn("[LeetTracker] fetchProblemNote error:", error);
      }
      return null;
    }
    clearTimeout(timeout);
    if (!res.ok) {
      console.warn(`[LeetTracker] fetchProblemNote HTTP error: ${res.status}`);
      return null;
    }
    let json;
    try {
      json = await res.json();
    } catch (error) {
      console.warn("[LeetTracker] fetchProblemNote invalid JSON:", error);
      return null;
    }
    return json.data?.question?.note || null;
  }

  async function fetchSubmissionDetails(submissionId) {
    const csrfToken = document.cookie
      .split("; ")
      .find((row) => row.startsWith("csrftoken="))
      ?.split("=")[1];

    const body = {
      query: `
        query submissionDetails($submissionId: Int!) {
          submissionDetails(submissionId: $submissionId) {
            code
            runtime
            runtimeDisplay
            runtimePercentile
            memory
            memoryDisplay
            memoryPercentile
            totalCorrect
            totalTestcases
            lastTestcase
            codeOutput
            expectedOutput
            runtimeError
            compileError
            fullCodeOutput
            notes
          }
        }
      `,
      variables: { submissionId: parseInt(submissionId) },
      operationName: "submissionDetails",
    };

    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-csrftoken": csrfToken,
        Referer: "https://leetcode.com/submissions/",
      },
      body: JSON.stringify(body),
      credentials: "include",
    });

    const json = await res.json();
    const submissionDetails = json.data?.submissionDetails;

    if (!submissionDetails) return null;

    return {
      code: submissionDetails.code,
      submissionDetails: {
        runtime: submissionDetails.runtime,
        memory: submissionDetails.memory,
        runtimeDisplay: submissionDetails.runtimeDisplay,
        runtimePercentile: submissionDetails.runtimePercentile,
        memoryDisplay: submissionDetails.memoryDisplay,
        memoryPercentile: submissionDetails.memoryPercentile,
        totalCorrect: submissionDetails.totalCorrect,
        totalTestcases: submissionDetails.totalTestcases,
        lastTestcase: submissionDetails.lastTestcase,
        codeOutput: submissionDetails.codeOutput,
        expectedOutput: submissionDetails.expectedOutput,
        runtimeError: submissionDetails.runtimeError,
        compileError: submissionDetails.compileError,
        fullCodeOutput: submissionDetails.fullCodeOutput,
        notes: submissionDetails.notes,
      },
    };
  }

  async function getFromStorage(key, fallback = null) {
    return new Promise((resolve) => {
      chrome.storage.local.get([key], (result) => {
        resolve(result[key] || fallback);
      });
    });
  }

  function saveToStorage(key, value) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: value }, resolve);
    });
  }

  async function leaderOrQuit() {
    const now = Date.now();
    const last = await getFromStorage(HEARTBEAT_KEY, 0);
    if (now - last < HEARTBEAT_TIMEOUT_MS) return false;

    // jitter then re-check
    await new Promise((r) => setTimeout(r, Math.random() * 1000 + 100));
    const last2 = await getFromStorage(HEARTBEAT_KEY, 0);
    if (Date.now() - last2 < HEARTBEAT_TIMEOUT_MS) return false;

    await saveToStorage(HEARTBEAT_KEY, Date.now());
    return true;
  }

  function startHeartbeat() {
    return setInterval(
      () => saveToStorage(HEARTBEAT_KEY, Date.now()),
      HEARTBEAT_INTERVAL_MS
    );
  }

  // --- Keep or replace your previous deriveSolveTime with this windowed version ---
  function deriveSolveWindow(sub, visitLog) {
    // sub.timestamp is seconds; visitLog entries are seconds; DAY_S is in scope.
    const hits = visitLog
      .filter(
        (e) =>
          e.slug === sub.titleSlug &&
          e.ts < sub.timestamp &&
          sub.timestamp - e.ts <= DAY_S
      )
      .map((e) => e.ts);

    if (!hits.length) return { startSec: null, solveTimeSec: null };
    const startSec = Math.max(...hits);
    return { startSec, solveTimeSec: sub.timestamp - startSec };
  }

  /** Fetch description if needed (does not mutate `seen`). */
  async function fetchDescriptionIfNeeded(sub, seen) {
    if (seen.has(sub.titleSlug)) return null;
    try {
      return await fetchProblemDescription(sub.titleSlug);
    } catch {
      return null;
    }
  }

  /** Fetch note (safe). */
  async function fetchNoteSafe(sub) {
    try {
      return await fetchProblemNote(sub.titleSlug);
    } catch {
      return null;
    }
  }

  /** Fetch submission details (safe). */
  async function fetchSubmissionDetailsSafe(sub) {
    try {
      return await fetchSubmissionDetails(sub.id); // { code, submissionDetails } | null
    } catch {
      return null;
    }
  }

  /** Load snapshots (only when applicable), safe. */
  async function loadSnapshotsIfApplicable(sub, username) {
    if (sub.statusDisplay !== "Accepted" || !username) return null;
    try {
      return await leetTrackerDB.getSnapshots(username, sub.titleSlug);
    } catch (error) {
      console.warn(
        "[LeetTracker] IndexedDB read failed for submission enrichment, skipping journey capture:",
        error
      );
      return null;
    }
  }

  /**
   * Build coding journey summary from snapshots that occurred
   * before (or at) the submission time.
   * Returns { codingJourney, earliestSnapshotMs } or null.
   */
  function buildCodingJourneyFromSnapshots(snapshotsData, submissionTsSec) {
    if (!snapshotsData) return null;
    const snapshots = snapshotsData.snapshots || [];
    if (snapshots.length === 0) return null;

    const cutoffMs = submissionTsSec * 1000;
    const relevant = snapshots.filter((s) => s.timestamp <= cutoffMs);
    if (relevant.length === 0) return null;

    const first = relevant[0].timestamp;
    const last = relevant[relevant.length - 1].timestamp;
    const totalCodingTime = last - first;

    return {
      codingJourney: {
        snapshotCount: relevant.length,
        snapshots: relevant,
        totalCodingTime,
        firstSnapshot: first,
        lastSnapshot: last,
      },
      earliestSnapshotMs: first,
    };
  }

  /**
   * Attach runs to submission using earliest credible start candidate.
   * Returns runEvents summary or null.
   * NOTE: keeps Accepted-only gating to mirror snapshot policy.
   */
  async function buildRunEventsForSubmission(sub, username, startCandidatesMs) {
    if (sub.statusDisplay !== "Accepted" || !username) return null;

    const endMs = sub.timestamp * 1000;
    if (!startCandidatesMs || startCandidatesMs.length === 0) return null;

    const startMs = Math.min(...startCandidatesMs);

    const runs = await leetTrackerDB.getRunEventsInWindow(
      username,
      sub.titleSlug,
      startMs,
      endMs
    );

    if (!runs || runs.length === 0) return null;

    const summarized = runs.map((r) => ({
      id: r.id || null,
      startedAt: r.startedAt || null,
      statusMsg: r.statusMsg || "",
      totalCorrect: r.totalCorrect ?? null,
      totalTestcases: r.totalTestcases ?? null,
      runtimeError: r.runtimeError ?? null,
      lastTestcase: r.lastTestcase ?? null,
      compareResult: r.compareResult ?? null,
      code: r.code ?? null,
      runtime: r.runtime ?? null,
      memory: r.memory ?? null,
    }));

    return {
      count: runs.length,
      firstRun: runs[0].timestamp,
      lastRun: runs[runs.length - 1].timestamp,
      hasDetailedRuns: true,
      runs: summarized,
      _window: { startMs, endMs },
    };
  }

  /** Small mutator to attach coding journey + store recent journey. */
  async function attachCodingJourney(sub, username, codingJourney) {
    // Store full journey (with snapshots) in recent list & archive
    sub.codingJourney = codingJourney;
    await storeRecentJourney(username, sub);

    // Replace with compact summary on the submission object
    sub.codingJourney = {
      snapshotCount: codingJourney.snapshotCount,
      totalCodingTime: codingJourney.totalCodingTime,
      firstSnapshot: codingJourney.firstSnapshot,
      lastSnapshot: codingJourney.lastSnapshot,
      hasDetailedJourney: true,
    };
  }

  /** Final small mutator to attach runEvents as compact summary only. */
  function attachRunEvents(sub, runEvents) {
    if (runEvents) {
      sub.runEvents = {
        count: runEvents.count,
        firstRun: runEvents.firstRun,
        lastRun: runEvents.lastRun,
        hasDetailedRuns: true,
      };
    }
  }

  /**
   * Orchestrator: small, readable, and side-effect minimal.
   * - Computes solve window (visit-log derived).
   * - Fetches description / note / submission details / snapshots in parallel.
   * - Builds coding journey (if any) and attaches it.
   * - Builds and attaches run-events in [start → submission].
   */
  async function enrichSubmission(sub, seen, visitLog, username) {
    // 1) Compute solve window from visit log (+ keep prior public field)
    const { startSec, solveTimeSec } = deriveSolveWindow(sub, visitLog);
    sub.solveTime = solveTimeSec;

    const startCandidatesMs = [];
    if (startSec != null) startCandidatesMs.push(startSec * 1000);

    // 2) Kick off all fetches in parallel
    const [desc, note, details, snapshotsData] = await Promise.all([
      fetchDescriptionIfNeeded(sub, seen),
      fetchNoteSafe(sub),
      fetchSubmissionDetailsSafe(sub),
      loadSnapshotsIfApplicable(sub, username),
    ]);

    // 3) Apply description/note/details
    if (desc) {
      sub.problemDescription = desc;
      seen.add(sub.titleSlug);
    }
    if (note) sub.problemNote = note;

    if (details) {
      if (details.code) sub.code = details.code;
      if (details.submissionDetails)
        sub.submissionDetails = details.submissionDetails;
    }

    // 4) Build & attach coding journey
    const journey = buildCodingJourneyFromSnapshots(
      snapshotsData,
      sub.timestamp
    );
    if (journey) {
      startCandidatesMs.push(journey.earliestSnapshotMs);
      await attachCodingJourney(sub, username, journey.codingJourney);
      console.log(
        `[LeetTracker] Captured ${journey.codingJourney.snapshotCount} snapshots for submission ${sub.id} (${sub.titleSlug})`
      );
    }

    // 5) Build & attach run events (window: earliest start candidate → submission time)
    try {
      const runEvents = await buildRunEventsForSubmission(
        sub,
        username,
        startCandidatesMs
      );

      // Persist detailed grouping in rolling recent cache + archive (Accepted-only already enforced upstream)
      if (runEvents) {
        await storeRecentRunGroup(username, sub, runEvents);
      }

      // Attach compact summary to the stored submission
      attachRunEvents(sub, runEvents);

      if (runEvents) {
        const { _window } = runEvents;
        console.log(
          `[LeetTracker] Attached ${
            runEvents.count
          } run(s) (summary) to submission ${sub.id} (${
            sub.titleSlug
          }) in window ${new Date(_window.startMs).toISOString()} → ${new Date(
            _window.endMs
          ).toISOString()}`
        );
      }
    } catch (err) {
      console.warn(
        `[LeetTracker] Run enrichment failed for ${sub.titleSlug}:`,
        err
      );
    }
  }

  async function flushChunk(
    username,
    idx,
    chunk,
    chunksMeta,
    manifestKey,
    seenKey,
    seenSet
  ) {
    await saveToStorage(getChunkKey(username, idx), chunk);
    chunksMeta[idx] = {
      index: idx,
      from: chunk[0].timestamp,
      to: chunk.at(-1).timestamp,
    };
    await saveToStorage(manifestKey, {
      chunkCount: idx + 1,
      lastTimestamp: chunk.at(-1).timestamp,
      chunks: chunksMeta,
    });
    await saveToStorage(seenKey, Array.from(seenSet));
    console.log(`[LeetTracker] Saved chunk ${idx}`);
  }

  async function syncSubmissions(username) {
    if (!(await leaderOrQuit())) return;

    const beat = startHeartbeat();
    try {
      const manifestKey = getManifestKey(username);
      const seenKey = getSeenProblemsKey(username);
      const visitLogKey = getVisitLogKey(username);

      const [visitLog, manifest, seenArr] = await Promise.all([
        getFromStorage(visitLogKey, []),
        getFromStorage(manifestKey, {}),
        getFromStorage(seenKey, []),
      ]);

      const seen = new Set(seenArr);
      const lastT = manifest.lastTimestamp || 0;
      const subs = await fetchAllSubmissions(lastT);
      if (!subs.length) return console.log("[LeetTracker] No new submissions.");

      let chunkIdx = manifest.chunkCount - 1 || 0;
      let chunk = await getFromStorage(getChunkKey(username, chunkIdx), []);
      const meta = manifest.chunks || [];

      for (let i = 0; i < subs.length; i++) {
        const sub = subs[i];
        await enrichSubmission(sub, seen, visitLog, username);

        chunk.push(sub);

        // Create new chunk after reaching 100 submissions
        if (chunk.length >= 100) {
          await flushChunk(
            username,
            chunkIdx,
            chunk,
            meta,
            manifestKey,
            seenKey,
            seen
          );
          chunk = [];
          chunkIdx++;
          await new Promise((r) => setTimeout(r, 20_000));
        } // Update manifest and flush current chunk every 20 submissions (without creating new chunk)
        else if (chunk.length % 20 === 0 && chunk.length < 100) {
          await flushChunk(
            username,
            chunkIdx,
            chunk,
            meta,
            manifestKey,
            seenKey,
            seen
          );
          await new Promise((r) => setTimeout(r, 10_000));
        }
      }

      if (chunk.length) {
        await flushChunk(
          username,
          chunkIdx,
          chunk,
          meta,
          manifestKey,
          seenKey,
          seen
        );
      }
      console.log(`[LeetTracker] Synced ${subs.length} submissions.`);
    } catch (e) {
      console.error("[LeetTracker] Sync failed:", e);
    } finally {
      clearInterval(beat);
    }
  }

  function hookSubmitButton(username) {
    const selector = '[data-e2e-locator="console-submit-button"]';
    const button = document.querySelector(selector);
    if (!button) return;

    // Avoid rebinding if already attached
    if (button.dataset.leettrackerHooked === "true") return;

    button.addEventListener("click", () => {
      console.log("[LeetTracker] Submit clicked — scheduling sync...");

      // Wait a few seconds for LC to process submission and update data
      setTimeout(() => {
        syncSubmissions(username);
      }, 5000); // or debounce multiple clicks
    });

    button.dataset.leettrackerHooked = "true";
  }

  async function recordProblemVisit(username, slug) {
    const key = getVisitLogKey(username);
    const nowSec = Math.floor(Date.now() / 1000); // convert to seconds

    const log = await getFromStorage(key, []); // array of {slug, ts}
    log.push({ slug, ts: nowSec });

    // keep only last 24 h (in seconds)
    const trimmed = log.filter((e) => nowSec - e.ts <= DAY_S);
    await saveToStorage(key, trimmed);
  }

  // Recent journeys management for successful submissions
  async function storeRecentJourney(username, submission) {
    if (!submission.codingJourney || !submission.codingJourney.snapshots) {
      return; // No journey data to store
    }

    const key = getRecentJourneysKey(username);
    const recent = await getFromStorage(key, []);

    // Add new journey to the beginning of the array
    recent.unshift({
      submissionId: submission.id,
      titleSlug: submission.titleSlug,
      timestamp: submission.timestamp,
      codingJourney: submission.codingJourney,
    });

    // Keep only last 20 journeys
    if (recent.length > 20) {
      recent.splice(20);
    }

    await saveToStorage(key, recent);

    // ALSO backup to IndexedDB archive (permanent storage)
    try {
      await leetTrackerDB.storeJourneyArchive(username, submission);
      console.log(
        `[LeetTracker] Archived journey for ${submission.titleSlug} (submission ${submission.id})`
      );
    } catch (error) {
      console.warn(
        "[LeetTracker] Failed to archive journey to IndexedDB:",
        error
      );
    }

    console.log(
      `[LeetTracker] Stored recent journey for ${submission.titleSlug} (${recent.length} total recent journeys)`
    );
  }

  async function getRecentJourney(username, submissionId) {
    const key = getRecentJourneysKey(username);
    const recent = await getFromStorage(key, []);

    return recent.find((journey) => journey.submissionId === submissionId);
  }

  // Recent runs management for successful submissions (grouped by submission)
  async function storeRecentRunGroup(username, submission, runEvents) {
    if (!runEvents || !runEvents.runs) return;

    const key = getRecentRunsKey(username);
    const recent = await getFromStorage(key, []);

    // Add new run grouping at the beginning
    recent.unshift({
      submissionId: submission.id,
      titleSlug: submission.titleSlug,
      timestamp: submission.timestamp,
      runEvents, // detailed grouping
    });

    // Keep only last 20 groupings
    if (recent.length > 20) {
      recent.splice(20);
    }

    await saveToStorage(key, recent);

    // ALSO backup to IndexedDB archive (permanent storage)
    try {
      // Provisionally attach detailed runs to the submission object for archive write
      const original = submission.runEvents;
      submission.runEvents = runEvents;
      await leetTrackerDB.storeRunGroupArchive(username, submission);
      // Restore compact summary on the submission (if any)
      submission.runEvents = original;
      console.log(
        `[LeetTracker] Archived run group for ${submission.titleSlug} (submission ${submission.id})`
      );
    } catch (error) {
      console.warn(
        "[LeetTracker] Failed to archive run group to IndexedDB:",
        error
      );
    }

    console.log(
      `[LeetTracker] Stored recent run group for ${submission.titleSlug}`
    );
  }

  // Function to explore LeetCode's IndexedDB
  async function exploreLeetCodeIndexedDB() {
    try {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open("LeetCode-problems");

        request.onerror = () => reject(request.error);

        request.onsuccess = () => {
          const db = request.result;

          if (db.objectStoreNames.contains("problem_code")) {
            const transaction = db.transaction(["problem_code"], "readonly");
            const store = transaction.objectStore("problem_code");

            // Get all keys to find matching patterns
            const keysRequest = store.getAllKeys();
            keysRequest.onsuccess = () => {
              resolve({
                db,
                store,
                keys: keysRequest.result,
              });
            };
          } else {
            resolve({ db, store: null, keys: [] });
          }
        };
      });
    } catch (error) {
      return null;
    }
  }

  // Persistent mapping of problem slug to problem ID
  const problemSlugToIdMap = new Map(); // In-memory cache for current session
  const PROBLEM_ID_STORAGE_KEY = "leettracker_problem_slug_to_id_map";

  // Function to get current problem slug from URL (fast and reliable)
  function getCurrentProblemSlug() {
    const urlMatch = window.location.pathname.match(/^\/problems\/([^\/]+)\/?/);
    return urlMatch ? urlMatch[1] : null;
  }

  // Function to get problem ID from slug with persistent caching
  async function getProblemIdFromSlug(problemSlug) {
    if (!problemSlug) return null;

    // Check in-memory cache first
    if (problemSlugToIdMap.has(problemSlug)) {
      return problemSlugToIdMap.get(problemSlug);
    }

    // Check persistent storage
    try {
      const storedMap = await getFromStorage(PROBLEM_ID_STORAGE_KEY, {});
      if (storedMap[problemSlug]) {
        // Cache in memory for faster access
        problemSlugToIdMap.set(problemSlug, storedMap[problemSlug]);
        return storedMap[problemSlug];
      }
    } catch (error) {
      // Continue to script lookup
    }

    // Not found in cache - fetch from API
    let question = null;
    try {
      question = await fetchProblemDescription(problemSlug);
    } catch (error) {
      console.warn(
        `[LeetTracker] fetchProblemDescription failed for slug '${problemSlug}':`,
        error
      );
      return null;
    }
    if (!question || !question.questionId) {
      console.warn(
        `[LeetTracker] No valid question data for slug '${problemSlug}'.`
      );
      return null;
    }
    const problemId = question.questionId;
    // Cache both in memory and persistent storage
    problemSlugToIdMap.set(problemSlug, problemId);
    try {
      const storedMap = await getFromStorage(PROBLEM_ID_STORAGE_KEY, {});
      storedMap[problemSlug] = problemId;
      await saveToStorage(PROBLEM_ID_STORAGE_KEY, storedMap);
      console.log(
        `[LeetTracker] Cached problem ID mapping: ${problemSlug} -> ${problemId}`
      );
    } catch (error) {
      console.warn(
        "[LeetTracker] Failed to persist problem ID mapping:",
        error
      );
    }
    return problemId;
  }

  // Function to get current problem ID - now much simpler and faster
  async function getCurrentProblemId() {
    const problemSlug = getCurrentProblemSlug();
    if (!problemSlug) {
      return {
        problemSlug: null,
        problemId: null,
        method: "no-slug",
      };
    }

    const problemId = await getProblemIdFromSlug(problemSlug);
    return {
      problemSlug,
      problemId,
      method: problemId ? "cached" : "slug-only",
    };
  }

  // Function to get code from LeetCode's IndexedDB
  async function getCodeFromLeetCodeDB(problemId, language = "python3") {
    try {
      // Get the memoized user ID first
      const { userId } = await getUserInfoWithCache();
      if (!userId) {
        return null;
      }

      const dbInfo = await exploreLeetCodeIndexedDB();
      if (!dbInfo || !dbInfo.store) {
        return null;
      }

      // Construct specific key using the memoized user ID
      const codeKey = `${problemId}_${userId}_${language}`;

      try {
        return await getCodeByKey(dbInfo, codeKey);
      } catch (error) {
        return null;
      }
    } catch (error) {
      return null;
    }
  }

  // Helper function to get data by key from LeetCode's IndexedDB
  async function getCodeByKey(dbInfo, key) {
    return new Promise((resolve, reject) => {
      const transaction = dbInfo.db.transaction(["problem_code"], "readonly");
      const store = transaction.objectStore("problem_code");
      const request = store.get(key);

      request.onsuccess = () => {
        const result = request.result;
        if (result && typeof result === "string" && result.length > 0) {
          resolve(result);
        } else {
          resolve(null);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  // Code snapshot functionality - Simple and reliable
  async function getCurrentCode() {
    let bestResult = null;
    let bestMethod = "none";

    // Method 1: Try LeetCode's IndexedDB first (most reliable and up-to-date)
    try {
      const problemInfo = await getCurrentProblemId();

      if (problemInfo.problemId) {
        const currentLang = await detectCurrentLanguage(
          "",
          problemInfo.problemSlug
        );
        const leetcodeCode = await getCodeFromLeetCodeDB(
          problemInfo.problemId,
          currentLang
        );

        if (leetcodeCode) {
          bestResult = leetcodeCode;
          bestMethod = "leetcodeIndexedDB";
        }
      }
    } catch (error) {
      // Continue to fallback
    }

    // Method 2: Fallback - try any textarea with content
    if (!bestResult) {
      try {
        const allTextareas = document.querySelectorAll("textarea");
        for (const textarea of allTextareas) {
          if (textarea.value && textarea.value.length > 10) {
            bestResult = textarea.value;
            bestMethod = "textarea_fallback";
            break;
          }
        }
      } catch (error) {
        // No fallback available
      }
    }

    return {
      bestGuess: bestResult,
      bestMethod: bestMethod,
      allResults: bestResult ? { [bestMethod]: bestResult } : {},
    };
  }

  function shouldTakeSnapshot(oldCode, newCode) {
    if (!oldCode || !newCode) return true;

    // Normalize both texts for comparison
    const normalizedOld = normalizeText(oldCode);
    const normalizedNew = normalizeText(newCode);

    // Use diff-match-patch to calculate changes
    if (!window.diff_match_patch) {
      console.error(
        "[LeetTracker] diff_match_patch not available for snapshot decision"
      );
      return false;
    }

    const dmp = new window.diff_match_patch();
    const diffs = dmp.diff_main(normalizedOld, normalizedNew);

    let charChanges = 0;
    let lineChanges = 0;

    diffs.forEach(([operation, text]) => {
      if (operation !== 0) {
        // 0 = EQUAL, 1 = INSERT, -1 = DELETE
        charChanges += text.length;
        lineChanges += (text.match(/\n/g) || []).length;
      }
    });

    return charChanges >= 30 || lineChanges >= 2;
  }

  async function takeCodeSnapshot(username, problemSlug) {
    return await withSnapshotLock(username, problemSlug, async () => {
      const codeResult = await getCurrentCode();
      if (!codeResult || !codeResult.bestGuess) {
        console.log("[LeetTracker] No code found to snapshot");
        return;
      }

      const currentCode = codeResult.bestGuess;

      // Get snapshots from IndexedDB
      let snapshots = [];
      let lastFinalCode = "";
      try {
        const snapshotData = await leetTrackerDB.getSnapshots(
          username,
          problemSlug
        );
        snapshots = snapshotData.snapshots || [];
        lastFinalCode = snapshotData.lastFinalCode || "";
      } catch (error) {
        console.warn(
          "[LeetTracker] IndexedDB read failed, skipping snapshot:",
          error
        );
        return; // No fallback - just skip if IndexedDB fails
      }

      const lastCode =
        snapshots.length > 0
          ? lastFinalCode ||
            snapshots[snapshots.length - 1].fullCode ||
            reconstructCodeFromSnapshots(snapshots)
          : "";

      if (!shouldTakeSnapshot(lastCode, currentCode)) return;

      // Create patch using diff-match-patch
      const patchResult = makePatch(lastCode, currentCode);
      if (!patchResult) return;

      const snapshot = {
        timestamp: Date.now(),
        patchText: patchResult.patchText,
        checksumBefore: patchResult.checksumBefore,
        checksumAfter: patchResult.checksumAfter,
        encodingInfo: "utf8 + nfc + lf",
      };

      // Store fullCode for checkpoints: first snapshot and every 25th snapshot for recovery
      const isCheckpoint =
        snapshots.length === 0 || snapshots.length % 25 === 0;
      if (isCheckpoint) {
        snapshot.fullCode = patchResult.afterNorm;
        snapshot.isCheckpoint = true;
      }

      // Simple validation: Test that this single patch can be applied correctly
      if (snapshots.length > 0) {
        const testResult = applyPatch(
          lastCode,
          patchResult.patchText,
          patchResult.checksumBefore
        );
        if (!testResult.applied || testResult.text !== patchResult.afterNorm) {
          console.error(
            "[LeetTracker] Patch validation failed, skipping snapshot"
          );
          return;
        }
      }

      snapshots.push(snapshot);

      console.log(
        `[LeetTracker] Took snapshot #${snapshots.length} for ${problemSlug} (${currentCode.length} chars) via ${codeResult.bestMethod}`
      );

      // Prepare storage data with lastFinalCode
      const snapshotData = {
        snapshots: snapshots,
        lastFinalCode: patchResult.afterNorm,
        lastUpdated: Date.now(),
      };

      try {
        // Store in IndexedDB only
        await leetTrackerDB.storeSnapshots(username, problemSlug, snapshotData);
      } catch (error) {
        console.warn(
          "[LeetTracker] Failed to save snapshot to IndexedDB:",
          error
        );
        // No fallback - if IndexedDB fails, we just lose this snapshot
      }
    });
  }

  // Utility function to reconstruct full code from snapshots using diff-match-patch
  function reconstructCodeFromSnapshots(snapshots, targetIndex = -1) {
    if (snapshots.length === 0) return "";
    if (targetIndex === -1) targetIndex = snapshots.length - 1;
    if (targetIndex >= snapshots.length) return "";

    // Find the most recent checkpoint at or before the target
    let baseIndex = targetIndex;
    while (baseIndex >= 0 && !snapshots[baseIndex].fullCode) {
      baseIndex--;
    }

    if (baseIndex < 0) {
      console.error("[LeetTracker] No checkpoint found in snapshots");
      return "";
    }

    let code = snapshots[baseIndex].fullCode;

    // Apply patches from checkpoint to target
    for (let i = baseIndex + 1; i <= targetIndex; i++) {
      const snapshot = snapshots[i];

      if (snapshot.patchText) {
        // New diff-match-patch format
        const result = applyPatch(
          code,
          snapshot.patchText,
          snapshot.checksumBefore
        );
        if (result.applied) {
          code = result.text;
        } else {
          console.warn(
            `[LeetTracker] Failed to apply patch ${i}, some hunks may have failed`
          );
          // Continue with partial result
          code = result.text;
        }
      } else if (snapshot.patch) {
        // Legacy format - fallback for old snapshots
        try {
          if (window.Diff && window.Diff.applyPatch) {
            const result = window.Diff.applyPatch(code, snapshot.patch);
            code = result || code;
          } else {
            console.warn(
              `[LeetTracker] Cannot apply legacy patch ${i}, skipping`
            );
          }
        } catch (error) {
          console.error(
            `[LeetTracker] Failed to apply legacy patch ${i}:`,
            error
          );
        }
      }
    }

    return code;
  }

  function startCodeSnapshotWatcher(username) {
    setInterval(async () => {
      const match = window.location.pathname.match(/^\/problems\/([^\/]+)\/?/);
      if (match) {
        await takeCodeSnapshot(username, match[1]);
      }
    }, 3000); // Check every 3 seconds
  }

  function startProblemNavigationWatcher(username) {
    let lastSlug = null;

    setInterval(() => {
      const m = window.location.pathname.match(/^\/problems\/([^\/]+)\/?/);
      if (!m) return;

      const slug = m[1];
      if (slug !== lastSlug) {
        lastSlug = slug;
        recordProblemVisit(username, slug);
      }
    }, 1000); // 1 s poll, negligible cost
  }

  // Load page-inject.js into the *page context* (CSP-safe external file)
  function injectRunCodeWatcher() {
    try {
      // Only run in the top frame; many LeetCode subframes are sandboxed/srcdoc
      if (window.top !== window) {
        console.debug(
          "[LeetTracker] injectRunCodeWatcher: not top frame, skipping"
        );
        return;
      }

      // Compute extension URL. In bad contexts Chrome returns ".../invalid/..."
      const url =
        chrome && chrome.runtime && chrome.runtime.getURL
          ? chrome.runtime.getURL("page-inject.js")
          : null;

      if (!url || url.includes("chrome-extension://invalid")) {
        console.warn(
          "[LeetTracker] injectRunCodeWatcher: computed invalid URL:",
          url
        );
        return; // Don’t try to append; it will 404/ERR_FAILED
      }

      const s = document.createElement("script");
      s.src = url;
      s.async = false; // ensure deterministic evaluation order
      s.type = "text/javascript";
      s.onload = () => s.remove(); // keep DOM clean
      (document.head || document.documentElement).appendChild(s);

      console.log("[LeetTracker] page-inject.js injected:", url);
    } catch (e) {
      console.error("[LeetTracker] injectRunCodeWatcher failed:", e);
    }
  }

  // Bridge messages from page → content, then store using DB
  function startRunCodeMessageBridge(username) {
    window.addEventListener("message", async (event) => {
      if (event.source !== window) return;
      const d = event.data;
      if (!d || d.source !== "leettracker") return;

      if (d.type === "lt-run-result") {
        const { interpret_id, data, meta } = d.payload || {};
        const problemSlug = getCurrentProblemSlug() || "unknown";

        // Prefer the exact code sent with interpret_solution; otherwise fall back
        let code = meta?.typed_code;
        if (!code) {
          try {
            const codeResult = await getCurrentCode();
            code = codeResult?.bestGuess || "";
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
          state: data?.state || null, // "SUCCESS"/"FAILURE"
          statusMsg: data?.status_msg || "", // "Accepted", etc.
          statusCode: data?.status_code ?? null,
          totalCorrect: data?.total_correct ?? data?.totalCorrect ?? null,
          totalTestcases: data?.total_testcases ?? data?.totalTestcases ?? null,
          fullRuntimeError: data?.full_runtime_error || null,
          runtimeError: data?.runtime_error || null,
          lastTestcase: data?.last_testcase || null,
          runtime: data?.status_runtime || data?.display_runtime || null,
          memory: data?.status_memory || data?.memory || null,
          codeAnswer: data?.code_answer ?? null, // array of outputs
          expectedCodeAnswer: data?.expected_code_answer ?? null,
          compareResult: data?.compare_result ?? null,
        };

        await leetTrackerDB.storeRunEvent(username, problemSlug, runRecord);
        console.log(
          `[LeetTracker][RunWatcher] Stored run via network intercept for ${problemSlug}:`,
          `${runRecord.totalCorrect ?? "?"}/${
            runRecord.totalTestcases ?? "?"
          } correct, ${runRecord.statusMsg}`
        );
      }
    });
  }

  // --- User Info Fetch/Caching ---
  let cachedUserInfo = { userId: null, username: null };
  let userInfoPromise = null;
  function getUserInfoWithCache(maxAttempts = 10) {
    if (cachedUserInfo.userId && cachedUserInfo.username) {
      return Promise.resolve(cachedUserInfo);
    }
    if (userInfoPromise) return userInfoPromise;
    userInfoPromise = (async () => {
      let attempt = 0;
      let delay = 1000;
      while (attempt < maxAttempts) {
        try {
          const body = {
            query: `query globalData { userStatus { username activeSessionId isSignedIn } }`,
            variables: {},
            operationName: "globalData",
          };
          const res = await fetch(GRAPHQL_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Referer: "https://leetcode.com/problemset/all/",
            },
            body: JSON.stringify(body),
            credentials: "include",
          });
          const json = await res.json();
          const userStatus = json.data?.userStatus;
          if (
            userStatus &&
            userStatus.isSignedIn &&
            userStatus.username &&
            userStatus.activeSessionId
          ) {
            cachedUserInfo = {
              userId: userStatus.activeSessionId.toString(),
              username: userStatus.username,
            };
            return cachedUserInfo;
          }
        } catch (e) {
          // continue to retry
        }
        console.warn(
          `[LeetTracker] Failed to fetch user sign-in status, retrying in ${delay}ms`
        );
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30000); // exponential backoff, max 30s
        attempt++;
      }
      return cachedUserInfo;
    })();
    return userInfoPromise;
  }

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
