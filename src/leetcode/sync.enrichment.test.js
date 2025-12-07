import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  attachCodingJourney,
  attachRunEvents,
  flushChunk,
  enrichSubmission,
} from "./sync.js";
import { store } from "../core/config.js";

// Mock the storage and DB dependencies
vi.mock("../core/db-instance.js", () => ({
  getDBInstance: vi.fn(() =>
    Promise.resolve({
      storeJourneyArchive: vi.fn(),
      storeRunGroupArchive: vi.fn(),
      getSnapshots: vi.fn(() => Promise.resolve(null)),
      getRunEventsInWindow: vi.fn(() => Promise.resolve([])),
    })
  ),
}));

vi.mock("./api.js", () => ({
  fetchProblemPremiumStatus: vi.fn(() => Promise.resolve(false)),
  fetchDescriptionIfNeeded: vi.fn(() => Promise.resolve(null)),
  fetchNoteSafe: vi.fn(() => Promise.resolve(null)),
  fetchSubmissionDetailsSafe: vi.fn(() => Promise.resolve(null)),
}));

describe("attachCodingJourney", () => {
  let mockSub;
  let mockCodingJourney;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSub = {
      id: "123",
      titleSlug: "two-sum",
      timestamp: 1000,
    };
    mockCodingJourney = {
      snapshotCount: 5,
      count: 5,
      totalCodingTime: 600000,
      firstSnapshot: 1000,
      lastSnapshot: 601000,
      snapshots: [{ timestamp: 1000 }, { timestamp: 601000 }],
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("attaches full journey data initially", async () => {
    await attachCodingJourney(mockSub, "testuser", mockCodingJourney);

    // Should store then replace with summary
    expect(mockSub.codingJourney).toEqual({
      snapshotCount: 5,
      totalCodingTime: 600000,
      firstSnapshot: 1000,
      lastSnapshot: 601000,
      hasDetailedJourney: true,
    });
  });

  it("marks journey as having detailed data", async () => {
    await attachCodingJourney(mockSub, "testuser", mockCodingJourney);

    expect(mockSub.codingJourney.hasDetailedJourney).toBe(true);
  });

  it("stores journey in recent journeys list", async () => {
    await attachCodingJourney(mockSub, "testuser", mockCodingJourney);

    // Verify chrome.storage.local.set was called (store.set wraps this)
    expect(chrome.storage.local.set).toHaveBeenCalled();
    const setCall = chrome.storage.local.set.mock.calls.find((call) => {
      const key = Object.keys(call[0])[0];
      return key && key.includes("recent_journeys");
    });
    expect(setCall).toBeDefined();
  });

  it("preserves snapshot count in summary", async () => {
    await attachCodingJourney(mockSub, "testuser", mockCodingJourney);

    expect(mockSub.codingJourney.snapshotCount).toBe(5);
  });

  it("preserves coding time in summary", async () => {
    await attachCodingJourney(mockSub, "testuser", mockCodingJourney);

    expect(mockSub.codingJourney.totalCodingTime).toBe(600000);
  });
});

describe("attachRunEvents", () => {
  let mockSub;

  beforeEach(() => {
    mockSub = {
      id: "123",
      titleSlug: "two-sum",
      timestamp: 1000,
    };
  });

  it("attaches run events summary when provided", () => {
    const runEvents = {
      count: 3,
      firstRun: 900,
      lastRun: 990,
      runs: [{ id: "r1" }, { id: "r2" }, { id: "r3" }],
    };

    attachRunEvents(mockSub, runEvents);

    expect(mockSub.runEvents).toEqual({
      count: 3,
      firstRun: 900,
      lastRun: 990,
      hasDetailedRuns: true,
    });
  });

  it("marks runs as having detailed data", () => {
    const runEvents = {
      count: 1,
      firstRun: 950,
      lastRun: 950,
      runs: [{ id: "r1" }],
    };

    attachRunEvents(mockSub, runEvents);

    expect(mockSub.runEvents.hasDetailedRuns).toBe(true);
  });

  it("does not attach when runEvents is null", () => {
    attachRunEvents(mockSub, null);

    expect(mockSub.runEvents).toBeUndefined();
  });

  it("does not attach when runEvents is undefined", () => {
    attachRunEvents(mockSub, undefined);

    expect(mockSub.runEvents).toBeUndefined();
  });

  it("preserves count in summary", () => {
    const runEvents = {
      count: 5,
      firstRun: 100,
      lastRun: 200,
    };

    attachRunEvents(mockSub, runEvents);

    expect(mockSub.runEvents.count).toBe(5);
  });
});

describe("flushChunk", () => {
  let mockChunk;
  let mockChunksMeta;
  let mockSeenMap;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChunk = [
      { id: "1", timestamp: 1000 },
      { id: "2", timestamp: 2000 },
      { id: "3", timestamp: 3000 },
    ];
    mockChunksMeta = [];
    mockSeenMap = { "two-sum": { isPremium: false } };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stores chunk at correct key", async () => {
    await flushChunk(
      "testuser",
      0,
      mockChunk,
      mockChunksMeta,
      "manifest_key",
      "seen_key",
      mockSeenMap,
      100,
      50,
      50
    );

    const chunkCall = chrome.storage.local.set.mock.calls.find((call) => {
      const key = Object.keys(call[0])[0];
      return key && key.includes("chunk_testuser_0");
    });
    expect(chunkCall).toBeDefined();
    expect(chunkCall[0][Object.keys(chunkCall[0])[0]]).toEqual(mockChunk);
  });

  it("updates chunks metadata with correct range", async () => {
    await flushChunk(
      "testuser",
      0,
      mockChunk,
      mockChunksMeta,
      "manifest_key",
      "seen_key",
      mockSeenMap,
      100,
      50,
      50
    );

    expect(mockChunksMeta[0]).toEqual({
      index: 0,
      from: 1000,
      to: 3000,
    });
  });

  it("saves manifest with chunk metadata", async () => {
    await flushChunk(
      "testuser",
      2,
      mockChunk,
      mockChunksMeta,
      "manifest_key",
      "seen_key",
      mockSeenMap,
      100,
      75,
      25
    );

    const manifestCall = chrome.storage.local.set.mock.calls.find((call) => {
      const key = Object.keys(call[0])[0];
      return key === "manifest_key";
    });
    expect(manifestCall).toBeDefined();
    expect(manifestCall[0]["manifest_key"]).toMatchObject({
      chunkCount: 3,
      lastTimestamp: 3000,
      total: 100,
      totalSynced: 75,
      skippedForBackfill: 25,
    });
  });

  it("saves seen problems map", async () => {
    await flushChunk(
      "testuser",
      0,
      mockChunk,
      mockChunksMeta,
      "manifest_key",
      "seen_key",
      mockSeenMap,
      100,
      50,
      50
    );

    const seenCall = chrome.storage.local.set.mock.calls.find((call) => {
      const key = Object.keys(call[0])[0];
      return key === "seen_key";
    });
    expect(seenCall).toBeDefined();
    expect(seenCall[0]["seen_key"]).toEqual(mockSeenMap);
  });

  it("handles multiple chunks correctly", async () => {
    // Flush chunk 0
    await flushChunk(
      "testuser",
      0,
      mockChunk,
      mockChunksMeta,
      "manifest_key",
      "seen_key",
      mockSeenMap,
      100,
      50,
      50
    );

    expect(mockChunksMeta.length).toBe(1);

    // Flush chunk 1
    const chunk2 = [
      { id: "4", timestamp: 4000 },
      { id: "5", timestamp: 5000 },
    ];
    await flushChunk(
      "testuser",
      1,
      chunk2,
      mockChunksMeta,
      "manifest_key",
      "seen_key",
      mockSeenMap,
      100,
      52,
      48
    );

    expect(mockChunksMeta.length).toBe(2);
    expect(mockChunksMeta[1]).toEqual({
      index: 1,
      from: 4000,
      to: 5000,
    });
  });

  it("uses array.at(-1) for last timestamp", async () => {
    await flushChunk(
      "testuser",
      0,
      mockChunk,
      mockChunksMeta,
      "manifest_key",
      "seen_key",
      mockSeenMap,
      100,
      50,
      50
    );

    const manifestCall = chrome.storage.local.set.mock.calls.find((call) => {
      const key = Object.keys(call[0])[0];
      return key === "manifest_key";
    });
    expect(manifestCall[0]["manifest_key"].lastTimestamp).toBe(3000);
  });
});

