# Chrome 152+ extension popup scroll regression

Since Chrome 152, scrolling in an extension **action popup** can drop from ~120 to ~15 scroll updates
per second, leaving virtualized lists blank while scrolling. The same page in a tab is fine.

## Repro

Load `extension/` unpacked, open its popup, and scroll fast. Smooth on Chrome 151, janky on 152+.

The popup has a viewport-sized root (`100vw`/`100vh`), a virtual list that re-renders on scroll, and
3,000 hidden paragraphs to make layout expensive. Remove either the viewport sizing or the paragraphs
and it scrolls fine.

To measure (macOS, Node 22+):

```
node measure.js "/path/to/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
```

| Build | Popup (updates/s) | Tab (updates/s) |
| --- | --- | --- |
| Chrome 151.0.7922.138 | 119 | 120 |
| Chrome 155.0.8059.39 | 17 | 120 |
| Chromium r1677665 | 115 | 119 |
| Chromium r1677676 | 11 | 103 |

## Cause

Bisected (from the [Bitwarden](https://github.com/bitwarden/clients) extension) to
[`14cad6085d` Fix WebView autosize after content width shrinks](https://chromium.googlesource.com/chromium/src/+/14cad6085dfbd8ab2b8a0f4b12eec966b7104d24)
(r1677671, merged to M152 in 152.0.7977.54).

It remeasures auto-sized views from their minimum size after every layout change. A virtual list
changes layout every frame, so anything viewport-dependent gets invalidated every frame. In Bitwarden
the worst trigger was a width-range media query in [ngx-toastr](https://github.com/scttcper/ngx-toastr)'s
default CSS, which flipped on each remeasure and forced a full style and layout recalc.
