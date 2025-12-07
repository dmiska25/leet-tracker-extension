// src/core/storage.js

// IndexedDB wrapper for larger data storage
class LeetTrackerDB {
  constructor() {
    this.db = null;
    this.initPromise = this.init();
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("LeetTrackerDB", 3);

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
          `[LeetTracker] Upgrading IndexedDB from version ${oldVersion} to 3`
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

        // Hint events store - tracks hint/solution views during problem solving
        if (!db.objectStoreNames.contains("hintEvents")) {
          const hintStore = db.createObjectStore("hintEvents", {
            keyPath: "id",
          });
          hintStore.createIndex("username", "username");
          hintStore.createIndex("problemSlug", "problemSlug");
          hintStore.createIndex("timestamp", "timestamp");
        }

        // Migration from v1 to v2: Convert seen problems list to new object format
        if (oldVersion === 1) {
          console.log(
            "[LeetTracker] Migrating seen problems from v1 to v2 format..."
          );

          // Wait for transaction to complete before accessing chrome.storage
          transaction.oncomplete = async () => {
            try {
              // Get all keys in chrome.storage
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
                          item.isPremium !== undefined ? item.isPremium : null,
                        hasDescription: item.hasDescription || false,
                      };
                    }
                  });
                } else if (seenData && typeof seenData === "object") {
                  // Already in object format, check if it needs property updates
                  const firstKey = Object.keys(seenData)[0];
                  if (
                    firstKey &&
                    !Object.prototype.hasOwnProperty.call(
                      seenData[firstKey],
                      "isPremium"
                    )
                  ) {
                    // Old object format without isPremium
                    needsMigration = true;
                    Object.keys(seenData).forEach((slug) => {
                      newFormat[slug] = {
                        isPremium: null, // Force re-fetch to get actual status
                        hasDescription: seenData[slug].hasDescription || false,
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
                if (
                  manifest &&
                  !Object.prototype.hasOwnProperty.call(manifest, "total")
                ) {
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
    const id = `${username}_${problemSlug}_${runData.timestamp || Date.now()}`;
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

  // --- Hint Event Management ---
  async storeHintEvent(username, problemSlug, hintData) {
    const db = await this.ensureDB();
    const id = `${username}_${problemSlug}_${hintData.timestamp || Date.now()}`;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(["hintEvents"], "readwrite");
      const store = transaction.objectStore("hintEvents");
      const data = {
        id,
        username,
        problemSlug,
        ...hintData,
      };
      const request = store.put(data);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getHintEventsInWindow(username, problemSlug, startMs, endMs) {
    const db = await this.ensureDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(["hintEvents"], "readonly");
      const store = tx.objectStore("hintEvents");
      const idx = store.index("timestamp");

      const range =
        startMs != null && endMs != null
          ? IDBKeyRange.bound(startMs, endMs)
          : startMs != null
            ? IDBKeyRange.lowerBound(startMs)
            : endMs != null
              ? IDBKeyRange.upperBound(endMs)
              : null;

      const events = [];
      const req = range ? idx.openCursor(range) : idx.openCursor();

      req.onsuccess = (ev) => {
        const cursor = ev.target.result;
        if (cursor) {
          const v = cursor.value;
          if (v.username === username && v.problemSlug === problemSlug) {
            events.push(v);
          }
          cursor.continue();
        } else {
          events.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
          resolve(events);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }
}

// Expose a simple factory; actual instance should be created by the bootstrap (or existing content.js)
export function create() {
  return new LeetTrackerDB();
}
