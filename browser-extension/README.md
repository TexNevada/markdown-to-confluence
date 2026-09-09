# Markdown → Confluence

A browser extension that converts Markdown on your clipboard into something
on-premise Confluence 9 will paste with code blocks and formatting intact.

Copying Markdown straight from Obsidian into Confluence loses code blocks,
and Confluence's own Markdown handling gives poor syntax highlighting. This
extension sits in between: paste Markdown into its popup, click once, and
the clipboard is rewritten into a format the Confluence editor understands.

## Install

There is no icon and no store listing; load it unpacked.

**Chrome / Edge** — `chrome://extensions`, enable *Developer mode*, click
*Load unpacked*, select this `browser-extension` directory.

**Firefox** — `about:debugging#/runtime/this-firefox`, click *Load Temporary
Add-on*, select `manifest.json`. Temporary add-ons are removed on restart;
for a permanent install, build a zip (below) and sign it.

## Use

1. Copy Markdown in Obsidian (or anywhere else).
2. Click the extension's toolbar button. The popup reads the clipboard and
   pre-fills the textarea. If clipboard access is blocked, paste manually.
3. Pick an output target.
4. Click **Convert & copy** (or press Ctrl/Cmd+Enter).
5. Paste into Confluence.

Nothing is written to the clipboard until you click; the extension has no
content scripts and never touches any page.

## Output targets

Confluence's paste filter behaves differently across on-premise versions and
highlighter builds, so there is no single correct answer here. Try them in
this order against a scratch page and keep whichever wins.

| Target | Paste into | Code blocks become |
| --- | --- | --- |
| **Rich HTML — code as `<pre>`** | the editor, directly | `<pre><code class="language-x">`, usually rendered as a *Preformatted* block without language-specific highlighting |
| **Rich HTML — Confluence macros** | the editor, directly | `<ac:structured-macro ac:name="code">` storage-format macros; a real Code Block macro if the paste filter keeps them, dropped entirely if it does not |
| **Confluence wiki markup** | **Insert → Markup**, markup type *Confluence Wiki* | `{code:language=x}`, which is a genuine Code Block macro |

The wiki target is the most faithful — it is the only one that is not at the
mercy of the editor's HTML paste filter — at the cost of going through a
dialog instead of a plain Ctrl+V. Start with **Rich HTML — Confluence
macros**; if code blocks vanish or arrive unhighlighted, switch to wiki.

The macro target also maps callouts to Confluence's info/tip/note/warning
panels and task lists to real Confluence tasks. The wiki target maps
callouts too. The plain `<pre>` target renders both as ordinary blockquotes
and lists.

Your choice is remembered between popup openings.

## What is converted

Headings (ATX and Setext), paragraphs, hard and soft line breaks, fenced and
indented code blocks, nested ordered and unordered lists, ordered lists with
a non-1 start, task lists, blockquotes, Obsidian callouts, tables with
alignment, horizontal rules, footnotes, bold, italic, strikethrough,
`==highlight==`, inline code, links, bare URLs, autolinks, images, and
backslash escapes.

Two Obsidian constructs cannot be resolved outside the vault:

- `[[Wikilinks]]` become plain text in the HTML targets. In the wiki target
  they become `[Page Title]`, which Confluence resolves as a page link — so
  wikilinks work if your note titles match your Confluence page titles.
- `![[embeds]]` are left as literal `![[file.png]]` text in the HTML targets,
  so it is obvious an attachment is still needed. In the wiki target they
  become `!file.png!`, which renders once the file is attached to the page.

Single newlines inside a paragraph become `<br>`, matching Obsidian's default
"strict line breaks: off" behaviour rather than CommonMark's.

## Known limits

- Confluence only ships four coloured panels, so several Obsidian callout
  types collapse onto each one. See `CALLOUT_MACRO` in `markdown.js`.
- Collapsible callouts (`> [!note]-`) are rendered expanded.
- Wiki markup cannot indent a block inside a list item, so a code block
  inside a list item is emitted after the list in the wiki target.
- The Confluence Code Block macro's language tokens vary by instance.
  Unrecognised languages fall back to `text`; adjust `CONFLUENCE_LANGUAGES`
  in `markdown.js` if yours differ.
- Nested emphasis of the same kind (`*a *b* c*`) is not disambiguated.

## Build

```bash
python3 build.py
```

Writes `markdown-confluence-chrome.zip` and
`markdown-confluence-firefox.zip`. The Chrome package has
`browser_specific_settings` stripped; the Firefox one keeps it for a stable
add-on id.

## Layout

| File | Role |
| --- | --- |
| `markdown.js` | The converter. Parses Markdown into a block tree, then renders that tree to each target. No DOM dependencies, so it can be imported and tested on its own. |
| `popup.html` / `popup.css` / `popup.js` | The popup UI, clipboard read/write, and target persistence. |
| `manifest.json` | Manifest V3. Two clipboard permissions, no host permissions. |
| `build.py` | Per-browser packaging. |
