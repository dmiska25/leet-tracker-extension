import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkLockAvailability } from "./locks.js";

describe("checkLockAvailability", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows acquisition when no lock exists", () => {
    const result = checkLockAvailability(null);
    expect(result).toEqual({ canAcquire: true, reason: "no_lock" });
  });

  it("allows acquisition when lock is not active", () => {
    const lock = { isLocked: false };
    const result = checkLockAvailability(lock);
    expect(result).toEqual({ canAcquire: true, reason: "no_lock" });
  });

  it("denies acquisition when lock has fresh heartbeat", () => {
    const now = Date.now();
    const lock = {
      isLocked: true,
      sessionId: "session_123",
      lastHeartbeat: now - 60000, // 1 minute ago (< 3 min timeout)
    };
    const result = checkLockAvailability(lock);
    expect(result.canAcquire).toBe(false);
    expect(result.reason).toBe("active");
  });

  it("allows acquisition when heartbeat expired", () => {
    const now = Date.now();
    const HEARTBEAT_TIMEOUT_MS = 180000; // 3 minutes
    const lock = {
      isLocked: true,
      sessionId: "session_123",
      lastHeartbeat: now - HEARTBEAT_TIMEOUT_MS - 1000, // 3+ minutes ago
    };
    const result = checkLockAvailability(lock);
    expect(result.canAcquire).toBe(true);
    expect(result.reason).toBe("heartbeat_expired");
  });

  it("handles missing lastHeartbeat gracefully", () => {
    const lock = {
      isLocked: true,
      sessionId: "session_123",
      // lastHeartbeat missing
    };
    const result = checkLockAvailability(lock);
    // When lastHeartbeat is 0 or missing, timeSinceHeartbeat will be very large
    expect(result.canAcquire).toBe(true);
  });

  it("handles lastHeartbeat as 0", () => {
    const lock = {
      isLocked: true,
      sessionId: "session_123",
      lastHeartbeat: 0,
    };
    const result = checkLockAvailability(lock);
    expect(result.canAcquire).toBe(true);
  });

  it("includes context in logging but does not affect result", () => {
    const now = Date.now();
    const lock = {
      isLocked: true,
      lastHeartbeat: now - 60000,
    };

    // Context should not change the logic, just logging
    const result = checkLockAvailability(lock, " after jitter");
    expect(result.canAcquire).toBe(false);
    expect(result.reason).toBe("active");
  });

  it("handles lock with undefined isLocked", () => {
    const lock = {
      sessionId: "session_123",
      // isLocked undefined
    };
    const result = checkLockAvailability(lock);
    expect(result.canAcquire).toBe(true);
    expect(result.reason).toBe("no_lock");
  });

  it("checks exact boundary of heartbeat timeout", () => {
    const now = Date.now();
    const HEARTBEAT_TIMEOUT_MS = 180000; // 3 minutes exactly

    const lockAtBoundary = {
      isLocked: true,
      sessionId: "session_123",
      lastHeartbeat: now - HEARTBEAT_TIMEOUT_MS,
    };

    const result = checkLockAvailability(lockAtBoundary);
    // At exactly the boundary (timeSinceHeartbeat == TIMEOUT), the condition is:
    // timeSinceHeartbeat < TIMEOUT is false, so lock is expired
    expect(result.canAcquire).toBe(true);
    expect(result.reason).toBe("heartbeat_expired");
  });

  it("handles very recent heartbeat", () => {
    const now = Date.now();
    const lock = {
      isLocked: true,
      sessionId: "session_123",
      lastHeartbeat: now - 100, // Just 100ms ago
    };
    const result = checkLockAvailability(lock);
    expect(result.canAcquire).toBe(false);
    expect(result.reason).toBe("active");
  });

  it("handles future heartbeat timestamp", () => {
    const now = Date.now();
    const lock = {
      isLocked: true,
      sessionId: "session_123",
      lastHeartbeat: now + 60000, // 1 minute in the future (clock skew)
    };
    const result = checkLockAvailability(lock);
    // Negative timeSinceHeartbeat should still be < timeout
    expect(result.canAcquire).toBe(false);
  });
});
