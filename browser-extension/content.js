/*
 * Markdown → Confluence, paste side.
 *
 * Runs only on origins the user has explicitly enabled by clicking the
 * toolbar icon, and only in the top frame. The TinyMCE editor lives in a
 * same-origin iframe, so rather than injecting into every frame this script
 * reaches into `iframe.contentDocument` and attaches there — one frame, no
 * cross-frame messaging, no about:blank matching.
 *
 * On paste it converts the clipboard's Markdown to Confluence wiki markup,
 * hands that to Confluence's own server-side converter, and inserts the HTML
 * that comes back. That last step is the whole point: hand-built HTML gets
 * mangled by the editor's paste filter, but anything Confluence converted
 * itself is accepted verbatim.
 */
(() => {
    "use strict";

    /*
     * The background worker injects this script directly when a site is
     * enabled, on top of registering it for later navigations, so the same
     * page can receive it twice — which would leave two paste listeners
     * fighting over one event.
     */
    if (window.__markdownToConfluenceLoaded) {
        return;
    }

    window.__markdownToConfluenceLoaded = true;

    const EDITOR_IFRAME_ID = "wysiwygTextarea_ifr";
    const TOGGLE_HOST_ID = "mdconf-toggle-host";
    const INSERT_REQUEST = "mdconf-insert";
    const INSERT_RESPONSE = "mdconf-inserted";
    const BRIDGE_TIMEOUT_MS = 2000;

    const TOGGLE_KEY = `toggle:${location.origin}`;

    const darkPreferred = matchMedia("(prefers-color-scheme: dark)");

    let editorDocument = null;
    let toggle = null;
    let enabled = true;
    let pasteToken = 0;
    let bridgeRequestId = 0;

    void init();


    async function init() {
        /*
         * This script only ever runs on origins the user enabled, so its
         * mere presence is what the badge reflects.
         */
        Promise.resolve(chrome.runtime.sendMessage({ type: "enabled" }))
            .catch(() => {});

        enabled = await readToggle();

        watchForEditor();
        watchToggleChanges();
        watchThemeChanges();
    }


    /* -------------------------------------------------------------- *
     * Finding the editor
     * -------------------------------------------------------------- */

    /*
     * Confluence builds the editor well after page load and tears it down
     * when editing ends, so this has to be observed rather than checked once.
     */
    function watchForEditor() {
        let scheduled = false;

        const schedule = () => {
            if (scheduled) {
                return;
            }

            scheduled = true;

            setTimeout(() => {
                scheduled = false;
                sync();
            }, 100);
        };

        new MutationObserver(schedule).observe(document.documentElement, {
            childList: true,
            subtree: true
        });

        sync();
    }


    function sync() {
        const found = findEditorDocument();

        if (found === editorDocument) {
            return;
        }

        detach();

        if (found) {
            attach(found);
        }
    }


    /*
     * Two signals, both required: the iframe is Confluence's page editor
     * frame, and its body is the TinyMCE editable root. Together these
     * exclude the search box, the page title and every other input on the
     * domain, all of which live in the top document.
     */
    function findEditorDocument() {
        const frame = document.getElementById(EDITOR_IFRAME_ID);

        if (!frame) {
            return null;
        }

        let doc;

        try {
            doc = frame.contentDocument;
        } catch {
            /*
             * Cross-origin editor frame. Undocumented but conceivable behind
             * a reverse proxy, and there is nothing useful to do about it.
             */
            return null;
        }

        if (!doc || !doc.body) {
            return null;
        }

        return doc.body.id === "tinymce" && doc.body.isContentEditable
            ? doc
            : null;
    }


    function attach(doc) {
        editorDocument = doc;

        doc.addEventListener("paste", onPaste, true);
        showToggle();
    }


    function detach() {
        if (editorDocument) {
            editorDocument.removeEventListener("paste", onPaste, true);
            editorDocument = null;
        }

        hideToggle();
    }


    /* -------------------------------------------------------------- *
     * Paste
     * -------------------------------------------------------------- */

    function onPaste(event) {
        if (!enabled || !event.clipboardData) {
            return;
        }

        const markdown = event.clipboardData.getData("text/plain");

        if (!markdown || !markdown.trim()) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        void handlePaste(markdown, ++pasteToken);
    }


    async function handlePaste(markdown, token) {
        try {
            /*
             * markdown.js is registered ahead of this script, so the global
             * is already in the isolated world.
             */
            const { toWikiMarkup } = globalThis.MarkdownToConfluence;
            const html = await convertOnServer(toWikiMarkup(markdown));

            /*
             * A second paste landed while this one was in flight; dropping
             * the stale result keeps them from arriving out of order.
             */
            if (token !== pasteToken) {
                return;
            }

            await insert(html);
        } catch (error) {
            if (token !== pasteToken) {
                return;
            }

            /*
             * The paste was already cancelled, so something has to be put
             * back — losing the user's clipboard is worse than losing the
             * formatting.
             */
            insertPlainText(markdown);
            notify(`Pasted unconverted: ${message(error)}`, true);
        }
    }


    /* -------------------------------------------------------------- *
     * Server-side conversion
     * -------------------------------------------------------------- */

    /*
     * Confluence's public REST API. Two round trips, because wiki → editor
     * is not a supported conversion pair — only wiki → storage and
     * storage → editor are.
     *
     * An earlier version also tried /rest/tinymce/1/wikixhtmlconverter, the
     * endpoint Confluence's own Insert → Markup dialog uses, since it does
     * the job in one request. It fails on this instance, and parts of its
     * request body are undocumented, so it was dropped rather than carried
     * as a guess. This path is the documented interface and demonstrably
     * works.
     */
    async function convertOnServer(wiki) {
        const context = readContext();

        const storage = await postJson(
            `${context.base}/rest/api/contentbody/convert/storage`,
            { value: wiki, representation: "wiki" }
        );

        const editor = await postJson(
            `${context.base}/rest/api/contentbody/convert/editor`,
            {
                value: storage.value,
                representation: "storage",

                /*
                 * Gives macros and links the page context they need to
                 * render. Omitted on a page that has never been saved,
                 * which has no id yet.
                 */
                ...(context.pageId
                    ? { content: { id: String(context.pageId) } }
                    : {})
            }
        );

        return editor.value;
    }


    /*
     * Everything the endpoints need about the current page. Confluence
     * publishes it as ajs-* meta tags; the page id also appears in the
     * editor URL, which covers instances that omit the tag.
     */
    function readContext() {
        const meta = name =>
            document.querySelector(`meta[name="${name}"]`)?.content || "";

        const pageId =
            meta("ajs-page-id") ||
            new URLSearchParams(location.search).get("pageId") ||
            "0";

        return {
            base: location.origin + meta("ajs-context-path"),
            pageId: Number(pageId) || 0,
            spaceKey: meta("ajs-space-key")
        };
    }


    /*
     * Same-origin, so the session cookie rides along automatically. The
     * XSRF header is what Confluence's own callers send.
     */
    async function postJson(url, body) {
        const response = await fetch(url, {
            method: "POST",
            credentials: "same-origin",
            headers: {
                "Content-Type": "application/json",
                "X-Atlassian-Token": "no-check"
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            throw await toError(response);
        }

        return await response.json();
    }


    async function toError(response) {
        /*
         * These return a login page, so the body is noise rather than a
         * useful message.
         */
        if (response.status === 401 || response.status === 403) {
            return new Error(
                "Confluence rejected the request — your session may have expired"
            );
        }

        const detail = (await response.text().catch(() => "")).slice(0, 200);

        return new Error(
            `HTTP ${response.status}${detail ? ` — ${detail}` : ""}`
        );
    }


    /* -------------------------------------------------------------- *
     * Insertion
     * -------------------------------------------------------------- */

    async function insert(html) {
        try {
            await insertViaTinyMce(html);
        } catch {
            /*
             * The bridge needs world: "MAIN" support (Chrome 111+, Firefox
             * 128+). Where that is unavailable, write to the DOM directly
             * and poke TinyMCE so it notices the change.
             */
            insertViaDom(html);
        }
    }


    function insertViaTinyMce(html) {
        return new Promise((resolve, reject) => {
            const id = String(++bridgeRequestId);

            const finish = () => {
                clearTimeout(timer);
                document.removeEventListener(INSERT_RESPONSE, onResponse);
            };

            const onResponse = event => {
                let payload;

                try {
                    payload = JSON.parse(event.detail);
                } catch {
                    return;
                }

                if (payload.id !== id) {
                    return;
                }

                finish();

                if (payload.ok) {
                    resolve();
                } else {
                    reject(new Error(payload.error || "bridge failed"));
                }
            };

            const timer = setTimeout(() => {
                finish();
                reject(new Error("bridge did not respond"));
            }, BRIDGE_TIMEOUT_MS);

            document.addEventListener(INSERT_RESPONSE, onResponse);
            document.dispatchEvent(
                new CustomEvent(INSERT_REQUEST, {
                    detail: JSON.stringify({ id, html })
                })
            );
        });
    }


    function insertViaDom(html) {
        if (!editorDocument) {
            throw new Error("the editor closed");
        }

        editorDocument.execCommand("insertHTML", false, html);
        editorDocument.body.dispatchEvent(
            new InputEvent("input", { bubbles: true })
        );
    }


    function insertPlainText(text) {
        if (!editorDocument) {
            return;
        }

        editorDocument.execCommand("insertText", false, text);
    }


    /* -------------------------------------------------------------- *
     * The Markdown mark toggle
     * -------------------------------------------------------------- */

    /*
     * The official Markdown mark (static/66x40.png), inlined.
     *
     * It is used as a CSS alpha mask rather than an <img>, for two reasons.
     * The artwork is pure black on transparent, so masking it and painting
     * `currentColor` underneath recolours it for free — one asset covers
     * light, dark, on and off. And inlining avoids exposing the file through
     * web_accessible_resources, which an <img src=runtime.getURL(...)> in a
     * page-side shadow root would require.
     */
    const MARK_DATA_URI =
        "data:image/png;base64," +
        "iVBORw0KGgoAAAANSUhEUgAAAEIAAAAoCAQAAADgMuRfAAABZklEQVR4Ae3YtdYT" +
        "URiG0Y1rgzU4De70WDUl1mMVF4HdBU6JT5v273F63N1dPhziulYOkve5gLOTzMRg" +
        "gsNuiATdcNgEmOGhSNhDszkmEpfzRAgrpdhKITwnfEmqhS/1ED1EM4goarNa2yCK" +
        "qr4oqgPEKwtV20KvuocIl4xWvtEuiW4iQkH5CqLbiLBN8baJFIgPMgCZD2kQ4aFp" +
        "YLKHIhUinDL4S6dESkTY96VIgah97MHuIYY5K6p01rDuIZjmoeqXafUjdosG7W4d" +
        "QSbKyqiJGKxP1KnP4HYQ7BRF7aQOgnGuCtW7ahztIQYoFL2JD2iAYJ5XokqvzKNN" +
        "RNFH1lWjaYhgtajSOjpBsMTbLy2hKQQ7RVk76RTB5i9pGkEuisrpGNHGu8BIF8SP" +
        "LhiZBsE094RwzzRSIVjm7ZdWkhLBli/1fnf0EH8n4okQMimWCeE5uUhczuz0f5zB" +
        "BMfcFgm67ZgJfAZJA3GF0B+BSQAAAABJRU5ErkJggg==";


    /*
     * Lives in a shadow root so Confluence's stylesheets cannot reach it and
     * its own styles cannot leak out, and in the top document rather than
     * the editor iframe — anything placed in the iframe would become part of
     * the page being edited.
     *
     * Geometry follows the mark's 1.625 aspect ratio rather than the circle
     * the old text button used.
     */
    const TOGGLE_STYLES = `
        :host {
            all: initial;
            position: fixed;
            right: 16px;
            bottom: 76px;
            z-index: 2147483000;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
                Roboto, Helvetica, Arial, sans-serif;
        }

        .wrap {
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 6px;

            --surface: #ffffff;
            --mark: #6b778c;
            --edge: #c1c7d0;
            --on-surface: #0052cc;
            --on-mark: #ffffff;
        }

        .wrap[data-theme="dark"] {
            --surface: #22272b;
            --mark: #9fadbc;
            --edge: #38414a;
            --on-surface: #4c9aff;
            --on-mark: #1d2125;
        }

        button {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 46px;
            height: 34px;
            padding: 0;
            border: 1px solid var(--edge);
            border-radius: 6px;
            background: var(--surface);
            color: var(--mark);
            cursor: pointer;
            box-shadow: 0 1px 4px rgba(9, 30, 66, 0.25);
            transition: background 120ms, color 120ms, border-color 120ms;
        }

        button[aria-pressed="true"] {
            border-color: transparent;
            background: var(--on-surface);
            color: var(--on-mark);
        }

        button:focus-visible {
            outline: 2px solid var(--on-surface);
            outline-offset: 2px;
        }

        .mark {
            width: 26px;
            height: 16px;
            background-color: currentColor;
            -webkit-mask-image: url("${MARK_DATA_URI}");
            mask-image: url("${MARK_DATA_URI}");
            -webkit-mask-size: contain;
            mask-size: contain;
            -webkit-mask-repeat: no-repeat;
            mask-repeat: no-repeat;
            -webkit-mask-position: center;
            mask-position: center;
        }

        /*
         * Without mask support the mark would be an invisible empty box, so
         * fall back to painting the artwork itself. Black only, but present.
         */
        @supports not ((mask-image: none) or (-webkit-mask-image: none)) {
            .mark {
                background-color: transparent;
                background-image: url("${MARK_DATA_URI}");
                background-size: contain;
                background-repeat: no-repeat;
                background-position: center;
            }
        }

        .toast {
            max-width: 280px;
            padding: 7px 10px;
            border-radius: 4px;
            background: #172b4d;
            color: #ffffff;
            font-size: 12px;
            line-height: 1.4;
            box-shadow: 0 1px 4px rgba(9, 30, 66, 0.25);
        }

        .toast[data-error="true"] {
            background: #ae2a19;
        }

        .toast:empty {
            display: none;
        }
    `;


    function showToggle() {
        if (toggle) {
            return;
        }

        const host = document.createElement("div");

        host.id = TOGGLE_HOST_ID;

        const root = host.attachShadow({ mode: "open" });
        const style = document.createElement("style");
        const wrap = document.createElement("div");
        const toast = document.createElement("div");
        const button = document.createElement("button");
        const mark = document.createElement("span");

        style.textContent = TOGGLE_STYLES;
        wrap.className = "wrap";
        toast.className = "toast";
        button.type = "button";
        mark.className = "mark";

        button.addEventListener("click", () => {
            void setEnabled(!enabled);
        });

        button.append(mark);
        wrap.append(toast, button);
        root.append(style, wrap);
        document.body.append(host);

        toggle = { host, wrap, button, toast, timer: 0 };

        paintToggle();
    }


    function hideToggle() {
        toggle?.host.remove();
        toggle = null;
    }


    function paintToggle() {
        if (!toggle) {
            return;
        }

        toggle.wrap.dataset.theme = resolveTheme();
        toggle.button.setAttribute("aria-pressed", String(enabled));
        toggle.button.setAttribute(
            "aria-label",
            enabled ? "Markdown conversion on" : "Markdown conversion off"
        );
        toggle.button.title = enabled
            ? "Markdown conversion on — pasted Markdown becomes Confluence markup"
            : "Markdown conversion off — pasting behaves normally";
    }


    /* -------------------------------------------------------------- *
     * Light or dark
     * -------------------------------------------------------------- */

    /*
     * Relative luminance below which a background counts as dark. This is
     * the WCAG crossover point where white text becomes more readable than
     * black, not the midpoint — luminance is non-linear, so sRGB mid-grey
     * is only 0.216 and a 0.5 threshold would call most light greys dark.
     */
    const DARK_THRESHOLD = 0.179;

    /*
     * Atlassian's design tokens declare the colour mode on <html>. Those
     * attribute names are unverified for Confluence DC 9 — I could not
     * establish whether DC 9 ships a dark theme at all — so the luminance
     * check below is the load-bearing path. It works whatever mechanism the
     * instance uses, including a custom space colour scheme.
     */
    function resolveTheme() {
        const root = document.documentElement;
        const declared =
            `${root.dataset.colorMode || ""} ${root.dataset.theme || ""}`;

        if (/dark/i.test(declared)) {
            return "dark";
        }

        if (/light/i.test(declared)) {
            return "light";
        }

        const luminance = backgroundLuminance();

        if (luminance !== null) {
            return luminance < DARK_THRESHOLD ? "dark" : "light";
        }

        return darkPreferred.matches ? "dark" : "light";
    }


    /*
     * Walks up from the body for the first background that is actually
     * painted; elements default to transparent, so the nearest opaque
     * ancestor is what the user sees.
     */
    function backgroundLuminance() {
        let node = document.body;

        while (node) {
            const colour = parseColour(
                getComputedStyle(node).backgroundColor
            );

            if (colour) {
                const [r, g, b] = colour.map(channel => {
                    const v = channel / 255;

                    return v <= 0.03928
                        ? v / 12.92
                        : ((v + 0.055) / 1.055) ** 2.4;
                });

                return 0.2126 * r + 0.7152 * g + 0.0722 * b;
            }

            node = node.parentElement;
        }

        return null;
    }


    /*
     * Returns null for anything fully transparent, so the walk continues.
     */
    function parseColour(value) {
        const match = /^rgba?\(([^)]+)\)$/.exec(value || "");

        if (!match) {
            return null;
        }

        const parts = match[1].split(/[,\s/]+/).map(Number);

        if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) {
            return null;
        }

        const alpha = parts.length > 3 ? parts[3] : 1;

        return alpha === 0 ? null : parts.slice(0, 3);
    }


    /*
     * Confluence can switch theme without a reload, so the toggle has to be
     * repainted rather than coloured once at creation.
     */
    function watchThemeChanges() {
        darkPreferred.addEventListener("change", paintToggle);

        new MutationObserver(paintToggle).observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["data-color-mode", "data-theme", "class"]
        });
    }


    function notify(text, isError = false) {
        if (!toggle) {
            return;
        }

        toggle.toast.textContent = text;
        toggle.toast.dataset.error = String(isError);

        clearTimeout(toggle.timer);

        toggle.timer = setTimeout(() => {
            if (toggle) {
                toggle.toast.textContent = "";
            }
        }, isError ? 6000 : 2500);
    }


    /* -------------------------------------------------------------- *
     * Stored state
     * -------------------------------------------------------------- */

    async function readToggle() {
        const stored = await chrome.storage.local.get(TOGGLE_KEY);

        /*
         * On by default: enabling the origin was already a deliberate act,
         * so the toggle is an escape hatch rather than a second setup step.
         */
        return stored[TOGGLE_KEY] !== false;
    }


    async function setEnabled(value) {
        enabled = value;

        paintToggle();
        notify(value ? "Markdown conversion on" : "Markdown conversion off");

        await chrome.storage.local.set({ [TOGGLE_KEY]: value });
    }


    /*
     * Keeps the toggle honest when the same Confluence is open in more than
     * one tab.
     */
    function watchToggleChanges() {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== "local" || !changes[TOGGLE_KEY]) {
                return;
            }

            const value = changes[TOGGLE_KEY].newValue !== false;

            if (value !== enabled) {
                enabled = value;
                paintToggle();
            }
        });
    }


    function message(error) {
        return String((error && error.message) || error);
    }
})();
