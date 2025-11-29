// src/leetcode/database.js
import { consts, keys, store } from "../core/config.js";
import { fetchProblemDescription, getUserInfoWithCache } from "./api.js";

const { GRAPHQL_URL } = consts;
const PKEY = keys.problemIdMap;

// In-memory slug -> questionId cache for this content-script lifetime
const slugToId = new Map();

/**
 * Open LeetCode's IndexedDB ("LeetCode-problems") and return basic handles.
 * Returns { db, store, keys } when available; { db, store:null, keys:[] } if store missing; null on error.
 */
export async function exploreLeetCodeIndexedDB() {
  try {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("LeetCode-problems");

      request.onerror = () => reject(request.error);

      request.onsuccess = () => {
        const db = request.result;

        if (db.objectStoreNames.contains("problem_code")) {
          const transaction = db.transaction(["problem_code"], "readonly");
          const store = transaction.objectStore("problem_code");

          const keysRequest = store.getAllKeys();
          keysRequest.onsuccess = () => {
            resolve({
              db,
              store,
              keys: keysRequest.result,
            });
          };
          keysRequest.onerror = () => {
            resolve({ db, store, keys: [] });
          };
        } else {
          resolve({ db, store: null, keys: [] });
        }
      };
    });
  } catch (error) {
    console.warn("[LeetTracker] exploreLeetCodeIndexedDB failed:", error);
    return null;
  }
}

/**
 * Extract current problem slug from location pathname.
 */
export function getCurrentProblemSlug() {
  const m = window.location.pathname.match(/^\/problems\/([^\/]+)\/?/);
  return m ? m[1] : null;
}

/**
 * Resolve slug -> questionId with layered caching:
 * 1) in-memory Map
 * 2) chrome.storage at key problemIdMap
 * 3) network fetch via fetchProblemDescription; falls back to local GraphQL call
 */
export async function getProblemIdFromSlug(problemSlug) {
  if (!problemSlug) return null;

  // 1) In-memory cache
  if (slugToId.has(problemSlug)) {
    return slugToId.get(problemSlug);
  }

  // 2) Persistent cache
  let storedMap = {};
  try {
    storedMap = (await store.get(PKEY, {})) || {};
    if (storedMap[problemSlug]) {
      const pid = storedMap[problemSlug];
      slugToId.set(problemSlug, pid);
      return pid;
    }
  } catch (e) {
    // continue to network fetch
  }

  // 3) Network fetch for question detail
  let question = null;
  try {
    question = await fetchProblemDescription(problemSlug);
  } catch (err) {
    console.warn(
      `[LeetTracker] fetchProblemDescription failed for '${problemSlug}':`,
      err
    );
    question = null;
  }

  if (!question || !question.questionId) {
    console.warn(
      `[LeetTracker] Could not resolve questionId for slug '${problemSlug}'.`
    );
    return null;
  }

  const problemId = question.questionId;

  // Update caches
  slugToId.set(problemSlug, problemId);
  try {
    const persisted = (await store.get(PKEY, {})) || {};
    persisted[problemSlug] = problemId;
    await store.set(PKEY, persisted);
    console.log(
      `[LeetTracker] Cached problem ID mapping: ${problemSlug} -> ${problemId}`
    );
  } catch (e) {
    console.warn("[LeetTracker] Failed to persist problem ID mapping:", e);
  }

  return problemId;
}

/**
 * Return current problem identifiers. Shape matches previous implementation:
 * { problemSlug, problemId, method: "cached" | "slug-only" | "no-slug" }
 */
export async function getCurrentProblemId() {
  const problemSlug = getCurrentProblemSlug();
  if (!problemSlug) {
    return { problemSlug: null, problemId: null, method: "no-slug" };
  }
  const problemId = await getProblemIdFromSlug(problemSlug);
  return { problemSlug, problemId, method: problemId ? "cached" : "slug-only" };
}

/**
 * Read the user's current code for a given problemId and language from LeetCode's IndexedDB.
 * Requires the active userId; attempts to read via getUserInfoWithCache.
 */
export async function getCodeFromLeetCodeDB(problemId, language = "python3") {
  try {
    // Resolve userId
    let userId = null;
    try {
      const info = await getUserInfoWithCache();
      userId = info?.userId || null;
    } catch {
      userId = null;
    }
    if (!userId) return null;

    // Open LC's IndexedDB
    const dbInfo = await exploreLeetCodeIndexedDB();
    if (!dbInfo || !dbInfo.store) return null;

    const codeKey = `${problemId}_${userId}_${language}`;
    try {
      return await _getCodeByKey(dbInfo, codeKey);
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * Helper to fetch value by key from LC's "problem_code" object store.
 */
export async function _getCodeByKey(dbInfo, key) {
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
