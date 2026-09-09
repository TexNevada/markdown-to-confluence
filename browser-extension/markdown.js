/*
 * Markdown → Confluence converter.
 *
 * Two stages, so that one parser can feed several clipboard formats:
 *
 *   1. parse()   Markdown text  → a small block tree.
 *   2. render*() that block tree → one clipboard target.
 *
 * Targets:
 *
 *   html-pre     Rich HTML. Code blocks become <pre><code class="language-x">.
 *                The safest, least surprising option; Confluence usually
 *                turns these into "Preformatted" blocks without language
 *                specific highlighting.
 *
 *   html-macro   Rich HTML, but code blocks, callouts and task lists are
 *                emitted as Confluence storage-format macros. Whether the
 *                editor's paste filter keeps them depends on the instance,
 *                so this one has to be tried against a real page.
 *
 *   wiki         Confluence wiki markup as plain text, for the editor's
 *                Insert → Markup dialog. Highest fidelity for code blocks,
 *                since {code:language=x} is a real Code Block macro, but it
 *                needs one extra dialog instead of a plain paste.
 *
 * Inline text is kept as raw Markdown in the block tree and parsed lazily by
 * parseInline(), so each renderer can escape it according to its own rules.
 */

export const TARGETS = ["html-pre", "html-macro", "wiki"];


export function convert(markdown, options = {}) {
    const target = TARGETS.includes(options.target)
        ? options.target
        : "html-pre";

    const doc = parse(markdown);

    if (target === "wiki") {
        return {
            target,
            html: null,
            plain: renderWiki(doc)
        };
    }

    return {
        target,
        html: renderHtml(doc, target),
        plain: markdown
    };
}


/* ------------------------------------------------------------------ *
 * Block parsing
 * ------------------------------------------------------------------ */

function parse(markdown) {
    const normalized = String(markdown)
        .replace(/\r\n?/g, "\n")
        .replace(/\t/g, "    ");

    const { lines, notes } = extractFootnotes(normalized.split("\n"));

    /*
     * Footnotes are numbered by definition order so that the rendered
     * ordered list lines up with the superscript references.
     */
    const footnoteNumbers = new Map();

    notes.forEach((note, index) => {
        if (!footnoteNumbers.has(note.id)) {
            footnoteNumbers.set(note.id, index + 1);
        }
    });

    return {
        blocks: parseBlocks(lines),
        notes,
        footnoteNumbers
    };
}


/*
 * Footnote definitions are pulled out before block parsing so they do not
 * show up as stray paragraphs wherever the author happened to put them.
 *
 *   [^ref]: The note body.
 *       An indented continuation line.
 */
function extractFootnotes(lines) {
    const kept = [];
    const notes = [];

    let i = 0;

    while (i < lines.length) {
        const match = /^\[\^([^\]]+)]:[ \t]*(.*)$/.exec(lines[i]);

        if (!match) {
            kept.push(lines[i]);
            i++;
            continue;
        }

        const body = [match[2]];

        i++;

        while (i < lines.length) {
            const indented = /^ {2,}\S/.test(lines[i]);
            const blankThenIndented =
                !lines[i].trim() &&
                i + 1 < lines.length &&
                /^ {2,}\S/.test(lines[i + 1]);

            if (!indented && !blankThenIndented) {
                break;
            }

            body.push(lines[i].replace(/^ {1,4}/, ""));
            i++;
        }

        notes.push({ id: match[1], lines: body });
    }

    return { lines: kept, notes };
}


