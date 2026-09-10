/*
 * Per-origin enablement.
 *
 * The extension ships with no host permissions at all, so it is genuinely
 * inert until asked: clicking the toolbar icon on a Confluence site requests
 * permission for that one origin and registers the content scripts for it.
 * Clicking again hands the permission back.
 *
 * There is no popup — the click is the whole interaction, and the badge
 * reports the state.
 */

const SCRIPT_PREFIX = "mdconf";
const CONVERTER_MENU_ID = "mdconf-open-converter";
const BADGE_TEXT = "M↓";
const BADGE_COLOUR = "#0052cc";


/*
 * Which origins are already granted, cached in memory.
 *
 * This exists because chrome.permissions.request() only works inside the
 * user gesture of the click, and awaiting permissions.contains() first
 * would forfeit that gesture. So the enable/disable decision is made from
 * this set rather than by asking the permissions API at click time.
 *
 * null means the set has not loaded yet — on a cold service worker the
 * click can arrive first. In that case the code takes the request path,
 * which is the safe direction: requesting an already-granted permission
 * resolves true without prompting, whereas guessing the other way would
 * revoke access the user did not ask to lose.
 */
let granted = null;

void loadGranted();


async function loadGranted() {
    const permissions = await chrome.permissions.getAll();

    granted = new Set(permissions.origins || []);
}


chrome.action.onClicked.addListener(tab => {
    const origin = originOf(tab?.url);

    if (!origin) {
        return;
    }

    if (granted?.has(pattern(origin))) {
        void disable(origin, tab.id);
        return;
    }

    chrome.permissions
        .request({ origins: [pattern(origin)] })
        .then(allowed => {
            if (!allowed) {
                return;
            }

            granted?.add(pattern(origin));

            return enable(origin, tab.id);
        })
        .catch(error => {
            console.warn("[markdown-to-confluence] enable failed:", error);
        });
});


async function enable(origin, tabId) {
    await register(origin);

    /*
     * registerContentScripts only affects future navigations, so the tab
     * the user is looking at gets an explicit injection.
     */
    await injectNow(tabId);
    await paintBadge(tabId, true);
}


async function disable(origin, tabId) {
    await unregister(origin);
    await chrome.permissions.remove({ origins: [pattern(origin)] });

    granted?.delete(pattern(origin));

    await paintBadge(tabId, false);
}


async function register(origin) {
    const scripts = [
        {
            id: scriptId(origin, "content"),
            matches: [pattern(origin)],
            js: ["markdown.js", "content.js"],
            runAt: "document_idle",
            persistAcrossSessions: true
        },
        {
            id: scriptId(origin, "bridge"),
            matches: [pattern(origin)],
            js: ["bridge.js"],
            runAt: "document_idle",
            world: "MAIN",
            persistAcrossSessions: true
        }
    ];

    await unregister(origin);

    try {
        await chrome.scripting.registerContentScripts(scripts);
    } catch (error) {
        /*
         * world: "MAIN" needs Chrome 111+ / Firefox 128+. Without it the
         * TinyMCE bridge is unavailable and content.js falls back to
         * writing into the DOM itself, so registering it alone is still
         * worth doing.
         */
        console.warn("[markdown-to-confluence] MAIN world unavailable:", error);
        await chrome.scripting.registerContentScripts([scripts[0]]);
    }
}


async function unregister(origin) {
    const ids = [scriptId(origin, "content"), scriptId(origin, "bridge")];
    const existing = await chrome.scripting.getRegisteredContentScripts();
    const present = existing
        .map(script => script.id)
        .filter(id => ids.includes(id));

    if (present.length > 0) {
        await chrome.scripting.unregisterContentScripts({ ids: present });
    }
}


async function injectNow(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ["bridge.js"],
            world: "MAIN"
        });
    } catch {
        /* No MAIN world; content.js copes without the bridge. */
    }

    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ["markdown.js", "content.js"]
        });
    } catch (error) {
        console.warn("[markdown-to-confluence] could not inject:", error);
    }
}


/*
 * content.js announces itself on load, which is a cheaper way to keep the
 * badge accurate than watching every tab — it only ever runs on origins
 * that are already enabled.
 */
chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type === "enabled" && sender.tab?.id !== undefined) {
        void paintBadge(sender.tab.id, true);
    }

    return false;
});


async function paintBadge(tabId, on) {
    if (tabId === undefined) {
        return;
    }

    try {
        await chrome.action.setBadgeText({ tabId, text: on ? BADGE_TEXT : "" });
        await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOUR });
        await chrome.action.setTitle({
            tabId,
            title: on
                ? "Markdown → Confluence: enabled here (click to disable)"
                : "Markdown → Confluence: click to enable on this site"
        });
    } catch {
        /* Tab closed mid-update. */
    }
}


/* ------------------------------------------------------------------ *
 * The manual converter
 * ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({
            id: CONVERTER_MENU_ID,
            title: "Open Markdown converter…",
            contexts: ["action"]
        });
    });

    void reconcile();
});


chrome.runtime.onStartup.addListener(() => void reconcile());


chrome.contextMenus.onClicked.addListener(info => {
    if (info.menuItemId === CONVERTER_MENU_ID) {
        void chrome.tabs.create({
            url: chrome.runtime.getURL("converter.html")
        });
    }
});


/* ------------------------------------------------------------------ *
 * Keeping registrations and permissions in step
 * ------------------------------------------------------------------ */

chrome.permissions.onRemoved.addListener(permissions => {
    for (const scope of permissions.origins || []) {
        granted?.delete(scope);

        const origin = originOf(scope.replace(/\/\*$/, "/"));

        if (origin) {
            void unregister(origin);
        }
    }
});


chrome.permissions.onAdded.addListener(permissions => {
    for (const scope of permissions.origins || []) {
        granted?.add(scope);
    }
});


/*
 * Permissions can also be revoked from the browser's own extension
 * settings, which leaves registrations behind that can never run.
 */
async function reconcile() {
    const scopes = await loadGranted();
    const registered = await chrome.scripting.getRegisteredContentScripts();

    const stale = registered
        .filter(script => script.id.startsWith(`${SCRIPT_PREFIX}-`))
        .filter(script => !(script.matches || []).some(m => scopes.has(m)))
        .map(script => script.id);

    if (stale.length > 0) {
        await chrome.scripting.unregisterContentScripts({ ids: stale });
    }
}


/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function originOf(url) {
    try {
        const { protocol, origin } = new URL(url);

        return protocol === "http:" || protocol === "https:" ? origin : null;
    } catch {
        return null;
    }
}


function pattern(origin) {
    return `${origin}/*`;
}


/*
 * Script ids allow a narrow character set, so the origin is flattened.
 */
function scriptId(origin, role) {
    return `${SCRIPT_PREFIX}-${origin.replace(/[^a-zA-Z0-9]+/g, "-")}-${role}`;
}
