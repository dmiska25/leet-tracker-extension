// src/core/db-instance.js
import * as storage from "./storage.js";

let dbInstance = null;
let initPromise = null;

/**
 * Get the singleton database instance.
 * Initializes on first call and caches the result.
 * Subsequent calls return the cached instance immediately.
 * If initialization is in progress, waits for it to complete.
 */
export async function getDBInstance() {
  // Return cached instance if available
  if (dbInstance) {
    return dbInstance;
  }

  // If initialization is already in progress, wait for it
  if (initPromise) {
    return initPromise;
  }

  // Start initialization
  initPromise = (async () => {
    dbInstance = storage.create();
    return dbInstance;
  })();

  return initPromise;
}

/**
 * Check if DB instance is initialized (synchronous check)
 */
export function isDBInitialized() {
  return dbInstance !== null;
}

/**
 * For testing: reset the singleton (use with caution)
 */
export function resetDBInstance() {
  dbInstance = null;
  initPromise = null;
}
