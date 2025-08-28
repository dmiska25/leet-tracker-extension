(function () {
  const EXTENSION_SOURCE = "leettracker-extension";
  const WEBAPP_SOURCE = "leettracker-webapp";

  console.log("[LeetTracker Inject] Webapp script loaded");

  window.addEventListener("message", async (event) => {
    const { source, type, username } = event.data || {};
    if (source !== WEBAPP_SOURCE || !username) return;

    if (type === "request_chunk_manifest_since") {
      const since = event.data.since || 0;
      try {
        const manifestKey = `leettracker_sync_manifest_${username}`;
        const result = await chrome.storage.local.get([manifestKey]);
        const manifestChunks = result[manifestKey]?.chunks || [];

        const filtered = manifestChunks.filter((chunk) => chunk.to > since);

        window.postMessage(
          {
            source: EXTENSION_SOURCE,
            type: "response_chunk_manifest",
            username,
            chunks: filtered,
          },
          "*"
        );
        console.log(
          `[LeetTracker Inject] Manifest for ${username} since ${since} sent`
        );
      } catch (e) {
        console.error("[LeetTracker Inject] Failed to get manifest:", e);
      }
    }

    if (type === "request_chunk_by_index") {
      const index = event.data.index;
      if (typeof index !== "number") return;

      try {
        const chunkKey = `leettracker_leetcode_chunk_${username}_${index}`;
        const result = await chrome.storage.local.get([chunkKey]);
        const baseData = result[chunkKey] || [];

        // Enhance with recent code journeys
        const recentJourneysKey = `leettracker_recent_journeys_${username}`;
        const recentJourneysResult = await chrome.storage.local.get([
          recentJourneysKey,
        ]);
        const recentJourneys = recentJourneysResult[recentJourneysKey] || [];

        // Enhance submissions with detailed journey data if available
        const journeysById = new Map(
          recentJourneys.map((j) => [String(j.submissionId), j])
        );
        const enhancedData = baseData.map((s) => {
          const j = journeysById.get(String(s.id));
          return j && j.codingJourney
            ? { ...s, codingJourney: j.codingJourney }
            : s;
        });

        window.postMessage(
          {
            source: EXTENSION_SOURCE,
            type: "response_chunk",
            username,
            index,
            data: enhancedData,
          },
          "*"
        );
        console.log(
          `[LeetTracker Inject] Enhanced chunk ${index} for ${username} sent (${enhancedData.length} submissions, ${recentJourneys.length} recent journeys)`
        );
      } catch (e) {
        console.error(
          `[LeetTracker Inject] Failed to get chunk ${index} for ${username}:`,
          e
        );
      }
    }
  });
})();
