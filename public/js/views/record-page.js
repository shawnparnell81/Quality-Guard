/* ============================================================
   Full-page record view.

   Clicking a record anywhere - a register row, a search hit, a
   linked-record chip, a dashboard row, a ?record= deep link - opens
   it here: the whole main content area becomes the record, rendered
   by the same detail renderer the old side panel used, plus a page
   header with Back / Edit / Print / PDF. No side panel, no browser
   tab.

   Types are converted to this view a few at a time. converted(type)
   says whether a type is on the full-page path yet; callers that get
   `false` from openRecordPage() fall back to their old side panel.
   ============================================================ */

import { show } from "../app.js";
import { api } from "../api.js";
import { el } from "../dom.js";
import { openRecordEditor } from "../forms.js";
import { renderRecordDetail } from "./events.js";
import { renderCustomDetail } from "./form-record.js";

const SLOT = "record-view";

/* Built-in types that render through events.js renderRecordDetail
   generic path AND have had their side panel removed. Grows as more
   screens are flipped over (stages S1-S2). */
const GENERIC = new Set(["ncr", "capa"]);

/* Every built-in type. One not in here is a type someone created; all
   of those go through renderCustomDetail and are already on the
   full-page path. */
const BUILT_IN = new Set([
    "ncr", "capa", "eightd", "complaint", "scar",
    "audit", "ecn", "risk", "apqp", "di", "fair", "ppap"
]);

/* A type is on the full-page path if it is a converted built-in or a
   custom (user-created) type. */
export function converted(type) {
    return GENERIC.has(type) || !BUILT_IN.has(type);
}

/* Where "Back" returns to, and the scroll position to restore there.
   Captured when a record is opened from a list; kept across an
   in-place re-render (opts.keepReturn) so an Edit round-trip does not
   reset it to the editor. */
let returnTo = null;

/* The record currently on screen - so the header buttons and a
   post-save re-render act on the right one without scraping the DOM. */
let current = null;

export async function openRecordPage(number, opts = {}) {
    const n = String(number || "").trim();
    if (!n) return false;

    let type = opts.type || null;
    if (!type) {
        try { type = (await api.record(n)).record.type; }
        catch { return false; }
    }
    if (!converted(type)) return false;

    if (!opts.keepReturn) {
        returnTo = { view: opts.returnView || currentViewName() || "dashboard", scrollY: window.scrollY };
    }

    await show("record", { reload: false });
    const shell = buildShell();
    shell.dataset.type = type;
    current = { number: n, type, generic: GENERIC.has(type) };

    const heading = document.getElementById(SLOT + "-detail-number");
    if (heading) heading.textContent = n;
    document.getElementById(SLOT + "-detail-status").replaceChildren();
    document.getElementById(SLOT + "-detail")
        .replaceChildren(el("p", { class: "sm dim", text: "Loading…" }));
    document.title = n + " · QMS Guardian";

    /* The generic renderer relies on external Edit/Print/PDF buttons
       (the chrome provides them); renderCustomDetail builds its own
       button row in the panel body, so the chrome hides its bar. */
    document.getElementById(SLOT + "-actions").hidden = !current.generic;

    try {
        if (current.generic) {
            await renderRecordDetail(type, n, { slot: SLOT });
        } else {
            await renderCustomDetail(type, n, { slot: SLOT });
        }
    } catch (error) {
        document.getElementById(SLOT + "-detail").replaceChildren(
            el("p", { class: "sm", style: "color:var(--crit)", text: error.message }));
    }
    window.scrollTo(0, 0);
    return true;
}

/* Re-render the record in place - used by the Edit round-trip's
   onSaved so returning to #view-record shows the saved values. */
export function refreshRecordPage() {
    if (current) return openRecordPage(current.number, { type: current.type, keepReturn: true });
}

/* The page frame, built once. Provides the id-suffixed slots the
   detail renderers write into:
     #record-view-detail-number  #record-view-detail-status
     #record-view-detail
     #record-view-edit  #record-view-print  #record-view-pdf  */
function buildShell() {
    const shell = document.getElementById("view-record");
    if (shell.dataset.built === "1") return shell;
    shell.dataset.built = "1";

    const back = el("button", { class: "btn no-print", type: "button", text: "← Back" });
    back.addEventListener("click", goBack);

    shell.replaceChildren(
        el("div", { class: "view-head record-page-head" }, [
            back,
            el("div", { class: "record-page-title" }, [
                el("h1", { class: "view-title", id: SLOT + "-detail-number", tabindex: "-1" }),
                el("span", { id: SLOT + "-detail-status" })
            ]),
            el("div", { class: "row no-print record-page-actions", id: SLOT + "-actions" }, [
                actionBtn(SLOT + "-edit", "Edit", "btn-primary"),
                actionBtn(SLOT + "-print", "Print"),
                actionBtn(SLOT + "-pdf", "PDF")
            ])
        ]),
        el("div", { class: "panel" }, el("div", { class: "panel-body", id: SLOT + "-detail" }))
    );

    wireActions();
    return shell;
}

function actionBtn(id, text, extra = "") {
    return el("button", { id, class: ("btn no-print " + extra).trim(), type: "button", text });
}

function wireActions() {
    document.getElementById(SLOT + "-print").addEventListener("click", () => {
        if (current) window.open(
            "/api/records/" + encodeURIComponent(current.number) + "/pdf?inline=1", "_blank");
    });
    document.getElementById(SLOT + "-pdf").addEventListener("click", () => {
        if (current) window.location.href =
            "/api/records/" + encodeURIComponent(current.number) + "/pdf";
    });
    document.getElementById(SLOT + "-edit").addEventListener("click", () => {
        if (!current) return;
        document.dispatchEvent(new CustomEvent("navigate", { detail: { view: "record-editor" } }));
        openRecordEditor(current.type, {
            number: current.number,
            returnView: "record",
            onSaved: () => refreshRecordPage()
        });
    });
}

function goBack() {
    const to = returnTo || { view: "dashboard", scrollY: 0 };
    current = null;
    document.title = "QMS Guardian";
    show(to.view, { reload: false }).then(() => window.scrollTo(0, to.scrollY || 0));
}

function currentViewName() {
    const v = [...document.querySelectorAll(".view")].find((x) => !x.hidden);
    return v ? v.id.replace(/^view-/, "") : null;
}
