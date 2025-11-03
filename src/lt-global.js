(() => {
  // Create/extend a single namespace shared by all files
  const LT = (globalThis.LT = globalThis.LT || {});

  // ---- Constants
  LT.consts = {
    GRAPHQL_URL: "https://leetcode.com/graphql/",
    SYNC_LOCK_KEY: "leettracker_sync_lock",
    HEARTBEAT_TIMEOUT_MS: 180000, // 3 minutes
    DAY_S: 86400,
  };

  // ---- Key helpers (shared across modules)
  LT.keys = {
    visitLog: (u) => `leettracker_problem_visit_log_${u}`,
    manifest: (u) => `leettracker_sync_manifest_${u}`,
    seenProblems: (u) => `leettracker_seen_problems_${u}`,
    chunk: (u, i) => `leettracker_leetcode_chunk_${u}_${i}`,
    snapshots: (u, slug) => `leettracker_snapshots_${u}_${slug}`,
    templates: (slug) => `leettracker_templates_${slug}`,
    recentJourneys: (u) => `leettracker_recent_journeys_${u}`,
    recentRuns: (u) => `leettracker_recent_runs_${u}`,
    problemIdMap: "leettracker_problem_slug_to_id_map",
  };

  // ---- chrome.storage helpers
  LT.store = {
    async get(key, fallback = null) {
      return new Promise((resolve) => {
        chrome.storage.local.get([key], (r) => resolve(r[key] ?? fallback));
      });
    },
    async set(key, value) {
      return new Promise((resolve) => {
        chrome.storage.local.set({ [key]: value }, resolve);
      });
    },
  };

  // ---- tiny utils
  LT.util = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    nowSec: () => Math.floor(Date.now() / 1000),
  };
})();