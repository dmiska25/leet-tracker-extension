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
  const getSnapshotsKey = (username, problemSlug) => 
    `leettracker_snapshots_${username}_${problemSlug}`;
  const getTemplatesKey = (problemSlug) => `leettracker_templates_${problemSlug}`;
  const getRecentJourneysKey = (username) => `leettracker_recent_journeys_${username}`;

  // IndexedDB wrapper for larger data storage
  class LeetTrackerDB {
    constructor() {
      this.db = null;
      this.initPromise = this.init();
    }

    async init() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open('LeetTrackerDB', 1);
        
        request.onerror = () => {
          console.error('[LeetTracker] IndexedDB init failed:', request.error);
          reject(request.error);
        };
        
        request.onsuccess = () => {
          this.db = request.result;
          console.log('[LeetTracker] IndexedDB initialized successfully');
          resolve();
        };
        
        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          
          // Templates store
          if (!db.objectStoreNames.contains('templates')) {
            const templateStore = db.createObjectStore('templates', { keyPath: 'problemSlug' });
            templateStore.createIndex('timestamp', 'timestamp');
          }
          
          // Active snapshots store
          if (!db.objectStoreNames.contains('snapshots')) {
            const snapshotStore = db.createObjectStore('snapshots', { keyPath: 'id' });
            snapshotStore.createIndex('username', 'username');
            snapshotStore.createIndex('problemSlug', 'problemSlug');
          }
          
          // Journey archive store - permanent backup of all coding journeys
          if (!db.objectStoreNames.contains('journeys')) {
            const journeyStore = db.createObjectStore('journeys', { keyPath: 'id' });
            journeyStore.createIndex('username', 'username');
            journeyStore.createIndex('titleSlug', 'titleSlug');
            journeyStore.createIndex('timestamp', 'timestamp');
            journeyStore.createIndex('archivedAt', 'archivedAt');
          }
        };
      });
    }

    async storeTemplates(problemSlug, templates) {
      await this.initPromise;
      
      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction(['templates'], 'readwrite');
        const store = transaction.objectStore('templates');
        
        const data = {
          problemSlug,
          templates,
          timestamp: Date.now()
        };
        
        const request = store.put(data);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    }

    async getTemplates(problemSlug) {
      await this.initPromise;
      
      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction(['templates'], 'readonly');
        const store = transaction.objectStore('templates');
        
        const request = store.get(problemSlug);
        request.onsuccess = () => {
          const result = request.result;
          if (result && Date.now() - result.timestamp < 86400000) { // 24 hours
            resolve(result.templates);
          } else {
            resolve(null); // Expired or not found
          }
        };
        request.onerror = () => reject(request.error);
      });
    }

    async storeSnapshots(username, problemSlug, snapshots) {
      await this.initPromise;
      
      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction(['snapshots'], 'readwrite');
        const store = transaction.objectStore('snapshots');
        
        const data = {
          id: `${username}_${problemSlug}`,
          username,
          problemSlug,
          snapshots,
          lastUpdated: Date.now()
        };
        
        const request = store.put(data);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    }

    async getSnapshots(username, problemSlug) {
      await this.initPromise;
      
      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction(['snapshots'], 'readonly');
        const store = transaction.objectStore('snapshots');
        
        const request = store.get(`${username}_${problemSlug}`);
        request.onsuccess = () => resolve(request.result?.snapshots || []);
        request.onerror = () => reject(request.error);
      });
    }

    async storeJourneyArchive(username, submission) {
      await this.initPromise;
      
      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction(['journeys'], 'readwrite');
        const store = transaction.objectStore('journeys');
        
        const data = {
          id: `${username}_${submission.id}`,
          username,
          submissionId: submission.id,
          titleSlug: submission.titleSlug,
          timestamp: submission.timestamp,
          codingJourney: submission.codingJourney,
          archivedAt: Date.now()
        };
        
        const request = store.put(data);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    }
  }

  // Initialize IndexedDB
  const leetTrackerDB = new LeetTrackerDB();

  // Fresh start detection functions with IndexedDB template caching
  async function cacheTemplatesForProblem(problemSlug) {
    try {
      // Try IndexedDB first (larger capacity)
      const cached = await leetTrackerDB.getTemplates(problemSlug);
      if (cached) {
        return cached;
      }
    } catch (error) {
      console.warn('[LeetTracker] IndexedDB read failed, trying chrome.storage fallback:', error);
    }
    
    // Fallback to chrome.storage
    const templatesKey = getTemplatesKey(problemSlug);
    const cached = await getFromStorage(templatesKey, null);
    
    // Return cached if it's fresh (less than 1 day old)
    if (cached && Date.now() - cached.timestamp < 86400000) {
      return cached.templates;
    }
    
    try {
      const templates = await fetchProblemCodeTemplate(problemSlug);
      
      if (templates.length > 0) {
        // Try to store in IndexedDB first
        try {
          await leetTrackerDB.storeTemplates(problemSlug, templates);
        } catch (indexError) {
          console.warn('[LeetTracker] IndexedDB store failed, using chrome.storage fallback:', indexError);
          // Fallback to chrome.storage
          await saveToStorage(templatesKey, {
            templates: templates,
            timestamp: Date.now(),
            problemSlug: problemSlug
          });
        }
      }
      
      return templates;
    } catch (error) {
      console.error('❌ [Template Cache] Failed to fetch templates:', error);
      return cached?.templates || [];
    }
  }

  async function checkForFreshStart(currentCode, problemSlug) {
    try {
      // Get cached templates (fast!)
      const templates = await cacheTemplatesForProblem(problemSlug);
      if (templates.length === 0) {
        return false;
      }
      
      // Get current language (fast - localStorage)
      const currentLang = await detectCurrentLanguage(currentCode, problemSlug);
      
      const template = templates.find(t => t.langSlug === currentLang);
      
      if (!template) {
        return false;
      }
      
      // Fast similarity check with very strict threshold (near 100%)
      const similarity = calculateCodeSimilarity(template.code, currentCode);
      const isSimilarToTemplate = similarity >= 0.98; // 98% threshold
      
      if (isSimilarToTemplate) {
        return true; // Fresh start detected
      }
      
      return isSimilarToTemplate;
    } catch (error) {
      console.error('❌ [Fresh Start] Error during check:', error);
      return false;
    }
  }

  // New fast reset logic - runs independently every 0.5 seconds
  async function handleFreshStartReset(username, problemSlug, currentCode) {
    // Get snapshots from IndexedDB first, fallback to chrome.storage
    let snapshots = [];
    try {
      snapshots = await leetTrackerDB.getSnapshots(username, problemSlug);
    } catch (error) {
      console.warn('[LeetTracker] IndexedDB read failed for reset check, using chrome.storage fallback:', error);
      const key = getSnapshotsKey(username, problemSlug);
      snapshots = await getFromStorage(key, []);
    }
    
    // Only need at least 1 snapshot to consider reset
    if (snapshots.length < 1) return false;
    
    // Fast template check with very strict similarity (near 100%)
    const matchesTemplate = await checkForFreshStart(currentCode, problemSlug);
    
    if (matchesTemplate) {
      // Clear snapshots from both IndexedDB and chrome.storage
      try {
        await leetTrackerDB.storeSnapshots(username, problemSlug, []);
      } catch (error) {
        console.warn('[LeetTracker] IndexedDB clear failed during reset, clearing chrome.storage fallback:', error);
      }
      
      // Also clear chrome.storage fallback
      const key = getSnapshotsKey(username, problemSlug);
      await saveToStorage(key, []);
      
      return true;
    }
    
    return false;
  }

  // Continuous fresh start checker - runs every 0.5 seconds
  function startFreshStartWatcher(username) {
    setInterval(async () => {
      const match = window.location.pathname.match(/^\/problems\/([^\/]+)\/?/);
      if (!match) return;
      
      const problemSlug = match[1];
      const currentCode = getCurrentCode();
      if (!currentCode) return;
      
      // Check for fresh start reset independently
      await handleFreshStartReset(username, problemSlug, currentCode);
    }, 500); // Check every 0.5 seconds
  }

  // Fresh start detection functions
  async function fetchProblemCodeTemplate(titleSlug) {
    const body = {
      query: `
        query questionEditorData($titleSlug: String!) {
          question(titleSlug: $titleSlug) {
            codeSnippets {
              lang
              langSlug
              code
            }
          }
        }
      `,
      variables: { titleSlug }
    };

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

      const json = await res.json();
      return json.data?.question?.codeSnippets || [];
    } catch (error) {
      console.error('[LeetTracker] Failed to fetch problem template:', error);
      return [];
    }
  }

  async function detectCurrentLanguage(code, problemSlug = null) {
    // Method 1: Check localStorage for saved language preference (most reliable)
    try {
      const savedLang = localStorage.getItem('global_lang');
      if (savedLang) {
        // Handle case where localStorage stores JSON string or plain string
        let cleanLang = savedLang;
        
        // If it starts and ends with quotes, it's a JSON string
        if (savedLang.startsWith('"') && savedLang.endsWith('"')) {
          cleanLang = JSON.parse(savedLang);
        }
        
        const normalizedLang = cleanLang.toLowerCase().trim();
        return normalizedLang;
      }
    } catch (error) {
      console.warn('[LeetTracker] Failed to access localStorage for language detection');
    }
    
    // Method 2: Fallback to pattern matching on code
    const patterns = [
      { pattern: /def\s+\w+.*:/, lang: 'python3', name: 'Python def (defaulting to python3)' },
      { pattern: /class.*public/, lang: 'java', name: 'Java class' },
      { pattern: /#include|int main/, lang: 'cpp', name: 'C/C++' },
      { pattern: /function|\s*=>\s*/, lang: 'javascript', name: 'JavaScript' },
      { pattern: /fn\s+\w+.*->/, lang: 'rust', name: 'Rust fn' },
      { pattern: /func\s+\w+.*{/, lang: 'golang', name: 'Go func' }
    ];
    
    for (const {pattern, lang, name} of patterns) {
      if (pattern.test(code)) {
        return lang;
      }
    }
    
    // Default fallback
    return 'python3';
  }

  function levenshteinDistance(str1, str2) {
    const matrix = [];
    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }
    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    return matrix[str2.length][str1.length];
  }

  function calculateCodeSimilarity(code1, code2) {
    // Simple similarity calculation
    const normalize = (code) => code.replace(/\s+/g, ' ').trim().toLowerCase();
    const norm1 = normalize(code1);
    const norm2 = normalize(code2);
    
    if (norm1.length === 0 && norm2.length === 0) return 1;
    if (norm1.length === 0 || norm2.length === 0) return 0;
    
    // Simple Levenshtein-based similarity
    const longer = norm1.length > norm2.length ? norm1 : norm2;
    const shorter = norm1.length > norm2.length ? norm2 : norm1;
    
    if (longer.length === 0) return 1;
    
    const distance = levenshteinDistance(longer, shorter);
    return (longer.length - distance) / longer.length;
  }

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
    
    // Capture snapshot history for successful submissions only
    if (sub.statusDisplay === 'Accepted') {
      const username = getUsernameFromDOM();
      if (username) {
        // Get snapshots from IndexedDB first, fallback to chrome.storage
        let snapshots = [];
        try {
          snapshots = await leetTrackerDB.getSnapshots(username, sub.titleSlug);
        } catch (error) {
          console.warn('[LeetTracker] IndexedDB read failed for submission enrichment, using chrome.storage fallback:', error);
          const snapshotsKey = getSnapshotsKey(username, sub.titleSlug);
          snapshots = await getFromStorage(snapshotsKey, []);
        }
        
        if (snapshots.length > 0) {
          // Only include snapshots that occurred before this submission
          const relevantSnapshots = snapshots.filter(snapshot => 
            snapshot.timestamp <= sub.timestamp * 1000 // submission timestamp is in seconds, snapshots in ms
          );
          
          if (relevantSnapshots.length > 0) {
            const codingJourney = {
              snapshotCount: relevantSnapshots.length,
              snapshots: relevantSnapshots,
              totalCodingTime: relevantSnapshots.length > 0 ? 
                (relevantSnapshots[relevantSnapshots.length - 1].timestamp - relevantSnapshots[0].timestamp) : 0,
              firstSnapshot: relevantSnapshots[0]?.timestamp,
              lastSnapshot: relevantSnapshots[relevantSnapshots.length - 1]?.timestamp
            };
            
            // Store in recent journeys (limited to 20 most recent)
            sub.codingJourney = codingJourney;
            await storeRecentJourney(username, sub);
            
            // Replace the full journey data with a reference for storage efficiency
            sub.codingJourney = {
              snapshotCount: relevantSnapshots.length,
              totalCodingTime: codingJourney.totalCodingTime,
              firstSnapshot: codingJourney.firstSnapshot,
              lastSnapshot: codingJourney.lastSnapshot,
              hasDetailedJourney: true // Flag to indicate journey is available
            };
            
            console.log(`[LeetTracker] Captured ${relevantSnapshots.length} snapshots for submission ${sub.id} (${sub.titleSlug})`);
          }
        }
      }
    }
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

  // Recent journeys management for successful submissions
  async function storeRecentJourney(username, submission) {
    if (!submission.codingJourney || !submission.codingJourney.snapshots) {
      return; // No journey data to store
    }
    
    const key = getRecentJourneysKey(username);
    const recent = await getFromStorage(key, []);
    
    // Add new journey to the beginning of the array
    recent.unshift({
      submissionId: submission.id,
      titleSlug: submission.titleSlug,
      timestamp: submission.timestamp,
      codingJourney: submission.codingJourney
    });
    
    // Keep only last 20 journeys
    if (recent.length > 20) {
      recent.splice(20);
    }
    
    await saveToStorage(key, recent);
    
    // ALSO backup to IndexedDB archive (permanent storage)
    try {
      await leetTrackerDB.storeJourneyArchive(username, submission);
      console.log(`[LeetTracker] Archived journey for ${submission.titleSlug} (submission ${submission.id})`);
    } catch (error) {
      console.warn('[LeetTracker] Failed to archive journey to IndexedDB:', error);
    }
    
    console.log(`[LeetTracker] Stored recent journey for ${submission.titleSlug} (${recent.length} total recent journeys)`);
  }

  async function getRecentJourney(username, submissionId) {
    const key = getRecentJourneysKey(username);
    const recent = await getFromStorage(key, []);
    
    return recent.find(journey => journey.submissionId === submissionId);
  }

  // Code snapshot functionality
  function getCurrentCode() {
    // Try Monaco Editor first (most common on LeetCode)
    if (window.monaco && window.monaco.editor) {
      const editors = window.monaco.editor.getModels();
      if (editors.length > 0) {
        return editors[0].getValue();
      }
    }
    
    // Fallback selectors for different LeetCode layouts
    const selectors = [
      '.monaco-editor .view-lines',
      'textarea[data-testid="code-area"]', 
      '.CodeMirror-code',
      '[role="textbox"]'
    ];
    
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) {
        return element.innerText || element.value || element.textContent;
      }
    }
    
    return null;
  }

  function shouldTakeSnapshot(oldCode, newCode) {
    if (!oldCode || !newCode) return true;
    
    const diffs = window.Diff.diffChars(oldCode, newCode);
    const changes = diffs.filter(part => part.added || part.removed);
    
    let charChanges = 0;
    let lineChanges = 0;
    
    changes.forEach(part => {
      charChanges += part.value.length;
      lineChanges += (part.value.match(/\n/g) || []).length;
    });
    
    return charChanges >= 30 || lineChanges >= 2;
  }

  async function takeCodeSnapshot(username, problemSlug) {
    const currentCode = getCurrentCode();
    if (!currentCode) return;
    
    // Get snapshots from IndexedDB first, fallback to chrome.storage
    let snapshots = [];
    try {
      snapshots = await leetTrackerDB.getSnapshots(username, problemSlug);
    } catch (error) {
      console.warn('[LeetTracker] IndexedDB read failed, using chrome.storage fallback:', error);
      const key = getSnapshotsKey(username, problemSlug);
      snapshots = await getFromStorage(key, []);
    }
    
    const lastCode = snapshots.length > 0 ? 
      (snapshots[snapshots.length - 1].fullCode || reconstructCodeFromSnapshots(snapshots)) : 
      '';
    
    if (!shouldTakeSnapshot(lastCode, currentCode)) return;
    
    if (typeof window.Diff === 'undefined' || !window.Diff.createPatch) {
      console.error('[LeetTracker] window.Diff.createPatch not available');
      return; // Skip snapshot creation
    }
    
    const patch = window.Diff.createPatch('code', lastCode, currentCode, '', '');
    
    const snapshot = {
      timestamp: Date.now(),
      patch: patch
    };
    
    // Only store fullCode for the first snapshot or every 10th snapshot for recovery
    if (snapshots.length === 0 || snapshots.length % 10 === 0) {
      snapshot.fullCode = currentCode;
    }
    
    snapshots.push(snapshot);
    
    try {
      // Try IndexedDB first
      await leetTrackerDB.storeSnapshots(username, problemSlug, snapshots);
    } catch (error) {
      console.warn('[LeetTracker] IndexedDB store failed, using chrome.storage fallback:', error);
      // Fallback to chrome.storage with size limits
      const key = getSnapshotsKey(username, problemSlug);
      
      // Check approximate storage size before saving
      const dataSize = JSON.stringify(snapshots).length;
      if (dataSize > 1000000) { // ~1MB limit per problem
        console.warn(`[LeetTracker] Snapshot data too large (${Math.round(dataSize/1024)}KB), reducing...`);
        snapshots.splice(0, 10); // Remove 10 oldest snapshots
      }
      
      try {
        await saveToStorage(key, snapshots);
      } catch (storageError) {
        console.error(`[LeetTracker] Failed to save snapshot:`, storageError);
        // Try to save with fewer snapshots
        if (snapshots.length > 10) {
          snapshots.splice(0, snapshots.length - 10);
          try {
            await saveToStorage(key, snapshots);
          } catch (retryError) {
            console.error(`[LeetTracker] Failed to save even reduced snapshots:`, retryError);
          }
        }
      }
    }
  }

  // Utility function to reconstruct full code from snapshots
  function reconstructCodeFromSnapshots(snapshots, targetIndex = -1) {
    if (snapshots.length === 0) return '';
    if (targetIndex === -1) targetIndex = snapshots.length - 1;
    if (targetIndex >= snapshots.length) return '';
    
    // Find the most recent snapshot with fullCode
    let baseIndex = targetIndex;
    while (baseIndex >= 0 && !snapshots[baseIndex].fullCode) {
      baseIndex--;
    }
    
    if (baseIndex < 0) {
      console.error('[LeetTracker] No base fullCode found in snapshots');
      return '';
    }
    
    let code = snapshots[baseIndex].fullCode;
    
    // Apply patches from base to target
    for (let i = baseIndex + 1; i <= targetIndex; i++) {
      try {
        code = window.Diff.applyPatch(code, snapshots[i].patch) || code;
      } catch (error) {
        console.error(`[LeetTracker] Failed to apply patch ${i}:`, error);
        break;
      }
    }
    
    return code;
  }

  function startCodeSnapshotWatcher(username) {
    setInterval(() => {
      const match = window.location.pathname.match(/^\/problems\/([^\/]+)\/?/);
      if (match) {
        takeCodeSnapshot(username, match[1]);
      }
    }, 3000); // Check every 3 seconds
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
      startCodeSnapshotWatcher(username);
      startFreshStartWatcher(username);

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
