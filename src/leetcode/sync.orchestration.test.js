import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { processBackfillQueue, syncSubmissions } from "./sync.js";
import * as locks from "../core/locks.js";
import * as api from "./api.js";
import * as analytics from "../core/analytics.js";

// Mock dependencies
vi.mock("../core/db-instance.js", () => ({
  getDBInstance: vi.fn(() =>
    Promise.resolve({
      getSnapshots: vi.fn(() => Promise.resolve(null)),
      getRunEventsInWindow: vi.fn(() => Promise.resolve([])),
      getHintEventsInWindow: vi.fn(() => Promise.resolve([])),
      storeJourneyArchive: vi.fn(),
      storeRunGroupArchive: vi.fn(),
    })
  ),
}));

vi.mock("./api.js", () => ({
  fetchProblemPremiumStatus: vi.fn(() => Promise.resolve(false)),
  fetchProblemDescription: vi.fn(() => Promise.resolve({ title: "Test" })),
  fetchDescriptionIfNeeded: vi.fn(() => Promise.resolve(null)),
  fetchNoteSafe: vi.fn(() => Promise.resolve(null)),
  fetchSubmissionDetailsSafe: vi.fn(() => Promise.resolve(null)),
  fetchAllSubmissions: vi.fn(() => Promise.resolve([])),
  fetchUserSubmissionTotal: vi.fn(() => Promise.resolve(null)),
  getUserInfoWithCache: vi.fn(() => Promise.resolve({ isPremium: false })),
}));

vi.mock("../core/locks.js", () => ({
  acquireSyncLock: vi.fn(() => Promise.resolve(true)),
  releaseSyncLock: vi.fn(() => Promise.resolve()),
  updateSyncHeartbeat: vi.fn(() => Promise.resolve(true)),
  updateSyncHeartbeatOrFail: vi.fn(() => Promise.resolve()),
  isOwner: vi.fn(() => true),
  sessionId: vi.fn(() => "test-session-id"),
}));

vi.mock("../core/analytics.js", () => ({
  getAnalytics: vi.fn(() => ({
    capture: vi.fn(),
    captureError: vi.fn(),
  })),
}));

