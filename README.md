# LeetTracker Chrome Extension

Track your LeetCode progress directly in the browser and sync submissions to the [LeetTracker Web App](https://github.com/dmiska25/leet-tracker).

## Features

- **Auto-sync LeetCode submissions** with intelligent backfill queue for large histories
- **Track solve time** using passive problem visit logs and code snapshots
- **Smart notifications** — welcome toast for new users, sync status updates, sign-in reminders
- **Seamless integration** with the [LeetTracker web app](https://github.com/dmiska25/leet-tracker)

## How It Works

- The extension runs on `leetcode.com` and watches for problem activity and submission events.
- On first run, it fetches your entire submission history (in batches) and enriches each solve with metadata like solve time, code, and description.
- **Intelligent backfill system**: Recent submissions (last 90 days) are enriched immediately. Older submissions are queued for background processing to keep initial sync fast.
- **Toast notifications** keep you informed: welcome message for first-time users, sync completion updates, and sign-in reminders.
- **Privacy-focused analytics** track usage patterns (errors, sync times, feature usage) to help improve the extension.
- Submissions are stored in local browser storage (`chrome.storage.local` and `IndexedDB`) and exposed to the LeetTracker web app via `window.postMessage`.
- Future syncs are incremental and only fetch new submissions.

## Installation (Development)

To build and load the extension manually:

1. Clone or download this repo
2. Install dependencies: `npm install`
3. Build the extension: `npm run build` (uses Vite bundler)
4. Open Chrome and go to `chrome://extensions/`
5. Enable "Developer Mode"
6. Click "Load unpacked" and select the `build/` folder

For development with auto-rebuild: `npm run dev`

## Permissions

The extension requests access to:

- `https://leetcode.com/*` — to read your submission data
- `chrome.storage` — to store problem and submission history
- `scripting` — to inject a companion script into the LeetTracker web app

No data is sent to any external server. All data remains on your device.

## Disclaimer

This tool is for **personal, non-commercial use**. LeetTracker is not affiliated with or endorsed by LeetCode. Problem descriptions and other content retrieved from LeetCode are copyrighted and subject to their [Terms of Service](https://leetcode.com/terms/).

You are responsible for ensuring that any personal exports or usage of problem content complies with LeetCode’s policies.

## Privacy Policy

See the full privacy policy [here](https://dmiska25.github.io/leet-tracker-extension/privacy.html).

## Contact

Questions or suggestions? Reach out to [djmiska25@gmail.com](mailto:djmiska25@gmail.com).
