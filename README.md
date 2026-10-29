# tab-triage

A Chrome extension that lists all open tabs, lets you filter and group
them, and flags candidates for closing.

## Features

- Filter by title or URL (plain text or regex) and by window
- Group by domain, window or close reason; sort by last viewed
- Click a tab title to switch to that tab
- Live updates as tabs open, close or navigate
- Copy the titles and URLs of checked tabs, to keep a list before closing

The extension is read-only: it never closes or changes tabs, apart from
switching to one when you click it.

## Close candidates

| Reason                  | Rule                                                    |
| ----------------------- | ------------------------------------------------------- |
| Exact duplicate         | Same URL as an earlier tab (the first one isn't flagged) |
| Same page, other params | Same origin and path, different query or fragment       |
| Not viewed recently     | Not viewed for 7-60 days (configurable)                 |
| PR merged / closed      | GitHub PR or issue is merged or closed                  |
| Login/auth page         | Login, sign-in or OAuth URL, usually an expired session |
| Blank/internal/search   | New tab, `about:blank`, Google or X search results      |
| Meeting link            | Google Meet or Zoom meeting                             |

Active and pinned tabs are never flagged as stale.

## Install

Requires Chrome 121 or later.

1. Clone this repository.
2. Open `chrome://extensions` and enable Developer mode.
3. Click "Load unpacked" and select the repository folder.
4. Pin Tab Triage to the toolbar and click it to open the dashboard.

To include incognito tabs, enable "Allow in Incognito" on the extension's
details page.

## Privacy

Tab data stays in the browser. The only network requests go to
`api.github.com`, sending the owner, repository and number of GitHub PRs
and issues that are open in tabs. Results are cached in the extension's
local storage.

Without a token, GitHub allows 60 requests per hour and private
repositories can't be checked. The optional token is stored unencrypted
in the extension's local storage; use a fine-grained token with read-only
access.

## License

[MIT](LICENSE)