function parseBlocks(lines) {
    const blocks = [];

    let i = 0;
    let paragraph = [];

    const flushParagraph = () => {
        const text = paragraph.join("\n").trim();

        if (text) {
            blocks.push({ type: "para", text });
        }

        paragraph = [];
    };

    while (i < lines.length) {
        const line = lines[i];

        if (!line.trim()) {
            flushParagraph();
            i++;
            continue;
        }

        /*
         * Fenced code block.
         *
         *   ```bash
         *   echo hello
         *   ```
         *
         * A longer fence can wrap a shorter one, so the closing fence must
         * be at least as long as the opening one.
         */
        const fence = /^( *)(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+#.\-]*)[^\n]*$/
            .exec(line);

        if (fence) {
            flushParagraph();

            const [, indent, marker, info] = fence;
            const closer = new RegExp(
                `^ *${marker[0] === "`" ? "`" : "~"}{${marker.length},} *$`
            );
            const body = [];

            i++;

            while (i < lines.length && !closer.test(lines[i])) {
                body.push(stripIndent(lines[i], indent.length));
                i++;
            }

            if (i < lines.length) {
                i++;
            }

            blocks.push({
                type: "code",
                lang: normalizeLanguage(info),
                code: body.join("\n")
            });

            continue;
        }

        /*
         * Setext heading underline. Checked before the horizontal rule so
         * that a "---" directly under text is read as a heading rather than
         * a rule, which is what both CommonMark and Obsidian do.
         */
        const setext = /^ {0,3}(=+|-+) *$/.exec(line);

        if (setext && paragraph.length > 0) {
            const text = paragraph.join("\n").trim();

            paragraph = [];

            blocks.push({
                type: "heading",
                level: setext[1][0] === "=" ? 1 : 2,
                text
            });

            i++;
            continue;
        }

        const heading = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);

        if (heading) {
            flushParagraph();

            blocks.push({
                type: "heading",
                level: heading[1].length,
                text: heading[2]
            });

            i++;
            continue;
        }

        if (isHorizontalRule(line)) {
            flushParagraph();
            blocks.push({ type: "hr" });
            i++;
            continue;
        }

        if (/^ {0,3}>/.test(line)) {
            flushParagraph();
            i = parseQuote(lines, i, blocks);
            continue;
        }

        if (isTableHeader(line, lines[i + 1])) {
            flushParagraph();
            i = parseTable(lines, i, blocks);
            continue;
        }

        if (matchListItem(line)) {
            flushParagraph();
            i = parseList(lines, i, blocks);
            continue;
        }

        /*
         * Indented code block. Only recognised at the start of a block, so
         * that indented paragraph continuations are left alone.
         */
        if (/^ {4,}\S/.test(line) && paragraph.length === 0) {
            const body = [];

            while (i < lines.length) {
                if (/^ {4}/.test(lines[i])) {
                    body.push(lines[i].slice(4));
                    i++;
                    continue;
                }

                if (!lines[i].trim() && hasMoreIndentedCode(lines, i)) {
                    body.push("");
                    i++;
                    continue;
                }

                break;
            }

            blocks.push({
                type: "code",
                lang: "",
                code: body.join("\n")
            });

            continue;
        }

        paragraph.push(line);
        i++;
    }

    flushParagraph();

    return blocks;
}


function hasMoreIndentedCode(lines, index) {
    for (let i = index + 1; i < lines.length; i++) {
        if (!lines[i].trim()) {
            continue;
        }

        return /^ {4}/.test(lines[i]);
    }

    return false;
}


function parseQuote(lines, start, blocks) {
    const inner = [];

    let i = start;

    while (i < lines.length) {
        const quoted = /^ {0,3}>[ \t]?(.*)$/.exec(lines[i]);

        if (quoted) {
            inner.push(quoted[1]);
            i++;
            continue;
        }

        /*
         * Lazy continuation: an unmarked line directly under a quote stays
         * part of it.
         */
        if (
            lines[i].trim() &&
            !isBlockStart(lines[i]) &&
            !matchListItem(lines[i])
        ) {
            inner.push(lines[i].trim());
            i++;
            continue;
        }

        break;
    }

    /*
     * Obsidian callout header.
     *
     *   > [!warning] Optional title
     */
    let callout = null;

    const header = /^\[!([A-Za-z-]+)]([+-]?)[ \t]*(.*)$/.exec(inner[0] || "");

    if (header) {
        callout = {
            kind: header[1].toLowerCase(),
            title: header[3].trim()
        };

        inner[0] = "";
    }

    blocks.push({
        type: "quote",
        callout,
        blocks: parseBlocks(inner)
    });

    return i;
}


const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])( +|$)(.*)$/;


