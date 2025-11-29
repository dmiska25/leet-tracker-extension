/**
 * PostHog Analytics Client for Chrome Extension
 *
 * This module provides analytics tracking for the extension using PostHog.
 * It handles batching, persistence, and multi-tab coordination.
 *
 * Key features:
 * - Batches events to reduce API calls
 * - Uses chrome.storage.local for identity persistence across tabs
 * - SHA-256 hashes usernames for privacy (matches webapp)
 * - Distinguishes extension events from webapp events
 * - Handles multi-tab scenarios gracefully
 */

import { sha256, getExtensionVersion, stringifyError } from "./utils.js";
import { store } from "./config.js";

const POSTHOG_API_HOST = "https://us.i.posthog.com";
const POSTHOG_API_KEY = "phc_q4aPPhGvG181I6oEYZOiQIcYwAXO0wRgKwkRvleEZfT";
const BATCH_ENDPOINT = "/capture/";

const FLUSH_INTERVAL = 30000; // 30 seconds
const MAX_QUEUE_SIZE = 50; // Flush when queue reaches this size
const MAX_QUEUE_CAPACITY = 1000; // Maximum events to keep in queue (prevent unbounded growth)
const BASE_BACKOFF_MS = 5000; // 5 seconds initial backoff
const MAX_BACKOFF_MS = 300000; // 5 minutes max backoff
const STORAGE_KEY_QUEUE = "leettracker_analytics_queue";
const STORAGE_KEY_USER_ID = "leettracker_analytics_user_id";
const STORAGE_KEY_ANON_ID = "leettracker_analytics_anon_id";
const STORAGE_KEY_IDENTIFIED = "leettracker_analytics_identified";
const STORAGE_KEY_RETRY_COUNT = "leettracker_analytics_retry_count";
const STORAGE_KEY_NEXT_FLUSH = "leettracker_analytics_next_flush";

class AnalyticsClient {
  constructor() {
    this.enabled = true;
    this.queue = [];
    this.currentDistinctId = null;
    this.flushTimer = null;
    this.identified = false;
    this.sessionId = this.generateSessionId();

    // Event throttling: track last time each event type was sent
    this.throttleMap = new Map(); // eventName -> timestamp
    this.throttleDuration = 60000; // 60 seconds default

    // Exponential backoff for flush retries
    this.retryCount = 0;
    this.nextFlushTime = null;

    // Initialization state
    this.initialized = false;
  }

