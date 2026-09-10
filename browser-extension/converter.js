const { toWikiMarkup } = globalThis.MarkdownToConfluence;

const el = {
    form: document.getElementById("form"),
    input: document.getElementById("input"),
    counter: document.getElementById("counter"),
    copy: document.getElementById("copy"),
    clear: document.getElementById("clear"),
    status: document.getElementById("status"),
    preview: document.getElementById("preview")
};

let wiki = "";

init();


function init() {
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
 * The usual flow is "copy in Obsidian, then open this page", so the
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

    el.counter.textContent = markdown
        ? `${markdown.length.toLocaleString()} chars`
        : "";

    if (!markdown.trim()) {
        wiki = "";
        el.copy.disabled = true;
        el.preview.textContent = "";
        return;
    }

    try {
        wiki = toWikiMarkup(markdown);
        el.copy.disabled = false;
        el.preview.textContent = wiki;
    } catch (error) {
        wiki = "";
        el.copy.disabled = true;
        el.preview.textContent = String(error);
        setStatus("Conversion failed — see the output pane.", "error");
    }
}


async function copyToClipboard() {
    if (!wiki) {
        return;
    }

    try {
        await navigator.clipboard.writeText(wiki);
        setStatus("Copied. Paste into Insert → Markup.", "ok");
    } catch (error) {
        setStatus(`Could not write to the clipboard: ${error.message}`, "error");
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