function matchListItem(line) {
    if (isHorizontalRule(line)) {
        return null;
    }

    const match = LIST_ITEM.exec(line);

    if (!match) {
        return null;
    }

    const [, indent, marker, gap, text] = match;
    const ordered = /\d/.test(marker);

    return {
        indent: indent.length,
        ordered,
        start: ordered ? parseInt(marker, 10) : null,
        contentOffset: indent.length + marker.length + Math.max(gap.length, 1),
        text
    };
}


/*
 * A list is collected one level at a time: anything indented past the base
 * marker becomes item content, which parseBlocks() then re-parses. Nesting
 * therefore falls out of the recursion instead of needing an indent stack.
 */
function parseList(lines, start, blocks) {
    const first = matchListItem(lines[start]);
    const baseIndent = first.indent;
    const ordered = first.ordered;
    const items = [];

    let i = start;
    let current = null;
    let pendingBlanks = 0;

    while (i < lines.length) {
        const line = lines[i];

        if (!line.trim()) {
            pendingBlanks++;
            i++;
            continue;
        }

        const indent = leadingSpaces(line);
        const item = matchListItem(line);

        if (item && item.indent <= baseIndent + 1) {
            if (item.ordered !== ordered) {
                break;
            }

            /*
             * Two or more blank lines end the list rather than making it
             * loose, matching how Obsidian splits adjacent lists.
             */
            if (pendingBlanks > 1) {
                break;
            }

            pendingBlanks = 0;

            current = {
                checked: null,
                contentOffset: item.contentOffset,
                lines: [item.text]
            };

            const task = /^\[([ xX])]\s+(.*)$/.exec(item.text);

            if (task) {
                current.checked = task[1] !== " ";
                current.lines = [task[2]];
            }

            items.push(current);
            i++;
            continue;
        }

        if (current && indent > baseIndent) {
            for (let b = 0; b < pendingBlanks; b++) {
                current.lines.push("");
            }

            pendingBlanks = 0;
            current.lines.push(line.slice(Math.min(current.contentOffset, indent)));
            i++;
            continue;
        }

        /*
         * Lazy continuation of the current item, e.g. a wrapped line that
         * was not indented. Without this the line would escape the list and
         * be emitted as a separate paragraph before it.
         */
        if (current && !pendingBlanks && !item && !isBlockStart(line)) {
            current.lines.push(line.trim());
            i++;
            continue;
        }

        break;
    }

    blocks.push({
        type: "list",
        ordered,
        start: first.start,
        items: items.map(item => ({
            checked: item.checked,
            blocks: parseBlocks(item.lines)
        }))
    });

    return i;
}


function parseTable(lines, start, blocks) {
    const header = splitTableRow(lines[start]);
    const align = splitTableRow(lines[start + 1]).map(cell => {
        const value = cell.trim();
        const left = value.startsWith(":");
        const right = value.endsWith(":");

        if (left && right) {
            return "center";
        }

        if (right) {
            return "right";
        }

        if (left) {
            return "left";
        }

        return null;
    });

    const rows = [];

    let i = start + 2;

    while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        rows.push(splitTableRow(lines[i]));
        i++;
    }

    blocks.push({
        type: "table",
        header: header.map(cell => cell.trim()),
        align,
        rows: rows.map(row =>
            header.map((_, c) => (row[c] || "").trim())
        )
    });

    return i;
}


function isTableHeader(line, separator) {
    if (!line || !separator || !line.includes("|")) {
        return false;
    }

    const cells = splitTableRow(separator);

    return (
        cells.length > 0 &&
        cells.every(cell => /^\s*:?-+:?\s*$/.test(cell))
    );
}


/*
 * Splits on unescaped pipes only, and ignores pipes inside inline code, so
 * that `a|b` and \| survive inside a cell.
 */
function splitTableRow(line) {
    let value = line.trim();

    if (value.startsWith("|")) {
        value = value.slice(1);
    }

    const cells = [];

    let cell = "";
    let inCode = false;
    let sawTrailingPipe = false;

    for (let i = 0; i < value.length; i++) {
        const char = value[i];

        if (char === "\\" && value[i + 1] === "|") {
            cell += "\\|";
            i++;
            continue;
        }

        if (char === "`") {
            inCode = !inCode;
            cell += char;
            continue;
        }

        if (char === "|" && !inCode) {
            cells.push(cell);
            cell = "";
            sawTrailingPipe = true;
            continue;
        }

        sawTrailingPipe = false;
        cell += char;
    }

    if (cell.trim() || !sawTrailingPipe) {
        cells.push(cell);
    }

    return cells;
}


