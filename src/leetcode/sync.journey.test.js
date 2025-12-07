import { describe, it, expect, vi } from "vitest";
import {
  buildCodingJourneyFromSnapshots,
  buildRunEventsForSubmission,
} from "./sync.js";
import { getDBInstance } from "../core/db-instance.js";

// Mock the DB instance
vi.mock("../core/db-instance.js", () => ({
  getDBInstance: vi.fn(),
}));

describe("buildCodingJourneyFromSnapshots", () => {
  it("returns null when no snapshots data", () => {
    expect(buildCodingJourneyFromSnapshots(null, 1000)).toBeNull();
    expect(buildCodingJourneyFromSnapshots(undefined, 1000)).toBeNull();
  });

  it("returns null when snapshots array is empty", () => {
    const data = { snapshots: [] };
    expect(buildCodingJourneyFromSnapshots(data, 1000)).toBeNull();
  });

  it("returns null when snapshots array is missing", () => {
    const data = {};
    expect(buildCodingJourneyFromSnapshots(data, 1000)).toBeNull();
  });

  it("filters snapshots after submission time", () => {
    const submissionTsSec = 2000;
    const data = {
      snapshots: [
        { timestamp: 1000 * 1000, code: "v1" }, // Before (keep) - in milliseconds
        { timestamp: 1500 * 1000, code: "v2" }, // Before (keep)
        { timestamp: 2500 * 1000, code: "v3" }, // After (exclude)
      ],
    };

    const result = buildCodingJourneyFromSnapshots(data, submissionTsSec);
    expect(result.codingJourney.snapshotCount).toBe(2);
  });

  it("calculates total coding time correctly", () => {
    const data = {
      snapshots: [
        { timestamp: 1000, code: "v1" },
        { timestamp: 2000, code: "v2" },
        { timestamp: 5000, code: "v3" },
      ],
    };

    const result = buildCodingJourneyFromSnapshots(data, 10);
    expect(result.codingJourney.totalCodingTime).toBe(4000); // 5000 - 1000
    expect(result.codingJourney.firstSnapshot).toBe(1000);
    expect(result.codingJourney.lastSnapshot).toBe(5000);
  });

  it("returns all relevant snapshots in array", () => {
    const data = {
      snapshots: [
        { timestamp: 1000, code: "v1" },
        { timestamp: 2000, code: "v2" },
      ],
    };

    const result = buildCodingJourneyFromSnapshots(data, 10);
    expect(result.codingJourney.snapshots).toHaveLength(2);
    expect(result.codingJourney.snapshots[0]).toEqual({
      timestamp: 1000,
      code: "v1",
    });
  });

  it("returns earliestSnapshotMs for solve window detection", () => {
    const data = {
      snapshots: [
        { timestamp: 5000, code: "v1" }, // First in array
        { timestamp: 1000, code: "v2" },
        { timestamp: 3000, code: "v3" },
      ],
    };

    const result = buildCodingJourneyFromSnapshots(data, 10);
    // earliestSnapshotMs is relevant[0].timestamp, which is the first in the filtered array
    // Since all timestamps <= cutoff, it's the first in the original array
    expect(result.earliestSnapshotMs).toBe(5000);
  });

  it("handles single snapshot", () => {
    const data = {
      snapshots: [{ timestamp: 1000, code: "v1" }],
    };

    const result = buildCodingJourneyFromSnapshots(data, 10);
    expect(result.codingJourney.snapshotCount).toBe(1);
    expect(result.codingJourney.totalCodingTime).toBe(0); // Same start/end
  });

  it("filters all snapshots when all are after submission", () => {
    const submissionTsSec = 1;
    const data = {
      snapshots: [
        { timestamp: 2000, code: "v1" },
        { timestamp: 3000, code: "v2" },
      ],
    };

    const result = buildCodingJourneyFromSnapshots(data, submissionTsSec);
    expect(result).toBeNull(); // No relevant snapshots
  });

  it("handles snapshot at exact submission time", () => {
    const submissionTsSec = 2;
    const data = {
      snapshots: [
        { timestamp: 1000, code: "v1" },
        { timestamp: 2000, code: "v2" }, // Exactly at submission time (milliseconds)
        { timestamp: 3000, code: "v3" },
      ],
    };

    const result = buildCodingJourneyFromSnapshots(data, submissionTsSec);
    // Timestamps are in ms, submission is in seconds
    // cutoffMs = 2 * 1000 = 2000
    // Should include timestamps <= 2000
    expect(result.codingJourney.snapshotCount).toBe(2);
  });

  it("preserves snapshot metadata", () => {
    const data = {
      snapshots: [
        {
          timestamp: 1000,
          code: "v1",
          language: "python3",
          checksum: "abc123",
        },
      ],
    };

    const result = buildCodingJourneyFromSnapshots(data, 10);
    expect(result.codingJourney.snapshots[0]).toHaveProperty("language");
    expect(result.codingJourney.snapshots[0]).toHaveProperty("checksum");
  });

  it("handles snapshot array as provided (assumes pre-sorted)", () => {
    const data = {
      snapshots: [
        { timestamp: 5000, code: "v3" },
        { timestamp: 1000, code: "v1" },
        { timestamp: 3000, code: "v2" },
      ],
    };

    const result = buildCodingJourneyFromSnapshots(data, 10);
    // Function doesn't sort - it uses array order as-is
    expect(result.codingJourney.snapshotCount).toBe(3);
    // earliestSnapshotMs is first in filtered array (which is first in original)
    expect(result.earliestSnapshotMs).toBe(5000);
    // First and last are based on array position, not chronological order
    expect(result.codingJourney.firstSnapshot).toBe(5000);
    expect(result.codingJourney.lastSnapshot).toBe(3000);
    // Total coding time is last - first (by array position)
    expect(result.codingJourney.totalCodingTime).toBe(-2000); // 3000 - 5000
  });
});