describe("enrichSubmission - solve window", () => {
  let mockSub;
  let mockSeenMap;
  let mockVisitLog;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSub = {
      id: "123",
      titleSlug: "two-sum",
      timestamp: 10000,
      statusDisplay: "Accepted",
    };
    mockSeenMap = {};
    mockVisitLog = [
      { slug: "two-sum", ts: 9500 },
      { slug: "three-sum", ts: 9600 },
    ];
  });

  it("calculates and attaches solve time", async () => {
    await enrichSubmission(mockSub, mockSeenMap, mockVisitLog, "testuser");

    expect(mockSub.solveTime).toBe(500); // 10000 - 9500
  });

  it("handles null solve time", async () => {
    mockVisitLog = []; // No visits

    await enrichSubmission(mockSub, mockSeenMap, mockVisitLog, "testuser");

    expect(mockSub.solveTime).toBeNull();
  });

  it("uses visit log to compute solve window", async () => {
    mockVisitLog = [
      { slug: "two-sum", ts: 8000 },
      { slug: "two-sum", ts: 9000 },
    ];

    await enrichSubmission(mockSub, mockSeenMap, mockVisitLog, "testuser");

    // Should use most recent visit
    expect(mockSub.solveTime).toBe(1000); // 10000 - 9000
  });
});

