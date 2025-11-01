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
            total: result[manifestKey]?.total ?? null,
            totalSynced: result[manifestKey]?.totalSynced ?? null,
            skippedForBackfill: result[manifestKey]?.skippedForBackfill ?? null,
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

        // Enhance with recent run groupings
        const recentRunsKey = `leettracker_recent_runs_${username}`;
        const recentRunsResult = await chrome.storage.local.get([
          recentRunsKey,
        ]);
        const recentRunGroups = recentRunsResult[recentRunsKey] || [];

        // Build lookup maps
        const journeysById = new Map(
          recentJourneys.map((j) => [String(j.submissionId), j])
        );
        const runGroupsById = new Map(
          recentRunGroups.map((g) => [String(g.submissionId), g])
        );

        // Enhance submissions with detailed journey and runEvents data if available
        const enhancedData = baseData.map((s) => {
          const sid = String(s.id);
          const j = journeysById.get(sid);
          const g = runGroupsById.get(sid);

          let out = s;
          if (j && j.codingJourney) {
            out = { ...out, codingJourney: j.codingJourney };
          }
          if (g && g.runEvents) {
            out = { ...out, runEvents: g.runEvents };
          }
          return out;
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
          `[LeetTracker Inject] Enhanced chunk ${index} for ${username} sent (${enhancedData.length} submissions, ${recentJourneys.length} recent journeys, ${recentRunGroups.length} recent run groups)`
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
