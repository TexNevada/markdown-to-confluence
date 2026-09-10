# Markdown → Confluence

Paste Obsidian Markdown straight into the on-premise Confluence 9 editor and
have it arrive with real code blocks, nested lists, tables and callouts.

Copying Markdown from Obsidian into Confluence loses code blocks, and
Confluence's own Markdown support gives poor syntax highlighting. Building the
HTML by hand does not help either — the editor's paste filter rewrites it.

So this extension does not build HTML. It converts Markdown to **Confluence
wiki markup**, hands that to **Confluence's own server-side converter**, and
inserts the HTML that comes back. Since Confluence produced that HTML itself,
the paste filter accepts it verbatim, and `{code:language=bash}` becomes a
genuine Code Block macro with highlighting.

The result is one keystroke: **Ctrl+V.**

## Install

There is no icon and no store listing; load it unpacked.

**Chrome / Edge** — `chrome://extensions`, enable *Developer mode*, click
*Load unpacked*, select this `browser-extension` directory.

**Firefox** — `about:debugging#/runtime/this-firefox`, click *Load Temporary
Add-on*, select `manifest.json`. Temporary add-ons are removed on restart; for
a permanent install, build a zip (below) and sign it.

Requires Chrome 111+ or Firefox 128+ for the TinyMCE bridge. Older browsers
fall back to writing into the editor DOM directly, which works but is less
well integrated with the editor's undo history.

## Use

**Once per Confluence site:** open any page on it and click the toolbar icon.
Accept the permission prompt. The badge shows `M↓` while the site is enabled.
Click the icon again to hand the permission back.

The extension ships with **no host permissions at all** and requests exactly
one origin at a time, so it cannot see any site you have not enabled.

**Then, whenever you are editing:**

1. Copy Markdown in Obsidian.
2. Ctrl+V in the Confluence page editor.

A button bearing the Markdown mark sits in the bottom-right of the editor. It
is on by default and turns conversion off when you want a plain paste; its
state is remembered per site. The mark recolours itself for a light or dark
Confluence. Conversion only ever runs inside the page editor — the search box,
the page title and every other field on the site are untouched.

If the conversion fails for any reason, the original text is pasted
unconverted and the reason appears next to the toggle. A failed conversion
never swallows your clipboard.

## What is converted

Headings (ATX and Setext), paragraphs, hard and soft line breaks, fenced and
indented code blocks, nested ordered and unordered lists, task lists,
blockquotes, Obsidian callouts, tables with alignment, horizontal rules,
footnotes, bold, italic, strikethrough, `==highlight==`, inline code, links,
bare URLs, autolinks, images, and backslash escapes.

Obsidian's own link syntax maps onto Confluence's, which is the one place this
works better than expected:

- `[[Some Page]]` becomes `[Some Page]`, which Confluence resolves as a page
  link. Wikilinks work if your note titles match your Confluence page titles.
- `[[Page|shown]]` becomes `[shown|Page]`.
- `![[diagram.png]]` becomes `!diagram.png!`, which renders once the file is
  attached to the page.

Single newlines inside a paragraph become line breaks, matching Obsidian's
default "strict line breaks: off" behaviour rather than CommonMark's.

## Known limits

- Confluence ships only four coloured panels, so several Obsidian callout
  types collapse onto each one. See `CALLOUT_MACRO` in `markdown.js`.
- Collapsible callouts (`> [!note]-`) render expanded.
- Wiki markup has no start number for ordered lists, so a list beginning at
  `3.` renumbers from 1.
- Wiki markup has no highlight, so `==text==` renders unstyled.
- Wiki markup cannot indent a block inside a list item, so a code block inside
  a list item is emitted after the list.
- Task lists become `☐`/`☑` glyphs; wiki markup has no task syntax.
- The Code Block macro's language tokens vary by instance. Unrecognised
  languages fall back to `text`; adjust `CONFLUENCE_LANGUAGES` in
  `markdown.js` if yours differ.
- **A code block containing `{code}` or `{noformat}` is refused**, and the
  paste falls back to plain text. A macro body runs literally until its
  closing token and wiki markup cannot escape that token, so converting it
  would silently end the block early and turn the rest of the document into
  live markup. Refusing beats corrupting. Inline code spans are checked too.
- Disabling a site takes effect on the next page load; already-open tabs keep
  the previously injected script until reloaded.

## Build

```bash
python3 build.py
```

Writes `markdown-confluence-chrome.zip` and `markdown-confluence-firefox.zip`.
The manifests differ in two ways that matter: Firefox gets
`browser_specific_settings` for a stable add-on id and an event-page
background, Chrome gets a service worker.

## Layout

| File | Role |
| --- | --- |
| `markdown.js` | The converter. Parses Markdown into a block tree, then renders that tree as Confluence wiki markup. No DOM dependencies, so it can be exercised on its own. Publishes `MarkdownToConfluence.toWikiMarkup`. |
| `background.js` | Per-origin enablement: the icon click requests or releases the host permission and registers or unregisters the content scripts. Owns the badge. |
| `content.js` | Finds the editor, draws the toggle, intercepts paste, and drives the server-side conversion. Runs in the top frame and reaches into the editor iframe. |
| `bridge.js` | Runs in the page's own JS context, the only place Confluence's `tinymce` global is reachable, and performs the insertion through TinyMCE's own command. |
| `manifest.json` | Manifest V3. No host permissions and no static content scripts; both are acquired at runtime. |
| `static/` | The official Markdown mark artwork, plus the generated `icon-*.png` toolbar icons. |
| `make-icons.py` | Regenerates the toolbar icons from the artwork. Run only when the icon design changes; output is committed. |
| `build.py` | Per-browser packaging. |

## Icons and the toggle

Both come from the official Markdown mark in `static/`, which is pure black on
transparent at every size.

The in-editor toggle uses the artwork as a **CSS alpha mask** with
`background-color: currentColor`, so one inlined copy of `static/66x40.png`
serves light, dark, on and off without a second asset. It is inlined as a data
URI rather than loaded by URL, which is what keeps the extension free of any
`web_accessible_resources` entry.

The toolbar icons are square, so `make-icons.py` composites the mark in white
onto a `#0052CC` rounded tile — black artwork would vanish on dark browser
chrome, and Chrome has no per-theme icon support. At 16px the mark's own border
plus the tile edge plus the glyph is too much detail, so that size uses the
glyph alone and lets the tile be the frame.

## How the conversion works

Two same-origin requests to Confluence's public REST API:

```
POST {context}/rest/api/contentbody/convert/storage
{"value": "<wiki markup>", "representation": "wiki"}     -> .value = storage XML

POST {context}/rest/api/contentbody/convert/editor
{"value": "<storage XML>", "representation": "storage",
 "content": {"id": "<pageId>"}}                          -> .value = editor HTML
```

Two steps rather than one because `wiki` → `editor` is not a supported
conversion pair — only `wiki` → `storage` and `storage` → `editor` are.

An earlier version tried `/rest/tinymce/1/wikixhtmlconverter` first, the
endpoint Confluence's own Insert → Markup dialog uses, which does the job in a
single request. It fails on this instance, and parts of its request body are
undocumented, so it was removed rather than carried as a guess. If you ever
point this at a different Confluence and want the single-round-trip path back,
it is in the git history.

Page context comes from Confluence's `ajs-context-path`, `ajs-page-id` and
`ajs-space-key` meta tags, with the `pageId` URL parameter as a fallback.
