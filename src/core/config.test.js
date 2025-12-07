import { describe, it, expect, vi, beforeEach } from "vitest";
import { store, keys, util } from "./config.js";

describe("store.get", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retrieves value from chrome.storage.local", async () => {
    chrome.storage.local.get.mockImplementation((keys, callback) => {
      callback({ testKey: "testValue" });
    });

    const value = await store.get("testKey");
    expect(value).toBe("testValue");
    expect(chrome.storage.local.get).toHaveBeenCalledWith(
      ["testKey"],
      expect.any(Function)
    );
  });

  it("returns fallback when key not found", async () => {
    chrome.storage.local.get.mockImplementation((keys, callback) => {
      callback({});
    });

    const value = await store.get("missingKey", "defaultValue");
    expect(value).toBe("defaultValue");
  });

  it("returns null as default fallback", async () => {
    chrome.storage.local.get.mockImplementation((keys, callback) => {
      callback({});
    });

    const value = await store.get("missingKey");
    expect(value).toBeNull();
  });

  it("handles complex objects", async () => {
    const testObject = { nested: { data: [1, 2, 3] } };
    chrome.storage.local.get.mockImplementation((keys, callback) => {
      callback({ testKey: testObject });
    });

    const value = await store.get("testKey");
    expect(value).toEqual(testObject);
  });
});

describe("store.set", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores value in chrome.storage.local", async () => {
    chrome.storage.local.set.mockImplementation((data, callback) => {
      if (callback) callback();
    });

    await store.set("testKey", "testValue");
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      { testKey: "testValue" },
      expect.any(Function)
    );
  });

  it("handles complex objects", async () => {
    const testObject = { complex: { nested: true } };
    chrome.storage.local.set.mockImplementation((data, callback) => {
      if (callback) callback();
    });

    await store.set("testKey", testObject);
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      { testKey: testObject },
      expect.any(Function)
    );
  });

  it("handles arrays", async () => {
    const testArray = [1, 2, 3, 4, 5];
    chrome.storage.local.set.mockImplementation((data, callback) => {
      if (callback) callback();
    });

    await store.set("testKey", testArray);
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      { testKey: testArray },
      expect.any(Function)
    );
  });
});

describe("store.remove", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes single key from chrome.storage.local", async () => {
    chrome.storage.local.remove.mockImplementation((keys, callback) => {
      if (callback) callback();
    });

    await store.remove("testKey");
    expect(chrome.storage.local.remove).toHaveBeenCalledWith(
      "testKey",
      expect.any(Function)
    );
  });

  it("removes multiple keys", async () => {
    chrome.storage.local.remove.mockImplementation((keys, callback) => {
      if (callback) callback();
    });

    await store.remove(["key1", "key2"]);
    expect(chrome.storage.local.remove).toHaveBeenCalledWith(
      ["key1", "key2"],
      expect.any(Function)
    );
  });
});

describe("keys helpers", () => {
  it("generates correct visitLog key", () => {
    expect(keys.visitLog("testuser")).toBe(
      "leettracker_problem_visit_log_testuser"
    );
  });

  it("generates correct manifest key", () => {
    expect(keys.manifest("testuser")).toBe(
      "leettracker_sync_manifest_testuser"
    );
  });

  it("generates correct seenProblems key", () => {
    expect(keys.seenProblems("testuser")).toBe(
      "leettracker_seen_problems_testuser"
    );
  });

  it("generates correct chunk key", () => {
    expect(keys.chunk("testuser", 0)).toBe(
      "leettracker_leetcode_chunk_testuser_0"
    );
    expect(keys.chunk("testuser", 5)).toBe(
      "leettracker_leetcode_chunk_testuser_5"
    );
  });

  it("generates correct snapshots key", () => {
    expect(keys.snapshots("testuser", "two-sum")).toBe(
      "leettracker_snapshots_testuser_two-sum"
    );
  });

  it("generates correct templates key", () => {
    expect(keys.templates("two-sum")).toBe("leettracker_templates_two-sum");
  });

  it("generates correct recentJourneys key", () => {
    expect(keys.recentJourneys("testuser")).toBe(
      "leettracker_recent_journeys_testuser"
    );
  });

  it("generates correct recentRuns key", () => {
    expect(keys.recentRuns("testuser")).toBe(
      "leettracker_recent_runs_testuser"
    );
  });

  it("returns correct problemIdMap key", () => {
    expect(keys.problemIdMap).toBe("leettracker_problem_slug_to_id_map");
  });
});

describe("util.sleep", () => {
  it("resolves after specified time", async () => {
    vi.useFakeTimers();

    const promise = util.sleep(1000);

    vi.advanceTimersByTime(999);
    expect(promise).toBeInstanceOf(Promise);

    vi.advanceTimersByTime(1);
    await promise;

    vi.useRealTimers();
  });

  it("handles zero delay", async () => {
    await expect(util.sleep(0)).resolves.toBeUndefined();
  });
});

describe("util.nowSec", () => {
  it("returns current time in seconds", () => {
    const now = util.nowSec();
    const expected = Math.floor(Date.now() / 1000);

    // Should be within 1 second (account for test execution time)
    expect(Math.abs(now - expected)).toBeLessThanOrEqual(1);
  });

  it("returns integer value", () => {
    const now = util.nowSec();
    expect(Number.isInteger(now)).toBe(true);
  });

  it("returns reasonable unix timestamp", () => {
    const now = util.nowSec();
    // Should be after 2020 and before 2100
    expect(now).toBeGreaterThan(1577836800); // 2020-01-01
    expect(now).toBeLessThan(4102444800); // 2100-01-01
  });
});
