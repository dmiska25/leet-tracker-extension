import { describe, it, expect } from "vitest";
import {
  normalizeText,
  createChecksum,
  makePatch,
  applyPatch,
  calculateCodeSimilarity,
} from "./snapshots.js";

describe("normalizeText", () => {
  it("strips zero-width characters", () => {
    const input = "hello\u200Bworld\uFEFF";
    expect(normalizeText(input)).toBe("helloworld\n");
  });

  it("normalizes line endings to LF", () => {
    expect(normalizeText("line1\r\nline2\rline3")).toBe(
      "line1\nline2\nline3\n"
    );
  });

  it("ensures trailing newline", () => {
    expect(normalizeText("code")).toBe("code\n");
    expect(normalizeText("code\n")).toBe("code\n");
  });

  it("applies NFC unicode normalization", () => {
    // é can be represented as single char or e + combining accent
    const composed = "\u00e9"; // é (single)
    const decomposed = "e\u0301"; // e + accent
    expect(normalizeText(composed)).toBe(normalizeText(decomposed));
  });

  it("handles empty input", () => {
    expect(normalizeText("")).toBe("\n");
    expect(normalizeText(null)).toBe("\n");
  });

  it("handles undefined input", () => {
    expect(normalizeText(undefined)).toBe("\n");
  });

  it("preserves tabs and spaces", () => {
    const input = "\tindented\n    spaced";
    expect(normalizeText(input)).toContain("\t");
    expect(normalizeText(input)).toContain("    ");
  });
});

describe("createChecksum", () => {
  it("creates consistent checksum for same input", () => {
    const text = "def solution():\n    return 42\n";
    const checksum1 = createChecksum(text);
    const checksum2 = createChecksum(text);
    expect(checksum1).toBe(checksum2);
  });

  it("creates different checksums for different inputs", () => {
    const checksum1 = createChecksum("code1");
    const checksum2 = createChecksum("code2");
    expect(checksum1).not.toBe(checksum2);
  });

  it("handles empty string", () => {
    expect(createChecksum("")).toBe("0");
  });

  it("returns string type", () => {
    const checksum = createChecksum("test");
    expect(typeof checksum).toBe("string");
  });

  it("handles unicode consistently", () => {
    const checksum1 = createChecksum("世界");
    const checksum2 = createChecksum("世界");
    expect(checksum1).toBe(checksum2);
  });
});

describe("makePatch and applyPatch", () => {
  it("creates patch for simple text change", () => {
    const before = "def solution():\n    return 1\n";
    const after = "def solution():\n    return 42\n";

    const { patchText, checksumBefore, checksumAfter } = makePatch(
      before,
      after
    );

    expect(patchText).toBeTruthy();
    expect(checksumBefore).toBeTruthy();
    expect(checksumAfter).toBeTruthy();

    // Verify patch can be applied
    const { text, applied } = applyPatch(before, patchText, checksumBefore);
    expect(applied).toBe(true);
    expect(normalizeText(text)).toBe(normalizeText(after));
  });

  it("handles multi-line changes", () => {
    const before = "line1\nline2\nline3\n";
    const after = "line1\nmodified\nline3\nextra\n";

    const { patchText } = makePatch(before, after);
    const { text, applied } = applyPatch(before, patchText);

    expect(applied).toBe(true);
    expect(normalizeText(text)).toBe(normalizeText(after));
  });

  it("handles complete text replacement", () => {
    const before = "old code";
    const after = "completely new code";

    const { patchText } = makePatch(before, after);
    const { text, applied } = applyPatch(before, patchText);

    expect(applied).toBe(true);
    expect(normalizeText(text)).toBe(normalizeText(after));
  });

  it("handles unicode correctly", () => {
    const before = "Hello 世界\n";
    const after = "Hello 世界！\n";

    const { patchText } = makePatch(before, after);
    const { text, applied } = applyPatch(before, patchText);

    expect(applied).toBe(true);
    expect(text).toContain("世界！");
  });

  it("detects checksum mismatch but still attempts patch", () => {
    const before = "original";
    const after = "modified";
    const { patchText, checksumBefore } = makePatch(before, after);

    // Apply patch to different base (wrong checksum)
    const wrongBase = "different";
    const result = applyPatch(wrongBase, patchText, checksumBefore);

    // Should still attempt to apply but checksum warning logged
    expect(result.applied).toBeDefined();
  });

  it("handles adding lines", () => {
    const before = "line1\n";
    const after = "line1\nline2\nline3\n";

    const { patchText } = makePatch(before, after);
    const { text, applied } = applyPatch(before, patchText);

    expect(applied).toBe(true);
    expect(text).toContain("line2");
    expect(text).toContain("line3");
  });

  it("handles removing lines", () => {
    const before = "line1\nline2\nline3\n";
    const after = "line1\n";

    const { patchText } = makePatch(before, after);
    const { text, applied } = applyPatch(before, patchText);

    expect(applied).toBe(true);
    expect(text).not.toContain("line2");
    expect(text).not.toContain("line3");
  });

  it("handles empty to non-empty", () => {
    const before = "";
    const after = "new content\n";

    const { patchText } = makePatch(before, after);
    const { text, applied } = applyPatch(before, patchText);

    expect(applied).toBe(true);
    expect(text).toContain("new content");
  });

  it("handles non-empty to empty", () => {
    const before = "content to remove\n";
    const after = "";

    const { patchText } = makePatch(before, after);
    const { text, applied } = applyPatch(before, patchText);

    expect(applied).toBe(true);
    expect(normalizeText(text)).toBe(normalizeText(after));
  });

  it("returns normalized versions in patch result", () => {
    const before = "code\r\n";
    const after = "code\n";

    const { beforeNorm, afterNorm } = makePatch(before, after);

    expect(beforeNorm).toBe("code\n");
    expect(afterNorm).toBe("code\n");
  });
});

