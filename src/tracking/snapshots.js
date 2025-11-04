// src/tracking/snapshots.js
import DiffMatchPatch from "diff-match-patch";
import { consts, keys, store } from "../core/config.js";
import { getUserInfoWithCache } from "../leetcode/api.js";
import {
  getCurrentProblemId,
  getProblemIdFromSlug,
  getCodeFromLeetCodeDB,
  getCurrentProblemSlug,
} from "../leetcode/database.js";
import { withSnapshotLock } from "../core/locks.js";
import { recordProblemVisit } from "./watchers.js";
import { getDBInstance } from "../core/db-instance.js";

const { GRAPHQL_URL, DAY_S } = consts;

// Initialize diff-match-patch for use throughout the module
const dmp = new DiffMatchPatch();
dmp.Diff_Timeout = 1; // seconds
dmp.Patch_DeleteThreshold = 0.5;

// ------------------------------
// Text normalization & diff/patch
// ------------------------------
export function normalizeText(raw) {
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

export function createChecksum(text) {
  let hash = 0;
  if (!text || text.length === 0) return hash.toString();
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32bit int
  }
  return hash.toString();
}

export function makePatch(beforeRaw, afterRaw) {
  const before = normalizeText(beforeRaw);
  const after = normalizeText(afterRaw);

  const diffs = dmp.diff_main(before, after);
  dmp.diff_cleanupSemantic(diffs);

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

export function applyPatch(baseRaw, patchText, expectedChecksum = null) {
  const base = normalizeText(baseRaw);

  if (expectedChecksum && createChecksum(base) !== expectedChecksum) {
    console.warn(
      "[LeetTracker] Checksum mismatch detected during patch application"
    );
  }

  const patches = dmp.patch_fromText(patchText);
  const [result, results] = dmp.patch_apply(patches, base);

  return {
    text: result,
    applied: results.every((r) => r === true),
    partialResults: results,
  };
}

export function calculateCodeSimilarity(code1, code2) {
  const norm1 = normalizeText(code1);
  const norm2 = normalizeText(code2);

  if (norm1.length === 0 && norm2.length === 0) return 1;
  if (norm1.length === 0 || norm2.length === 0) return 0;

  const diffs = dmp.diff_main(norm1, norm2);

  const totalLength = Math.max(norm1.length, norm2.length);
  let changedLength = 0;

  diffs.forEach(([op, text]) => {
    if (op !== 0) changedLength += text.length; // 0=EQUAL, 1=INSERT, -1=DELETE
  });

  return Math.max(0, (totalLength - changedLength) / totalLength);
}

// ------------------------------
// Language helpers (localStorage + user)
// ------------------------------
export function getSelectedLanguageForProblem(problemId, userId) {
  if (!problemId || !userId) return null;
  const key = `${problemId}_${userId}_lang`;
  return localStorage.getItem(key);
}

export async function detectCurrentLanguage(code, problemSlug = null) {
  try {
    const { userId } = await getUserInfoWithCache();
    const problemId = problemSlug
      ? await getProblemIdFromSlug(problemSlug)
      : null;
    if (problemId && userId) {
      let lang = getSelectedLanguageForProblem(problemId, userId);
      if (lang.startsWith('"') && lang.endsWith('"')) {
        lang = JSON.parse(lang);
      }
      if (lang) return lang;
    }
  } catch {
    // continue to fallback
  }

  try {
    const savedLang = localStorage.getItem("global_lang");
    if (savedLang) {
      let cleanLang = savedLang;
      if (savedLang.startsWith('"') && savedLang.endsWith('"')) {
        cleanLang = JSON.parse(savedLang);
      }
      return cleanLang.toLowerCase().trim();
    }
  } catch {
    // ignore
  }

  return "python3";
}

// ------------------------------
// Read current code from page/LeetCode DB
// ------------------------------
export async function getCurrentCode() {
  let bestResult = null;
  let bestMethod = "none";

  // Method 1: LeetCode's IndexedDB (preferred)
  try {
    const { problemSlug, problemId } = await getCurrentProblemId();
    if (problemId) {
      const currentLang = await detectCurrentLanguage("", problemSlug);
      const leetcodeCode = await getCodeFromLeetCodeDB(problemId, currentLang);
      if (leetcodeCode) {
        bestResult = leetcodeCode;
        bestMethod = "leetcodeIndexedDB";
      }
    }
  } catch {
    // fall back
  }

  // Method 2: any textarea content
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
    } catch {
      // ignore
    }
  }

  return {
    bestGuess: bestResult,
    bestMethod,
    allResults: bestResult ? { [bestMethod]: bestResult } : {},
  };
}

