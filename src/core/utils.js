/**
 * Utility functions for the extension
 */

/**
 * SHA-256 helper to hash the LeetCode username before sending to PostHog.
 * Returns a lowercase hex string.
 * This ensures consistency with the webapp's user identification.
 */
export async function sha256(message) {
  const data = new TextEncoder().encode(message);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Get the extension version from the manifest
 */
export function getExtensionVersion() {
  return chrome.runtime.getManifest().version;
}

/**
 * Check if running in development mode
 */
export function isDevelopment() {
  // Check if manifest has development indicators
  const manifest = chrome.runtime.getManifest();
  return (
    manifest.name.includes("Dev") ||
    manifest.version.includes("dev") ||
    // Check if in development build by looking at manifest source
    !chrome.runtime.getURL("").startsWith("chrome-extension://")
  );
}

/**
 * Safely stringify an error object for logging
 */
export function stringifyError(error) {
  if (!error) return "Unknown error";

  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack?.split("\n").slice(0, 3).join("\n"), // First 3 lines only
    };
  }

  if (typeof error === "string") return error;

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
