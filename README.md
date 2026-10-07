# LinkedIn Hide

Chrome extension (Manifest V3) that collapses every post on the LinkedIn **home feed**
into a one-line card with a reveal toggle.

## Behaviour

| Post source | Collapsed card shows |
| --- | --- |
| 1st-degree connection | Their name + blue `1ST` tag + **Reveal** |
| Person or company you follow | Their name + green `FOLLOWING` tag + **Reveal** |
| Anyone else | `Post` + grey `2ND` / `3RD+` / `PROMOTED` / `SUGGESTED` / `PAGE` tag + **Reveal** |

Tag precedence is `PROMOTED` → `1ST` → `FOLLOWING` → degree → `SUGGESTED` → `PAGE`,
so a promoted post never shows a name even if you follow the advertiser.

- **Reveal** expands the original post in place and turns into **Hide**, so you can
  re-collapse it. Nothing is persisted — everything re-collapses on reload.
- A floating **Reveal all** button (bottom right) expands every post currently
  loaded, then flips to **Collapse all**.
- Promoted and suggested posts are collapsed like everything else, just labelled.
- Only the home feed (`/feed/`, `/`) is touched. Profiles, post permalinks,
  search, and messaging are left alone.

## Enabling / disabling

Click the pinned toolbar icon. There is no popup — the click toggles directly.

- **On** — blue icon.
- **Off** — grey icon; hover text states the current state either way.

Toggling applies immediately to every open LinkedIn tab, no reload. Switching off
removes the collapsed cards and hands the feed back to LinkedIn untouched. The
setting persists across restarts (`chrome.storage.local`), defaulting to on.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this folder
4. Reload any open LinkedIn tab

## Files

- `manifest.json` — MV3 manifest. Only the `storage` permission; no
  `host_permissions`. The content script is scoped to `https://www.linkedin.com/*`
  and gates itself to the feed at runtime.
- `content.js` — post detection, degree parsing, collapsed card, MutationObserver.
- `background.js` — toolbar icon toggle. Reads and writes a single boolean; no
  network access, no tab or scripting permissions.
- `styles.css` — card styling, light + LinkedIn dark theme.
- `icons/linkedin-favicon.ico` — source asset, downloaded unmodified from
  `https://www.linkedin.com/favicon.ico` (24,838 bytes; frames at 16/24/32/64,
  32bpp BMP).
- `icons/` — `active-*.png` (LinkedIn's mark) and `inactive-*.png` (the same mark
  desaturated), 16/32/48/128, generated from that source.
- `tools/make-icons.py` — regenerates `icons/` from the `.ico`. Pure stdlib, no
  Pillow: the ICO frames are 32bpp BMP, so it reads RGBA directly and only ever
  *encodes* PNG.

  ```
  python3 tools/make-icons.py
  ```

  Sizes 16 and 32 come from exact frames; 48 and 128 are bilinear-resampled from
  the 64px frame (128 is therefore a 2× upscale and slightly soft). The grey
  state is Rec. 709 luminance with a 15% lift, so it reads as muted rather than
  merely dark — tune `GREY_LIFT` there.

### Trademark note

The icon is LinkedIn's actual logo, and their asset is vendored in this repo.
That is fine for a personal, locally-loaded extension. It would be a problem for
distribution: Chrome Web Store policy prohibits branding that implies affiliation
with another company, and this would likely be rejected. Swap in an original mark
before publishing anywhere.

## Security posture

Adding the toggle changed two of the properties from the original review. Current
state: **`storage` is the only permission**, and there is still no network egress
(`fetch` / `XHR` / `sendBeacon` / `WebSocket` all absent), no HTML injection
(display names go in via `textContent` only, never `innerHTML`), no remote code,
no `host_permissions`, no `externally_connectable`, and no dependencies. The full
privileged surface is `chrome.action.*`, `chrome.storage.local`,
`chrome.storage.onChanged`, `chrome.runtime.onInstalled/onStartup`.

The stored data is one boolean. Re-run the sink grep after any change:

```
grep -rnE "innerHTML|insertAdjacentHTML|eval\(|new Function|fetch\(|XMLHttpRequest|sendBeacon|WebSocket" .
```

## How it finds posts

The feed is **server-driven UI** (`data-sdui-screen` =
`com.linkedin.sdui.flagshipnav.feed.MainFeed`). Every class name is a rotating
build hash — `d1f0e118`, `_849cef98` — so class-based selectors are worthless.
The old semantic names (`feed-shared-update-v2`, `update-components-actor__*`)
no longer exist anywhere in the document.

This version anchors on accessibility affordances instead, which are stable
because screen readers depend on them:

- **Feed list** — `[componentkey="container-update-list_mainFeed-lazy-container"]`,
  falling back to `[componentkey*="mainFeed"]`, then to the nearest common
  ancestor of two post headings.
- **Post** — the direct child of that list containing `<h2>Feed post</h2>`.
- **Author name** — the `aria-label` `"Open control menu for post by <Name>"`
  (fallback `"Hide post by <Name>"`). Preferred over the degree label because it
  also covers company/page actors, which carry no degree.
- **Degree** — the actor `aria-label`, formatted
  `"<Name> [Verified|Premium Profile] <degree>"`.
- **Promoted** — a leaf element whose exact text is `Promoted`.
- **Following** — inferred from the *absence* of a `"Follow <Name>"` aria-label.
  LinkedIn renders that button only when you are not already following.

**Do not use the first `a[href*="/in/"]` or `"View X's profile"` for the author.**
On a reshare both name whoever reacted ("Sasha Pilch likes this"), not the post's
author. Only the control-menu and degree labels are author-accurate.

## Notes on fragility

- **Degree parsing is English-only.** `ACTOR_LABEL_RE` matches `1st` / `2nd` /
  `3rd+`, and `FOLLOW_OFFER_RE` matches the literal word `Follow`. On a
  non-English UI degrees stop resolving and every post looks followed. Add locale
  strings to both if you switch languages.
- **`FOLLOWING` is inferred, not stated.** It means "LinkedIn did not offer a
  Follow button", which is true for people and pages you follow — and also for
  your own posts, which will therefore show your name with a `FOLLOWING` tag.
- **The feed lazy-mounts and recycles rows.** A post already handled can return
  stripped of its bar, so every scan re-checks and re-inserts rather than
  trusting a processed flag.
- **Failure is safe.** If detection breaks, the feed renders normally rather than
  going blank: `.lih-arming` is removed as soon as the feed list is found — even
  with zero posts matched — and on a 4s failsafe regardless.
- **Never collapse with `display: none`.** LinkedIn's expandable-text-box picks
  its "… more" control by measuring the text, and a `display:none` element
  measures 0×0. Collapse must keep the content laid out and measurable.
- **`display: contents` is the trap.** The post wrapper and its child both use
  it, so they generate no box: `position: absolute` on them is silently ignored
  and the content never leaves the flow, while `visibility: hidden` *does*
  inherit down to the grid grandchild that carries the height. You get invisible
  posts at full height (~471px of blank space each). The collapse rule must force
  `display: block` before `position: absolute` can do anything. Full reasoning is
  in the `styles.css` comment — read it before touching that rule.
- **Trade-off of not using `display:none`:** collapsed posts are still laid out,
  so images and video remain loaded rather than skipped. They are clipped to zero
  height, which should also keep viewport-visibility triggers from firing, but
  that has not been verified — if muted autoplay ever runs behind a collapsed
  post, pause the media on collapse rather than reverting to `display:none`.