export function shouldTakeSnapshot(oldCode, newCode) {
  if (!oldCode || !newCode) return true;

  const normalizedOld = normalizeText(oldCode);
  const normalizedNew = normalizeText(newCode);

  const diffs = dmp.diff_main(normalizedOld, normalizedNew);

  let charChanges = 0;
  let lineChanges = 0;

  diffs.forEach(([op, text]) => {
    if (op !== 0) {
      charChanges += text.length;
      lineChanges += (text.match(/\n/g) || []).length;
    }
  });

  return charChanges >= 30 || lineChanges >= 2;
}

// ------------------------------
// Snapshot reconstruction
// ------------------------------
export function reconstructCodeFromSnapshots(snapshots, targetIndex = -1) {
  if (!snapshots || snapshots.length === 0) return "";
  if (targetIndex === -1) targetIndex = snapshots.length - 1;
  if (targetIndex >= snapshots.length) return "";

  // Most recent checkpoint at/before target
  let baseIndex = targetIndex;
  while (baseIndex >= 0 && !snapshots[baseIndex].fullCode) {
    baseIndex--;
  }
  if (baseIndex < 0) {
    console.error("[LeetTracker] No checkpoint found in snapshots");
    return "";
  }

  let code = snapshots[baseIndex].fullCode;

  for (let i = baseIndex + 1; i <= targetIndex; i++) {
    const snapshot = snapshots[i];

    if (snapshot.patchText) {
      const result = applyPatch(
        code,
        snapshot.patchText,
        snapshot.checksumBefore
      );
      code = result.text;
      if (!result.applied) {
        console.warn(
          `[LeetTracker] Failed to apply patch ${i}, continuing with partial result`
        );
      }
    } else if (snapshot.patch) {
      // Legacy fallback (if present)
      try {
        if (globalThis.Diff && globalThis.Diff.applyPatch) {
          const result = globalThis.Diff.applyPatch(code, snapshot.patch);
          code = result || code;
        } else {
          console.warn(
            `[LeetTracker] Cannot apply legacy patch ${i}, skipping`
          );
        }
      } catch (e) {
        console.error(`[LeetTracker] Failed to apply legacy patch ${i}:`, e);
      }
    }
  }

  return code;
}

