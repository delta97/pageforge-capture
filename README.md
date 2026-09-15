# PageForge – Full Page Capture

A clean-room Manifest V3 Chrome extension that reproduces the core workflow of a full-page screenshot tool: click once, auto-scroll the current page, capture viewport tiles, reconstruct them at full resolution, then export PNG/JPEG/PDF.

## What is implemented

- One-click full-page capture from the toolbar
- `Alt+Shift+P` keyboard shortcut
- Automatic vertical and horizontal scrolling
- Full-resolution tile stitching
- Lazy-load settling delay
- Restoration of the user's original scroll position
- De-duplication of fixed elements
- Best-effort de-duplication of sticky elements
- Automatic detection of a dominant inner scroll container (useful for some app/chat layouts)
- Oversized capture splitting by megapixels and max image dimension
- PNG and JPEG output
- Clipboard copy for single-part captures
- PDF export: US Letter, A4, US Legal, or a single continuous page when within PDF size limits
- Filename templates
- Auto-download option
- Configurable capture delay, image quality, and page-handling behavior
- No broad `<all_urls>` host permission; it relies on `activeTab` after the user clicks the extension

## Install locally

1. Unzip this folder somewhere permanent.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the `pageforge-capture` folder.
6. Pin **PageForge – Full Page Capture** to the toolbar.
7. Open a normal HTTP/HTTPS page and click the extension icon.

Chrome will not allow normal content-script injection on some restricted pages, including parts of the Chrome Web Store and certain `chrome://` pages.

## Architecture

### `background.js`
Orchestrates capture. It injects `content.js`, asks the page to scroll, calls `chrome.tabs.captureVisibleTab()`, stores each PNG tile in IndexedDB, updates the toolbar badge, restores the source page, and opens the result tab.

### `content.js`
Runs only after the user invokes the extension. It measures the page, chooses the scrolling target, temporarily disables smooth scrolling/animations, manages fixed and sticky elements, scrolls to each requested position, and restores all modified state when done.

### `result.js`
Reads the captured PNG tiles from IndexedDB, reconstructs the screenshot into safe-sized image parts, displays them, and implements PNG/JPEG/clipboard/PDF export.

### `options.js`
Stores customization in `chrome.storage.sync`.

## Important implementation choices

Chrome limits `captureVisibleTab()` to at most two calls per second. The extension therefore enforces a minimum 550 ms delay between captures. Lowering that delay below Chrome's limit will make captures fail intermittently.

The result renderer intentionally splits very large pages instead of trying to allocate one enormous canvas. The default is 30 megapixels per part and a 16,384 px maximum part dimension. Both values are configurable.

## Known gaps vs. a mature commercial screenshot extension

This is a working MVP, not a decade-hardened capture engine. The main remaining edge cases are:

- Deep scrolling inside cross-origin iframes
- Pages with multiple independently scrolling panes that all need to be expanded into one composite
- Some parallax/transform-heavy layouts
- Video/canvas/WebGL content that changes while scrolling
- Semantic “smart” PDF page breaks that analyze text lines before splitting
- Annotation/crop/editor tooling
- Automated regression fixtures across hundreds of websites

The code is structured so those can be added without replacing the basic capture pipeline.

## Customization points

The easiest areas to extend are:

- `chooseScrollTarget()` in `content.js` — change how app-style inner scrollers are detected.
- `applyPositionedElementRules()` — tune fixed/sticky element handling.
- `makePositions()` in `background.js` — add overlap between tiles if desired.
- `renderRegion()` in `result.js` — add overlays, watermarks, redaction, timestamps, URL labels, etc.
- `exportPdf()` — add margins, headers/footers, smart break detection, custom page sizes.
- `options.html/js` — expose any new behavior as a user setting.

## Suggested next upgrades

1. **Selection and visible-area modes** so the toolbar can choose Full Page / Visible / Region.
2. **Annotation editor** using a canvas overlay layer with crop, text, arrows, highlights, blur/redaction, and undo/redo.
3. **Smart PDF splitting** by scanning a horizontal band around each proposed break and preferring rows with low visual density.
4. **Iframe-aware capture** by injecting helper scripts into accessible frames and composing frame scroll states.
5. **Capture profiles** such as “documentation”, “design review”, or “LLM chat”, each with different delay/sticky/inner-scroller rules.
6. **Post-capture automation hooks** such as copying to clipboard automatically, saving to a chosen service, or passing the result to another local workflow.

## Clean-room / reference note

The extension was independently implemented from the public product behavior and Chrome extension APIs. GoFullPage's historical repository is public under the MIT License, but its current production branch is private. This project does not include GoFullPage branding, icons, premium assets, or private source code.
