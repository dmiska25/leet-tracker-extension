// src/lt-net.js
(() => {
  const LT = globalThis.LT || (globalThis.LT = {});
  const { GRAPHQL_URL } = LT.consts || {};

  if (!GRAPHQL_URL) {
    console.warn(
      "[LeetTracker] GRAPHQL_URL missing from LT.consts; lt-net.js may not function correctly."
    );
  }

  /**
   * Retry a fetch-like operation with exponential backoff up to a cap.
   * @param {() => Promise<any>} fetchFn - function performing the fetch, returns parsed result
   * @param {(result:any) => boolean} validator - returns true if result is valid, false triggers retry
   * @param {number} maxRetries - max attempts (default 5)
   * @returns {Promise<any|null>} last valid result or null on failure
   */
  async function retryWithBackoff(fetchFn, validator, maxRetries = 5) {
    let delay = 2000; // start 2s
    const maxDelay = 60000; // cap 60s

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const result = await fetchFn();
        if (validator(result)) {
          return result;
        }

        if (attempt < maxRetries - 1) {
          console.warn(
            `[LeetTracker] Rate limit/invalid response (attempt ${
              attempt + 1
            }/${maxRetries}), retrying in ${delay / 1000}s...`
          );
          await new Promise((r) => setTimeout(r, delay));
          delay = Math.min(delay * 2, maxDelay);
        } else {
          console.warn(
            `[LeetTracker] Final attempt (${
              attempt + 1
            }/${maxRetries}) failed validation.`
          );
        }
      } catch (error) {
        if (attempt < maxRetries - 1) {
          console.warn(
            `[LeetTracker] Fetch error (attempt ${
              attempt + 1
            }/${maxRetries}), retrying in ${delay / 1000}s:`,
            error
          );
          await new Promise((r) => setTimeout(r, delay));
          delay = Math.min(delay * 2, maxDelay);
        } else {
          console.warn(
            `[LeetTracker] Fetch error on final attempt (${
              attempt + 1
            }/${maxRetries}):`,
            error
          );
        }
      }
    }

    return null;
  }

  /**
   * Poll LeetCode submission check endpoint to ensure the most recent submission is processed.
   * @param {string|number} submissionId
   * @param {number} maxWaitMs
   * @returns {Promise<{verified:boolean, state:string, statusMsg?:string, finished?:number}>}
   */
  async function verifyRecentSubmissionStatus(submissionId, maxWaitMs = 15000) {
    const checkUrl = `https://leetcode.com/submissions/detail/${submissionId}/check/`;
    const startTime = Date.now();
    const pollInterval = 1000;

    console.log(
      `[LeetTracker] Verifying submission ${submissionId} processing status...`
    );

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(checkUrl, {
          method: "GET",
          credentials: "include",
          headers: { Referer: window.location.href },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          console.warn(
            `[LeetTracker] Check endpoint returned ${response.status} for ${submissionId}, assuming processed`
          );
          return { verified: true, state: "ASSUMED_SUCCESS" };
        }

        const data = await response.json();

        if (data.state === "STARTED" || data.state === "PENDING") {
          console.log(
            `[LeetTracker] Submission ${submissionId} still processing (${data.state})...`
          );
          await new Promise((resolve) => setTimeout(resolve, pollInterval));
          continue;
        }

        if (data.state === "SUCCESS" || data.state === "FAILURE") {
          console.log(
            `[LeetTracker] Submission ${submissionId} completed with state: ${data.state}`
          );
          return {
            verified: true,
            state: data.state,
            statusMsg: data.status_msg,
            finished: data.finished,
          };
        }

        console.warn(
          `[LeetTracker] Unknown state for ${submissionId}: ${data.state}, assuming completed`
        );
        return { verified: true, state: "UNKNOWN" };
      } catch (error) {
        console.warn(
          `[LeetTracker] Error checking submission ${submissionId}:`,
          error
        );
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }
    }

    console.warn(
      `[LeetTracker] Timeout verifying submission ${submissionId}, assuming processed`
    );
    return { verified: false, state: "TIMEOUT" };
  }

  /**
   * Fetch submissions after a given timestamp (seconds), applying limited backoff per page.
   * Verifies the most recent submission (if within 60s) has completed processing.
   * @param {number} lastTimestamp - seconds since epoch
   * @returns {Promise<Array<{id:string,titleSlug:string,statusDisplay:string,timestamp:number,lang:string}>>}
   */
  async function fetchAllSubmissions(lastTimestamp) {
    const submissions = [];
    let offset = 0;
    const limit = 20;
    let hasMore = true;
    let shouldContinue = true;

    while (hasMore && shouldContinue) {
      const body = {
        query: `
          query submissionList($offset: Int!, $limit: Int!) {
            submissionList(offset: $offset, limit: $limit) {
              hasNext
              submissions {
                id
                titleSlug
                statusDisplay
                timestamp
                lang
              }
            }
          }
        `,
        variables: { offset, limit },
      };

      let retryDelay = 5000;
      let attempt = 0;
      let success = false;
      let json = null;

      while (!success && retryDelay < 60000) {
        try {
          const res = await fetch(GRAPHQL_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Referer: "https://leetcode.com/problemset/all/",
            },
            body: JSON.stringify(body),
            credentials: "include",
          });

          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          json = await res.json();
          if (!json?.data?.submissionList?.submissions) {
            throw new Error("Missing submissions data");
          }

          success = true;
        } catch (err) {
          console.warn(
            `[LeetTracker] Failed fetch at offset=${offset}, retrying in ${
              retryDelay / 1000
            }s... (${err.message})`
          );
          await new Promise((r) => setTimeout(r, retryDelay));
          retryDelay = Math.min(retryDelay * 2, 60000);
          attempt++;
        }
      }

      if (!success) {
        throw new Error(
          `[LeetTracker] Submission fetch failed after ${attempt} retries at offset ${offset}`
        );
      }

      const data = json.data.submissionList;

      for (const s of data.submissions) {
        if (s.timestamp <= lastTimestamp) {
          shouldContinue = false;
          break;
        }
        submissions.push(s);
      }

      hasMore = data.hasNext;
      offset += limit;
    }

    const newSubmissions = Array.from(
      new Map(submissions.map((s) => [s.id, s])).values()
    ).sort((a, b) => a.timestamp - b.timestamp);

    // Verify the most recent submission (if within last 60 seconds).
    const now = Math.floor(Date.now() / 1000);
    const recentSubmissions = newSubmissions.filter(
      (s) => now - s.timestamp < 60
    );

    if (recentSubmissions.length > 0) {
      console.log(
        `[LeetTracker] Found ${recentSubmissions.length} recent submissions, verifying processing status...`
      );

      const mostRecent = recentSubmissions[recentSubmissions.length - 1];
      const verification = await verifyRecentSubmissionStatus(mostRecent.id);
      if (!verification.verified) {
        console.warn(
          `[LeetTracker] Could not verify submission ${mostRecent.id}, proceeding anyway`
        );
      }
    }

    return newSubmissions;
  }

  /**
   * Query problem premium status with backoff.
   * @param {string} titleSlug
   * @returns {Promise<boolean>}
   */
  async function fetchProblemPremiumStatus(titleSlug) {
    const fetchFn = async () => {
      const body = {
        query: `
          query selectProblem($titleSlug: String!) {
            question(titleSlug: $titleSlug) {
              isPaidOnly
            }
          }
        `,
        variables: { titleSlug },
        operationName: "selectProblem",
      };

      const res = await fetch(GRAPHQL_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Referer: "https://leetcode.com/problemset/all/",
        },
        body: JSON.stringify(body),
        credentials: "include",
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const json = await res.json();
      return json.data?.question || null;
    };

    const validator = (result) => {
      if (result === null || result.isPaidOnly === undefined) {
        console.warn(
          `[LeetTracker] Empty premium status response for ${titleSlug}, likely rate limited`
        );
        return false;
      }
      return true;
    };

    const result = await retryWithBackoff(fetchFn, validator);

    if (result === null) {
      console.error(
        `[LeetTracker] Failed to get premium status for ${titleSlug} after retries, assuming non-premium`
      );
      return false;
    }

    return result.isPaidOnly || false;
  }

  /**
   * Fetch problem description (HTML content + questionId).
   * @param {string} titleSlug
   * @returns {Promise<{questionId:string, content:string}|null>}
   */
  async function fetchProblemDescription(titleSlug) {
    const body = {
      query: `
        query getQuestionDetail($titleSlug: String!) {
          question(titleSlug: $titleSlug) {
            questionId
            content
          }
        }
      `,
      variables: { titleSlug },
    };

    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Referer: "https://leetcode.com/problemset/all/",
      },
      body: JSON.stringify(body),
      credentials: "include",
    });

    const json = await res.json();
    return json.data?.question || null;
  }

  /**
   * Fetch problem note (safe; times out after 8s).
   * @param {string} titleSlug
   * @returns {Promise<string|null>}
   */
  async function fetchProblemNote(titleSlug) {
    const body = {
      query: `
        query questionNote($titleSlug: String!) {
          question(titleSlug: $titleSlug) {
            questionId
            note
          }
        }
      `,
      variables: { titleSlug },
      operationName: "questionNote",
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let res;
    try {
      res = await fetch(GRAPHQL_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Referer: "https://leetcode.com/problemset/all/",
        },
        body: JSON.stringify(body),
        credentials: "include",
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      if (error.name === "AbortError") {
        console.warn("[LeetTracker] fetchProblemNote timed out");
      } else {
        console.warn("[LeetTracker] fetchProblemNote error:", error);
      }
      return null;
    }
    clearTimeout(timeout);
    if (!res.ok) {
      console.warn(`[LeetTracker] fetchProblemNote HTTP error: ${res.status}`);
      return null;
    }
    let json;
    try {
      json = await res.json();
    } catch (error) {
      console.warn("[LeetTracker] fetchProblemNote invalid JSON:", error);
      return null;
    }
    return json.data?.question?.note || null;
  }

  /**
   * Fetch detailed submission info including code and performance stats.
   * @param {string|number} submissionId
   * @returns {Promise<{code:string, submissionDetails:object}|null>}
   */
  async function fetchSubmissionDetails(submissionId) {
    const csrfToken = document.cookie
      .split("; ")
      .find((row) => row.startsWith("csrftoken="))
      ?.split("=")[1];

    const body = {
      query: `
        query submissionDetails($submissionId: Int!) {
          submissionDetails(submissionId: $submissionId) {
            code
            runtime
            runtimeDisplay
            runtimePercentile
            memory
            memoryDisplay
            memoryPercentile
            totalCorrect
            totalTestcases
            lastTestcase
            codeOutput
            expectedOutput
            runtimeError
            compileError
            fullCodeOutput
            notes
          }
        }
      `,
      variables: { submissionId: parseInt(submissionId) },
      operationName: "submissionDetails",
    };

    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-csrftoken": csrfToken,
        Referer: "https://leetcode.com/submissions/",
      },
      body: JSON.stringify(body),
      credentials: "include",
    });

    const json = await res.json();
    const details = json.data?.submissionDetails;

    if (!details) return null;

    return {
      code: details.code,
      submissionDetails: {
        runtime: details.runtime,
        memory: details.memory,
        runtimeDisplay: details.runtimeDisplay,
        runtimePercentile: details.runtimePercentile,
        memoryDisplay: details.memoryDisplay,
        memoryPercentile: details.memoryPercentile,
        totalCorrect: details.totalCorrect,
        totalTestcases: details.totalTestcases,
        lastTestcase: details.lastTestcase,
        codeOutput: details.codeOutput,
        expectedOutput: details.expectedOutput,
        runtimeError: details.runtimeError,
        compileError: details.compileError,
        fullCodeOutput: details.fullCodeOutput,
        notes: details.notes,
      },
    };
  }

  // --- Sign-in / user info caching ---
  let cachedUserInfo = { userId: null, username: null, isPremium: false };
  let userInfoPromise = null;

  /**
   * Get signed-in user info with memoization + bounded retries/backoff.
   * @param {number} maxAttempts
   * @returns {Promise<{userId:string|null, username:string|null, isPremium:boolean}>}
   */
  function getUserInfoWithCache(maxAttempts = 10) {
    if (cachedUserInfo.userId && cachedUserInfo.username) {
      return Promise.resolve(cachedUserInfo);
    }
    if (userInfoPromise) return userInfoPromise;

    userInfoPromise = (async () => {
      let attempt = 0;
      let delay = 1000;

      while (attempt < maxAttempts) {
        try {
          const body = {
            query: `query globalData {
              userStatus {
                username
                activeSessionId
                isSignedIn
                isPremium
              }
            }`,
            variables: {},
            operationName: "globalData",
          };

          const res = await fetch(GRAPHQL_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Referer: "https://leetcode.com/problemset/all/",
            },
            body: JSON.stringify(body),
            credentials: "include",
          });

          const json = await res.json();
          const userStatus = json.data?.userStatus;

          if (
            userStatus &&
            userStatus.isSignedIn &&
            userStatus.username &&
            userStatus.activeSessionId
          ) {
            cachedUserInfo = {
              userId: userStatus.activeSessionId.toString(),
              username: userStatus.username,
              isPremium: userStatus.isPremium || false,
            };
            console.log(
              `[LeetTracker] User ${cachedUserInfo.username} premium status: ${cachedUserInfo.isPremium}`
            );
            return cachedUserInfo;
          }
        } catch (e) {
          // continue to retry
        }

        console.warn(
          `[LeetTracker] Failed to fetch user sign-in status, retrying in ${delay}ms`
        );
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30000);
        attempt++;
      }

      // Return whatever we have (possibly empty) after exhausting attempts
      return cachedUserInfo;
    })();

    return userInfoPromise;
  }

  /** Fetch description if needed (does not mutate `seenMap`). */
  async function fetchDescriptionIfNeeded(sub, seenMap) {
    const seenInfo = seenMap[sub.titleSlug];
    if (seenInfo?.hasDescription) return null;

    return await retryWithBackoff(
      () => fetchProblemDescription(sub.titleSlug),
      (result) => {
        // Rate limited if we got a response but content is missing/empty
        if (
          result === null ||
          !result.content ||
          result.content.trim() === ""
        ) {
          console.warn(
            `[LeetTracker] Empty description for ${sub.titleSlug}, likely rate limited`
          );
          return false;
        }
        return true;
      }
    );
  }

  /** Fetch note (safe). No retry - can't detect rate limiting from empty notes */
  async function fetchNoteSafe(sub) {
    try {
      return await fetchProblemNote(sub.titleSlug);
    } catch {
      return null;
    }
  }

  /** Fetch submission details (safe). */
  async function fetchSubmissionDetailsSafe(sub) {
    return await retryWithBackoff(
      () => fetchSubmissionDetails(sub.id),
      (result) => {
        if (result === null || !result.code || result.code.trim() === "") {
          console.warn(
            `[LeetTracker] Empty code for submission ${sub.id}, likely rate limited`
          );
          return false; // Reject and retry
        }

        // Got valid code
        return true;
      }
    );
  }

  // Expose public API
  LT.net = {
    retryWithBackoff,
    verifyRecentSubmissionStatus,
    fetchAllSubmissions,
    fetchProblemPremiumStatus,
    fetchProblemDescription,
    fetchProblemNote,
    fetchSubmissionDetails,
    getUserInfoWithCache,
    fetchDescriptionIfNeeded,
    fetchNoteSafe,
    fetchSubmissionDetailsSafe,
  };
})();
