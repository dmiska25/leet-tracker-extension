(function () {
  const GRAPHQL_URL = "https://leetcode.com/graphql/";
  const SYNC_LOCK_KEY = "leettracker_sync_lock";
  const HEARTBEAT_TIMEOUT_MS = 180000; // Consider stale after 3 minutes of no heartbeat
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
        const request = indexedDB.open("LeetTrackerDB", 2);

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

        request.onupgradeneeded = async (event) => {
          const db = event.target.result;
          const oldVersion = event.oldVersion;
          const transaction = event.target.transaction;

          console.log(
            `[LeetTracker] Upgrading IndexedDB from version ${oldVersion} to 2`
          );

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

          // Migration from v1 to v2: Convert seen problems list to new object format
          if (oldVersion === 1) {
            console.log(
              "[LeetTracker] Migrating seen problems from v1 to v2 format..."
            );

            // Wait for transaction to complete before accessing chrome.storage
            transaction.oncomplete = async () => {
              try {
                // Get all usernames that might have seen problems data
                const allKeys = await new Promise((resolve) => {
                  chrome.storage.local.get(null, (items) => {
                    resolve(Object.keys(items));
                  });
                });

                // Find all seen problems keys (format: leettracker_seen_problems_<username>)
                const seenProblemsKeys = allKeys.filter((key) =>
                  key.startsWith("leettracker_seen_problems_")
                );

                let migratedCount = 0;
                for (const key of seenProblemsKeys) {
                  const seenData = await new Promise((resolve) => {
                    chrome.storage.local.get([key], (result) => {
                      resolve(result[key]);
                    });
                  });

                  // Check if it needs migration
                  let needsMigration = false;
                  let newFormat = {};

                  if (Array.isArray(seenData)) {
                    // Old format: array of strings or objects
                    needsMigration = true;
                    seenData.forEach((item) => {
                      if (typeof item === "string") {
                        // Very old format: just a slug string
                        newFormat[item] = {
                          isPremium: null, // Force re-fetch to get actual status
                          hasDescription: true,
                        };
                      } else if (item && item.slug) {
                        // Array of objects format
                        newFormat[item.slug] = {
                          isPremium:
                            item.isPremium !== undefined
                              ? item.isPremium
                              : null,
                          hasDescription: item.hasDescription || false,
                        };
                      }
                    });
                  } else if (seenData && typeof seenData === "object") {
                    // Already in object format, check if it needs property updates
                    const firstKey = Object.keys(seenData)[0];
                    if (
                      firstKey &&
                      !seenData[firstKey].hasOwnProperty("isPremium")
                    ) {
                      // Old object format without isPremium
                      needsMigration = true;
                      Object.keys(seenData).forEach((slug) => {
                        newFormat[slug] = {
                          isPremium: null, // Force re-fetch to get actual status
                          hasDescription:
                            seenData[slug].hasDescription || false,
                        };
                      });
                    }
                  }

                  if (needsMigration) {
                    // Save migrated data
                    await new Promise((resolve) => {
                      chrome.storage.local.set({ [key]: newFormat }, resolve);
                    });

                    migratedCount++;
                    console.log(
                      `[LeetTracker] Migrated ${key}: ${
                        Object.keys(newFormat).length
                      } problems`
                    );
                  }
                }

                if (migratedCount > 0) {
                  console.log(
                    `[LeetTracker] Migration complete: ${migratedCount} user(s) migrated`
                  );
                } else {
                  console.log(
                    "[LeetTracker] No migration needed (already in v2 format)"
                  );
                }

                // Add manifest.total field for all users (v2 migration)
                console.log(
                  "[LeetTracker] Computing manifest.total for all users..."
                );

                // Find all manifest keys
                const manifestKeys = allKeys.filter((key) =>
                  key.startsWith("leettracker_sync_manifest_")
                );

                let manifestUpdateCount = 0;
                for (const manifestKey of manifestKeys) {
                  const manifest = await new Promise((resolve) => {
                    chrome.storage.local.get([manifestKey], (result) => {
                      resolve(result[manifestKey]);
                    });
                  });

                  // Only update if manifest exists and doesn't already have total field
                  if (manifest && !manifest.hasOwnProperty("total")) {
                    const username = manifestKey.replace(
                      "leettracker_sync_manifest_",
                      ""
                    );
                    const chunks = manifest.chunks || [];

                    // Count submissions across all chunks
                    let total = 0;
                    for (const chunkMeta of chunks) {
                      if (chunkMeta && chunkMeta.index !== undefined) {
                        const chunkKey = `leettracker_leetcode_chunk_${username}_${chunkMeta.index}`;
                        const chunk = await new Promise((resolve) => {
                          chrome.storage.local.get([chunkKey], (result) => {
                            resolve(result[chunkKey] || []);
                          });
                        });
                        total += chunk.length;
                      }
                    }

                    // Update manifest with total field
                    manifest.total = total;
                    await new Promise((resolve) => {
                      chrome.storage.local.set(
                        { [manifestKey]: manifest },
                        resolve
                      );
                    });

                    manifestUpdateCount++;
                    console.log(
                      `[LeetTracker] Updated manifest for ${username}: total = ${total} submissions`
                    );
                  }
                }

                if (manifestUpdateCount > 0) {
                  console.log(
                    `[LeetTracker] Manifest total field added for ${manifestUpdateCount} user(s)`
                  );
                }
              } catch (error) {
                console.error(
                  "[LeetTracker] Error during seen problems migration:",
                  error
                );
              }
            };
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

  async function fetchProblemPremiumStatus(titleSlug) {
    const fetchFn = async () => {
      const body = {
        query: `
          query selectProblem($titleSlug: String!) {
            question(titleSlug: $titleSlug) {
              isPaidOnly
            }
          }
        `,
        variables: { titleSlug },
        operationName: "selectProblem",
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

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const json = await res.json();
      return json.data?.question || null;
    };

    const validator = (result) => {
      // Empty/invalid response - likely rate limited
      if (result === null || result.isPaidOnly === undefined) {
        console.warn(
          `[LeetTracker] Empty premium status response for ${titleSlug}, likely rate limited`
        );
        return false;
      }

      return true;
    };

    const result = await retryWithBackoff(fetchFn, validator);

    // Default to false if all retries fail (safer to attempt fetch than skip)
    if (result === null) {
      console.error(
        `[LeetTracker] Failed to get premium status for ${titleSlug} after retries, assuming non-premium`
      );
      return false;
    }

    return result.isPaidOnly || false;
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

  // Generate unique session ID for this content script instance
  const SESSION_ID = `session_${Date.now()}_${Math.random()
    .toString(36)
    .substr(2, 9)}`;

  // In-memory flag to track if this session owns the lock
  let isLockOwner = false;

  /**
   * Check if a lock is available for acquisition.
   * Returns { canAcquire: boolean, reason: string }
   */
  function checkLockAvailability(lock, context = "") {
    if (!lock || !lock.isLocked) {
      return { canAcquire: true, reason: "no_lock" };
    }

    const now = Date.now();
    const timeSinceHeartbeat = now - (lock.lastHeartbeat || 0);

    // Fresh heartbeat (active sync in progress)
    if (timeSinceHeartbeat < HEARTBEAT_TIMEOUT_MS) {
      console.log(
        `[LeetTracker] Sync lock held by ${lock.sessionId}${context}`,
        { timeSinceHeartbeat, sessionId: lock.sessionId }
      );
      return { canAcquire: false, reason: "active" };
    }

    // Stale heartbeat - sync has crashed or stopped updating
    console.log(
      `[LeetTracker] Sync lock expired (no heartbeat for ${Math.floor(
        timeSinceHeartbeat / 1000
      )}s)${context}`,
      { timeSinceHeartbeat, sessionId: lock.sessionId }
    );
    return { canAcquire: true, reason: "heartbeat_expired" };
  }

  /**
   * Attempt to acquire the sync lock.
   * Returns true if lock was acquired, false otherwise.
   *
   * Lock structure in storage:
   * {
   *   sessionId: string,      // Who owns the lock
   *   acquiredAt: number,     // When lock was acquired (ms)
   *   lastHeartbeat: number,  // Last heartbeat update (ms)
   *   isLocked: boolean       // Hard lock boolean
   * }
   */
  async function acquireSyncLock() {
    // Step 1: Check current lock state
    const currentLock = await getFromStorage(SYNC_LOCK_KEY, null);
    const initialCheck = checkLockAvailability(currentLock);

    if (!initialCheck.canAcquire) {
      return false;
    }

    // Step 2: Random jitter to reduce collision probability
    const jitterMs = Math.random() * 1000 + 100; // 100-1100ms
    await new Promise((resolve) => setTimeout(resolve, jitterMs));

    // Step 3: Re-check lock state after jitter
    const recheckLock = await getFromStorage(SYNC_LOCK_KEY, null);
    const recheckResult = checkLockAvailability(recheckLock, " after jitter");

    if (!recheckResult.canAcquire) {
      return false;
    }

    // Step 4: Attempt to acquire lock
    const acquisitionTime = Date.now();
    const newLock = {
      sessionId: SESSION_ID,
      acquiredAt: acquisitionTime,
      lastHeartbeat: acquisitionTime,
      isLocked: true,
    };

    await saveToStorage(SYNC_LOCK_KEY, newLock);

    // Step 5: Verify we actually got the lock (detect race condition)
    // Small delay to ensure write completed
    await new Promise((resolve) => setTimeout(resolve, 50));

    const verifyLock = await getFromStorage(SYNC_LOCK_KEY, null);

    if (!verifyLock || verifyLock.sessionId !== SESSION_ID) {
      console.log(`[LeetTracker] Lost lock race to another session`, {
        ourSession: SESSION_ID,
        winningSession: verifyLock?.sessionId,
      });
      return false;
    }

    // Success! We own the lock
    isLockOwner = true;
    console.log(`[LeetTracker] Sync lock acquired`, {
      sessionId: SESSION_ID,
      acquiredAt: acquisitionTime,
    });
    return true;
  }

  /**
   * Update heartbeat to indicate sync is still in progress.
   * Also verifies we still own the lock.
   */
  async function updateSyncHeartbeat() {
    if (!isLockOwner) {
      console.warn(
        `[LeetTracker] Attempted heartbeat update without lock ownership`
      );
      return false;
    }

    const currentLock = await getFromStorage(SYNC_LOCK_KEY, null);

    // Verify we still own the lock
    if (!currentLock || currentLock.sessionId !== SESSION_ID) {
      console.error(`[LeetTracker] Lost lock ownership! Aborting sync.`, {
        ourSession: SESSION_ID,
        currentOwner: currentLock?.sessionId,
      });
      isLockOwner = false;
      return false;
    }

    // Update heartbeat
    const updatedLock = {
      ...currentLock,
      lastHeartbeat: Date.now(),
    };

    await saveToStorage(SYNC_LOCK_KEY, updatedLock);
    return true;
  }

  /**
   * Update heartbeat and throw error if lock ownership is lost.
   * Convenience wrapper for critical sections that must abort on lock loss.
   */
  async function updateSyncHeartbeatOrFail(context = "") {
    const success = await updateSyncHeartbeat();
    if (!success) {
      throw new Error(`Lost lock ownership during ${context || "operation"}`);
    }
  }

  /**
   * Release the sync lock.
   */
  async function releaseSyncLock() {
    if (!isLockOwner) {
      console.warn(`[LeetTracker] Attempted to release lock without ownership`);
      return;
    }

    const currentLock = await getFromStorage(SYNC_LOCK_KEY, null);

    // Only release if we still own it
    if (currentLock && currentLock.sessionId === SESSION_ID) {
      await saveToStorage(SYNC_LOCK_KEY, {
        sessionId: null,
        acquiredAt: null,
        lastHeartbeat: null,
        isLocked: false,
      });
      console.log(`[LeetTracker] Sync lock released`, {
        sessionId: SESSION_ID,
      });
    } else {
      console.warn(
        `[LeetTracker] Lock already taken by another session, skipping release`,
        { ourSession: SESSION_ID, currentOwner: currentLock?.sessionId }
      );
    }

    isLockOwner = false;
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

  /**
   * Retry a fetch operation with exponential backoff up to 60 seconds.
   * Validates the response to detect rate limiting (empty/null responses).
   */
  async function retryWithBackoff(fetchFn, validator, maxRetries = 5) {
    let delay = 2000; // Start with 2 seconds
    const maxDelay = 60000; // Cap at 60 seconds

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const result = await fetchFn();

        // If validator passes or returns null, we're good
        if (validator(result)) {
          return result;
        }

        // Failed validation - likely rate limited
        if (attempt < maxRetries - 1) {
          console.warn(
            `[LeetTracker] Rate limit detected (attempt ${
              attempt + 1
            }/${maxRetries}), retrying in ${delay / 1000}s...`
          );
          await new Promise((r) => setTimeout(r, delay));
          delay = Math.min(delay * 2, maxDelay);
        } else {
          // Final attempt failed
          console.warn(
            `[LeetTracker] Rate limit detected on final attempt (${
              attempt + 1
            }/${maxRetries}), giving up`
          );
        }
      } catch (error) {
        if (attempt < maxRetries - 1) {
          console.warn(
            `[LeetTracker] Fetch error (attempt ${
              attempt + 1
            }/${maxRetries}), retrying in ${delay / 1000}s:`,
            error
          );
          await new Promise((r) => setTimeout(r, delay));
          delay = Math.min(delay * 2, maxDelay);
        } else {
          // Final attempt errored
          console.warn(
            `[LeetTracker] Fetch error on final attempt (${
              attempt + 1
            }/${maxRetries}):`,
            error
          );
        }
      }
    }

    return null;
  }

  /** Fetch description if needed (does not mutate `seenMap`). */
  async function fetchDescriptionIfNeeded(sub, seenMap) {
    const seenInfo = seenMap[sub.titleSlug];
    if (seenInfo?.hasDescription) return null;

    return await retryWithBackoff(
      () => fetchProblemDescription(sub.titleSlug),
      (result) => {
        // Rate limited if we got a response but content is missing/empty
        if (
          result === null ||
          !result.content ||
          result.content.trim() === ""
        ) {
          console.warn(
            `[LeetTracker] Empty description for ${sub.titleSlug}, likely rate limited`
          );
          return false;
        }
        return true;
      }
    );
  }

  /** Fetch note (safe). No retry - can't detect rate limiting from empty notes */
  async function fetchNoteSafe(sub) {
    try {
      return await fetchProblemNote(sub.titleSlug);
    } catch {
      return null;
    }
  }

  /** Fetch submission details (safe). */
  async function fetchSubmissionDetailsSafe(sub) {
    return await retryWithBackoff(
      () => fetchSubmissionDetails(sub.id),
      (result) => {
        if (result === null || !result.code || result.code.trim() === "") {
          console.warn(
            `[LeetTracker] Empty code for submission ${sub.id}, likely rate limited`
          );
          return false; // Reject and retry
        }

        // Got valid code
        return true;
      }
    );
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
   * - Checks premium status FIRST (cached)
   * - Fetches description / note / submission details / snapshots in parallel.
   * - Builds coding journey (if any) and attaches it.
   * - Builds and attaches run-events in [start → submission].
   */
  async function enrichSubmission(
    sub,
    seenMap,
    visitLog,
    username,
    userHasPremium = false
  ) {
    // 1) Compute solve window from visit log (+ keep prior public field)
    const { startSec, solveTimeSec } = deriveSolveWindow(sub, visitLog);
    sub.solveTime = solveTimeSec;

    const startCandidatesMs = [];
    if (startSec != null) startCandidatesMs.push(startSec * 1000);

    // 2) Check if problem is premium (from cache or fetch)
    let seenInfo = seenMap[sub.titleSlug];
    let isPremiumProblem = false;

    if (seenInfo && seenInfo.isPremium !== null) {
      // We've seen this problem before AND have cached premium status
      isPremiumProblem = seenInfo.isPremium;
    } else {
      // First time seeing OR isPremium is null (migrated data) - fetch premium status
      try {
        isPremiumProblem = await fetchProblemPremiumStatus(sub.titleSlug);
        seenMap[sub.titleSlug] = {
          isPremium: isPremiumProblem,
          hasDescription: seenInfo?.hasDescription || false,
        };
      } catch (error) {
        console.warn(
          `[LeetTracker] Failed to fetch premium status for ${sub.titleSlug}:`,
          error
        );
        isPremiumProblem = false;
      }
    }

    // Store premium status on submission
    if (isPremiumProblem) {
      sub.isPremiumProblem = true;
    }

    // 3) Skip enrichment for premium problems if user doesn't have premium
    if (isPremiumProblem && !userHasPremium) {
      return;
    }

    // 4) Kick off all fetches in parallel (non-premium or user has premium)
    const [desc, note, details, snapshotsData] = await Promise.all([
      fetchDescriptionIfNeeded(sub, seenMap),
      fetchNoteSafe(sub),
      fetchSubmissionDetailsSafe(sub),
      loadSnapshotsIfApplicable(sub, username),
    ]);

    // 5) Validate critical enrichment data
    const isFirstTimeSeeing = !seenMap[sub.titleSlug]?.hasDescription;

    if (isFirstTimeSeeing && !desc) {
      console.error(
        `[LeetTracker] Failed to fetch description for ${sub.titleSlug} (submission ${sub.id}) after retries - storing incomplete`
      );
    }

    if (!details || !details.code) {
      console.error(
        `[LeetTracker] Failed to fetch code for submission ${sub.id} (${sub.titleSlug}) after retries - storing incomplete`
      );
    }

    // 6) Apply description/note/details
    if (desc) {
      sub.problemDescription = desc;
      // Update seen map with description flag, preserving isPremium (including null)
      const existing = seenMap[sub.titleSlug] || { isPremium: null };
      seenMap[sub.titleSlug] = { ...existing, hasDescription: true };
    }
    if (note) sub.problemNote = note;

    if (details) {
      if (details.code) sub.code = details.code;
      if (details.submissionDetails)
        sub.submissionDetails = details.submissionDetails;
    }

    // 7) Build & attach coding journey
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

    // 8) Build & attach run events (window: earliest start candidate → submission time)
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
    seenMap,
    totalSubs,
    totalSynced,
    skippedForBackfill
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
      total: totalSubs,
      totalSynced: totalSynced,
      skippedForBackfill: skippedForBackfill,
    });

    // Save object directly (no conversion needed)
    await saveToStorage(seenKey, seenMap);
    console.log(`[LeetTracker] Saved chunk ${idx}`);
  }

  async function syncSubmissions(username) {
    // Attempt to acquire the sync lock
    if (!(await acquireSyncLock())) {
      console.log(`[LeetTracker] Could not acquire sync lock, skipping sync`);
      return;
    }

    console.log(
      "[LeetTracker] Starting submission sync...",
      username,
      new Date().toISOString()
    );

    // Critical threshold: 15s before timeout (165s)
    const CRITICAL_THRESHOLD_MS = HEARTBEAT_TIMEOUT_MS - 15000;

    // Enrichment cutoff: last 30 days
    const ENRICHMENT_CUTOFF_DAYS = 30;
    const ENRICHMENT_CUTOFF_TIMESTAMP =
      Math.floor(Date.now() / 1000) - ENRICHMENT_CUTOFF_DAYS * 24 * 60 * 60;

    try {
      const manifestKey = getManifestKey(username);
      const seenKey = getSeenProblemsKey(username);
      const visitLogKey = getVisitLogKey(username);
      const backfillQueueKey = `leettracker_backfill_queue_${username}`;

      const [visitLog, manifest, seenMap, userInfo] = await Promise.all([
        getFromStorage(visitLogKey, []),
        getFromStorage(manifestKey, {}),
        getFromStorage(seenKey, {}),
        getUserInfoWithCache(),
      ]);

      const userHasPremium = userInfo.isPremium || false;
      const lastT = manifest.lastTimestamp || 0;
      const prevTotalSubs = manifest.total || 0;
      const subs = await fetchAllSubmissions(lastT);
      const newTotalSubs = prevTotalSubs + subs.length;
      let totalSynced = manifest.totalSynced || prevTotalSubs;
      let skippedForBackfill = 0;

      console.log(
        `[LeetTracker] Fetched ${subs.length} new submissions (total: ${newTotalSubs})`
      );

      if (!subs.length) {
        console.log("[LeetTracker] No new submissions.");

        // Even with no new submissions, process backfill queue
        await processBackfillQueue(
          username,
          backfillQueueKey,
          seenMap,
          visitLog,
          userHasPremium,
          manifest,
          manifestKey,
          seenKey
        );
        return;
      }

      let chunkIdx = manifest.chunkCount - 1 || 0;
      let chunk = await getFromStorage(getChunkKey(username, chunkIdx), []);
      const meta = manifest.chunks || [];

      // Helper to flush chunk with all captured variables
      const executeFlushChunk = async () => {
        await flushChunk(
          username,
          chunkIdx,
          chunk,
          meta,
          manifestKey,
          seenKey,
          seenMap,
          newTotalSubs,
          totalSynced,
          skippedForBackfill
        );
      };

      // PRE-STEP: Count how many submissions we'll skip for backfill
      for (const sub of subs) {
        if (sub.timestamp < ENRICHMENT_CUTOFF_TIMESTAMP) {
          skippedForBackfill++;
        }
      }
      const enrichedCount = subs.length - skippedForBackfill;

      console.log(
        `[LeetTracker] Processing ${enrichedCount} recent submissions, queueing ${skippedForBackfill} for backfill`
      );

      // STEP 1: Process skipped submissions AS IS (no enrichment) and save to chunks
      if (skippedForBackfill > 0) {
        const backfillQueue = [];
        for (let i = 0; i < skippedForBackfill; i++) {
          const sub = subs[i];

          // Add to backfill queue for later enrichment
          backfillQueue.push({
            id: sub.id,
            titleSlug: sub.titleSlug,
            chunkIndex: chunkIdx, // Track which chunk it will be in
          });

          // Add submission AS IS to chunk (no enrichment)
          chunk.push(sub);
          totalSynced++;

          // Create new chunk after reaching 100 submissions
          if (chunk.length >= 100) {
            await executeFlushChunk();
            chunk = [];
            chunkIdx++;
          }
        }

        // Flush any remaining submissions from Step 1
        if (chunk.length > 0) {
          await executeFlushChunk();
          // Don't reset chunk, we'll continue adding to it in Step 2
        }

        // Save backfill queue if we have items to backfill
        if (backfillQueue.length > 0) {
          const existingQueue = await getFromStorage(backfillQueueKey, []);
          const combinedQueue = [...existingQueue, ...backfillQueue.reverse()];
          await saveToStorage(backfillQueueKey, combinedQueue);
          console.log(
            `[LeetTracker] Added ${backfillQueue.length} submissions to backfill queue (total: ${combinedQueue.length})`
          );
        }

        console.log(
          `[LeetTracker] ${skippedForBackfill} submissions saved for backfill`
        );
      }

      // STEP 2: Main loop - process recent submissions with enrichment
      for (let i = skippedForBackfill; i < subs.length; i++) {
        // 1. Update heartbeat BEFORE enrichment (abort if lock lost)
        await updateSyncHeartbeatOrFail(
          `heartbeat update at submission ${i}/${subs.length}`
        );

        // 2. Get the heartbeat timestamp we just wrote
        const lockBeforeEnrich = await getFromStorage(SYNC_LOCK_KEY, null);
        if (!lockBeforeEnrich || lockBeforeEnrich.sessionId !== SESSION_ID) {
          throw new Error(
            `Lost lock ownership after heartbeat update at submission ${i}/${subs.length}`
          );
        }

        const heartbeatBeforeEnrich = lockBeforeEnrich.lastHeartbeat;
        const enrichStartTime = Date.now();

        // 3. Do the work - FULL enrichment for recent submissions
        const sub = subs[i];
        await enrichSubmission(
          sub,
          seenMap,
          visitLog,
          username,
          userHasPremium
        );

        chunk.push(sub);
        totalSynced++;

        // 4. Verify heartbeat after enrichment
        const lockAfterEnrich = await getFromStorage(SYNC_LOCK_KEY, null);

        // ABORT if another process took over (heartbeat timestamp changed)
        if (lockAfterEnrich.lastHeartbeat !== heartbeatBeforeEnrich) {
          throw new Error(
            `Another process started sync (heartbeat changed from ${heartbeatBeforeEnrich} to ${lockAfterEnrich.lastHeartbeat}) at submission ${i}/${subs.length}`
          );
        }

        // ABORT if enrichment took too long (within 15s of expiring)
        const enrichDuration = Date.now() - enrichStartTime;
        if (enrichDuration >= CRITICAL_THRESHOLD_MS) {
          throw new Error(
            `Enrichment took ${Math.floor(
              enrichDuration / 1000
            )}s (critical threshold: ${Math.floor(
              CRITICAL_THRESHOLD_MS / 1000
            )}s), aborting at submission ${i}/${subs.length}`
          );
        }

        // 5. Update heartbeat again immediately after verification (abort if lock lost)
        await updateSyncHeartbeatOrFail(
          `post-enrichment heartbeat update at submission ${i}/${subs.length}`
        );

        // Yield to event loop
        await new Promise((r) => setTimeout(r, 100));

        // Create new chunk after reaching 100 submissions
        if (chunk.length >= 100) {
          await executeFlushChunk();
          chunk = [];
          chunkIdx++;
          await new Promise((r) => setTimeout(r, 10_000));
        } // Update manifest and flush current chunk every 20 submissions (without creating new chunk)
        else if (chunk.length % 20 === 0 && chunk.length < 100) {
          await executeFlushChunk();
          await new Promise((r) => setTimeout(r, 10_000));
        }
      }

      // Flush remaining chunk
      if (chunk.length) {
        await executeFlushChunk();
      }

      console.log(
        `[LeetTracker] Synced ${subs.length} submissions (${enrichedCount} fully enriched, ${skippedForBackfill} saved for backfill)`
      );
    } catch (e) {
      console.error("[LeetTracker] Sync failed:", e);
    } finally {
      console.log(
        "[LeetTracker] Finished submission sync",
        username,
        new Date().toISOString()
      );
      await releaseSyncLock();
    }
  }

  /**
   * Process up to 20 submissions from the backfill queue.
   * Groups by chunk to minimize storage operations.
   */
  async function processBackfillQueue(
    username,
    backfillQueueKey,
    seenMap,
    visitLog,
    userHasPremium,
    manifest,
    manifestKey,
    seenKey
  ) {
    const MAX_BACKFILL_PER_SYNC = 20;

    const queue = await getFromStorage(backfillQueueKey, []);
    if (!queue || queue.length === 0) {
      return; // Nothing to backfill
    }

    console.log(
      `[LeetTracker] Processing backfill queue (${queue.length} remaining)...`
    );

    // Take first 20 submissions
    const batchToProcess = queue.slice(0, MAX_BACKFILL_PER_SYNC);
    const remainingQueue = queue.slice(MAX_BACKFILL_PER_SYNC);

    // Group by chunk index to minimize storage operations
    const byChunk = new Map();
    for (const item of batchToProcess) {
      if (!byChunk.has(item.chunkIndex)) {
        byChunk.set(item.chunkIndex, []);
      }
      byChunk.get(item.chunkIndex).push(item.id);
    }

    // Process each chunk
    let processedCount = 0;
    for (const [chunkIndex, subIds] of byChunk) {
      try {
        const chunk = await getFromStorage(
          getChunkKey(username, chunkIndex),
          []
        );

        for (const subId of subIds) {
          // Update heartbeat before enriching each submission (abort if lock lost)
          await updateSyncHeartbeatOrFail(
            `backfill enrichment (chunk ${chunkIndex}, sub ${subId})`
          );

          const sub = chunk.find((s) => s.id === subId);
          if (sub) {
            // Re-enrich with full data
            await enrichSubmission(
              sub,
              seenMap,
              visitLog,
              username,
              userHasPremium
            );
            processedCount++;
          }

          // Update heartbeat after enriching each submission (abort if lock lost)
          await updateSyncHeartbeatOrFail(
            `backfill post-enrichment (chunk ${chunkIndex}, sub ${subId})`
          );
        }

        // Save chunk with all enriched submissions
        await saveToStorage(getChunkKey(username, chunkIndex), chunk);
      } catch (error) {
        // If lock ownership lost, re-throw to abort backfill
        if (error.message && error.message.includes("Lost lock ownership")) {
          throw error;
        }

        console.warn(
          `[LeetTracker] Backfill failed for chunk ${chunkIndex}:`,
          error
        );
        // Continue processing other chunks for non-lock errors
      }
    }

    // Update backfill queue
    await saveToStorage(backfillQueueKey, remainingQueue);

    // Update manifest with backfill timestamp (notify webapp)
    if (processedCount > 0) {
      manifest.backfillProcessedAt = Date.now();
      await saveToStorage(manifestKey, manifest);

      // Persist seenMap changes (premium status, description flags, etc.)
      await saveToStorage(seenKey, seenMap);

      console.log(
        `[LeetTracker] Backfill: processed ${processedCount}, ${remainingQueue.length} remaining`
      );
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
            query: `query globalData { 
              userStatus { 
                username 
                activeSessionId 
                isSignedIn 
                isPremium
              } 
            }`,
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
              isPremium: userStatus.isPremium || false,
            };
            console.log(
              `[LeetTracker] User ${cachedUserInfo.username} premium status: ${cachedUserInfo.isPremium}`
            );
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