  async init() {
    if (this.initialized) {
      return; // Prevent double initialization
    }

    // Load queue from storage and merge with any events already queued during startup
    try {
      const stored = await store.get(STORAGE_KEY_QUEUE);
      if (stored && Array.isArray(stored)) {
        // Merge stored queue with in-memory queue, deduplicating by UUID
        const existingUUIDs = new Set(this.queue.map((e) => e.uuid));
        const uniqueStored = stored.filter((e) => !existingUUIDs.has(e.uuid));

        // Prepend stored events to maintain order (stored are older)
        this.queue = [...uniqueStored, ...this.queue];

        console.log(
          `[LeetTracker][Analytics] Loaded ${
            uniqueStored.length
          } queued events from storage, merged with ${
            this.queue.length - uniqueStored.length
          } in-memory events`
        );
      }
    } catch (error) {
      console.error(
        "[LeetTracker][Analytics] Failed to load queue from storage:",
        error
      );
    }

    // Load retry state from storage
    try {
      const retryCount = await store.get(STORAGE_KEY_RETRY_COUNT);
      const nextFlushTime = await store.get(STORAGE_KEY_NEXT_FLUSH);
      if (typeof retryCount === "number") {
        this.retryCount = retryCount;
      }
      if (typeof nextFlushTime === "number") {
        this.nextFlushTime = nextFlushTime;
      }
    } catch (error) {
      console.error(
        "[LeetTracker][Analytics] Failed to load retry state from storage:",
        error
      );
    }

    // Load current distinct_id
    this.currentDistinctId = await this.getDistinctId();

    // Check if already identified this session
    const identifiedFlag = await store.get(STORAGE_KEY_IDENTIFIED);
    this.identified = identifiedFlag === true;

    // Start auto-flush
    this.startAutoFlush();

    // Flush on page unload
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", () => {
        this.flush();
      });
    }

    this.initialized = true;
  }

  generateSessionId() {
    return `sess_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Get browser name from user agent
   */
  _getBrowserName() {
    if (typeof navigator === "undefined") return "Unknown";
    const ua = navigator.userAgent;
    if (ua.includes("Edg")) return "Edge";
    if (ua.includes("Chrome")) return "Chrome";
    if (ua.includes("Firefox")) return "Firefox";
    if (ua.includes("Safari")) return "Safari";
    return "Unknown";
  }

  /**
   * Get browser version from user agent
   */
  _getBrowserVersion() {
    if (typeof navigator === "undefined") return null;
    const ua = navigator.userAgent;
    let match;

    if (ua.includes("Edg/")) {
      match = ua.match(/Edg\/(\d+)/);
    } else if (ua.includes("Chrome/")) {
      match = ua.match(/Chrome\/(\d+)/);
    } else if (ua.includes("Firefox/")) {
      match = ua.match(/Firefox\/(\d+)/);
    } else if (ua.includes("Version/") && ua.includes("Safari")) {
      match = ua.match(/Version\/(\d+)/);
    }

    return match ? parseInt(match[1]) : null;
  }

  /**
   * Get operating system from user agent
   */
  _getOS() {
    if (typeof navigator === "undefined") return "Unknown";
    const ua = navigator.userAgent;

    if (ua.includes("Win")) return "Windows";
    if (ua.includes("Mac")) return "Mac OS X";
    if (ua.includes("Linux")) return "Linux";
    if (ua.includes("CrOS")) return "Chrome OS";
    return "Unknown";
  }

  /**
   * Identify a user. This should be called when user logs into LeetCode.
   * Safe to call multiple times - PostHog handles it gracefully.
   *
   * @param {string} username - LeetCode username
   * @param {object} properties - Additional user properties
   */
  async identify(username, properties = {}) {
    if (!this.enabled || !username) return;

    try {
      // Hash username to match webapp
      const newDistinctId = await sha256(username);

      // Check if already identified with this ID
      if (this.currentDistinctId === newDistinctId && this.identified) {
        console.log(
          "[LeetTracker][Analytics] User already identified, skipping"
        );
        return;
      }

      // Get the old anonymous ID (if exists) for aliasing
      const oldDistinctId =
        this.currentDistinctId || (await this.getDistinctId());

      // Send $alias event to link anonymous ID to identified ID
      // This must be sent BEFORE we update currentDistinctId
      if (
        oldDistinctId !== newDistinctId &&
        oldDistinctId.startsWith("anon_")
      ) {
        await this.enqueue({
          event: "$create_alias",
          distinct_id: newDistinctId,
          properties: {
            alias: oldDistinctId,
            $anon_distinct_id: oldDistinctId,
          },
        });
        console.log(
          `[LeetTracker][Analytics] Aliasing ${oldDistinctId.substring(
            0,
            20
          )}... to ${newDistinctId.substring(0, 8)}...`
        );
      }

      // NOW update the distinct ID
      this.currentDistinctId = newDistinctId;
      await store.set(STORAGE_KEY_USER_ID, newDistinctId);
      await store.set(STORAGE_KEY_IDENTIFIED, true);
      this.identified = true;

      // Send $identify event to PostHog with user properties
      await this.enqueue({
        event: "$identify",
        distinct_id: newDistinctId,
        properties: {
          $set: {
            username: username,
            platform: "chrome_extension",
            extension_version: getExtensionVersion(),
            ...properties,
          },
          $set_once: {
            first_seen_extension: new Date().toISOString(),
          },
        },
      });

      console.log(
        `[LeetTracker][Analytics] Identified user: ${username} (hashed: ${newDistinctId.substring(
          0,
          8
        )}...)`
      );
    } catch (error) {
      console.error("[LeetTracker][Analytics] Failed to identify user:", error);
    }
  }

  /**
   * Capture an analytics event
   *
   * @param {string} eventName - Name of the event
   * @param {object} properties - Event properties
   * @param {object} options - Capture options
   * @param {boolean} options.throttle - If true, throttle this event to once per minute
   * @param {number} options.throttleDuration - Custom throttle duration in ms (default: 60000)
   * @param {string} options._throttleKey - Internal: custom key for throttling (for differentiated warnings)
   */
  async capture(eventName, properties = {}, options = {}) {
    if (!this.enabled) return;

    // Handle throttling if requested
    if (options.throttle) {
      const throttleDuration =
        options.throttleDuration || this.throttleDuration;
      const now = Date.now();
      // Use custom throttle key if provided, otherwise use event name
      const throttleKey = options._throttleKey || eventName;
      const lastSent = this.throttleMap.get(throttleKey);

      if (lastSent && now - lastSent < throttleDuration) {
        // Event was sent too recently, drop it
        return;
      }

      // Update last sent timestamp
      this.throttleMap.set(throttleKey, now);
    }

    try {
      const distinctId = await this.getDistinctId();

      await this.enqueue({
        event: eventName,
        distinct_id: distinctId,
        properties: {
          ...properties,
          // Add standard properties to all events
          source: "chrome_extension",
          extension_version: getExtensionVersion(),
          session_id: this.sessionId,

          // URL properties (matching PostHog JS SDK)
          $current_url:
            typeof window !== "undefined" ? window.location.href : undefined,
          $host:
            typeof window !== "undefined" ? window.location.host : undefined,
          $pathname:
            typeof window !== "undefined"
              ? window.location.pathname
              : undefined,

          // Browser/Device properties
          $browser: this._getBrowserName(),
          $browser_version: this._getBrowserVersion(),
          $os: this._getOS(),
          $device_type: "Desktop", // Extensions are desktop-only

          // Screen properties
          $screen_height:
            typeof window !== "undefined" ? window.screen.height : undefined,
          $screen_width:
            typeof window !== "undefined" ? window.screen.width : undefined,
          $viewport_height:
            typeof window !== "undefined" ? window.innerHeight : undefined,
          $viewport_width:
            typeof window !== "undefined" ? window.innerWidth : undefined,

          // Referrer (for navigation tracking)
          $referrer:
            typeof document !== "undefined"
              ? document.referrer || "$direct"
              : "$direct",

          // Timezone
          $timezone:
            typeof Intl !== "undefined"
              ? Intl.DateTimeFormat().resolvedOptions().timeZone
              : undefined,
          $timezone_offset: new Date().getTimezoneOffset(),

          // Language
          $browser_language:
            typeof navigator !== "undefined" ? navigator.language : undefined,
          $browser_language_prefix:
            typeof navigator !== "undefined"
              ? navigator.language?.split("-")[0]
              : undefined,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error(
        `[LeetTracker][Analytics] Failed to capture event ${eventName}:`,
        error
      );
    }
  }

  /**
   * Capture an error event with detailed context
   *
   * @param {string} errorType - Type/category of error
   * @param {Error|string} error - The error object or message
   * @param {object} context - Additional context about the error
   * @param {object} options - Capture options (throttle, etc.)
   */
  async captureError(errorType, error, context = {}, options = {}) {
    const errorDetails = stringifyError(error);

    await this.capture(
      "extension_error",
      {
        error_type: errorType,
        error_details: errorDetails,
        ...context,
        severity: context.severity || "error",
      },
      options
    );
  }

  /**
   * Capture an integration warning (e.g., DOM selectors not found)
   * These are critical for monitoring LeetCode UI changes
   *
   * @param {string} integration - Which integration point (e.g., 'submit_button', 'code_editor')
   * @param {string} issue - Description of the issue
   * @param {object} context - Additional context
   * @param {object} options - Capture options (throttle, etc.)
   */
  async captureIntegrationWarning(
    integration,
    issue,
    context = {},
    options = {}
  ) {
    // Create a unique event name that combines integration + issue for throttling
    const eventKey = `integration_warning:${integration}:${issue}`;

    await this.capture(
      "integration_warning",
      {
        integration_point: integration,
        issue_description: issue,
        ...context,
        severity: "warning",
      },
      {
        ...options,
        // Use custom event key for throttling to differentiate between different warnings
        _throttleKey: eventKey,
      }
    );

    // Also log to console for development (but only once per minute to avoid spam)
    const logKey = `log:${eventKey}`;
    const lastLog = this.throttleMap.get(logKey);
    const now = Date.now();
    if (!lastLog || now - lastLog > 60000) {
      console.warn(
        `[LeetTracker][Analytics][Integration] ${integration}: ${issue}`,
        context
      );
      this.throttleMap.set(logKey, now);
    }
  }

  /**
   * Reset identity (logout). Creates new anonymous session.
   */
  async reset() {
    if (!this.enabled) return;

    try {
      const oldId = this.currentDistinctId;

      // Capture signout event before resetting
      await this.capture("user_signed_out", {
        previous_distinct_id: oldId,
      });

      // Flush pending events
      await this.flush();

      // Clear identity
      this.currentDistinctId = null;
      this.identified = false;
      await store.remove([STORAGE_KEY_USER_ID, STORAGE_KEY_IDENTIFIED]);

      // Generate new anonymous ID
      const newAnonId = await this.generateAnonymousId(true);
      this.currentDistinctId = newAnonId;

      console.log(
        "[LeetTracker][Analytics] User identity reset, new anonymous session started"
      );
    } catch (error) {
      console.error(
        "[LeetTracker][Analytics] Failed to reset identity:",
        error
      );
    }
  }

  async enqueue(event) {
    // Add UUID for deduplication
    event.uuid = crypto.randomUUID();
    event.timestamp = event.timestamp || new Date().toISOString();

    this.queue.push(event);

    // Enforce maximum queue capacity to prevent unbounded growth
    // Drop oldest events if queue exceeds capacity (FIFO)
    if (this.queue.length > MAX_QUEUE_CAPACITY) {
      const dropped = this.queue.length - MAX_QUEUE_CAPACITY;
      this.queue = this.queue.slice(-MAX_QUEUE_CAPACITY);
      console.warn(
        `[LeetTracker][Analytics] Queue exceeded capacity, dropped ${dropped} oldest events`
      );
    }

    // Persist queue to storage
    try {
      await store.set(STORAGE_KEY_QUEUE, this.queue);
    } catch (error) {
      console.error("[LeetTracker][Analytics] Failed to persist queue:", error);
    }

    // Flush if queue is full
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      await this.flush();
    }
  }

  async flush() {
    if (this.queue.length === 0) return;

    // Check if we're in backoff period
    const now = Date.now();
    if (this.nextFlushTime && now < this.nextFlushTime) {
      const waitTime = Math.ceil((this.nextFlushTime - now) / 1000);
      console.log(
        `[LeetTracker][Analytics] Flush delayed due to backoff, retry in ${waitTime}s`
      );
      return;
    }

    const batch = [...this.queue];
    this.queue = [];

    // Clear queue from storage
    try {
      await store.set(STORAGE_KEY_QUEUE, []);
    } catch (error) {
      console.error(
        "[LeetTracker][Analytics] Failed to clear queue in storage:",
        error
      );
    }

    try {
      const response = await fetch(`${POSTHOG_API_HOST}${BATCH_ENDPOINT}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          api_key: POSTHOG_API_KEY,
          batch: batch.map((event) => ({
            ...event,
            properties: {
              ...event.properties,
              $lib: "chrome-extension",
              $lib_version: getExtensionVersion(),
            },
          })),
        }),
      });

      if (!response.ok) {
        console.error(
          "[LeetTracker][Analytics] Failed to send events:",
          response.status,
          response.statusText
        );
        // Re-queue failed events with backoff
        await this.handleFlushFailure(batch);
      } else {
        console.log(
          `[LeetTracker][Analytics] Flushed ${batch.length} events to PostHog`
        );
        // Reset backoff on success
        await this.resetBackoff();
      }
    } catch (error) {
      console.error(
        "[LeetTracker][Analytics] Network error while sending events:",
        error
      );
      // Re-queue failed events with backoff
      await this.handleFlushFailure(batch);
    }
  }

  /**
   * Handle flush failure by re-queuing events with capacity limit and applying backoff
   * Drops oldest events if re-queuing would exceed MAX_QUEUE_CAPACITY
   *
   * @param {Array} batch - The batch of events that failed to send
   */
  async handleFlushFailure(batch) {
    // Re-queue failed events (prepend to maintain order)
    this.queue.unshift(...batch);

    // Enforce maximum queue capacity - drop oldest events (from the beginning) if exceeded
    if (this.queue.length > MAX_QUEUE_CAPACITY) {
      const dropped = this.queue.length - MAX_QUEUE_CAPACITY;
      this.queue = this.queue.slice(-MAX_QUEUE_CAPACITY);
      console.warn(
        `[LeetTracker][Analytics] Queue exceeded capacity after re-queue, dropped ${dropped} oldest events`
      );
    }

    // Persist trimmed queue
    try {
      await store.set(STORAGE_KEY_QUEUE, this.queue);
    } catch (storeError) {
      console.error(
        "[LeetTracker][Analytics] Failed to persist queue after failure:",
        storeError
      );
    }

    // Apply exponential backoff
    this.retryCount++;
    const backoffDelay = Math.min(
      MAX_BACKOFF_MS,
      BASE_BACKOFF_MS * Math.pow(2, this.retryCount - 1)
    );
    this.nextFlushTime = Date.now() + backoffDelay;

    console.warn(
      `[LeetTracker][Analytics] Flush failed, retry ${
        this.retryCount
      }, backing off ${Math.ceil(backoffDelay / 1000)}s`
    );

    // Persist retry state
    try {
      await store.set(STORAGE_KEY_RETRY_COUNT, this.retryCount);
      await store.set(STORAGE_KEY_NEXT_FLUSH, this.nextFlushTime);
    } catch (error) {
      console.error(
        "[LeetTracker][Analytics] Failed to persist retry state:",
        error
      );
    }

    // Schedule next flush attempt after backoff delay
    setTimeout(() => {
      this.flush();
    }, backoffDelay);
  }

  /**
   * Reset backoff state after successful flush
   */
  async resetBackoff() {
    if (this.retryCount > 0) {
      console.log(
        `[LeetTracker][Analytics] Flush successful, resetting backoff (was retry ${this.retryCount})`
      );
    }
    this.retryCount = 0;
    this.nextFlushTime = null;

    // Clear retry state from storage
    try {
      await store.remove([STORAGE_KEY_RETRY_COUNT, STORAGE_KEY_NEXT_FLUSH]);
    } catch (error) {
      console.error(
        "[LeetTracker][Analytics] Failed to clear retry state:",
        error
      );
    }
  }

  startAutoFlush() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }

    this.flushTimer = setInterval(() => {
      this.flush();
    }, FLUSH_INTERVAL);
  }

  async getDistinctId() {
    // Check memory first
    if (this.currentDistinctId) {
      return this.currentDistinctId;
    }

    // Check if user is identified
    const userId = await store.get(STORAGE_KEY_USER_ID);
    if (userId) {
      this.currentDistinctId = userId;
      return userId;
    }

    // Use anonymous ID
    const anonId = await this.generateAnonymousId();
    this.currentDistinctId = anonId;
    return anonId;
  }

  async generateAnonymousId(force = false) {
    if (!force) {
      const existing = await store.get(STORAGE_KEY_ANON_ID);
      if (existing) return existing;
    }

    const anonId = `anon_${crypto.randomUUID()}`;
    await store.set(STORAGE_KEY_ANON_ID, anonId);
    return anonId;
  }

  /**
   * Check if user is currently identified
   */
  isIdentified() {
    return this.identified;
  }

  /**
   * Enable or disable analytics
   */
  setEnabled(enabled) {
    this.enabled = enabled;
    console.log(`[LeetTracker][Analytics] ${enabled ? "Enabled" : "Disabled"}`);
  }
}

