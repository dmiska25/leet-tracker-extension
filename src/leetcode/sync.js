// src/leetcode/sync.js
import { consts, keys, store } from "../core/config.js";
import {
  fetchAllSubmissions,
  fetchProblemPremiumStatus,
  getUserInfoWithCache,
  fetchDescriptionIfNeeded,
  fetchNoteSafe,
  fetchSubmissionDetailsSafe,
} from "./api.js";
import {
  acquireSyncLock,
  releaseSyncLock,
  updateSyncHeartbeatOrFail,
  sessionId,
} from "../core/locks.js";
import {
  takeCodeSnapshot,
  reconstructCodeFromSnapshots,
} from "../tracking/snapshots.js";
import { getDBInstance } from "../core/db-instance.js";
import { getAnalytics } from "../core/analytics.js";

const { SYNC_LOCK_KEY, HEARTBEAT_TIMEOUT_MS, DAY_S } = consts;
const {
  visitLog: getVisitLogKey,
  manifest: getManifestKey,
  seenProblems: getSeenProblemsKey,
  chunk: getChunkKey,
  recentJourneys: getRecentJourneysKey,
  recentRuns: getRecentRunsKey,
} = keys;
const { get: getFromStorage, set: saveToStorage } = store;

// --------------- derive solve window from visit log ---------------
export function deriveSolveWindow(sub, visitLog) {
  // sub.timestamp is seconds; visitLog entries are seconds; DAY_S is in scope.
  const hits = (visitLog || [])
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

// --------------- snapshot/run data loaders ---------------
export async function loadSnapshotsIfApplicable(sub, username) {
  if (sub.statusDisplay !== "Accepted" || !username) return null;
  try {
    return await (await getDBInstance()).getSnapshots(username, sub.titleSlug);
  } catch (error) {
    console.warn(
      "[LeetTracker] IndexedDB read failed for submission enrichment, skipping journey capture:",
      error
    );
    return null;
  }
}

export function buildCodingJourneyFromSnapshots(
  snapshotsData,
  submissionTsSec
) {
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

export async function buildRunEventsForSubmission(
  sub,
  username,
  startCandidatesMs
) {
  if (sub.statusDisplay !== "Accepted" || !username) return null;

  const endMs = sub.timestamp * 1000;
  if (!startCandidatesMs || startCandidatesMs.length === 0) return null;

  const startMs = Math.min(...startCandidatesMs);

  const runs = await (
    await getDBInstance()
  ).getRunEventsInWindow(username, sub.titleSlug, startMs, endMs);

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
    firstRun: runs[0].startedAt || runs[0].timestamp,
    lastRun: runs[runs.length - 1].startedAt || runs[runs.length - 1].timestamp,
    hasDetailedRuns: true,
    runs: summarized,
    _window: { startMs, endMs },
  };
}

export async function storeRecentJourney(username, submission) {
  if (!submission.codingJourney || !submission.codingJourney.snapshots) {
    return;
  }

  const key = getRecentJourneysKey(username);
  const recent = (await getFromStorage(key, [])) || [];

  recent.unshift({
    submissionId: submission.id,
    titleSlug: submission.titleSlug,
    timestamp: submission.timestamp,
    codingJourney: submission.codingJourney,
  });

  if (recent.length > 20) recent.splice(20);

  await saveToStorage(key, recent);

  try {
    await (await getDBInstance()).storeJourneyArchive(username, submission);
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

export async function storeRecentRunGroup(username, submission, runEvents) {
  if (!runEvents || !runEvents.runs) return;

  const key = getRecentRunsKey(username);
  const recent = (await getFromStorage(key, [])) || [];

  recent.unshift({
    submissionId: submission.id,
    titleSlug: submission.titleSlug,
    timestamp: submission.timestamp,
    runEvents,
  });

  if (recent.length > 20) recent.splice(20);

  await saveToStorage(key, recent);

  const original = submission.runEvents;
  try {
    submission.runEvents = runEvents;
    await (await getDBInstance()).storeRunGroupArchive(username, submission);
    console.log(
      `[LeetTracker] Archived run group for ${submission.titleSlug} (submission ${submission.id})`
    );
  } catch (error) {
    console.warn(
      "[LeetTracker] Failed to archive run group to IndexedDB:",
      error
    );
  } finally {
    submission.runEvents = original;
  }

  console.log(
    `[LeetTracker] Stored recent run group for ${submission.titleSlug}`
  );
}

export async function attachCodingJourney(sub, username, codingJourney) {
  sub.codingJourney = codingJourney;
  await storeRecentJourney(username, sub);

  sub.codingJourney = {
    snapshotCount: codingJourney.snapshotCount,
    totalCodingTime: codingJourney.totalCodingTime,
    firstSnapshot: codingJourney.firstSnapshot,
    lastSnapshot: codingJourney.lastSnapshot,
    hasDetailedJourney: true,
  };
}

export function attachRunEvents(sub, runEvents) {
  if (runEvents) {
    sub.runEvents = {
      count: runEvents.count,
      firstRun: runEvents.firstRun,
      lastRun: runEvents.lastRun,
      hasDetailedRuns: true,
    };
  }
}

// --------------- chunk/manifest helpers ---------------
export async function flushChunk(
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

  await saveToStorage(seenKey, seenMap);
  console.log(`[LeetTracker] Saved chunk ${idx}`);
}

// --------------- enrichment ---------------
export async function enrichSubmission(
  sub,
  seenMap,
  visitLog,
  username,
  userHasPremium = false
) {
  // 1) Compute solve window
  const { startSec, solveTimeSec } = deriveSolveWindow(sub, visitLog);
  sub.solveTime = solveTimeSec;

  const startCandidatesMs = [];
  if (startSec != null) startCandidatesMs.push(startSec * 1000);

  // 2) Premium check/cache
  let seenInfo = seenMap[sub.titleSlug];
  let isPremiumProblem = false;

  if (
    seenInfo &&
    seenInfo.isPremium !== null &&
    seenInfo.isPremium !== undefined
  ) {
    isPremiumProblem = seenInfo.isPremium;
  } else {
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

  if (isPremiumProblem) {
    sub.isPremiumProblem = true;
  }

  // 3) Skip enrichment if premium and user lacks premium
  if (isPremiumProblem && !userHasPremium) {
    return;
  }

  // 4) Parallel fetches
  const [desc, note, details, snapshotsData] = await Promise.all([
    fetchDescriptionIfNeeded(sub, seenMap),
    fetchNoteSafe(sub),
    fetchSubmissionDetailsSafe(sub),
    loadSnapshotsIfApplicable(sub, username),
  ]);

  // 5) Validation logs
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

  // 6) Apply data + update seenMap
  if (desc) {
    sub.problemDescription = desc;
    const existing = seenMap[sub.titleSlug] || { isPremium: null };
    seenMap[sub.titleSlug] = { ...existing, hasDescription: true };
  }
  if (note) sub.problemNote = note;
  if (details) {
    if (details.code) sub.code = details.code;
    if (details.submissionDetails)
      sub.submissionDetails = details.submissionDetails;
  }

  // 7) Coding journey
  const journey = buildCodingJourneyFromSnapshots(snapshotsData, sub.timestamp);
  if (journey) {
    startCandidatesMs.push(journey.earliestSnapshotMs);
    await attachCodingJourney(sub, username, journey.codingJourney);
    console.log(
      `[LeetTracker] Captured ${journey.codingJourney.snapshotCount} snapshots for submission ${sub.id} (${sub.titleSlug})`
    );
  }

  // 8) Run events
  try {
    const runEvents = await buildRunEventsForSubmission(
      sub,
      username,
      startCandidatesMs
    );

    if (runEvents) {
      await storeRecentRunGroup(username, sub, runEvents);
    }

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

// --------------- backfill queue ---------------
export async function processBackfillQueue(
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

  const batchToProcess = queue.slice(0, MAX_BACKFILL_PER_SYNC);
  const remainingQueue = queue.slice(MAX_BACKFILL_PER_SYNC);

  const byChunk = new Map();
  for (const item of batchToProcess) {
    if (!byChunk.has(item.chunkIndex)) {
      byChunk.set(item.chunkIndex, []);
    }
    byChunk.get(item.chunkIndex).push(item.id);
  }

  let processedCount = 0;
  for (const [chunkIndex, subIds] of byChunk) {
    try {
      const chunk = await getFromStorage(getChunkKey(username, chunkIndex), []);

      for (const subId of subIds) {
        await updateSyncHeartbeatOrFail(
          `backfill enrichment (chunk ${chunkIndex}, sub ${subId})`
        );

        const sub = chunk.find((s) => s.id === subId);
        if (sub) {
          await enrichSubmission(
            sub,
            seenMap,
            visitLog,
            username,
            userHasPremium
          );
          processedCount++;
        }

        await updateSyncHeartbeatOrFail(
          `backfill post-enrichment (chunk ${chunkIndex}, sub ${subId})`
        );
      }

      await saveToStorage(getChunkKey(username, chunkIndex), chunk);
    } catch (error) {
      if (error.message && error.message.includes("Lost lock ownership")) {
        throw error;
      }
      console.warn(
        `[LeetTracker] Backfill failed for chunk ${chunkIndex}:`,
        error
      );
    }
  }

  await saveToStorage(backfillQueueKey, remainingQueue);

  if (processedCount > 0) {
    manifest.backfillProcessedAt = Date.now();
    await saveToStorage(manifestKey, manifest);
    await saveToStorage(seenKey, seenMap);

    console.log(
      `[LeetTracker] Backfill: processed ${processedCount}, ${remainingQueue.length} remaining`
    );

    // Track backfill progress
    const analytics = getAnalytics();
    analytics.capture("backfill_processed", {
      username,
      items_processed: processedCount,
      items_remaining: remainingQueue.length,
      batch_size: MAX_BACKFILL_PER_SYNC,
    });
  }
}

// --------------- main sync orchestrator ---------------
export async function syncSubmissions(username) {
  const analytics = getAnalytics();
  const syncStartTime = Date.now();

  // will be set after loading manifest, defined here for error reporting
  let lastT = null;
  let prevTotalSubs = null;
  let isFirstSync = null;

  if (!(await acquireSyncLock())) {
    console.log(`[LeetTracker] Could not acquire sync lock, skipping sync`);
    analytics.capture("sync_skipped", {
      username,
      reason: "lock_held_by_other_tab",
    });
    return { success: false, error: "lock_held" };
  }

  const SESSION_ID = sessionId();
  console.log(
    "[LeetTracker] Starting submission sync...",
    username,
    new Date().toISOString()
  );

  const CRITICAL_THRESHOLD_MS = HEARTBEAT_TIMEOUT_MS - 15000;
  const ENRICHMENT_CUTOFF_DAYS = 90;
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
    lastT = manifest.lastTimestamp || 0;
    prevTotalSubs = manifest.total || 0;
    isFirstSync = lastT === 0;

    const subs = await fetchAllSubmissions(lastT);
    const newTotalSubs = prevTotalSubs + subs.length;
    let totalSynced = manifest.totalSynced || prevTotalSubs;
    let skippedForBackfill = 0;

    console.log(
      `[LeetTracker] Fetched ${subs.length} new submissions (total: ${newTotalSubs})`
    );

    if (!subs.length) {
      console.log("[LeetTracker] No new submissions.");

      // For first-time users with no submissions, initialize empty manifest
      if (isFirstSync) {
        console.log(
          "[LeetTracker] First-time user with no submissions, initializing empty manifest"
        );
        await saveToStorage(manifestKey, {
          chunkCount: 0,
          lastTimestamp: 1, // mark 1 so we know we've done first sync
          chunks: [],
          total: 0,
          totalSynced: 0,
          skippedForBackfill: 0,
        });

        analytics.capture("sync_completed_first_time_empty", {
          username,
          duration_ms: Date.now() - syncStartTime,
        });

        return {
          success: true,
          newSolves: 0,
          isBackfill: false,
          isFirstSync: true,
        };
      }

      analytics.capture(
        "sync_no_new_submissions",
        {
          username,
          total_submissions: prevTotalSubs,
          last_sync_timestamp: lastT,
        },
        { throttle: true, throttleDuration: 3600000 } // 1 hour
      );

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
      return { success: true, newSolves: 0, isBackfill: false };
    }

    let chunkIdx = manifest.chunkCount - 1 || 0;
    let chunk = await getFromStorage(getChunkKey(username, chunkIdx), []);
    const meta = manifest.chunks || [];

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

    for (const sub of subs) {
      if (sub.timestamp < ENRICHMENT_CUTOFF_TIMESTAMP) {
        skippedForBackfill++;
      }
    }
    const enrichedCount = subs.length - skippedForBackfill;

    console.log(
      `[LeetTracker] Processing ${enrichedCount} recent submissions, queueing ${skippedForBackfill} for backfill`
    );

    if (skippedForBackfill > 0) {
      const backfillQueue = [];
      for (let i = 0; i < skippedForBackfill; i++) {
        const sub = subs[i];

        backfillQueue.push({
          id: sub.id,
          titleSlug: sub.titleSlug,
          chunkIndex: chunkIdx,
        });

        chunk.push(sub);
        totalSynced++;

        if (chunk.length >= 100) {
          await executeFlushChunk();
          chunk = [];
          chunkIdx++;
        }
      }

      if (chunk.length > 0) {
        await executeFlushChunk();
      }

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

    // Track enriched solves for toast notification
    const enrichedSolves = [];

    for (let i = skippedForBackfill; i < subs.length; i++) {
      await updateSyncHeartbeatOrFail(
        `heartbeat update at submission ${i}/${subs.length}`
      );

      const lockBeforeEnrich = await getFromStorage(SYNC_LOCK_KEY, null);
      if (!lockBeforeEnrich || lockBeforeEnrich.sessionId !== SESSION_ID) {
        throw new Error(
          `Lost lock ownership after heartbeat update at submission ${i}/${subs.length}`
        );
      }

      const heartbeatBeforeEnrich = lockBeforeEnrich.lastHeartbeat;
      const enrichStartTime = Date.now();

      const sub = subs[i];
      await enrichSubmission(sub, seenMap, visitLog, username, userHasPremium);

      // Track this solve for notification (only accepted solves)
      if (sub.statusDisplay === "Accepted") {
        enrichedSolves.push({
          slug: sub.titleSlug,
          duration: sub.solveTime || null,
        });
      }

      chunk.push(sub);
      totalSynced++;

      const lockAfterEnrich = await getFromStorage(SYNC_LOCK_KEY, null);
      if (
        !lockAfterEnrich ||
        lockAfterEnrich.lastHeartbeat !== heartbeatBeforeEnrich
      ) {
        throw new Error(
          `Another process started sync (heartbeat changed from ${heartbeatBeforeEnrich} to ${lockAfterEnrich?.lastHeartbeat}) at submission ${i}/${subs.length}`
        );
      }

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

      await updateSyncHeartbeatOrFail(
        `post-enrichment heartbeat update at submission ${i}/${subs.length}`
      );

      await new Promise((r) => setTimeout(r, 100));

      if (chunk.length >= 100) {
        await executeFlushChunk();
        chunk = [];
        chunkIdx++;
        await new Promise((r) => setTimeout(r, 10_000));
      } else if (chunk.length % 20 === 0 && chunk.length < 100) {
        await executeFlushChunk();
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }

    if (chunk.length) {
      await executeFlushChunk();
    }

    const syncDuration = Date.now() - syncStartTime;

    console.log(
      `[LeetTracker] Synced ${subs.length} submissions (${enrichedCount} fully enriched, ${skippedForBackfill} saved for backfill)`
    );

    // Track successful sync completion
    analytics.capture("sync_completed", {
      username,
      duration_ms: syncDuration,
      sync_start_timestamp: syncStartTime,
      new_submissions: subs.length,
      total_submissions: newTotalSubs,
      enriched_count: enrichedCount,
      backfill_count: skippedForBackfill,
      chunks_created: chunkIdx + 1,
      is_first_sync: isFirstSync,
      last_sync_timestamp: lastT,
      previous_total: prevTotalSubs,
    });

    // Return sync result for toast notification
    return {
      success: true,
      newSolves: enrichedSolves.length,
      isBackfill: false,
      solves: enrichedSolves,
    };
  } catch (e) {
    console.error("[LeetTracker] Sync failed:", e);

    // Track sync failure
    analytics.captureError("sync_failed", e, {
      username,
      duration_ms: Date.now() - syncStartTime,
      sync_start_timestamp: syncStartTime,
      error_stage: "sync_process",
      last_sync_timestamp: lastT,
      previous_total: prevTotalSubs,
    });

    return { success: false, error: e.message };
  } finally {
    console.log(
      "[LeetTracker] Finished submission sync",
      username,
      new Date().toISOString()
    );
    await releaseSyncLock();
  }
}