describe("enrichSubmission - premium status", () => {
  let mockSub;
  let mockSeenMap;
  let mockVisitLog;
  let api;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSub = {
      id: "123",
      titleSlug: "premium-problem",
      timestamp: 10000,
      statusDisplay: "Accepted",
    };
    mockSeenMap = {};
    mockVisitLog = [];

    // Reimport to get fresh mock
    api = await import("./api.js");
  });

  it("checks premium status if not cached", async () => {
    api.fetchProblemPremiumStatus.mockResolvedValue(true);

    await enrichSubmission(mockSub, mockSeenMap, mockVisitLog, "testuser");

    expect(api.fetchProblemPremiumStatus).toHaveBeenCalledWith(
      "premium-problem"
    );
  });

  it("caches premium status in seenMap", async () => {
    api.fetchProblemPremiumStatus.mockResolvedValue(true);

    await enrichSubmission(mockSub, mockSeenMap, mockVisitLog, "testuser");

    expect(mockSeenMap["premium-problem"]).toMatchObject({
      isPremium: true,
    });
  });

  it("uses cached premium status on subsequent calls", async () => {
    mockSeenMap["premium-problem"] = {
      isPremium: true,
      hasDescription: false,
    };

    await enrichSubmission(mockSub, mockSeenMap, mockVisitLog, "testuser");

    // Should not call fetch since it's cached
    expect(api.fetchProblemPremiumStatus).not.toHaveBeenCalled();
    expect(mockSub.isPremiumProblem).toBe(true);
  });

  it("marks submission as premium when detected", async () => {
    api.fetchProblemPremiumStatus.mockResolvedValue(true);

    await enrichSubmission(mockSub, mockSeenMap, mockVisitLog, "testuser");

    expect(mockSub.isPremiumProblem).toBe(true);
  });

  it("skips enrichment for premium problems without premium access", async () => {
    api.fetchProblemPremiumStatus.mockResolvedValue(true);

    await enrichSubmission(
      mockSub,
      mockSeenMap,
      mockVisitLog,
      "testuser",
      false
    );

    // Should not fetch description/notes/details
    expect(api.fetchDescriptionIfNeeded).not.toHaveBeenCalled();
    expect(api.fetchNoteSafe).not.toHaveBeenCalled();
    expect(api.fetchSubmissionDetailsSafe).not.toHaveBeenCalled();
  });

  it("enriches premium problems when user has premium", async () => {
    api.fetchProblemPremiumStatus.mockResolvedValue(true);

    await enrichSubmission(
      mockSub,
      mockSeenMap,
      mockVisitLog,
      "testuser",
      true
    );

    // Should fetch all data
    expect(api.fetchDescriptionIfNeeded).toHaveBeenCalled();
    expect(api.fetchNoteSafe).toHaveBeenCalled();
    expect(api.fetchSubmissionDetailsSafe).toHaveBeenCalled();
  });

  it("handles premium status fetch errors gracefully", async () => {
    api.fetchProblemPremiumStatus.mockRejectedValue(new Error("Network error"));

    await expect(
      enrichSubmission(mockSub, mockSeenMap, mockVisitLog, "testuser")
    ).resolves.not.toThrow();

    // Should assume not premium and continue
    expect(mockSub.isPremiumProblem).toBeUndefined();
  });
});