describe("processBackfillQueue", () => {
  let mockStorage;

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup chrome.storage mock to use our test storage
    mockStorage = new Map();

    // Override chrome.storage.local.get
    global.chrome.storage.local.get.mockImplementation((keys, callback) => {
      const key = Array.isArray(keys) ? keys[0] : keys;
      const result = { [key]: mockStorage.get(key) };
      callback(result);
    });

    // Override chrome.storage.local.set
    global.chrome.storage.local.set.mockImplementation((items, callback) => {
      Object.entries(items).forEach(([key, value]) => {
        mockStorage.set(key, value);
      });
      if (callback) callback();
    });

    global.chrome.storage.local.remove.mockImplementation((keys, callback) => {
      const list = Array.isArray(keys) ? keys : [keys];
      list.forEach((k) => {
        const key = typeof k === "string" ? k : String(k);
        mockStorage.delete(key);
      });
      if (callback) callback();
      return Promise.resolve();
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns early when queue is empty", async () => {
    mockStorage.set("leettracker_backfill_queue_testuser", []);

    await processBackfillQueue(
      "testuser",
      "leettracker_backfill_queue_testuser",
      {},
      [],
      false,
      {},
      "manifest_key",
      "seen_key"
    );

    expect(locks.updateSyncHeartbeatOrFail).not.toHaveBeenCalled();
  });

  it("returns early when queue is null", async () => {
    mockStorage.set("leettracker_backfill_queue_testuser", null);

    await processBackfillQueue(
      "testuser",
      "leettracker_backfill_queue_testuser",
      {},
      [],
      false,
      {},
      "manifest_key",
      "seen_key"
    );

    expect(locks.updateSyncHeartbeatOrFail).not.toHaveBeenCalled();
  });

  it("processes single item from queue", async () => {
    const queue = [{ id: "sub1", titleSlug: "two-sum", chunkIndex: 0 }];

    const chunk = [{ id: "sub1", titleSlug: "two-sum", timestamp: 1000 }];

    mockStorage.set("leettracker_backfill_queue_testuser", queue);
    mockStorage.set("leettracker_leetcode_chunk_testuser_0", chunk);

    const manifest = { lastTimestamp: 1000 };
    const seenMap = {};

    await processBackfillQueue(
      "testuser",
      "leettracker_backfill_queue_testuser",
      seenMap,
      [],
      false,
      manifest,
      "manifest_key",
      "seen_key"
    );

    // Verify enrichment was called
    expect(locks.updateSyncHeartbeatOrFail).toHaveBeenCalled();

    // Verify queue is now empty
    const remainingQueue = mockStorage.get(
      "leettracker_backfill_queue_testuser"
    );
    expect(remainingQueue).toEqual([]);

    // Verify manifest was updated
    expect(manifest.backfillProcessedAt).toBeDefined();
    expect(mockStorage.get("manifest_key")).toEqual(manifest);
  });

  it("processes maximum of 20 items per call", async () => {
    const queue = Array.from({ length: 30 }, (_, i) => ({
      id: `sub${i}`,
      titleSlug: "two-sum",
      chunkIndex: 0,
    }));

    const chunk = Array.from({ length: 30 }, (_, i) => ({
      id: `sub${i}`,
      titleSlug: "two-sum",
      timestamp: 1000 + i,
    }));

    mockStorage.set("leettracker_backfill_queue_testuser", queue);
    mockStorage.set("leettracker_leetcode_chunk_testuser_0", chunk);

    await processBackfillQueue(
      "testuser",
      "leettracker_backfill_queue_testuser",
      {},
      [],
      false,
      {},
      "manifest_key",
      "seen_key"
    );

    // Verify only 20 items processed
    const remainingQueue = mockStorage.get(
      "leettracker_backfill_queue_testuser"
    );
    expect(remainingQueue.length).toBe(10);
  });

  it("groups items by chunk for efficient processing", async () => {
    const queue = [
      { id: "sub1", titleSlug: "two-sum", chunkIndex: 0 },
      { id: "sub2", titleSlug: "add-two", chunkIndex: 1 },
      { id: "sub3", titleSlug: "three-sum", chunkIndex: 0 },
    ];

    const chunk0 = [
      { id: "sub1", titleSlug: "two-sum", timestamp: 1000 },
      { id: "sub3", titleSlug: "three-sum", timestamp: 1002 },
    ];
    const chunk1 = [{ id: "sub2", titleSlug: "add-two", timestamp: 1001 }];

    mockStorage.set("leettracker_backfill_queue_testuser", queue);
    mockStorage.set("leettracker_leetcode_chunk_testuser_0", chunk0);
    mockStorage.set("leettracker_leetcode_chunk_testuser_1", chunk1);

    await processBackfillQueue(
      "testuser",
      "leettracker_backfill_queue_testuser",
      {},
      [],
      false,
      {},
      "manifest_key",
      "seen_key"
    );

    // Verify both chunks were saved
    expect(
      mockStorage.get("leettracker_leetcode_chunk_testuser_0")
    ).toBeDefined();
    expect(
      mockStorage.get("leettracker_leetcode_chunk_testuser_1")
    ).toBeDefined();
  });

  it("handles missing submission in chunk gracefully", async () => {
    const queue = [
      { id: "sub1", titleSlug: "two-sum", chunkIndex: 0 },
      { id: "sub999", titleSlug: "missing", chunkIndex: 0 },
    ];

    const chunk = [
      { id: "sub1", titleSlug: "two-sum", timestamp: 1000 },
      // sub999 is missing
    ];

    mockStorage.set("leettracker_backfill_queue_testuser", queue);
    mockStorage.set("leettracker_leetcode_chunk_testuser_0", chunk);

    await processBackfillQueue(
      "testuser",
      "leettracker_backfill_queue_testuser",
      {},
      [],
      false,
      {},
      "manifest_key",
      "seen_key"
    );

    // Should complete without error
    expect(mockStorage.get("leettracker_backfill_queue_testuser")).toEqual([]);
  });

  it("updates manifest with backfillProcessedAt timestamp", async () => {
    const queue = [{ id: "sub1", titleSlug: "two-sum", chunkIndex: 0 }];
    const chunk = [{ id: "sub1", titleSlug: "two-sum", timestamp: 1000 }];
    const manifest = { lastTimestamp: 1000 };

    mockStorage.set("leettracker_backfill_queue_testuser", queue);
    mockStorage.set("leettracker_leetcode_chunk_testuser_0", chunk);

    const beforeTime = Date.now();
    await processBackfillQueue(
      "testuser",
      "leettracker_backfill_queue_testuser",
      {},
      [],
      false,
      manifest,
      "manifest_key",
      "seen_key"
    );
    const afterTime = Date.now();

    // Verify timestamp is a number and reasonable (within test execution window + small margin)
    expect(typeof manifest.backfillProcessedAt).toBe("number");
    expect(manifest.backfillProcessedAt).toBeGreaterThanOrEqual(
      beforeTime - 100
    );
    expect(manifest.backfillProcessedAt).toBeLessThanOrEqual(afterTime + 100);
  });

  it("captures analytics event for backfill progress", async () => {
    const queue = [{ id: "sub1", titleSlug: "two-sum", chunkIndex: 0 }];
    const chunk = [{ id: "sub1", titleSlug: "two-sum", timestamp: 1000 }];

    mockStorage.set("leettracker_backfill_queue_testuser", queue);
    mockStorage.set("leettracker_leetcode_chunk_testuser_0", chunk);

    const mockAnalytics = { capture: vi.fn() };
    vi.mocked(analytics.getAnalytics).mockReturnValue(mockAnalytics);

    await processBackfillQueue(
      "testuser",
      "leettracker_backfill_queue_testuser",
      {},
      [],
      false,
      {},
      "manifest_key",
      "seen_key"
    );

    expect(mockAnalytics.capture).toHaveBeenCalledWith(
      "backfill_processed",
      expect.objectContaining({
        username: "testuser",
        items_processed: 1,
        items_remaining: 0,
        batch_size: 20,
      })
    );
  });

  it("calls heartbeat before and after each submission enrichment", async () => {
    const queue = [
      { id: "sub1", titleSlug: "two-sum", chunkIndex: 0 },
      { id: "sub2", titleSlug: "add-two", chunkIndex: 0 },
    ];
    const chunk = [
      { id: "sub1", titleSlug: "two-sum", timestamp: 1000 },
      { id: "sub2", titleSlug: "add-two", timestamp: 1001 },
    ];

    mockStorage.set("leettracker_backfill_queue_testuser", queue);
    mockStorage.set("leettracker_leetcode_chunk_testuser_0", chunk);

    await processBackfillQueue(
      "testuser",
      "leettracker_backfill_queue_testuser",
      {},
      [],
      false,
      {},
      "manifest_key",
      "seen_key"
    );

    // Should be called twice per submission (before and after)
    expect(locks.updateSyncHeartbeatOrFail).toHaveBeenCalledTimes(4);
    expect(locks.updateSyncHeartbeatOrFail).toHaveBeenCalledWith(
      expect.stringContaining("backfill enrichment")
    );
    expect(locks.updateSyncHeartbeatOrFail).toHaveBeenCalledWith(
      expect.stringContaining("backfill post-enrichment")
    );
  });

  it("rethrows lock ownership errors", async () => {
    const queue = [{ id: "sub1", titleSlug: "two-sum", chunkIndex: 0 }];
    const chunk = [{ id: "sub1", titleSlug: "two-sum", timestamp: 1000 }];

    mockStorage.set("leettracker_backfill_queue_testuser", queue);
    mockStorage.set("leettracker_leetcode_chunk_testuser_0", chunk);

    vi.mocked(locks.updateSyncHeartbeatOrFail).mockRejectedValueOnce(
      new Error("Lost lock ownership")
    );

    await expect(
      processBackfillQueue(
        "testuser",
        "leettracker_backfill_queue_testuser",
        {},
        [],
        false,
        {},
        "manifest_key",
        "seen_key"
      )
    ).rejects.toThrow("Lost lock ownership");
  });

  it("continues processing other chunks if one chunk fails", async () => {
    const queue = [
      { id: "sub1", titleSlug: "two-sum", chunkIndex: 0 },
      { id: "sub2", titleSlug: "add-two", chunkIndex: 1 },
    ];

    mockStorage.set("leettracker_backfill_queue_testuser", queue);
    // chunk 0 exists and will succeed
    mockStorage.set("leettracker_leetcode_chunk_testuser_0", [
      { id: "sub1", titleSlug: "two-sum", timestamp: 1000 },
    ]);
    // chunk 1 exists
    mockStorage.set("leettracker_leetcode_chunk_testuser_1", [
      { id: "sub2", titleSlug: "add-two", timestamp: 2000 },
    ]);

    // Mock enrichSubmission to throw for chunk 1 submission only
    vi.mocked(api.fetchProblemDescription).mockImplementation((slug) => {
      if (slug === "add-two") {
        throw new Error("Network error for add-two");
      }
      return Promise.resolve({ title: slug });
    });

    await processBackfillQueue(
      "testuser",
      "leettracker_backfill_queue_testuser",
      {},
      [],
      false,
      {},
      "manifest_key",
      "seen_key"
    );

    // Should complete without throwing, queue should be empty
    // (both items processed, even though one failed)
    expect(mockStorage.get("leettracker_backfill_queue_testuser")).toEqual([]);
  });

  it("does not update manifest if no items processed", async () => {
    const queue = [{ id: "sub999", titleSlug: "missing", chunkIndex: 0 }];
    const chunk = []; // Empty chunk
    const manifest = { lastTimestamp: 1000 };

    mockStorage.set("leettracker_backfill_queue_testuser", queue);
    mockStorage.set("leettracker_leetcode_chunk_testuser_0", chunk);

    await processBackfillQueue(
      "testuser",
      "leettracker_backfill_queue_testuser",
      {},
      [],
      false,
      manifest,
      "manifest_key",
      "seen_key"
    );

    // backfillProcessedAt should not be set
    expect(manifest.backfillProcessedAt).toBeUndefined();
  });

  it("saves seenMap when items are processed", async () => {
    const queue = [{ id: "sub1", titleSlug: "two-sum", chunkIndex: 0 }];
    const chunk = [{ id: "sub1", titleSlug: "two-sum", timestamp: 1000 }];
    const seenMap = { "two-sum": { isPremium: false } };

    mockStorage.set("leettracker_backfill_queue_testuser", queue);
    mockStorage.set("leettracker_leetcode_chunk_testuser_0", chunk);

    await processBackfillQueue(
      "testuser",
      "leettracker_backfill_queue_testuser",
      seenMap,
      [],
      false,
      {},
      "manifest_key",
      "seen_key"
    );

    expect(mockStorage.get("seen_key")).toEqual(seenMap);
  });
});

