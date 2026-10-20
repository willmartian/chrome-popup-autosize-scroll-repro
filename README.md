# Chrome extension popup: scrolling collapses since Chrome 152

A minimal MV3 extension that reproduces a scrolling regression in Chrome extension **action
popups**, starting in Chrome 152. During a fast scroll, the popup's scroll position only advances
about 15–20 times per second instead of about 120, so anything rendered on scroll (virtualized
lists) shows blank space for most of the gesture. The same page in a regular tab is unaffected.

## The repro

`extension/` is a four-file extension with no framework:

- `popup.html`: the popup page. Its content is sized from the viewport
  (`width: 100vw; height: 100vh`).
- `popup.js`:
  - a bare-bones virtual list (2,000 rows; the visible rows are re-rendered on every `scroll` event)
  - 3,000 paragraphs of text under the same viewport-sized root, clipped out of view
- `manifest.json`, `sw.js`: the action popup, and an empty service worker so a script can open the
  popup with `chrome.action.openPopup()`.

Both ingredients are needed: something that changes layout on every scroll frame, and a page whose
layout depends on the viewport size and is expensive to redo. Without the `vh`/`vw` root or without
the extra content, affected builds scroll normally.

## Reproducing

**By hand:** load `extension/` as an unpacked extension (`chrome://extensions` → Developer mode →
Load unpacked), click its toolbar icon, and scroll the popup quickly with a trackpad. On Chrome 151
it scrolls smoothly. On Chrome 152+ the rows lag far behind and the list is mostly blank while
scrolling. Opening `popup.html` in a tab scrolls smoothly on every version.

**Scripted (macOS):** `measure.js` launches a given Chrome binary with a throwaway profile, then
measures the real popup and the same page in a tab:

```
node measure.js "/path/to/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
```

It prints the idle frame rate and the scroll updates per second during a synthetic scroll gesture
(`Input.synthesizeScrollGesture`, 15,000px at 12,000px/s). Requires Node 22+.

## Results

macOS 26, Apple Silicon, 120Hz display.

| Build                             | Scroll updates/s, real popup | Scroll updates/s, tab |
| --------------------------------- | ---------------------------- | --------------------- |
| Chrome for Testing 151.0.7922.138 | 119                          | 120                   |
| Chrome for Testing 155.0.8059.39  | **17**                       | 120                   |
| Chromium snapshot r1677665        | 115                          | 119                   |
| Chromium snapshot r1677676        | **11**                       | 103                   |

On r1677676, a trace of one popup fling shows 1,226ms of layout, against 29ms on r1677665.

## Regression range

Found by bisecting the [Bitwarden](https://github.com/bitwarden/clients) browser extension's popup,
then confirmed with this repro on the two snapshots above:

- Chrome for Testing **152.0.7977.42 is good and 152.0.7977.54 is bad.**
- On main, snapshot **r1677665 is good and r1677676 is bad.** The only rendering change in that
  range is:

  **[`14cad6085d`](https://chromium.googlesource.com/chromium/src/+/14cad6085dfbd8ab2b8a0f4b12eec966b7104d24)
  Fix WebView autosize after content width shrinks** (r1677671,
  [review 8212439](https://chromium-review.googlesource.com/c/chromium/src/+/8212439); bugs
  543045592, 543924650, 543721489)

  It was merged to M152 as `c90d289a39` (branch-heads/7977 #1808), first shipped in 152.0.7977.54.

## Likely mechanism

This part is a hypothesis from traces, not from reading Blink's code.

The change makes auto-sized views (extension popups among them) "remeasure from the minimum autosize
size after loading and subsequent layout changes". A virtual list changes layout on every scroll
frame, so every frame now also re-lays out the document at the popup's minimum size and back.
Anything that depends on the viewport size is invalidated each time:

- In this repro, it's the `vh`/`vw`-sized content: about 3× as many layout passes during a fling,
  and each one expensive.
- In Bitwarden's popup, the biggest cost was a width-range media query from
  [ngx-toastr](https://github.com/scttcper/ngx-toastr)'s default stylesheet
  (`@media all and (min-width: 241px) and (max-width: 480px)`, which only styles toasts). It matches
  at the popup's normal width but not at the minimum, so it flipped twice per frame. Traces showed
  every frame re-styling and re-laying out the whole document, with invalidation reasons "Style rule
  change" and "Fonts changed", which never appear on Chrome 151. Removing ngx-toastr's media queries
  and the popup root's `vh`/`vw` sizing recovered most of the lost scrolling performance on
  Chrome 155.
