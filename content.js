(function () {
  const GRAPHQL_URL = "https://leetcode.com/graphql/";
  const HEARTBEAT_KEY = "leettracker_sync_heartbeat";
  const HEARTBEAT_INTERVAL_MS = 5000;
  const HEARTBEAT_TIMEOUT_MS = 10000;
  const DAY_S = 86400;

  const getVisitLogKey = (u) => `leettracker_problem_visit_log_${u}`;
  const getManifestKey = (username) => `leettracker_sync_manifest_${username}`;
  const getSeenProblemsKey = (username) =>
    `leettracker_seen_problems_${username}`;
  const getChunkKey = (username, index) =>
    `leettracker_leetcode_chunk_${username}_${index}`;

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

    return Array.from(new Map(submissions.map((s) => [s.id, s])).values()).sort(
      (a, b) => a.timestamp - b.timestamp
    );
  }

  async function fetchProblemDescription(titleSlug) {
    const body = {
      query: `
        query getQuestionDetail($titleSlug: String!) {
          question(titleSlug: $titleSlug) {
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
    return json.data?.question?.content || null;
  }

  async function fetchSubmissionCode(submissionId) {
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
            memory
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
    return json.data?.submissionDetails;
  }

  function getUsernameFromDOM() {
    const link = document.querySelector('a[href^="/u/"]');
    return link?.getAttribute("href")?.split("/u/")[1] || null;
  }

  async function getFromStorage(key, fallback = null) {
    return new Promise((resolve) => {
      chrome.storage.local.get([key], (result) => {
        resolve(result[key] || fallback);
      });
    });
  }

  function saveToStorage(key, value) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: value }, resolve);
    });
  }

  async function leaderOrQuit() {
    const now = Date.now();
    const last = await getFromStorage(HEARTBEAT_KEY, 0);
    if (now - last < HEARTBEAT_TIMEOUT_MS) return false;

    // jitter then re-check
    await new Promise((r) => setTimeout(r, Math.random() * 1000 + 100));
    const last2 = await getFromStorage(HEARTBEAT_KEY, 0);
    if (Date.now() - last2 < HEARTBEAT_TIMEOUT_MS) return false;

    await saveToStorage(HEARTBEAT_KEY, Date.now());
    return true;
  }

  function startHeartbeat() {
    return setInterval(
      () => saveToStorage(HEARTBEAT_KEY, Date.now()),
      HEARTBEAT_INTERVAL_MS
    );
  }

  function deriveSolveTime(sub, visitLog) {
    const hits = visitLog
      .filter(
        (e) =>
          e.slug === sub.titleSlug &&
          e.ts < sub.timestamp &&
          sub.timestamp - e.ts <= DAY_S
      )
      .map((e) => e.ts);

    return hits.length ? sub.timestamp - Math.max(...hits) : null;
  }

  async function enrichSubmission(sub, seen, visitLog) {
    sub.solveTime = deriveSolveTime(sub, visitLog);

    if (!seen.has(sub.titleSlug)) {
      const desc = await fetchProblemDescription(sub.titleSlug).catch(
        () => null
      );
      if (desc) {
        sub.problemDescription = desc;
        seen.add(sub.titleSlug);
      }
    }
    sub.codeDetail = await fetchSubmissionCode(sub.id).catch(() => null);
  }

  async function flushChunk(
    username,
    idx,
    chunk,
    chunksMeta,
    manifestKey,
    seenKey,
    seenSet
  ) {
    await saveToStorage(getChunkKey(username, idx), chunk);
    chunksMeta[idx] = {
      index: idx,
      from: chunk[0].timestamp,
      to: chunk.at(-1).timestamp,
    };
    await saveToStorage(manifestKey, {
      chunkCount: idx + 1,
      lastTimestamp: chunk.at(-1).timestamp,
      chunks: chunksMeta,
    });
    await saveToStorage(seenKey, Array.from(seenSet));
    console.log(`[LeetTracker] Saved chunk ${idx}`);
  }

  async function syncSubmissions(username) {
    if (!(await leaderOrQuit())) return;

    const beat = startHeartbeat();
    try {
      const manifestKey = getManifestKey(username);
      const seenKey = getSeenProblemsKey(username);
      const visitLogKey = getVisitLogKey(username);

      const [visitLog, manifest, seenArr] = await Promise.all([
        getFromStorage(visitLogKey, []),
        getFromStorage(manifestKey, {}),
        getFromStorage(seenKey, []),
      ]);

      const seen = new Set(seenArr);
      const lastT = manifest.lastTimestamp || 0;
      const subs = await fetchAllSubmissions(lastT);
      if (!subs.length) return console.log("[LeetTracker] No new submissions.");

      let chunkIdx = manifest.chunkCount - 1 || 0;
      let chunk = await getFromStorage(getChunkKey(username, chunkIdx), []);
      const meta = manifest.chunks || [];

      for (let i = 0; i < subs.length; i++) {
        const sub = subs[i];
        await enrichSubmission(sub, seen, visitLog);

        if (chunk.length >= 100) {
          await flushChunk(
            username,
            chunkIdx,
            chunk,
            meta,
            manifestKey,
            seenKey,
            seen
          );
          chunk = [];
          chunkIdx++;
          await new Promise((r) => setTimeout(r, 20_000));
        }

        chunk.push(sub);
        if (i % 20 === 19) await new Promise((r) => setTimeout(r, 10_000));
      }

      if (chunk.length) {
        await flushChunk(
          username,
          chunkIdx,
          chunk,
          meta,
          manifestKey,
          seenKey,
          seen
        );
      }
      console.log(`[LeetTracker] Synced ${subs.length} submissions.`);
    } catch (e) {
      console.error("[LeetTracker] Sync failed:", e);
    } finally {
      clearInterval(beat);
    }
  }

  function hookSubmitButton(username) {
    const selector = '[data-e2e-locator="console-submit-button"]';
    const button = document.querySelector(selector);
    if (!button) return;

    // Avoid rebinding if already attached
    if (button.dataset.leettrackerHooked === "true") return;

    button.addEventListener("click", () => {
      console.log("[LeetTracker] Submit clicked — scheduling sync...");

      // Wait a few seconds for LC to process submission and update data
      setTimeout(() => {
        syncSubmissions(username);
      }, 5000); // or debounce multiple clicks
    });

    button.dataset.leettrackerHooked = "true";
  }

  async function recordProblemVisit(username, slug) {
    const key = getVisitLogKey(username);
    const nowSec = Math.floor(Date.now() / 1000); // convert to seconds

    const log = await getFromStorage(key, []); // array of {slug, ts}
    log.push({ slug, ts: nowSec });

    // keep only last 24 h (in seconds)
    const trimmed = log.filter((e) => nowSec - e.ts <= DAY_S);
    await saveToStorage(key, trimmed);
  }

  function startProblemNavigationWatcher(username) {
    let lastSlug = null;

    setInterval(() => {
      const m = window.location.pathname.match(/^\/problems\/([^\/]+)\/?/);
      if (!m) return;

      const slug = m[1];
      if (slug !== lastSlug) {
        lastSlug = slug;
        recordProblemVisit(username, slug);
      }
    }, 1000); // 1 s poll, negligible cost
  }

  function trySyncIfLoggedIn() {
    const username = getUsernameFromDOM();
    const SELECTOR = '[data-e2e-locator="console-submit-button"]';

    if (username) {
      console.log(
        `[LeetTracker] Detected login as ${username}. Starting sync...`
      );
      syncSubmissions(username);
      setInterval(() => {
        if (!window.location.pathname.startsWith("/problems/")) return;
        syncSubmissions(username);
      }, 1 * 60 * 1000);
      setInterval(() => {
        if (!window.location.pathname.startsWith("/problems/")) return;

        const btn = document.querySelector(SELECTOR);
        if (btn && btn.dataset.leettrackerHooked !== "true") {
          hookSubmitButton(username);
        }
      }, 5000); // 5 s poll
      startProblemNavigationWatcher(username);

      return true;
    } else {
      console.log("[LeetTracker] Not logged in, skipping fetch.");
    }
    return false;
  }

  if (window.location.hostname === "leetcode.com") {
    const intervalId = setInterval(() => {
      if (trySyncIfLoggedIn()) {
        clearInterval(intervalId);
      } else {
        console.log("[LeetTracker] Waiting for login...");
      }
    }, 5000);
  }
})();
