// page-inject.js
(() => {
  if (window.__leettrackerRunCodePatched) return;
  window.__leettrackerRunCodePatched = true;

  const origFetch = window.fetch;
  const pending = new Map(); // interpret_id -> meta we care about

  function safeParseBody(body) {
    try {
      if (!body) return null;
      if (typeof body === "string") return JSON.parse(body);
      if (body instanceof URLSearchParams)
        return Object.fromEntries(body.entries());
      // Avoid consuming streams/Request bodies to not break fetch
      return null;
    } catch {
      return null;
    }
  }

  window.fetch = async function (...args) {
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
    try {
      // 1) Run Code trigger: POST .../problems/{slug}/interpret_solution/
      if (url.includes("/interpret_solution/")) {
        const opts = args[1] || {};
        const payload =
          opts && typeof opts.body === "string"
            ? safeParseBody(opts.body)
            : null;

        const res = await origFetch.apply(this, args);
        res
          .clone()
          .json()
          .then((data) => {
            const interpret_id = data?.interpret_id;
            if (interpret_id) {
              pending.set(interpret_id, {
                typed_code: payload?.typed_code ?? null,
                question_id: payload?.question_id ?? null,
                lang: payload?.lang ?? null,
                data_input: payload?.data_input ?? null,
                startedAt: Date.now(),
              });
              window.postMessage(
                {
                  source: "leettracker",
                  type: "lt-run-start",
                  interpret_id,
                  meta: pending.get(interpret_id),
                },
                "*"
              );
            }
          })
          .catch(() => {});
        return res;
      }

      // 2) Polling: GET .../submissions/detail/{interpret_id}/check/
      if (url.includes("/submissions/detail/") && url.endsWith("/check/")) {
        const res = await origFetch.apply(this, args);
        res
          .clone()
          .json()
          .then((data) => {
            const interpret_id =
              data?.submission_id ||
              url.match(/detail\/([^/]+)\/check\/?/)?.[1] ||
              null;

            const meta = interpret_id ? pending.get(interpret_id) : undefined;
            const done = data?.state === "SUCCESS" || data?.state === "FAILURE";

            const payload = { interpret_id, data, meta };
            window.postMessage(
              {
                source: "leettracker",
                type: done ? "lt-run-result" : "lt-run-progress",
                payload,
              },
              "*"
            );

            if (done && interpret_id) pending.delete(interpret_id);
          })
          .catch(() => {});
        return res;
      }

      // default
      return origFetch.apply(this, args);
    } catch (error) {
      console.error("[LeetTracker] Failed while intercepting fetch:", error);
      // fall back if our wrapper errors
      return origFetch.apply(this, args);
    }
  };
})();
