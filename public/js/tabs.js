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
    multi: "Split view",
    readiness: "Audit Readiness",
    "form-library": "Forms",
    "form-record": "Custom Forms",
    "form-import": "Import Form",
    people: "People & Access",
    workflows: "Roles & Permissions",
    "menu-layout": "Menu Layout"
};

/* Screens that must never get their own tab. The full-page record
   view (#view-record) is transient like the editor - opening a record
   leaves the strip showing the module tab it was opened from. */
const NOT_TABBABLE = new Set([
    "record-editor", "record", "onboarding", "onboarding-packet"
]);

let strip = null;
let open = [HOME];     // ordered view names, HOME always first
let active = HOME;
let dragView = null;   // view name of the tab being dragged

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

/* Where a drag currently hovers: the tab whose midpoint the pointer
   has not yet passed, i.e. the one the dragged tab should land before.
   Dashboard (HOME, always first) is never a drop target. */
function dropTargetAt(x) {
    const tabs = [...strip.querySelectorAll(".wtab")].filter((t) => t.dataset.view !== HOME);
    for (const tab of tabs) {
        const box = tab.getBoundingClientRect();
        if (x < box.left + box.width / 2) return tab;
    }
    return null;
}

/* Rebuild `open` from the strip's DOM order (HOME forced first) and
   persist. Run after a drag settles. */
function reorderFromDom() {
    const seen = [...strip.querySelectorAll(".wtab")]
        .map((t) => t.dataset.view)
        .filter((v) => v && v !== HOME);
    open = [HOME, ...seen];
    persist();
}

function render() {
    if (!strip) return;

    strip.replaceChildren(...open.map((view) => {
        const tab = el("div", {
            class: "wtab" + (view === active ? " is-active" : ""),
            role: "tab",
            "aria-selected": view === active ? "true" : "false",
            tabindex: "0",
            title: labelFor(view),
            "data-view": view,
            draggable: view === HOME ? undefined : "true"
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
            tab.addEventListener("dragstart", (event) => {
                dragView = view;
                tab.classList.add("dragging");
                event.dataTransfer.effectAllowed = "move";
                try { event.dataTransfer.setData("text/plain", view); } catch { /* Firefox needs a payload */ }
            });
            tab.addEventListener("dragend", () => {
                tab.classList.remove("dragging");
                dragView = null;
                reorderFromDom();
                render();
            });

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

/* One delegated dragover on the strip moves the dragged tab live. */
function wireStripDnd() {
    if (!strip || strip.dataset.dndWired) return;
    strip.dataset.dndWired = "1";
    strip.addEventListener("dragover", (event) => {
        if (!dragView) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const dragging = strip.querySelector(".wtab.dragging");
        if (!dragging) return;
        const before = dropTargetAt(event.clientX);
        if (before === dragging) return;
        if (before) strip.insertBefore(dragging, before);
        else strip.appendChild(dragging);
    });
    strip.addEventListener("drop", (event) => { if (dragView) event.preventDefault(); });
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
    wireStripDnd();

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
