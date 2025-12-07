import { describe, it, expect } from "vitest";
import { deriveSolveWindow } from "./sync.js";

// DAY_S constant from config
const DAY_S = 86400; // 24 hours in seconds

describe("deriveSolveWindow", () => {
  it("returns null when no matching visits", () => {
    const sub = {
      titleSlug: "two-sum",
      timestamp: 100000, // Use larger timestamp
    };
    const visitLog = [
      { slug: "three-sum", ts: 99900 }, // Different problem
      { slug: "two-sum", ts: 100 }, // Too old (> 24h = 86400s before submission)
    ];

    const result = deriveSolveWindow(sub, visitLog);
    expect(result).toEqual({
      startSec: null,
      solveTimeSec: null,
    });
  });

  it("calculates solve time from most recent visit", () => {
    const sub = {
      titleSlug: "two-sum",
      timestamp: 1000,
    };
    const visitLog = [
      { slug: "two-sum", ts: 500 }, // First visit
      { slug: "two-sum", ts: 800 }, // Most recent visit (should use this)
      { slug: "three-sum", ts: 850 },
    ];

    const result = deriveSolveWindow(sub, visitLog);
    expect(result).toEqual({
      startSec: 800,
      solveTimeSec: 200, // 1000 - 800
    });
  });

  it("ignores visits after submission", () => {
    const sub = {
      titleSlug: "two-sum",
      timestamp: 1000,
    };
    const visitLog = [
      { slug: "two-sum", ts: 500 },
      { slug: "two-sum", ts: 1500 }, // After submission
    ];

    const result = deriveSolveWindow(sub, visitLog);
    expect(result.startSec).toBe(500);
    expect(result.solveTimeSec).toBe(500);
  });

  it("filters out visits older than 24 hours", () => {
    const now = 100000;
    const sub = {
      titleSlug: "two-sum",
      timestamp: now,
    };
    const visitLog = [
      { slug: "two-sum", ts: now - DAY_S - 100 }, // Too old (beyond 24h)
      { slug: "two-sum", ts: now - 100 }, // Valid (within 24h)
    ];

    const result = deriveSolveWindow(sub, visitLog);
    expect(result.startSec).toBe(now - 100);
    expect(result.solveTimeSec).toBe(100);
  });

  it("handles empty visit log", () => {
    const sub = { titleSlug: "two-sum", timestamp: 1000 };
    const result = deriveSolveWindow(sub, []);
    expect(result.startSec).toBeNull();
    expect(result.solveTimeSec).toBeNull();
  });

  it("handles null visit log", () => {
    const sub = { titleSlug: "two-sum", timestamp: 1000 };
    const result = deriveSolveWindow(sub, null);
    expect(result.startSec).toBeNull();
    expect(result.solveTimeSec).toBeNull();
  });

  it("handles undefined visit log", () => {
    const sub = { titleSlug: "two-sum", timestamp: 1000 };
    const result = deriveSolveWindow(sub, undefined);
    expect(result.startSec).toBeNull();
    expect(result.solveTimeSec).toBeNull();
  });

  it("handles exact 24-hour boundary", () => {
    const now = 100000;
    const sub = {
      titleSlug: "two-sum",
      timestamp: now,
    };
    const visitLog = [
      { slug: "two-sum", ts: now - DAY_S }, // Exactly 24 hours
    ];

    const result = deriveSolveWindow(sub, visitLog);
    expect(result.startSec).toBe(now - DAY_S);
    expect(result.solveTimeSec).toBe(DAY_S);
  });

  it("uses most recent of multiple valid visits", () => {
    const sub = {
      titleSlug: "two-sum",
      timestamp: 10000,
    };
    const visitLog = [
      { slug: "two-sum", ts: 5000 },
      { slug: "two-sum", ts: 8000 },
      { slug: "two-sum", ts: 9000 }, // Latest valid visit
    ];

    const result = deriveSolveWindow(sub, visitLog);
    expect(result.startSec).toBe(9000); // Latest visit
    expect(result.solveTimeSec).toBe(1000); // 10000 - 9000
  });

  it("handles mixed valid and invalid visits", () => {
    const now = 100000;
    const sub = {
      titleSlug: "two-sum",
      timestamp: now,
    };
    const visitLog = [
      { slug: "two-sum", ts: now - DAY_S - 1000 }, // Too old
      { slug: "three-sum", ts: now - 500 }, // Wrong problem
      { slug: "two-sum", ts: now - 1000 }, // Valid
      { slug: "two-sum", ts: now + 500 }, // After submission
    ];

    const result = deriveSolveWindow(sub, visitLog);
    expect(result.startSec).toBe(now - 1000);
    expect(result.solveTimeSec).toBe(1000);
  });

  it("handles visit at exact submission time", () => {
    const sub = {
      titleSlug: "two-sum",
      timestamp: 1000,
    };
    const visitLog = [
      { slug: "two-sum", ts: 1000 }, // Same time as submission
    ];

    const result = deriveSolveWindow(sub, visitLog);
    // Visit at exact time should be excluded (< condition, not <=)
    expect(result.startSec).toBeNull();
    expect(result.solveTimeSec).toBeNull();
  });

  it("handles zero solve time", () => {
    const sub = {
      titleSlug: "two-sum",
      timestamp: 1000,
    };
    const visitLog = [
      { slug: "two-sum", ts: 999 }, // 1 second before
    ];

    const result = deriveSolveWindow(sub, visitLog);
    expect(result.startSec).toBe(999);
    expect(result.solveTimeSec).toBe(1);
  });

  it("handles multiple problems in log", () => {
    const sub = {
      titleSlug: "two-sum",
      timestamp: 10000,
    };
    const visitLog = [
      { slug: "three-sum", ts: 9900 },
      { slug: "two-sum", ts: 9950 },
      { slug: "four-sum", ts: 9960 },
      { slug: "two-sum", ts: 9970 },
      { slug: "three-sum", ts: 9980 },
    ];

    const result = deriveSolveWindow(sub, visitLog);
    // Should only consider two-sum visits, and pick the latest one
    expect(result.startSec).toBe(9970);
    expect(result.solveTimeSec).toBe(30);
  });

  it("handles large time values", () => {
    const now = Math.floor(Date.now() / 1000); // Current Unix timestamp
    const sub = {
      titleSlug: "two-sum",
      timestamp: now,
    };
    const visitLog = [
      { slug: "two-sum", ts: now - 3600 }, // 1 hour ago
    ];

    const result = deriveSolveWindow(sub, visitLog);
    expect(result.startSec).toBe(now - 3600);
    expect(result.solveTimeSec).toBe(3600);
  });
});