describe("buildRunEventsForSubmission", () => {
  // Note: This function is async and depends on getDBInstance
  // These tests would require more complex mocking of IndexedDB
  // For now, we'll test the basic structure and add TODO for full implementation

  it("returns null when submission is not Accepted", async () => {
    const sub = {
      statusDisplay: "Wrong Answer",
      timestamp: 1000,
    };

    const result = await buildRunEventsForSubmission(sub, "username", [1000]);
    expect(result).toBeNull();
  });

  it("returns null when no username provided", async () => {
    const sub = {
      statusDisplay: "Accepted",
      timestamp: 1000,
    };

    const result = await buildRunEventsForSubmission(sub, null, [1000]);
    expect(result).toBeNull();
  });

  it("returns null when startCandidatesMs is empty", async () => {
    const sub = {
      statusDisplay: "Accepted",
      timestamp: 1000,
    };

    const result = await buildRunEventsForSubmission(sub, "username", []);
    expect(result).toBeNull();
  });

  it("returns null when startCandidatesMs is null", async () => {
    const sub = {
      statusDisplay: "Accepted",
      timestamp: 1000,
    };

    const result = await buildRunEventsForSubmission(sub, "username", null);
    expect(result).toBeNull();
  });

  it("builds run summary when runs are found in window", async () => {
    const sub = {
      statusDisplay: "Accepted",
      timestamp: 2, // Unix seconds (will be converted to 2000ms)
      titleSlug: "two-sum",
    };

    const mockRuns = [
      { startedAt: 1500, statusMsg: "Success", code: "test code 1" },
      { startedAt: 1800, statusMsg: "Failure", code: "test code 2" },
    ];

    // Mock the DB instance to return run events
    const mockDB = {
      getRunEventsInWindow: vi.fn().mockResolvedValue(mockRuns),
    };
    vi.mocked(getDBInstance).mockResolvedValue(mockDB);

    const result = await buildRunEventsForSubmission(
      sub,
      "username",
      [1000, 1500]
    );

    expect(result).not.toBeNull();
    expect(result.count).toBe(2);
    expect(result.firstRun).toBe(1500); // startedAt of first run
    expect(result.lastRun).toBe(1800); // startedAt of last run
    expect(result.hasDetailedRuns).toBe(true);
    expect(result.runs).toHaveLength(2);
    expect(result._window).toEqual({
      startMs: 1000,
      endMs: 2000, // timestamp * 1000
    });

    expect(mockDB.getRunEventsInWindow).toHaveBeenCalledWith(
      "username",
      "two-sum",
      1000,
      2000
    );
  });

  // Additional tests would require mocking getDBInstance() and getRunEventsInWindow()
  // This is a good candidate for future integration tests with a real or fake IndexedDB
});
