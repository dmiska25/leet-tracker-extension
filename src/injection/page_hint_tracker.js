// page_hint_tracker.js
(() => {
  if (window.__leettrackerHintTrackerPatched) return;
  window.__leettrackerHintTrackerPatched = true;

  const trackedHints = new Set(); // Track which hints have been viewed this session
  let solutionViewed = false;
  let gptHelpUsed = false;

  // Track interval IDs for cleanup
  const activeIntervals = []; // Watcher intervals that get cleaned up on navigation
  let navigationInterval = null; // Persistent navigation watcher (never cleaned up)

  // Throttling for analytics warnings (1 minute)
  const analyticsThrottle = {
    gptButton: 0,
    solutionButton: 0,
    twoSumHints: 0,
  };
  const THROTTLE_MS = 60000; // 1 minute

  // Clean up all active intervals
  function cleanupIntervals() {
    activeIntervals.forEach((id) => clearInterval(id));
    activeIntervals.length = 0;
  }

  // Send integration warning to content script for analytics
  function sendIntegrationWarning(type, details) {
    const now = Date.now();
    if (now - analyticsThrottle[type] < THROTTLE_MS) {
      return; // Throttled
    }
    analyticsThrottle[type] = now;

    window.postMessage(
      {
        source: "leettracker",
        type: "lt-integration-warning",
        payload: {
          warningType: type,
          details,
          timestamp: now,
          pathname: window.location.pathname,
        },
      },
      "*"
    );
    console.warn(`[LeetTracker] Integration warning: ${type}`, details);
  }

  // Debounce helper to avoid duplicate events
  function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  // Monitor hint expansions
  function setupHintWatchers() {
    // Use MutationObserver to detect style changes (height transitions)
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (
          mutation.type === "attributes" &&
          mutation.attributeName === "style"
        ) {
          const target = mutation.target;

          // Check if this is a hint content container
          if (
            target.classList.contains("overflow-hidden") &&
            target.classList.contains("transition-all")
          ) {
            const style = target.getAttribute("style") || "";
            const heightMatch = style.match(/height:\s*(\d+(?:\.\d+)?)px/);

            if (heightMatch && parseFloat(heightMatch[1]) > 0) {
              // Hint is being expanded
              const parent = target.closest(".flex.flex-col");
              if (!parent) return;

              // Find hint number
              const hintText =
                parent.querySelector(".text-body")?.textContent || "";
              const hintMatch = hintText.match(/Hint\s+(\d+)/i);

              if (hintMatch) {
                const hintNumber = hintMatch[1];
                const hintKey = `hint_${hintNumber}`;

                if (!trackedHints.has(hintKey)) {
                  trackedHints.add(hintKey);

                  window.postMessage(
                    {
                      source: "leettracker",
                      type: "lt-hint-viewed",
                      payload: {
                        hintType: "leetcode_hint",
                        hintNumber: parseInt(hintNumber, 10),
                        timestamp: Date.now(),
                      },
                    },
                    "*"
                  );

                  console.log(`[LeetTracker] Hint ${hintNumber} viewed`);
                }
              }
            }
          }
        }
      });
    });

    // Observe the entire description area
    const descriptionArea =
      document.querySelector('[data-track-load="description_content"]') ||
      document.querySelector(".elfjS") ||
      document.body;

    if (descriptionArea) {
      observer.observe(descriptionArea, {
        attributes: true,
        attributeFilter: ["style"],
        subtree: true,
      });
    }

    // Also setup click listeners as backup
    const setupClickListeners = debounce(() => {
      const hintButtons = document.querySelectorAll(
        ".flex.flex-col .group.flex.cursor-pointer"
      );

      // Check for integration issues on Two Sum (known to have hints)
      const isTwoSum =
        window.location.pathname.includes("/two-sum") ||
        window.location.pathname.includes("/1/");

      if (isTwoSum) {
        const hasHintText = Array.from(hintButtons).some((btn) => {
          const text = btn.textContent || "";
          return /Hint\s+\d+/i.test(text);
        });

        if (!hasHintText) {
          sendIntegrationWarning("twoSumHints", {
            message: "Could not find hint buttons on Two Sum problem",
            buttonsFound: hintButtons.length,
          });
        }
      }

      hintButtons.forEach((button) => {
        if (button.dataset.leettrackerHintWatched) return;

        const hintText = button.querySelector(".text-body")?.textContent || "";
        const hintMatch = hintText.match(/Hint\s+(\d+)/i);

        if (hintMatch) {
          button.dataset.leettrackerHintWatched = "true";
          const hintNumber = parseInt(hintMatch[1], 10);

          button.addEventListener("click", () => {
            console.log(`[LeetTracker] Hint button ${hintNumber} clicked`);

            // Give the hint a moment to expand, then track it
            setTimeout(() => {
              const hintKey = `hint_${hintNumber}`;

              if (!trackedHints.has(hintKey)) {
                trackedHints.add(hintKey);

                window.postMessage(
                  {
                    source: "leettracker",
                    type: "lt-hint-viewed",
                    payload: {
                      hintType: "leetcode_hint",
                      hintNumber: hintNumber,
                      timestamp: Date.now(),
                    },
                  },
                  "*"
                );

                console.log(
                  `[LeetTracker] Hint ${hintNumber} viewed (via click)`
                );
              }
            }, 300);
          });
        }
      });
    }, 500);

    setupClickListeners();
    const hintInterval = setInterval(setupClickListeners, 5000); // Re-check periodically for dynamic content
    activeIntervals.push(hintInterval);
  }

  // Monitor solution tab activation
  function setupSolutionWatcher() {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (
          mutation.type === "attributes" &&
          mutation.attributeName === "class"
        ) {
          const target = mutation.target;

          // Check if this is the solutions/editorial tab
          const isSolutionTab =
            target.id === "solutions_tab" ||
            target.closest('[id="solutions_tab"]') ||
            target.dataset.layoutPath?.includes("tb3");

          // Also check by text content (Editorial, Solutions)
          let isSolutionByText = false;
          if (
            !isSolutionTab &&
            target.classList.contains("flexlayout__tab_button")
          ) {
            const text = target.textContent || "";
            const lowerText = text.toLowerCase();
            isSolutionByText =
              lowerText.includes("solutions") ||
              lowerText.includes("editorial");
          }

          if (isSolutionTab || isSolutionByText) {
            const parentTab =
              target.closest(".flexlayout__tab_button") || target;

            if (
              parentTab.classList.contains(
                "flexlayout__tab_button--selected"
              ) &&
              !solutionViewed
            ) {
              solutionViewed = true;

              window.postMessage(
                {
                  source: "leettracker",
                  type: "lt-hint-viewed",
                  payload: {
                    hintType: "solution_peek",
                    timestamp: Date.now(),
                  },
                },
                "*"
              );

              const tabText = parentTab.textContent || "";
              console.log(
                `[LeetTracker] Solution tab viewed: ${tabText.trim()}`
              );
            }
          }
        }
      });
    });

    // Observe the tab container
    const tabContainer =
      document.querySelector(
        ".flexlayout__tabset_tabbar_inner_tab_container"
      ) || document.body;

    if (tabContainer) {
      observer.observe(tabContainer, {
        attributes: true,
        attributeFilter: ["class"],
        subtree: true,
      });
    }

    // Also setup click listeners as backup
    const setupClickListeners = debounce(() => {
      if (!window.location.pathname.startsWith("/problems/")) return;

      // Find all solution-related tabs (Editorial, Solutions, etc.)
      const solutionTabs = [];

      // Look for tab by ID
      const tabById = document.querySelector('[id="solutions_tab"]');
      if (tabById) {
        solutionTabs.push(tabById);
      }

      // Look for tabs by text content (Editorial, Solutions)
      const allTabs = document.querySelectorAll(
        ".flexlayout__tab_button_content"
      );
      for (const tab of allTabs) {
        const text = tab.textContent || "";
        const lowerText = text.toLowerCase();
        if (
          lowerText.includes("solutions") ||
          lowerText.includes("editorial")
        ) {
          const button = tab.closest(".flexlayout__tab_button");
          if (button && !solutionTabs.includes(button)) {
            solutionTabs.push(button);
          }
        }
      }

      // Check for integration issues
      if (solutionTabs.length === 0) {
        sendIntegrationWarning("solutionButton", {
          message: "Could not find any solution/editorial tabs",
          tabsFound: allTabs.length,
        });
      }

      // Add click listeners to all solution tabs
      solutionTabs.forEach((solutionTab) => {
        if (!solutionTab.dataset.leettrackerSolutionWatched) {
          solutionTab.dataset.leettrackerSolutionWatched = "true";

          solutionTab.addEventListener("click", () => {
            const tabText = solutionTab.textContent || "";
            console.log(
              `[LeetTracker] Solution tab clicked: ${tabText.trim()}`
            );

            // Give the tab a moment to switch, then track it
            setTimeout(() => {
              if (!solutionViewed) {
                solutionViewed = true;

                window.postMessage(
                  {
                    source: "leettracker",
                    type: "lt-hint-viewed",
                    payload: {
                      hintType: "solution_peek",
                      timestamp: Date.now(),
                    },
                  },
                  "*"
                );

                console.log("[LeetTracker] Solution tab viewed (via click)");
              }
            }, 300);
          });
        }
      });
    }, 500);

    setupClickListeners();
    const solutionInterval = setInterval(setupClickListeners, 5000);
    activeIntervals.push(solutionInterval);
  }

  // Monitor "Ask Leet" GPT button clicks
  function setupGptWatcher() {
    const setupClickListener = debounce(() => {
      if (!window.location.pathname.startsWith("/problems/")) return;

      // Find the "Ask Leet" button by aria-label or icon
      const askLeetButton = document.querySelector('[aria-label="Ask Leet"]');

      // Check for integration issues
      if (!askLeetButton) {
        sendIntegrationWarning("gptButton", {
          message: "Could not find Ask Leet button",
          pathname: window.location.pathname,
        });
      }

      if (askLeetButton && !askLeetButton.dataset.leettrackerGptWatched) {
        askLeetButton.dataset.leettrackerGptWatched = "true";

        askLeetButton.addEventListener("click", () => {
          if (!gptHelpUsed) {
            gptHelpUsed = true;

            window.postMessage(
              {
                source: "leettracker",
                type: "lt-hint-viewed",
                payload: {
                  hintType: "gpt_help",
                  timestamp: Date.now(),
                },
              },
              "*"
            );

            console.log("[LeetTracker] GPT help used (Ask Leet clicked)");
          }
        });
      }
    }, 500);

    setupClickListener();
    const gptInterval = setInterval(setupClickListener, 5000); // Re-check periodically for dynamic content
    activeIntervals.push(gptInterval);
  }

  // Reset tracking when navigating to a new problem
  function setupNavigationReset() {
    // Only set up once - don't create duplicate navigation watchers
    if (navigationInterval !== null) return;

    let lastPathname = window.location.pathname;

    navigationInterval = setInterval(() => {
      if (window.location.pathname !== lastPathname) {
        lastPathname = window.location.pathname;

        if (window.location.pathname.startsWith("/problems/")) {
          // Clean up old intervals before setting up new ones
          cleanupIntervals();

          // Reset tracking state
          trackedHints.clear();
          solutionViewed = false;
          gptHelpUsed = false;

          // Re-setup watchers with fresh intervals
          setupHintWatchers();
          setupSolutionWatcher();
          setupGptWatcher();

          console.log("[LeetTracker] Reset hint tracking for new problem");
        }
      }
    }, 1000);
    // Note: navigationInterval is NOT added to activeIntervals
    // It remains persistent across navigations
  }

  // Initialize
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      setupHintWatchers();
      setupSolutionWatcher();
      setupGptWatcher();
      setupNavigationReset();
    });
  } else {
    setupHintWatchers();
    setupSolutionWatcher();
    setupGptWatcher();
    setupNavigationReset();
  }

  console.log("[LeetTracker] Hint tracking initialized (with GPT detection)");
})();
