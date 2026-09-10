/*
 * Runs in the page's own JavaScript context (world: "MAIN"), which is the
 * only way to reach Confluence's `tinymce` global — content scripts live in
 * an isolated world and cannot see it.
 *
 * Insertion has to go through TinyMCE's own command rather than writing to
 * the DOM directly. TinyMCE tracks dirty state and undo history internally,
 * and content inserted behind its back can be dropped when the page is saved.
 *
 * content.js talks to this over DOM events, with JSON strings rather than
 * objects as the payload: object payloads do not reliably survive the
 * isolated → main world boundary in Firefox.
 */
(() => {
    "use strict";

    const REQUEST = "mdconf-insert";
    const RESPONSE = "mdconf-inserted";

    document.addEventListener(REQUEST, event => {
        let id = null;

        try {
            const request = JSON.parse(event.detail);

            id = request.id;

            const editor = window.tinymce && window.tinymce.activeEditor;

            if (!editor || editor.removed) {
                respond(id, false, "no active TinyMCE editor");
                return;
            }

            editor.execCommand("mceInsertContent", false, request.html);

            respond(id, true, null);
        } catch (error) {
            /*
             * JSON.parse on a malformed request, or a throw from inside
             * TinyMCE's own insertion pipeline.
             */
            respond(id, false, String((error && error.message) || error));
        }
    });

    function respond(id, ok, error) {
        document.dispatchEvent(
            new CustomEvent(RESPONSE, {
                detail: JSON.stringify({ id, ok, error })
            })
        );
    }
})();
