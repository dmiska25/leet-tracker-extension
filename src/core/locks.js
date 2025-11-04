// src/core/locks.js
import { consts, store, util } from "./config.js";

const { SYNC_LOCK_KEY, HEARTBEAT_TIMEOUT_MS } = consts;

// ---- Per-problem in-memory lock (content-script lifetime)
// Map of `${username}_${problemSlug}` -> Promise sentinel
const snapshotLocks = new Map();

export async function withSnapshotLock(username, problemSlug, operation) {
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

// ---- Sync lock in chrome.storage (cross-tab)
let SESSION_ID = `session_${Date.now()}_${Math.random()
  .toString(36)
  .slice(2, 11)}`;
let isLockOwner = false;

/**
 * Check if a lock is available for acquisition.
 * Returns { canAcquire: boolean, reason: string }
 */
export function checkLockAvailability(lock, context = "") {
  if (!lock || !lock.isLocked) {
    return { canAcquire: true, reason: "no_lock" };
  }

  const now = Date.now();
  const timeSinceHeartbeat = now - (lock.lastHeartbeat || 0);

  // Fresh heartbeat (active sync in progress)
  if (timeSinceHeartbeat < HEARTBEAT_TIMEOUT_MS) {
    console.log(`[LeetTracker] Sync lock held by ${lock.sessionId}${context}`, {
      timeSinceHeartbeat,
      sessionId: lock.sessionId,
    });
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
 */
export async function acquireSyncLock() {
  // Step 1: Check current lock state
  const currentLock = await store.get(SYNC_LOCK_KEY, null);
  const initialCheck = checkLockAvailability(currentLock);

  if (!initialCheck.canAcquire) {
    return false;
  }

  // Step 2: Random jitter to reduce collision probability
  const jitterMs = Math.random() * 1000 + 100; // 100-1100ms
  await util.sleep(jitterMs);

  // Step 3: Re-check lock state after jitter
  const recheckLock = await store.get(SYNC_LOCK_KEY, null);
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

  await store.set(SYNC_LOCK_KEY, newLock);

  // Step 5: Verify we actually got the lock (detect race condition)
  await util.sleep(50);

  const verifyLock = await store.get(SYNC_LOCK_KEY, null);

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
export async function updateSyncHeartbeat() {
  if (!isLockOwner) {
    console.warn(
      `[LeetTracker] Attempted heartbeat update without lock ownership`
    );
    return false;
  }

  const currentLock = await store.get(SYNC_LOCK_KEY, null);

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

  await store.set(SYNC_LOCK_KEY, updatedLock);
  return true;
}

/**
 * Update heartbeat and throw error if lock ownership is lost.
 * Convenience wrapper for critical sections that must abort on lock loss.
 */
export async function updateSyncHeartbeatOrFail(context = "") {
  const success = await updateSyncHeartbeat();
  if (!success) {
    throw new Error(`Lost lock ownership during ${context || "operation"}`);
  }
}

/**
 * Release the sync lock if we still own it.
 */
export async function releaseSyncLock() {
  if (!isLockOwner) {
    console.warn(`[LeetTracker] Attempted to release lock without ownership`);
    return;
  }

  const currentLock = await store.get(SYNC_LOCK_KEY, null);

  if (currentLock && currentLock.sessionId === SESSION_ID) {
    await store.set(SYNC_LOCK_KEY, {
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

export function isOwner() {
  return isLockOwner;
}

export function sessionId() {
  return SESSION_ID;
}
