# Cursor Usage Tracker

A lightweight browser extension that overlays real-time API usage analytics when you visit the Cursor usage dashboard.

## Features

- Token usage totals and per-model breakdown
- Cost totals and per-model cost (with optional pricing map)
- Plan quota usage and remaining estimate (when plan limit is set)
- Request counts, average tokens, error rate
- Timeline and session usage summaries
- JSON/CSV export and one-click reset
- Local persistence via `chrome.storage.local`

## Setup

1. Open Chrome (or Chromium-based browser) and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select folder containing plugin.
4. Visit `https://cursor.com/dashboard/usage`.

The overlay should appear automatically when the URL matches the configured pattern.

## Configuration

Open the extension options (Extensions → Cursor Usage Tracker → Details → Extension options):

- **Target URL pattern**: wildcard match, default `https://cursor.com/dashboard/usage*`
- **Plan token limit**: used to calculate quota usage and remaining estimate
- **Model pricing**: JSON map of model name to price per 1M tokens (USD)

Example pricing JSON:

```json
{
  "gpt-4": 30,
  "gpt-3.5": 1,
  "claude-4.6-opus-high-thinking": 15
}
```

## Notes

- Metrics are computed from the visible usage table rows. Change the date range on the page to capture more history.
- Costs fall back to the page’s cost column when available. Included usage is treated as $0 unless you supply pricing.
- Data is stored locally in your browser profile only.