function isHorizontalRule(line) {
    return /^ {0,3}([*\-_])(?: *\1){2,} *$/.test(line);
}


function isBlockStart(line) {
    return (
        /^ {0,3}#{1,6}\s/.test(line) ||
        /^ *(`{3,}|~{3,})/.test(line) ||
        /^ {0,3}>/.test(line) ||
        isHorizontalRule(line)
    );
}


function leadingSpaces(line) {
    return /^ */.exec(line)[0].length;
}


function stripIndent(line, width) {
    let i = 0;

    while (i < width && line[i] === " ") {
        i++;
    }

    return line.slice(i);
}


/* ------------------------------------------------------------------ *
 * Inline parsing
 * ------------------------------------------------------------------ */

/*
 * One alternation, scanned left to right. Alternative order is precedence:
 * escapes and code spans win over everything, images over links, strong
 * over emphasis.
 */
const INLINE = new RegExp([
    /(?<esc>\\[\\`*_{}\[\]()#+\-.!>~|=])/,
    /(?<fence>`+)(?<code>[\s\S]*?)\k<fence>/,
    /!\[\[(?<embed>[^\]]+)]]/,
    /!\[(?<alt>[^\]]*)]\((?<src>[^)\s]+)(?:\s+"(?<imgTitle>[^"]*)")?\)/,
    /\[\[(?<wiki>[^\]|]+)(?:\|(?<wikiAlias>[^\]]+))?]]/,
    /\[\^(?<footnote>[^\]\s]+)]/,
    /\[(?<label>[^\]]*)]\((?<href>[^)\s]*)(?:\s+"(?<linkTitle>[^"]*)")?\)/,
    /<(?<autolink>(?:https?|mailto):[^>\s]+)>/,
    /(?<strongMark>\*\*|__)(?<strong>[\s\S]+?)\k<strongMark>/,
    /~~(?<del>[\s\S]+?)~~/,
    /==(?<mark>[\s\S]+?)==/,
    /\*(?<emStar>[^*\s][\s\S]*?)\*/,
    /(?<=^|[\s(])_(?<emUnderscore>[^_\s][\s\S]*?)_(?=$|[\s).,!?;:])/,
    /(?<br>\\?[ \t]*\n)/,
    /(?<url>https?:\/\/[^\s<>"'\]),]+)/
].map(pattern => pattern.source).join("|"), "g");


function parseInline(text) {
    const nodes = [];

    let last = 0;
    let match;

    INLINE.lastIndex = 0;

    while ((match = INLINE.exec(text)) !== null) {
        if (match.index > last) {
            nodes.push({ t: "text", v: text.slice(last, match.index) });
        }

        last = match.index + match[0].length;

        const g = match.groups;

        if (g.esc !== undefined) {
            nodes.push({ t: "text", v: g.esc.slice(1) });
        } else if (g.code !== undefined) {
            nodes.push({ t: "code", v: g.code.replace(/^ (.*) $/, "$1") });
        } else if (g.embed !== undefined) {
            nodes.push({ t: "embed", v: g.embed });
        } else if (g.src !== undefined) {
            nodes.push({
                t: "img",
                src: g.src,
                alt: g.alt || "",
                title: g.imgTitle || ""
            });
        } else if (g.wiki !== undefined) {
            nodes.push({
                t: "wikilink",
                target: g.wiki.trim(),
                alias: (g.wikiAlias || "").trim()
            });
        } else if (g.footnote !== undefined) {
            nodes.push({ t: "footnote", id: g.footnote });
        } else if (g.href !== undefined) {
            nodes.push({
                t: "link",
                href: g.href,
                title: g.linkTitle || "",
                c: parseInline(g.label || g.href)
            });
        } else if (g.autolink !== undefined) {
            nodes.push({
                t: "link",
                href: g.autolink,
                title: "",
                c: [{ t: "text", v: g.autolink }]
            });
        } else if (g.strong !== undefined) {
            nodes.push({ t: "strong", c: parseInline(g.strong) });
        } else if (g.del !== undefined) {
            nodes.push({ t: "del", c: parseInline(g.del) });
        } else if (g.mark !== undefined) {
            nodes.push({ t: "mark", c: parseInline(g.mark) });
        } else if (g.emStar !== undefined) {
            nodes.push({ t: "em", c: parseInline(g.emStar) });
        } else if (g.emUnderscore !== undefined) {
            nodes.push({ t: "em", c: parseInline(g.emUnderscore) });
        } else if (g.br !== undefined) {
            nodes.push({ t: "br" });
        } else if (g.url !== undefined) {
            nodes.push({
                t: "link",
                href: g.url,
                title: "",
                c: [{ t: "text", v: g.url }]
            });
        }
    }

    if (last < text.length) {
        nodes.push({ t: "text", v: text.slice(last) });
    }

    return nodes;
}


/* ------------------------------------------------------------------ *
 * HTML rendering
 * ------------------------------------------------------------------ */

function renderHtml(doc, target) {
    const ctx = { target, footnoteNumbers: doc.footnoteNumbers };
    const parts = doc.blocks.map(block => htmlBlock(block, ctx));

    if (doc.notes.length > 0) {
        parts.push("<hr />");
        parts.push(
            "<ol>" +
            doc.notes
                .map(note =>
                    "<li>" +
                    parseBlocks(note.lines)
                        .map(block => htmlBlock(block, ctx))
                        .join("") +
                    "</li>"
                )
                .join("") +
            "</ol>"
        );
    }

    return parts.join("\n");
}


function htmlBlock(block, ctx) {
    switch (block.type) {
        case "heading":
            return (
                `<h${block.level}>` +
                htmlInline(parseInline(block.text), ctx) +
                `</h${block.level}>`
            );

        case "para":
            return `<p>${htmlInline(parseInline(block.text), ctx)}</p>`;

        case "hr":
            return "<hr />";

        case "code":
            return htmlCode(block, ctx);

        case "list":
            return htmlList(block, ctx);

        case "quote":
            return htmlQuote(block, ctx);

        case "table":
            return htmlTable(block, ctx);

        default:
            return "";
    }
}


function htmlCode(block, ctx) {
    if (ctx.target === "html-macro") {
        const language = confluenceLanguage(block.lang);

        return (
            '<ac:structured-macro ac:name="code" ac:schema-version="1">' +
            (language
                ? '<ac:parameter ac:name="language">' +
                  escapeHtml(language) +
                  "</ac:parameter>"
                : "") +
            "<ac:plain-text-body>" +
            cdata(block.code) +
            "</ac:plain-text-body>" +
            "</ac:structured-macro>"
        );
    }

    const languageClass = block.lang
        ? ` class="language-${escapeHtml(block.lang)}"`
        : "";

    return (
        `<pre><code${languageClass}>` +
        escapeHtml(block.code) +
        "</code></pre>"
    );
}


function htmlList(block, ctx) {
    const allTasks =
        block.items.length > 0 &&
        block.items.every(item => item.checked !== null);

    if (ctx.target === "html-macro" && allTasks) {
        return (
            "<ac:task-list>" +
            block.items
                .map(item =>
                    "<ac:task>" +
                    "<ac:task-status>" +
                    (item.checked ? "complete" : "incomplete") +
                    "</ac:task-status>" +
                    "<ac:task-body>" +
                    htmlItemBody(item, ctx) +
                    "</ac:task-body>" +
                    "</ac:task>"
                )
                .join("") +
            "</ac:task-list>"
        );
    }

    const tag = block.ordered ? "ol" : "ul";
    const start =
        block.ordered && block.start > 1 ? ` start="${block.start}"` : "";

    return (
        `<${tag}${start}>` +
        block.items
            .map(item => {
                const box =
                    item.checked === null
                        ? ""
                        : item.checked
                        ? "☑ "
                        : "☐ ";

                return `<li>${box}${htmlItemBody(item, ctx)}</li>`;
            })
            .join("") +
        `</${tag}>`
    );
}


/*
 * The first paragraph of a list item is rendered without a <p> wrapper so
 * that a nested list follows the text directly, which is what the editor
 * expects.
 */
function htmlItemBody(item, ctx) {
    return item.blocks
        .map((block, index) =>
            index === 0 && block.type === "para"
                ? htmlInline(parseInline(block.text), ctx)
                : htmlBlock(block, ctx)
        )
        .join("");
}


function htmlQuote(block, ctx) {
    const macro = block.callout
        ? CALLOUT_MACRO[block.callout.kind]
        : undefined;

    const body = block.blocks
        .map(inner => htmlBlock(inner, ctx))
        .join("");

    if (ctx.target === "html-macro" && macro) {
        const title = block.callout.title;

        return (
            `<ac:structured-macro ac:name="${macro}" ac:schema-version="1">` +
            (title
                ? '<ac:parameter ac:name="title">' +
                  escapeHtml(title) +
                  "</ac:parameter>"
                : "") +
            `<ac:rich-text-body>${body}</ac:rich-text-body>` +
            "</ac:structured-macro>"
        );
    }

    const heading =
        block.callout && block.callout.title
            ? `<p><strong>${escapeHtml(block.callout.title)}</strong></p>`
            : block.callout
            ? `<p><strong>${escapeHtml(calloutLabel(block.callout.kind))}</strong></p>`
            : "";

    return `<blockquote>${heading}${body}</blockquote>`;
}


function htmlTable(block, ctx) {
    const cell = (tag, text, align) => {
        const style = align ? ` style="text-align: ${align};"` : "";

        return `<${tag}${style}>${htmlInline(parseInline(text), ctx)}</${tag}>`;
    };

    return (
        "<table><thead><tr>" +
        block.header
            .map((text, c) => cell("th", text, block.align[c]))
            .join("") +
        "</tr></thead><tbody>" +
        block.rows
            .map(row =>
                "<tr>" +
                row.map((text, c) => cell("td", text, block.align[c])).join("") +
                "</tr>"
            )
            .join("") +
        "</tbody></table>"
    );
}


function htmlInline(nodes, ctx) {
    return nodes.map(node => htmlNode(node, ctx)).join("");
}


function htmlNode(node, ctx) {
    switch (node.t) {
        case "text":
            return escapeHtml(node.v);

        case "code":
            return `<code>${escapeHtml(node.v)}</code>`;

        case "strong":
            return `<strong>${htmlInline(node.c, ctx)}</strong>`;

        case "em":
            return `<em>${htmlInline(node.c, ctx)}</em>`;

        case "del":
            return `<del>${htmlInline(node.c, ctx)}</del>`;

        case "mark":
            return (
                '<span style="background-color: #FFF59D;">' +
                htmlInline(node.c, ctx) +
                "</span>"
            );

        case "link": {
            const title = node.title
                ? ` title="${escapeHtml(node.title)}"`
                : "";

            return (
                `<a href="${escapeHtml(node.href)}"${title}>` +
                htmlInline(node.c, ctx) +
                "</a>"
            );
        }

        case "img": {
            const title = node.title
                ? ` title="${escapeHtml(node.title)}"`
                : "";

            return (
                `<img src="${escapeHtml(node.src)}"` +
                ` alt="${escapeHtml(node.alt)}"${title} />`
            );
        }

        /*
         * Obsidian embeds point at local vault files, which Confluence
         * cannot resolve. The marker is kept verbatim so it is obvious that
         * an attachment still has to be added by hand.
         */
        case "embed":
            return escapeHtml(`![[${node.v}]]`);

        case "wikilink":
            return escapeHtml(node.alias || node.target);

        case "footnote": {
            const number = ctx.footnoteNumbers.get(node.id);

            return number === undefined
                ? escapeHtml(`[^${node.id}]`)
                : `<sup>${number}</sup>`;
        }

        case "br":
            return "<br />";

        default:
            return "";
    }
}


/* ------------------------------------------------------------------ *
 * Confluence wiki markup rendering
 * ------------------------------------------------------------------ */

function renderWiki(doc) {
    const ctx = { footnoteNumbers: doc.footnoteNumbers };
    const parts = doc.blocks
        .map(block => wikiBlock(block, ctx))
        .filter(part => part !== "");

    if (doc.notes.length > 0) {
        parts.push("----");
        parts.push(
            doc.notes
                .map(note =>
                    "# " +
                    parseBlocks(note.lines)
                        .map(block => wikiBlock(block, ctx))
                        .join(" ")
                        .replace(/\n+/g, " ")
                )
                .join("\n")
        );
    }

    return parts.join("\n\n") + "\n";
}


function wikiBlock(block, ctx) {
    switch (block.type) {
        case "heading":
            return `h${block.level}. ${wikiInline(parseInline(block.text), ctx)}`;

        case "para":
            return wikiInline(parseInline(block.text), ctx);

        case "hr":
            return "----";

        case "code":
            return block.lang
                ? `{code:language=${confluenceLanguage(block.lang)}}\n` +
                  `${block.code}\n{code}`
                : `{noformat}\n${block.code}\n{noformat}`;

        case "list": {
            const out = [];

            wikiList(block, "", out, ctx);

            return out.join("\n");
        }

        case "quote":
            return wikiQuote(block, ctx);

        case "table":
            return wikiTable(block, ctx);

        default:
            return "";
    }
}


/*
 * Wiki lists express depth by repeating the marker, so nesting is a string
 * prefix rather than an indent.
 */
function wikiList(block, prefix, out, ctx) {
    const marker = prefix + (block.ordered ? "#" : "*");

    for (const item of block.items) {
        const box =
            item.checked === null
                ? ""
                : item.checked
                ? "☑ "
                : "☐ ";

        const [first, ...rest] = item.blocks;
        const inlineFirst = first && first.type === "para";
        const text = inlineFirst
            ? wikiInline(parseInline(first.text), ctx).replace(/\n/g, " ")
            : "";

        out.push(`${marker} ${box}${text}`.trimEnd());

        for (const inner of inlineFirst ? rest : item.blocks) {
            if (inner.type === "list") {
                wikiList(inner, marker, out, ctx);
                continue;
            }

            /*
             * Wiki markup has no way to indent a block inside a list item,
             * so anything else is emitted at the top level.
             */
            out.push(wikiBlock(inner, ctx));
        }
    }
}


function wikiQuote(block, ctx) {
    const macro = block.callout
        ? CALLOUT_MACRO[block.callout.kind]
        : undefined;

    const body = block.blocks
        .map(inner => wikiBlock(inner, ctx))
        .filter(part => part !== "")
        .join("\n\n");

    if (macro) {
        const title = block.callout.title || calloutLabel(block.callout.kind);

        return `{${macro}:title=${title}}\n${body}\n{${macro}}`;
    }

    return `{quote}\n${body}\n{quote}`;
}


function wikiTable(block, ctx) {
    const cell = text =>
        wikiInline(parseInline(text), ctx)
            .replace(/\|/g, "\\|")
            .replace(/\n/g, " ");

    const rows = [
        "||" + block.header.map(cell).join("||") + "||"
    ];

    for (const row of block.rows) {
        rows.push("|" + row.map(text => cell(text) || " ").join("|") + "|");
    }

    return rows.join("\n");
}


function wikiInline(nodes, ctx) {
    return nodes.map(node => wikiNode(node, ctx)).join("");
}


function wikiNode(node, ctx) {
    switch (node.t) {
        case "text":
            return escapeWiki(node.v);

        case "code":
            return `{{${node.v}}}`;

        case "strong":
            return `*${wikiInline(node.c, ctx)}*`;

        case "em":
            return `_${wikiInline(node.c, ctx)}_`;

        case "del":
            return `-${wikiInline(node.c, ctx)}-`;

        /*
         * Wiki markup has no highlight, so the text is kept unstyled.
         */
        case "mark":
            return wikiInline(node.c, ctx);

        case "link": {
            const label = wikiInline(node.c, ctx);

            return label === escapeWiki(node.href)
                ? `[${node.href}]`
                : `[${label}|${node.href}]`;
        }

        case "img":
            return `!${node.src}!`;

        /*
         * An Obsidian embed target is a bare filename, which lines up with
         * Confluence attachment syntax once the file is attached.
         */
        case "embed":
            return `!${node.v}!`;

        case "wikilink":
            return node.alias
                ? `[${escapeWiki(node.alias)}|${node.target}]`
                : `[${node.target}]`;

        case "footnote": {
            const number = ctx.footnoteNumbers.get(node.id);

            return number === undefined
                ? escapeWiki(`[^${node.id}]`)
                : `^${number}^`;
        }

        case "br":
            return "\n";

        default:
            return "";
    }
}


/* ------------------------------------------------------------------ *
 * Shared tables
 * ------------------------------------------------------------------ */

/*
 * Obsidian callout type → Confluence macro name. Confluence only ships
 * four coloured panels, so several callout types collapse onto each one.
 * A null value falls back to a plain quote.
 */
const CALLOUT_MACRO = {
    abstract: "info",
    example: "info",
    info: "info",
    note: "info",
    summary: "info",
    tldr: "info",
    todo: "info",

    check: "tip",
    done: "tip",
    hint: "tip",
    important: "tip",
    success: "tip",
    tip: "tip",

    attention: "note",
    caution: "note",
    faq: "note",
    help: "note",
    question: "note",
    warning: "note",

    bug: "warning",
    danger: "warning",
    error: "warning",
    fail: "warning",
    failure: "warning",
    missing: "warning",

    cite: null,
    quote: null
};


function calloutLabel(kind) {
    return kind.charAt(0).toUpperCase() + kind.slice(1);
}


/*
 * Markdown fence language → canonical name, used for the language-* class.
 */
const LANGUAGE_ALIASES = {
    "c++": "cpp",
    "c#": "csharp",
    cc: "cpp",
    cs: "csharp",
    console: "bash",
    dockerfile: "bash",
    golang: "go",
    htm: "html",
    js: "javascript",
    jsx: "javascript",
    ksh: "bash",
    md: "markdown",
    objc: "objectivec",
    "objective-c": "objectivec",
    plaintext: "text",
    ps: "powershell",
    ps1: "powershell",
    py: "python",
    rb: "ruby",
    rs: "rust",
    sh: "bash",
    shell: "bash",
    ts: "typescript",
    tsx: "typescript",
    txt: "text",
    vb: "vb",
    yml: "yaml",
    zsh: "bash"
};


/*
 * Canonical name → the token the Confluence Code Block macro expects.
 * Anything not listed falls back to "text", which renders unhighlighted
 * rather than failing the macro. Adjust this table if your instance ships
 * a different highlighter build.
 */
const CONFLUENCE_LANGUAGES = {
    actionscript: "actionscript3",
    applescript: "applescript",
    bash: "bash",
    coldfusion: "coldfusion",
    cpp: "cpp",
    csharp: "csharp",
    css: "css",
    delphi: "delphi",
    diff: "diff",
    erlang: "erl",
    go: "go",
    groovy: "groovy",
    html: "xml",
    java: "java",
    javascript: "js",
    json: "json",
    objectivec: "objectivec",
    perl: "perl",
    php: "php",
    powershell: "powershell",
    python: "py",
    ruby: "ruby",
    rust: "text",
    sass: "sass",
    scala: "scala",
    scss: "sass",
    sql: "sql",
    swift: "swift",
    text: "text",
    typescript: "js",
    vb: "vb",
    xml: "xml",
    yaml: "yml"
};


function normalizeLanguage(language) {
    const key = String(language || "").toLowerCase();

    return LANGUAGE_ALIASES[key] || key;
}


function confluenceLanguage(language) {
    if (!language) {
        return "";
    }

    return CONFLUENCE_LANGUAGES[language] || "text";
}


function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}


/*
 * Braces and brackets start wiki macros and links, so literal ones have to
 * be escaped or the paste will silently lose text.
 */
function escapeWiki(value) {
    return String(value).replace(/([{}\[\]])/g, "\\$1");
}


/*
 * CDATA cannot contain "]]>", so a run is split across two sections.
 */
function cdata(value) {
    return (
        "<![CDATA[" +
        String(value).split("]]>").join("]]]]><![CDATA[>") +
        "]]>"
    );
}