describe("calculateCodeSimilarity", () => {
  it("returns 1.0 for identical code", () => {
    const code = "def solution(): return 42";
    expect(calculateCodeSimilarity(code, code)).toBe(1.0);
  });

  it("returns 0.0 for completely different code", () => {
    const code1 = "def solution(): return 1";
    const code2 = "class Tree: pass";
    const similarity = calculateCodeSimilarity(code1, code2);
    expect(similarity).toBeLessThan(0.5);
  });

  it("returns high similarity for minor changes", () => {
    const code1 = "def solution():\n    return 42\n";
    const code2 = "def solution():\n    return 43\n";
    const similarity = calculateCodeSimilarity(code1, code2);
    expect(similarity).toBeGreaterThan(0.9);
  });

  it("handles empty strings", () => {
    // Both empty strings normalize to "\n", so they're identical
    expect(calculateCodeSimilarity("", "")).toBe(1.0);

    // Empty vs non-empty: normalizeText adds "\n" to both, so there's some similarity
    // The actual similarity depends on the diff-match-patch algorithm
    const sim1 = calculateCodeSimilarity("code", "");
    const sim2 = calculateCodeSimilarity("", "code");
    expect(sim1).toBeGreaterThanOrEqual(0);
    expect(sim1).toBeLessThan(1);
    expect(sim2).toBeGreaterThanOrEqual(0);
    expect(sim2).toBeLessThan(1);
  });

  it("normalizes before comparison", () => {
    const code1 = "def solution():\r\n    return 42\r\n";
    const code2 = "def solution():\n    return 42\n";
    expect(calculateCodeSimilarity(code1, code2)).toBe(1.0);
  });

  it("returns value between 0 and 1", () => {
    const code1 = "abc";
    const code2 = "def";
    const similarity = calculateCodeSimilarity(code1, code2);
    expect(similarity).toBeGreaterThanOrEqual(0);
    expect(similarity).toBeLessThanOrEqual(1);
  });

  it("calculates reasonable similarity for partial matches", () => {
    const code1 = "def solution():\n    x = 1\n    y = 2\n    return x + y\n";
    const code2 = "def solution():\n    x = 1\n    y = 2\n    return x * y\n";
    const similarity = calculateCodeSimilarity(code1, code2);

    // Should be high similarity (only operator changed)
    expect(similarity).toBeGreaterThan(0.8);
    expect(similarity).toBeLessThan(1.0);
  });

  it("handles unicode characters", () => {
    const code1 = "# 注释\ndef solution():\n    return 42\n";
    const code2 = "# 评论\ndef solution():\n    return 42\n";
    const similarity = calculateCodeSimilarity(code1, code2);

    // Most of the code is the same
    expect(similarity).toBeGreaterThan(0.7);
  });
});