describe("enrichSubmission - parallel data fetching", () => {
  let mockSub;
  let mockSeenMap;
  let mockVisitLog;
  let api;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSub = {
      id: "123",
      titleSlug: "two-sum",
      timestamp: 10000,
      statusDisplay: "Accepted",
    };
    mockSeenMap = {};
    mockVisitLog = [];

    api = await import("./api.js");
  });

  it("fetches description when not cached", async () => {
    const mockDesc = {
      title: "Two Sum",
      content: "Find two numbers...",
      difficulty: "Easy",
    };
    api.fetchDescriptionIfNeeded.mockResolvedValue(mockDesc);

    await enrichSubmission(mockSub, mockSeenMap, mockVisitLog, "testuser");

    expect(mockSub.problemDescription).toEqual(mockDesc);
  });

  it("updates seenMap when description is fetched", async () => {
    const mockDesc = {
      title: "Two Sum",
      content: "Find two numbers...",
    };
    api.fetchDescriptionIfNeeded.mockResolvedValue(mockDesc);

    await enrichSubmission(mockSub, mockSeenMap, mockVisitLog, "testuser");

    expect(mockSeenMap["two-sum"]).toMatchObject({
      hasDescription: true,
    });
  });

  it("fetches and attaches personal note", async () => {
    const mockNote = "My solution approach...";
    api.fetchNoteSafe.mockResolvedValue(mockNote);

    await enrichSubmission(mockSub, mockSeenMap, mockVisitLog, "testuser");

    expect(mockSub.problemNote).toBe(mockNote);
  });

  it("fetches and attaches submission details", async () => {
    const mockDetails = {
      code: "class Solution { ... }",
      submissionDetails: { runtime: 50, memory: 14.2 },
    };
    api.fetchSubmissionDetailsSafe.mockResolvedValue(mockDetails);

    await enrichSubmission(mockSub, mockSeenMap, mockVisitLog, "testuser");

    expect(mockSub.code).toBe("class Solution { ... }");
    expect(mockSub.submissionDetails).toEqual({
      runtime: 50,
      memory: 14.2,
    });
  });

  it("handles partial fetch failures gracefully", async () => {
    api.fetchDescriptionIfNeeded.mockResolvedValue({
      title: "Two Sum",
    });
    api.fetchNoteSafe.mockResolvedValue(null);
    api.fetchSubmissionDetailsSafe.mockResolvedValue(null);

    await expect(
      enrichSubmission(mockSub, mockSeenMap, mockVisitLog, "testuser")
    ).resolves.not.toThrow();

    expect(mockSub.problemDescription).toBeDefined();
    expect(mockSub.problemNote).toBeUndefined();
    expect(mockSub.code).toBeUndefined();
  });

  it("handles all fetches failing gracefully", async () => {
    api.fetchDescriptionIfNeeded.mockResolvedValue(null);
    api.fetchNoteSafe.mockResolvedValue(null);
    api.fetchSubmissionDetailsSafe.mockResolvedValue(null);

    await expect(
      enrichSubmission(mockSub, mockSeenMap, mockVisitLog, "testuser")
    ).resolves.not.toThrow();

    // Submission should still have basic data
    expect(mockSub.id).toBe("123");
    expect(mockSub.titleSlug).toBe("two-sum");
  });

  it("does not attach code when details.code is missing", async () => {
    api.fetchSubmissionDetailsSafe.mockResolvedValue({
      submissionDetails: { runtime: 50 },
      // code is missing
    });

    await enrichSubmission(mockSub, mockSeenMap, mockVisitLog, "testuser");

    expect(mockSub.code).toBeUndefined();
  });
});