// ------------------------------
// Snapshot writer
// ------------------------------
export async function takeCodeSnapshot(username, problemSlug) {
  return withSnapshotLock(username, problemSlug, async () => {
    // Get current code
    const codeResult = await getCurrentCode();
    if (!codeResult || !codeResult.bestGuess) {
      console.log("[LeetTracker] No code found to snapshot");
      return;
    }
    const currentCode = codeResult.bestGuess;

    // Read snapshots from IndexedDB
    let snapshots = [];
    let lastFinalCode = "";
    try {
      const snapshotData = await (
        await getDBInstance()
      ).getSnapshots(username, problemSlug);
      snapshots = snapshotData.snapshots || [];
      lastFinalCode = snapshotData.lastFinalCode || "";
    } catch (error) {
      console.warn(
        "[LeetTracker] IndexedDB read failed, skipping snapshot:",
        error
      );
      return;
    }

    const lastCode =
      snapshots.length > 0
        ? lastFinalCode ||
          snapshots[snapshots.length - 1].fullCode ||
          reconstructCodeFromSnapshots(snapshots)
        : "";

    if (!shouldTakeSnapshot(lastCode, currentCode)) return;

    const patchResult = makePatch(lastCode, currentCode);
    if (!patchResult) return;

    const snapshot = {
      timestamp: Date.now(),
      patchText: patchResult.patchText,
      checksumBefore: patchResult.checksumBefore,
      checksumAfter: patchResult.checksumAfter,
      encodingInfo: "utf8 + nfc + lf",
    };

    const isCheckpoint = snapshots.length === 0 || snapshots.length % 25 === 0;
    if (isCheckpoint) {
      snapshot.fullCode = patchResult.afterNorm;
      snapshot.isCheckpoint = true;
    }

    if (snapshots.length > 0) {
      const test = applyPatch(
        lastCode,
        patchResult.patchText,
        patchResult.checksumBefore
      );
      if (!test.applied || test.text !== patchResult.afterNorm) {
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

    const snapshotData = {
      snapshots,
      lastFinalCode: patchResult.afterNorm,
      lastUpdated: Date.now(),
    };

    try {
      await (
        await getDBInstance()
      ).storeSnapshots(username, problemSlug, snapshotData);
    } catch (error) {
      console.warn(
        "[LeetTracker] Failed to save snapshot to IndexedDB:",
        error
      );
    }
  });
}

// ------------------------------
// Template cache & "fresh start" detection
// ------------------------------
export async function fetchProblemCodeTemplate(titleSlug) {
  if (!GRAPHQL_URL) return [];
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

export async function cacheTemplatesForProblem(problemSlug) {
  // Try IndexedDB (preferred)
  try {
    const idbTemplates = await (
      await getDBInstance()
    ).getTemplates(problemSlug);
    if (idbTemplates) return idbTemplates;
  } catch (e) {
    console.warn(
      "[LeetTracker] IndexedDB read failed, trying chrome.storage fallback:",
      e
    );
  }

  // Fallback to chrome.storage
  const templatesKey = keys.getTemplatesKey
    ? keys.getTemplatesKey(problemSlug)
    : keys.templates
    ? keys.templates(problemSlug)
    : `leettracker_templates_${problemSlug}`;

  const storageCached = await store.get(templatesKey, null);
  if (storageCached && Date.now() - storageCached.timestamp < 86400000) {
    return storageCached.templates;
  }

  try {
    const templates = await fetchProblemCodeTemplate(problemSlug);
    if (templates.length > 0) {
      try {
        await (await getDBInstance()).storeTemplates(problemSlug, templates);
      } catch (indexError) {
        console.warn(
          "[LeetTracker] IndexedDB store failed, using chrome.storage fallback:",
          indexError
        );
        await store.set(templatesKey, {
          templates,
          timestamp: Date.now(),
          problemSlug,
        });
      }
    }
    return templates;
  } catch (error) {
    console.error("❌ [Template Cache] Failed to fetch templates:", error);
    return storageCached?.templates || [];
  }
}

export async function checkForFreshStart(currentCode, problemSlug) {
  try {
    const templates = await cacheTemplatesForProblem(problemSlug);
    if (!templates || templates.length === 0) return false;

    const currentLang = await detectCurrentLanguage(currentCode, problemSlug);
    const template = templates.find((t) => t.langSlug === currentLang);
    if (!template) return false;

    const similarity = calculateCodeSimilarity(template.code, currentCode);
    return similarity >= 0.98;
  } catch (error) {
    console.error("❌ [Fresh Start] Error during check:", error);
    return false;
  }
}

export async function handleFreshStartReset(
  username,
  problemSlug,
  currentCode
) {
  return withSnapshotLock(username, problemSlug, async () => {
    // Read snapshots
    let snapshots = [];
    try {
      const snapshotData = await (
        await getDBInstance()
      ).getSnapshots(username, problemSlug);
      snapshots = snapshotData.snapshots || [];
    } catch (error) {
      return false;
    }

    if (snapshots.length < 1) return false;

    const matchesTemplate = await checkForFreshStart(currentCode, problemSlug);
    if (!matchesTemplate) return false;

    if (snapshots.length === 1) return false;

    // Record problem visit for solve-window tracking
    recordProblemVisit(username, problemSlug);

    try {
      await (
        await getDBInstance()
      ).storeSnapshots(username, problemSlug, {
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
  });
}

export function startFreshStartWatcher(username) {
  setInterval(async () => {
    const slug = getCurrentProblemSlug();
    if (!slug) return;

    const codeResult = await getCurrentCode();
    if (!codeResult || !codeResult.bestGuess) return;

    await handleFreshStartReset(username, slug, codeResult.bestGuess);
  }, 500);
}
