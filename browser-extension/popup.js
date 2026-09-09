import { convert, TARGETS } from "./markdown.js";

const STORAGE_KEY = "markdown-to-confluence.target";

const HINTS = {
    "html-pre":
        "Paste straight into the Confluence editor. Code blocks arrive as " +
        "preformatted text; highlighting depends on the instance.",
    "html-macro":
        "Paste straight into the Confluence editor. Code blocks, callouts " +
        "and tasks are sent as macros, which some paste filters strip.",
    wiki:
        "Paste into Insert → Markup with markup type “Confluence Wiki”. " +
        "Most reliable route to real Code Block macros."
};

const el = {
    form: document.getElementById("form"),
    target: document.getElementById("target"),
    hint: document.getElementById("hint"),
    input: document.getElementById("input"),
    counter: document.getElementById("counter"),
    copy: document.getElementById("copy"),
    clear: document.getElementById("clear"),
    status: document.getElementById("status"),
    preview: document.getElementById("preview")
};

let converted = null;

init();


function init() {
    el.target.value = loadTarget();

    el.target.addEventListener("change", () => {
        saveTarget(el.target.value);
        refresh();
    });

    el.input.addEventListener("input", () => {
        setStatus("");
        refresh();
    });

    el.clear.addEventListener("click", () => {
        el.input.value = "";
        setStatus("");
        refresh();
        el.input.focus();
    });

    /*
     * copyToClipboard() and prefillFromClipboard() report their own
     * failures through setStatus(), so the promises are deliberately
     * discarded rather than awaited from handlers.
     */
    el.form.addEventListener("submit", event => {
        event.preventDefault();
        void copyToClipboard();
    });

    /*
     * Ctrl/Cmd+Enter converts without leaving the textarea.
     */
    document.addEventListener("keydown", event => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void copyToClipboard();
        }
    });

    refresh();
    el.input.focus();
    void prefillFromClipboard();
}


/*
 * The usual flow is "copy in Obsidian, then open this popup", so the
 * clipboard is read once on open as a convenience. Nothing is written back
 * until the user asks for it.
 */
async function prefillFromClipboard() {
    if (el.input.value.trim()) {
        return;
    }

    try {
        const text = await navigator.clipboard.readText();

        if (!text.trim()) {
            return;
        }

        el.input.value = text;
        el.input.select();
        refresh();
        setStatus("Loaded from clipboard.");
    } catch {
        /*
         * No clipboard read permission, or the clipboard holds something
         * that is not text. Manual paste still works.
         */
    }
}


function refresh() {
    const markdown = el.input.value;
    const target = el.target.value;

    el.hint.textContent = HINTS[target] || "";
    el.counter.textContent = markdown
        ? `${markdown.length.toLocaleString()} chars`
        : "";

    if (!markdown.trim()) {
        converted = null;
        el.copy.disabled = true;
        el.preview.textContent = "";
        return;
    }

    try {
        converted = convert(markdown, { target });
        el.copy.disabled = false;
        el.preview.textContent = converted.html ?? converted.plain;
    } catch (error) {
        converted = null;
        el.copy.disabled = true;
        el.preview.textContent = String(error);
        setStatus("Conversion failed — see output below.", "error");
    }
}


async function copyToClipboard() {
    if (!converted) {
        return;
    }

    try {
        await writeClipboard(converted);

        setStatus(
            converted.html
                ? "Copied as rich HTML. Paste into the editor."
                : "Copied as wiki markup. Paste into Insert → Markup.",
            "ok"
        );
    } catch (error) {
        setStatus(`Could not write to the clipboard: ${error.message}`, "error");
    }
}


async function writeClipboard({ html, plain }) {
    if (!html) {
        await navigator.clipboard.writeText(plain);
        return;
    }

    if (navigator.clipboard?.write && typeof ClipboardItem === "function") {
        try {
            await navigator.clipboard.write([
                new ClipboardItem({
                    "text/html": new Blob([html], { type: "text/html" }),
                    "text/plain": new Blob([plain], { type: "text/plain" })
                })
            ]);

            return;
        } catch {
            /*
             * Older builds reject multi-flavour writes; fall through to the
             * execCommand path, which is still the only way to put two
             * representations on the clipboard everywhere.
             */
        }
    }

    copyViaExecCommand(html, plain);
}


function copyViaExecCommand(html, plain) {
    const onCopy = event => {
        event.clipboardData.setData("text/html", html);
        event.clipboardData.setData("text/plain", plain);
        event.preventDefault();
    };

    document.addEventListener("copy", onCopy, { once: true });

    try {
        /*
         * execCommand("copy") needs a live selection, so the textarea is
         * selected and then restored.
         */
        const { selectionStart, selectionEnd } = el.input;

        el.input.focus();
        el.input.select();

        /*
         * execCommand is deprecated but not removed, and it is still the
         * only way to put two representations on the clipboard at once on
         * Firefox before 127, where ClipboardItem is unavailable.
         */
        // noinspection JSDeprecatedSymbols
        if (!document.execCommand("copy")) {
            throw new Error("the browser refused the copy command");
        }

        el.input.setSelectionRange(selectionStart, selectionEnd);
    } finally {
        document.removeEventListener("copy", onCopy);
    }
}


function setStatus(text, kind) {
    el.status.textContent = text;

    if (kind) {
        el.status.dataset.kind = kind;
    } else {
        delete el.status.dataset.kind;
    }
}


function loadTarget() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);

        if (TARGETS.includes(stored)) {
            return stored;
        }
    } catch {
        /* Storage disabled; fall back to the default. */
    }

    return "html-pre";
}


function saveTarget(target) {
    try {
        localStorage.setItem(STORAGE_KEY, target);
    } catch {
        /* Not worth surfacing: the choice just will not persist. */
    }
}
