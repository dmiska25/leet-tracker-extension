import { describe, it, expect } from "vitest";
import {
  sha256,
  stringifyError,
  getExtensionVersion,
  isDevelopment,
} from "./utils.js";

describe("sha256", () => {
  it("produces consistent hash for same input", async () => {
    const input = "test-username";
    const hash1 = await sha256(input);
    const hash2 = await sha256(input);
    expect(hash1).toBe(hash2);
  });

  it("produces different hashes for different inputs", async () => {
    const hash1 = await sha256("user1");
    const hash2 = await sha256("user2");
    expect(hash1).not.toBe(hash2);
  });

  it("returns lowercase hex string", async () => {
    const hash = await sha256("test");
    expect(hash).toMatch(/^[a-f0-9]+$/);
    expect(hash.length).toBeGreaterThan(0);
  });

  it("handles empty string", async () => {
    const hash = await sha256("");
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });

  it("handles unicode", async () => {
    const hash = await sha256("用户名");
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });

  it("handles special characters", async () => {
    const hash = await sha256("user@example.com!#$%");
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });

  it("handles long strings", async () => {
    const longString = "a".repeat(10000);
    const hash = await sha256(longString);
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });
});

describe("stringifyError", () => {
  it("extracts message from Error object", () => {
    const error = new Error("Test error");
    const result = stringifyError(error);
    expect(result.message).toBe("Test error");
    expect(result.name).toBe("Error");
    expect(result.stack).toBeDefined();
  });

  it("limits stack trace to first 3 lines", () => {
    const error = new Error("Test");
    const result = stringifyError(error);
    if (result.stack) {
      const stackLines = result.stack.split("\n");
      expect(stackLines.length).toBeLessThanOrEqual(3);
    }
  });

  it("handles string errors", () => {
    const result = stringifyError("Simple error string");
    expect(result).toBe("Simple error string");
  });

  it("handles null", () => {
    expect(stringifyError(null)).toBe("Unknown error");
  });

  it("handles undefined", () => {
    expect(stringifyError(undefined)).toBe("Unknown error");
  });

  it("handles plain objects", () => {
    const error = { code: "ERR_001", msg: "Failed" };
    const result = stringifyError(error);
    expect(result).toContain("ERR_001");
  });

  it("handles TypeError", () => {
    const error = new TypeError("Type error occurred");
    const result = stringifyError(error);
    expect(result.message).toBe("Type error occurred");
    expect(result.name).toBe("TypeError");
  });

  it("handles RangeError", () => {
    const error = new RangeError("Range exceeded");
    const result = stringifyError(error);
    expect(result.message).toBe("Range exceeded");
    expect(result.name).toBe("RangeError");
  });

  it("handles number as error", () => {
    const result = stringifyError(404);
    expect(result).toBe("404");
  });

  it("handles boolean as error", () => {
    // false is falsy, so returns "Unknown error"
    const result = stringifyError(false);
    expect(result).toBe("Unknown error");

    // true should be converted to string
    const result2 = stringifyError(true);
    expect(result2).toBe("true");
  });

  it("preserves error name for custom errors", () => {
    class CustomError extends Error {
      constructor(message) {
        super(message);
        this.name = "CustomError";
      }
    }

    const error = new CustomError("Custom error message");
    const result = stringifyError(error);
    expect(result.message).toBe("Custom error message");
    expect(result.name).toBe("CustomError");
  });
});

describe("getExtensionVersion", () => {
  it("returns version from manifest", () => {
    const version = getExtensionVersion();
    expect(version).toBe("0.1.1"); // From mocked manifest in setup.js
  });

  it("returns a string", () => {
    const version = getExtensionVersion();
    expect(typeof version).toBe("string");
  });

  it("returns a valid semver format", () => {
    const version = getExtensionVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("isDevelopment", () => {
  it("returns a boolean", () => {
    const isDev = isDevelopment();
    expect(typeof isDev).toBe("boolean");
  });

  it("detects dev mode from manifest name", () => {
    // Based on our mock, manifest.name includes "Dev"
    const isDev = isDevelopment();
    expect(isDev).toBe(true);
  });
});
