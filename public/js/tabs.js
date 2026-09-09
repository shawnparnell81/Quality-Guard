/* ============================================================
   In-app workspace tabs.

   Opening a module (CAPA, NCR, 8D, Document Control, ...) adds a
   closable tab to the strip under the menu bar. Several stay open at
   once; switching between them is instant and keeps each screen's
   selected record, because every view is a persistent (hidden) node
   in index.html and show() re-selects the last record on the way in.

   Dashboard is pinned as the first tab and cannot be closed. The open
   set and the active tab survive a page reload (localStorage).

   Transient screens - the record editor, the onboarding wizard - are
   deliberately not tabbed: navigating to one leaves the strip showing
   whichever module tab you came from.
   ============================================================ */

import { show } from "./app.js";
import { navItemLabels } from "./nav.js";
import { el } from "./dom.js";

const STORE_KEY = "qmsg:tabs:v1";
const HOME = "dashboard";

/* Labels for views a menu leaf does not name. */
const EXTRA_LABELS = {
    dashboard: "Dashboard",
    readiness: "Audit Readiness",
    "form-library": "Forms",
    "form-record": "Custom Forms",
    "form-import": "Import Form",
    people: "People & Access",
    workflows: "Roles & Permissions",
    "menu-layout": "Menu Layout"
};

/* Screens that must never get their own tab. */
const NOT_TABBABLE = new Set([
    "record-editor", "onboarding", "onboarding-packet"
]);

let strip = null;
let open = [HOME];     // ordered view names, HOME always first
let active = HOME;

function labelFor(view) {
    return navItemLabels()[view]
        || EXTRA_LABELS[view]
        || view.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function persist() {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify({
            open: open.filter((v) => v !== HOME), active
        }));
    } catch { /* private mode / full - the tabs just will not survive a reload */ }
}

function render() {
    if (!strip) return;

    strip.replaceChildren(...open.map((view) => {
        const tab = el("div", {
            class: "wtab" + (view === active ? " is-active" : ""),
            role: "tab",
            "aria-selected": view === active ? "true" : "false",
            tabindex: "0",
            title: labelFor(view)
        }, [el("span", { class: "wtab-label", text: labelFor(view) })]);

        /* reload:false - the view's DOM is already built and holds its
           scroll, selected record and any half-typed input; a switch
           should be instant and lossless, not a refetch. */
        const go = () => { if (view !== active) show(view, { reload: false }); };
        tab.addEventListener("click", go);
        tab.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); go(); }
        });

        if (view !== HOME) {
            const close = el("button", {
                class: "wtab-close", type: "button",
                "aria-label": "Close " + labelFor(view)
            }, "×");
            close.addEventListener("click", (event) => { event.stopPropagation(); closeTab(view); });
            tab.append(close);
        }
        return tab;
    }));

    /* Just Dashboard open -> the strip is noise, hide it. */
    strip.hidden = open.length <= 1;
}

export function closeTab(view) {
    if (view === HOME) return;
    const index = open.indexOf(view);
    if (index === -1) return;

    open.splice(index, 1);

    if (active === view) {
        show(open[index - 1] || open[index] || HOME);   // show() calls trackTab -> render + persist
    } else {
        render();
        persist();
    }
}

/* Called by app.js show() at the top of every navigation. */
export function trackTab(view) {
    if (NOT_TABBABLE.has(view)) return;
    if (!open.includes(view)) open.push(view);
    active = view;
    render();
    persist();
}

/* Restore the open set from a previous visit. Call before the first
   show(). Returns the view to open. */
export function wireTabs() {
    strip = document.getElementById("workspace-tabs");

    try {
        const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
        if (saved && Array.isArray(saved.open)) {
            open = [HOME, ...saved.open.filter((v) => v && v !== HOME && !NOT_TABBABLE.has(v))];
            active = saved.active && open.includes(saved.active) ? saved.active : HOME;
        }
    } catch { /* keep the default single Dashboard tab */ }

    render();
    return active;
}