// Singleton instance
let analyticsInstance = null;
let initPromise = null;
let proxyInstance = null;

/**
 * Initialize analytics client (call once on startup)
 * Must be awaited to ensure proper initialization before use
 *
 * @returns {Promise<AnalyticsClient>} Initialized analytics client
 */
export async function initAnalytics() {
  if (analyticsInstance) {
    return analyticsInstance;
  }

  // If initialization is already in progress, return the same promise
  if (initPromise) {
    return initPromise;
  }

  // Start initialization
  initPromise = (async () => {
    analyticsInstance = new AnalyticsClient();
    await analyticsInstance.init();
    return analyticsInstance;
  })();

  return initPromise;
}

/**
 * Get analytics client instance
 * Returns a proxy that queues calls until initialization completes
 * This ensures all operations happen on a fully-initialized client
 *
 * @returns {AnalyticsClient} Analytics client (or proxy if not yet initialized)
 */
export function getAnalytics() {
  // If already initialized, return the real instance
  if (analyticsInstance) {
    return analyticsInstance;
  }

  // If proxy already created, return it
  if (proxyInstance) {
    return proxyInstance;
  }

  // Create a queue for operations called before initialization
  const operationQueue = [];
  let isInitializing = false;

  // Start initialization if not already in progress
  if (!initPromise && !isInitializing) {
    isInitializing = true;
    console.log(
      "[LeetTracker][Analytics] Analytics not initialized, starting initialization..."
    );
    initAnalytics()
      .then(() => {
        // Replay queued operations on the real instance
        if (operationQueue.length > 0) {
          console.log(
            `[LeetTracker][Analytics] Replaying ${operationQueue.length} queued operations`
          );
          operationQueue.forEach(({ method, args, resolve, reject }) => {
            try {
              const result = analyticsInstance[method](...args);
              // Handle both sync and async methods
              if (result && typeof result.then === "function") {
                result.then(resolve).catch(reject);
              } else {
                resolve(result);
              }
            } catch (error) {
              reject(error);
            }
          });
          operationQueue.length = 0; // Clear the queue
        }
      })
      .catch((error) => {
        console.error("[LeetTracker][Analytics] Initialization failed:", error);
        // Reject all queued operations
        operationQueue.forEach(({ reject }) => {
          reject(new Error("Analytics initialization failed"));
        });
        operationQueue.length = 0;
      });
  }

  // Create a proxy that queues method calls until initialization completes
  proxyInstance = new Proxy(
    {},
    {
      get(_target, prop) {
        // If already initialized, delegate to real instance
        if (analyticsInstance) {
          return analyticsInstance[prop];
        }

        // For method calls, queue them
        if (typeof AnalyticsClient.prototype[prop] === "function") {
          return function (...args) {
            // If initialized by the time method is called, use real instance
            if (analyticsInstance) {
              return analyticsInstance[prop](...args);
            }

            // Otherwise, queue the operation and return a promise
            return new Promise((resolve, reject) => {
              operationQueue.push({ method: prop, args, resolve, reject });
            });
          };
        }

        // For property access, return undefined or a safe default
        return undefined;
      },
    }
  );

  return proxyInstance;
}

/**
 * Reset analytics identity (logout)
 */
export async function resetAnalyticsIdentity() {
  const analytics = getAnalytics();
  if (analytics) {
    await analytics.reset();
  }
}
