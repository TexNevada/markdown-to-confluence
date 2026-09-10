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
    const STRATEGY_KEY = `strategy:${location.origin}`;

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
     * Which endpoint an on-premise instance exposes varies by version, so
     * both known candidates are tried and the one that worked is remembered
     * per origin.
     */
    const STRATEGIES = [
        {
            id: "wikixhtmlconverter",

            /*
             * The endpoint Confluence's own Insert → Markup dialog posts to.
             * One round trip, and it returns HTML rather than JSON.
             *
             * The body shape is only partly documented: `contextType` has no
             * published set of values, and `entityId` rejects 0 on pages
             * that have never been saved. Both are dropped in turn.
             */
            async run(wiki, context) {
                const base = {
                    wiki,
                    spaceKey: context.spaceKey,
                    suppressFirstParagraph: false
                };

                const variants = [
                    { ...base, entityId: context.pageId, contextType: "PAGE" },
                    { ...base, entityId: context.pageId },
                    base
                ];

                let failure;

                for (const body of variants) {
                    const response = await post(
                        `${context.base}/rest/tinymce/1/wikixhtmlconverter`,
                        body
                    );

                    if (response.ok) {
                        return await response.text();
                    }

                    failure = await toError(response);

                    if (response.status !== 400) {
                        break;
                    }
                }

                throw failure;
            }
        },
        {
            id: "contentbody",

            /*
             * The public REST API. Two steps, because wiki → editor is not a
             * supported pair; only wiki → storage and storage → editor are.
             */
            async run(wiki, context) {
                const storage = await postJson(
                    `${context.base}/rest/api/contentbody/convert/storage`,
                    { value: wiki, representation: "wiki" }
                );

                const editor = await postJson(
                    `${context.base}/rest/api/contentbody/convert/editor`,
                    {
                        value: storage.value,
                        representation: "storage",
                        ...(context.pageId
                            ? { content: { id: String(context.pageId) } }
                            : {})
                    }
                );

                return editor.value;
            }
        }
    ];


    async function convertOnServer(wiki) {
        const context = readContext();
        const preferred = await readStrategy();
        const ordered = [...STRATEGIES].sort(
            (a, b) => (b.id === preferred) - (a.id === preferred)
        );

        let failure;

        for (const strategy of ordered) {
            try {
                const html = await strategy.run(wiki, context);

                await writeStrategy(strategy.id);

                return html;
            } catch (error) {
                if (error.fatal) {
                    throw error;
                }

                failure = error;
            }
        }

        throw failure || new Error("no conversion endpoint responded");
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


    function post(url, body) {
        return fetch(url, {
            method: "POST",
            credentials: "same-origin",
            headers: {
                "Content-Type": "application/json",
                "X-Atlassian-Token": "no-check"
            },
            body: JSON.stringify(body)
        });
    }


    async function postJson(url, body) {
        const response = await post(url, body);

        if (!response.ok) {
            throw await toError(response);
        }

        return await response.json();
    }


    async function toError(response) {
        const detail = (await response.text().catch(() => "")).slice(0, 200);
        const error = new Error(
            `HTTP ${response.status}${detail ? ` — ${detail}` : ""}`
        );

        /*
         * A dead session will fail identically on every endpoint, so there
         * is no point working through the rest of the list.
         */
        error.fatal = response.status === 401;

        return error;
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
     * The M↓ toggle
     * -------------------------------------------------------------- */

    /*
     * Lives in a shadow root so Confluence's stylesheets cannot reach it and
     * its own styles cannot leak out, and in the top document rather than
     * the editor iframe — anything placed in the iframe would become part of
     * the page being edited.
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
        }

        button {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 40px;
            height: 40px;
            padding: 0;
            border: 1px solid #c1c7d0;
            border-radius: 50%;
            background: #ffffff;
            color: #6b778c;
            font-size: 15px;
            font-weight: 600;
            line-height: 1;
            cursor: pointer;
            box-shadow: 0 1px 4px rgba(9, 30, 66, 0.25);
            transition: background 120ms, color 120ms, border-color 120ms;
        }

        button[aria-pressed="true"] {
            border-color: transparent;
            background: #0052cc;
            color: #ffffff;
        }

        button:focus-visible {
            outline: 2px solid #0052cc;
            outline-offset: 2px;
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

        style.textContent = TOGGLE_STYLES;
        wrap.className = "wrap";
        toast.className = "toast";
        button.type = "button";
        button.textContent = "M↓";

        button.addEventListener("click", () => {
            void setEnabled(!enabled);
        });

        wrap.append(toast, button);
        root.append(style, wrap);
        document.body.append(host);

        toggle = { host, button, toast, timer: 0 };

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

        toggle.button.setAttribute("aria-pressed", String(enabled));
        toggle.button.title = enabled
            ? "Markdown conversion on — pasted Markdown becomes Confluence markup"
            : "Markdown conversion off — pasting behaves normally";
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


    async function readStrategy() {
        const stored = await chrome.storage.local.get(STRATEGY_KEY);

        return stored[STRATEGY_KEY] || null;
    }


    async function writeStrategy(id) {
        await chrome.storage.local.set({ [STRATEGY_KEY]: id });
    }


    function message(error) {
        return String((error && error.message) || error);
    }
})();
