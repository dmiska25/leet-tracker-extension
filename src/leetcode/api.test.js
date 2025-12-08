import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchAllSubmissions, verifyRecentSubmissionStatus } from "./api.js";

// Mock global fetch
global.fetch = vi.fn();

describe("fetchAllSubmissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock Date.now to return consistent time
    vi.spyOn(Date, "now").mockReturnValue(1765228875000); // Matches the timestamp in the bug report
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should update statusDisplay with verified status for recent submissions", async () => {
    const mockSubmission = {
      id: "1850531905",
      titleSlug: "minimum-time-to-visit-disappearing-nodes",
      statusDisplay: "Internal Error", // Initial incorrect status
      timestamp: 1765228875, // Within last 60 seconds (now = 1765228875000ms)
      lang: "python3",
    };

    // Mock the initial submission fetch
    global.fetch.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              submissionList: {
                hasNext: false,
                submissions: [mockSubmission],
              },
            },
          }),
      })
    );

    // Mock the verification check endpoint responses
    // First call: PENDING
    global.fetch.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            state: "PENDING",
          }),
      })
    );

    // Second call: STARTED
    global.fetch.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            state: "STARTED",
          }),
      })
    );

    // Third call: SUCCESS with correct status
    global.fetch.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            state: "SUCCESS",
            status_msg: "Accepted", // The correct status
            finished: true,
          }),
      })
    );

    const result = await fetchAllSubmissions(0);

    expect(result).toHaveLength(1);
    // The bug was that statusDisplay remained "Internal Error"
    // Now it should be updated to "Accepted"
    expect(result[0].statusDisplay).toBe("Accepted");
    expect(result[0].id).toBe("1850531905");
  });

  it("should not update statusDisplay if verification fails", async () => {
    vi.useFakeTimers();

    const mockSubmission = {
      id: "123456",
      titleSlug: "test-problem",
      statusDisplay: "Internal Error",
      timestamp: 1765228875, // Within last 60 seconds
      lang: "python3",
    };

    // Mock the initial submission fetch
    global.fetch.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              submissionList: {
                hasNext: false,
                submissions: [mockSubmission],
              },
            },
          }),
      })
    );

    // Mock verification to timeout (all calls return PENDING)
    global.fetch.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            state: "PENDING",
          }),
      })
    );

    const fetchPromise = fetchAllSubmissions(0);

    // Fast-forward past the 15s timeout
    await vi.advanceTimersByTimeAsync(16000);

    const result = await fetchPromise;

    expect(result).toHaveLength(1);
    // Should keep original status if verification times out
    expect(result[0].statusDisplay).toBe("Internal Error");

    vi.useRealTimers();
  });

  it("should not verify submissions older than 60 seconds", async () => {
    const oldSubmission = {
      id: "123456",
      titleSlug: "test-problem",
      statusDisplay: "Accepted",
      timestamp: 1765228775, // 100 seconds ago (now = 1765228875000ms)
      lang: "python3",
    };

    // Mock the initial submission fetch
    global.fetch.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              submissionList: {
                hasNext: false,
                submissions: [oldSubmission],
              },
            },
          }),
      })
    );

    const result = await fetchAllSubmissions(0);

    expect(result).toHaveLength(1);
    // Should not call verification endpoint (only 1 fetch call for submissions)
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result[0].statusDisplay).toBe("Accepted");
  });
});

describe("verifyRecentSubmissionStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("should return verified status when submission completes", async () => {
    global.fetch
      .mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              state: "PENDING",
            }),
        })
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              state: "SUCCESS",
              status_msg: "Accepted",
              finished: true,
            }),
        })
      );

    const verificationPromise = verifyRecentSubmissionStatus("12345");

    // Advance timers to trigger the polling
    await vi.advanceTimersByTimeAsync(1000);

    const result = await verificationPromise;

    expect(result.verified).toBe(true);
    expect(result.state).toBe("SUCCESS");
    expect(result.statusMsg).toBe("Accepted");
  });

  it("should timeout after maxWaitMs", async () => {
    global.fetch.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            state: "PENDING",
          }),
      })
    );

    const verificationPromise = verifyRecentSubmissionStatus("12345", 5000);

    // Advance past the timeout
    await vi.advanceTimersByTimeAsync(6000);

    const result = await verificationPromise;

    expect(result.verified).toBe(false);
    expect(result.state).toBe("TIMEOUT");
  });
});