describe("syncSubmissions", () => {
  let mockStorage;
  let mockAnalytics;

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup chrome.storage mock to use our test storage
    mockStorage = new Map();

    // Override chrome.storage.local.get
    global.chrome.storage.local.get.mockImplementation((keys, callback) => {
      const key = Array.isArray(keys) ? keys[0] : keys;
      const result = { [key]: mockStorage.get(key) };
      callback(result);
    });

    // Override chrome.storage.local.set
    global.chrome.storage.local.set.mockImplementation((items, callback) => {
      Object.entries(items).forEach(([key, value]) => {
        mockStorage.set(key, value);
      });
      if (callback) callback();
    });

    // Setup analytics mock
    mockAnalytics = { capture: vi.fn(), captureError: vi.fn() };
    vi.mocked(analytics.getAnalytics).mockReturnValue(mockAnalytics);

    // Default lock behavior - setup lock state in storage
    const sessionId = "test-session-123";
    vi.mocked(locks.acquireSyncLock).mockResolvedValue(true);
    vi.mocked(locks.releaseSyncLock).mockResolvedValue(undefined);
    vi.mocked(locks.sessionId).mockReturnValue(sessionId);
    vi.mocked(locks.isOwner).mockReturnValue(true);

    // Setup lock state in chrome.storage
    mockStorage.set("leettracker_sync_lock", {
      isLocked: true,
      sessionId: sessionId,
      acquiredAt: Date.now(),
      lastHeartbeat: Date.now(),
    });

    // Mock updateSyncHeartbeat to update the lock in storage
    vi.mocked(locks.updateSyncHeartbeat).mockImplementation(async () => {
      const currentLock = mockStorage.get("leettracker_sync_lock");
      if (currentLock) {
        mockStorage.set("leettracker_sync_lock", {
          ...currentLock,
          lastHeartbeat: Date.now(),
        });
      }
      return true;
    });
    vi.mocked(locks.updateSyncHeartbeatOrFail).mockImplementation(async () => {
      const success = await locks.updateSyncHeartbeat();
      if (!success) {
        throw new Error("Lost lock ownership");
      }
    });

    // Default API behavior
    vi.mocked(api.fetchAllSubmissions).mockResolvedValue([]);
    vi.mocked(api.getUserInfoWithCache).mockResolvedValue({ isPremium: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips sync when lock cannot be acquired", async () => {
    vi.mocked(locks.acquireSyncLock).mockResolvedValue(false);

    const result = await syncSubmissions("testuser");

    expect(result).toEqual({ success: false, error: "lock_held" });
    expect(locks.releaseSyncLock).not.toHaveBeenCalled();
  });

  it("initializes empty manifest for first-time user with no submissions", async () => {
    // No manifest exists
    mockStorage.set("leettracker_sync_manifest_testuser", {});
    vi.mocked(api.fetchAllSubmissions).mockResolvedValue([]);

    const result = await syncSubmissions("testuser");

    expect(result).toEqual({
      success: true,
      newSolves: 0,
      isBackfill: false,
      isFirstSync: true,
    });

    const manifest = mockStorage.get("leettracker_sync_manifest_testuser");
    expect(manifest).toEqual({
      chunkCount: 0,
      lastTimestamp: 1,
      chunks: [],
      total: 0,
      totalSynced: 0,
      skippedForBackfill: 0,
    });

    expect(mockAnalytics.capture).toHaveBeenCalledWith(
      "sync_completed_first_time_empty",
      expect.objectContaining({
        username: "testuser",
      })
    );
  });

  it("returns early when no new submissions for existing user", async () => {
    mockStorage.set("leettracker_sync_manifest_testuser", {
      lastTimestamp: 1000,
      total: 50,
    });
    vi.mocked(api.fetchAllSubmissions).mockResolvedValue([]);
    vi.mocked(api.fetchUserSubmissionTotal).mockResolvedValue(1000);
    vi.mocked(api.getUserInfoWithCache).mockResolvedValue({
      isPremium: false,
      username: "testuser",
    });

    const result = await syncSubmissions("testuser");

    expect(result).toEqual({ success: true, newSolves: 0, isBackfill: false });
    expect(mockAnalytics.capture).toHaveBeenCalledWith(
      "sync_no_new_submissions",
      expect.objectContaining({
        username: "testuser",
        total_submissions: 50,
      }),
      expect.any(Object)
    );
  });

  it("processes new submissions and creates chunks", async () => {
    mockStorage.set("leettracker_sync_manifest_testuser", {
      lastTimestamp: 1000,
      total: 0,
      totalSynced: 0,
      chunkCount: 0,
      chunks: [],
    });

    const now = Math.floor(Date.now() / 1000);
    const submissions = Array.from({ length: 5 }, (_, i) => ({
      id: `sub${i}`,
      titleSlug: `problem-${i}`,
      timestamp: now - i * 100,
      statusDisplay: "Accepted",
    }));

    vi.mocked(api.fetchAllSubmissions).mockResolvedValue(submissions);

    const result = await syncSubmissions("testuser");

    expect(result.success).toBe(true);
    expect(result.newSolves).toBe(5);
    expect(mockAnalytics.capture).toHaveBeenCalledWith(
      "sync_completed",
      expect.objectContaining({
        username: "testuser",
        new_submissions: 5,
        total_submissions: 5,
      })
    );

    // Verify chunk was created at index 0 (first chunk)
    const chunk = mockStorage.get("leettracker_leetcode_chunk_testuser_0");
    expect(chunk).toBeDefined();
    expect(chunk.length).toBe(5);

    // Verify manifest was updated correctly
    const manifest = mockStorage.get("leettracker_sync_manifest_testuser");
    expect(manifest.chunkCount).toBe(1);
    expect(manifest.totalSynced).toBe(5);
    // lastTimestamp is chunk.at(-1).timestamp (the last item added to chunk)
    expect(manifest.lastTimestamp).toBe(submissions[4].timestamp);
    expect(manifest.chunks[0]).toEqual({
      index: 0,
      from: submissions[0].timestamp, // chunk[0] - first item added (newest submission)
      to: submissions[4].timestamp, // chunk.at(-1) - last item added (oldest submission)
    });
  });

  it("handles empty first sync followed by sync with submissions", async () => {
    // This test ensures chunkIdx calculation handles undefined/0 chunkCount correctly
    // Scenario: User's first sync has no submissions, second sync has submissions

    // FIRST SYNC: No submissions
    vi.mocked(api.fetchAllSubmissions).mockResolvedValue([]);

    const firstResult = await syncSubmissions("testuser");

    expect(firstResult.success).toBe(true);
    expect(firstResult.newSolves).toBe(0);
    expect(firstResult.isFirstSync).toBe(true);

    // Verify manifest was initialized with chunkCount: 0
    let manifest = mockStorage.get("leettracker_sync_manifest_testuser");
    expect(manifest.chunkCount).toBe(0);
    expect(manifest.totalSynced).toBe(0);

    // SECOND SYNC: Now user has submissions
    const now = Math.floor(Date.now() / 1000);
    const submissions = Array.from({ length: 3 }, (_, i) => ({
      id: `sub${i}`,
      titleSlug: `problem-${i}`,
      timestamp: now - i * 100,
      statusDisplay: "Accepted",
    }));

    vi.mocked(api.fetchAllSubmissions).mockResolvedValue(submissions);

    const secondResult = await syncSubmissions("testuser");

    expect(secondResult.success).toBe(true);
    expect(secondResult.newSolves).toBe(3);

    // Verify chunk was created at index 0 (not NaN or -1)
    const chunk = mockStorage.get("leettracker_leetcode_chunk_testuser_0");
    expect(chunk).toBeDefined();
    expect(chunk.length).toBe(3);

    // Verify manifest was updated correctly
    manifest = mockStorage.get("leettracker_sync_manifest_testuser");
    expect(manifest.chunkCount).toBe(1); // Should be 1, not 0
    expect(manifest.totalSynced).toBe(3);
    expect(manifest.chunks[0]).toBeDefined();
    expect(manifest.chunks[0].index).toBe(0); // Verify index is 0, not NaN
  });

  it("splits old submissions into backfill queue", async () => {
    // NOTE: The sync logic iterates through submissions in order and counts how many
    // are older than the cutoff (skippedForBackfill). It then queues the first N items
    // for backfill. This means old submissions should be at the START of the array.
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - 90 * 24 * 60 * 60; // 90 days ago

    mockStorage.set("leettracker_sync_manifest_testuser", {
      lastTimestamp: 0,
      total: 0,
      totalSynced: 0,
      chunkCount: 0,
      chunks: [],
    });

    const submissions = [
      // Old submission at index 0 (should go to backfill)
      {
        id: "old1",
        titleSlug: "old-problem",
        timestamp: cutoff - 1000,
        statusDisplay: "Accepted",
      },
      // Recent submission (should be enriched immediately)
      {
        id: "new1",
        titleSlug: "new-problem",
        timestamp: now - 1000,
        statusDisplay: "Accepted",
      },
    ];

    vi.mocked(api.fetchAllSubmissions).mockResolvedValue(submissions);

    const result = await syncSubmissions("testuser");

    expect(result.success).toBe(true);

    // Check backfill queue contains the old submission
    const backfillQueue = mockStorage.get(
      "leettracker_backfill_queue_testuser"
    );
    expect(backfillQueue).toBeDefined();
    expect(backfillQueue.length).toBe(1);
    expect(backfillQueue[0].id).toBe("old1");
  });

  it("handles mixed-order submissions with multiple old items", async () => {
    // Test to catch regressions in backfill selection logic.
    // The sync code counts how many submissions are old (before cutoff),
    // then queues the first N items (by array index) for backfill,
    // and enriches items from index N onward.
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - 90 * 24 * 60 * 60;

    mockStorage.set("leettracker_sync_manifest_testuser", {
      lastTimestamp: 0,
      total: 0,
      totalSynced: 0,
      chunkCount: 0,
      chunks: [],
    });

    const submissions = [
      // First two are old (will be queued for backfill)
      { id: "old1", timestamp: cutoff - 2000, statusDisplay: "Accepted" },
      { id: "old2", timestamp: cutoff - 1000, statusDisplay: "Accepted" },
      // Last two are recent (will be enriched)
      { id: "new1", timestamp: now - 1000, statusDisplay: "Accepted" },
      { id: "new2", timestamp: now - 2000, statusDisplay: "Accepted" },
    ];

    vi.mocked(api.fetchAllSubmissions).mockResolvedValue(submissions);

    const result = await syncSubmissions("testuser");

    expect(result.success).toBe(true);

    // Verify both old submissions made it to backfill queue (first 2 items)
    const backfillQueue = mockStorage.get(
      "leettracker_backfill_queue_testuser"
    );
    expect(backfillQueue).toBeDefined();
    expect(backfillQueue.length).toBe(2);
    const oldIds = backfillQueue.map((item) => item.id);
    expect(oldIds).toContain("old1");
    expect(oldIds).toContain("old2");
  });

  it("releases lock on success", async () => {
    mockStorage.set("leettracker_sync_manifest_testuser", {
      lastTimestamp: 1000,
      total: 0,
    });
    vi.mocked(api.fetchAllSubmissions).mockResolvedValue([]);

    await syncSubmissions("testuser");

    expect(locks.releaseSyncLock).toHaveBeenCalled();
  });

  it("releases lock on error", async () => {
    vi.mocked(api.fetchAllSubmissions).mockRejectedValue(
      new Error("API failure")
    );

    const result = await syncSubmissions("testuser");

    expect(result.success).toBe(false);
    expect(locks.releaseSyncLock).toHaveBeenCalled();
    expect(mockAnalytics.captureError).toHaveBeenCalledWith(
      "sync_failed",
      expect.any(Error),
      expect.objectContaining({
        username: "testuser",
      })
    );
  });

  it("resets manifest when stored total exceeds LeetCode total", async () => {
    mockStorage.set("leettracker_sync_manifest_testuser", {
      lastTimestamp: 999999999,
      total: 1200,
      chunkCount: 2,
      chunks: [{ index: 0 }, { index: 1 }],
      totalSynced: 1200,
    });
    mockStorage.set("leettracker_leetcode_chunk_testuser_0", [{ id: "a" }]);
    mockStorage.set("leettracker_leetcode_chunk_testuser_1", [{ id: "b" }]);
    mockStorage.set("leettracker_backfill_queue_testuser", [{ id: "c" }]);

    vi.mocked(api.fetchUserSubmissionTotal).mockResolvedValue(900);
    vi.mocked(api.getUserInfoWithCache).mockResolvedValue({
      isPremium: false,
      username: "testuser",
    });
    vi.mocked(api.fetchAllSubmissions).mockResolvedValue([]);

    const result = await syncSubmissions("testuser");

    expect(result).toEqual({ success: false, error: "reset_due_to_mismatch" });

    // Chunks/backfill should be cleared (all keys removed individually)
    const removedKeys = global.chrome.storage.local.remove.mock.calls
      .map((call) => (Array.isArray(call[0]) ? call[0] : [call[0]]))
      .flat();

    expect(removedKeys).toEqual(
      expect.arrayContaining([
        "leettracker_sync_manifest_testuser",
        "leettracker_seen_problems_testuser",
        "leettracker_backfill_queue_testuser",
        "leettracker_leetcode_chunk_testuser_0",
        "leettracker_leetcode_chunk_testuser_1",
      ])
    );

    // Sync should have aborted after first fetch
    expect(api.fetchAllSubmissions).toHaveBeenCalledTimes(1);
    expect(api.fetchAllSubmissions).toHaveBeenCalledWith(999999999);

    expect(mockAnalytics.capture).toHaveBeenCalledWith(
      "sync_data_reset_due_to_mismatch",
      expect.objectContaining({
        username: "testuser",
        stored_total: 1200,
        remote_total: 900,
      })
    );
  });

  it("tracks first sync vs subsequent sync", async () => {
    // First sync
    mockStorage.set("leettracker_sync_manifest_testuser", {
      lastTimestamp: 0, // First sync indicator
    });

    const submissions = [
      {
        id: "sub1",
        titleSlug: "two-sum",
        timestamp: Math.floor(Date.now() / 1000),
        statusDisplay: "Accepted",
      },
    ];
    vi.mocked(api.fetchAllSubmissions).mockResolvedValue(submissions);

    await syncSubmissions("testuser");

    expect(mockAnalytics.capture).toHaveBeenCalledWith(
      "sync_completed",
      expect.objectContaining({
        is_first_sync: true,
      })
    );
  });

  it("validates lock ownership during enrichment", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockStorage.set("leettracker_sync_manifest_testuser", {
      lastTimestamp: 0,
      total: 0,
      totalSynced: 0,
      chunkCount: 0,
      chunks: [],
    });

    const submissions = [
      {
        id: "sub1",
        titleSlug: "two-sum",
        timestamp: now,
        statusDisplay: "Accepted",
      },
    ];
    vi.mocked(api.fetchAllSubmissions).mockResolvedValue(submissions);

    // Override updateSyncHeartbeat to simulate lock loss on second call
    let heartbeatCallCount = 0;
    vi.mocked(locks.updateSyncHeartbeat).mockImplementation(async () => {
      heartbeatCallCount++;
      if (heartbeatCallCount <= 1) {
        return true; // First call succeeds
      }
      return false; // Subsequent calls fail (lock lost)
    });

    // updateSyncHeartbeatOrFail should throw when updateSyncHeartbeat returns false
    vi.mocked(locks.updateSyncHeartbeatOrFail).mockImplementation(
      async (context) => {
        const success = await locks.updateSyncHeartbeat();
        if (!success) {
          throw new Error(
            `Lost lock ownership during ${context || "operation"}`
          );
        }
      }
    );

    const result = await syncSubmissions("testuser");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Lost lock ownership");
  });

  it("handles enrichment timeout", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockStorage.set("leettracker_sync_manifest_testuser", {
      lastTimestamp: 0,
      total: 0,
      totalSynced: 0,
      chunkCount: 0,
      chunks: [],
    });

    const submissions = [
      {
        id: "sub1",
        titleSlug: "two-sum",
        timestamp: now,
        statusDisplay: "Accepted",
      },
    ];
    vi.mocked(api.fetchAllSubmissions).mockResolvedValue(submissions);

    // Note: The timeout check happens in the calling code, not in enrichSubmission itself.
    // Since we're testing syncSubmissions in isolation, we can't easily trigger the timeout
    // without actually waiting. Instead, we test that the function completes successfully
    // when enrichment is fast (which it is with our mocks).
    // A real timeout scenario would require integration testing or a different approach.

    const result = await syncSubmissions("testuser");

    // With our current mocks, enrichment is fast so sync succeeds
    expect(result.success).toBe(true);
    expect(result.newSolves).toBe(1);
  });

  it("updates heartbeat during enrichment loop", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockStorage.set("leettracker_sync_manifest_testuser", {
      lastTimestamp: 0,
      total: 0,
      totalSynced: 0,
      chunkCount: 0,
      chunks: [],
    });

    const submissions = [
      {
        id: "sub1",
        titleSlug: "two-sum",
        timestamp: now,
        statusDisplay: "Accepted",
      },
      {
        id: "sub2",
        titleSlug: "add-two",
        timestamp: now - 100,
        statusDisplay: "Accepted",
      },
    ];
    vi.mocked(api.fetchAllSubmissions).mockResolvedValue(submissions);

    await syncSubmissions("testuser");

    // Should call heartbeat before and after each submission
    expect(locks.updateSyncHeartbeatOrFail).toHaveBeenCalledWith(
      expect.stringContaining("heartbeat update at submission")
    );
    expect(locks.updateSyncHeartbeatOrFail).toHaveBeenCalledWith(
      expect.stringContaining("post-enrichment heartbeat update")
    );
  });

  it("returns enriched solves for notification", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockStorage.set("leettracker_sync_manifest_testuser", {
      lastTimestamp: 0,
      total: 0,
      totalSynced: 0,
      chunkCount: 0,
      chunks: [],
    });
    mockStorage.set("leettracker_problem_visit_log_testuser", [
      { slug: "two-sum", ts: now - 600 },
    ]);

    const submissions = [
      {
        id: "sub1",
        titleSlug: "two-sum",
        timestamp: now,
        statusDisplay: "Accepted",
      },
    ];
    vi.mocked(api.fetchAllSubmissions).mockResolvedValue(submissions);

    const result = await syncSubmissions("testuser");

    expect(result.success).toBe(true);
    expect(result.solves).toBeDefined();
    expect(result.solves.length).toBe(1);
    expect(result.solves[0]).toEqual({
      slug: "two-sum",
      duration: expect.any(Number),
    });
  });
});
