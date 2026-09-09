/* ============================================================
   Full-page record view.

   Clicking a record anywhere - a register row, a search hit, a
   linked-record chip, a dashboard trend point, a ?record= deep link -
   opens it here: the whole main content area becomes the record,
   rendered by the same detail renderer the old side panel used, plus a
   page header with Back / Edit / Print / PDF. No side panel, no
   browser tab.

   Types move onto this path a few at a time. converted(type) says
   whether a type is there yet; a caller that gets `false` from
   openRecordPage() falls back to that type's own screen.

     GENERIC  - events.js renderRecordDetail, side panel removed
     BESPOKE  - its own renderer (fair/ppap/8D/ECN), side panel removed
     custom   - user-created type, renderCustomDetail (always full-page)
   ============================================================ */

import { show } from "../app.js";
import { api } from "../api.js";
import { el } from "../dom.js";
import { openRecordEditor } from "../forms.js";
import { renderRecordDetail } from "./events.js";
import { renderCustomDetail } from "./form-record.js";
import { renderFairDetail } from "./fair.js";
import { renderPpapDetail } from "./ppap.js";
import { renderEightDDetail, renderChangeDetail } from "./change.js";
import { renderDiDetail } from "./di.js";
import { renderApqpDetail } from "./apqp.js";

const SLOT = "record-view";

const GENERIC = new Set(["ncr", "capa", "complaint", "scar", "audit", "risk"]);

const BESPOKE = {
    fair: renderFairDetail,
    ppap: renderPpapDetail,
    eightd: renderEightDDetail,
    ecn: renderChangeDetail,
    di: renderDiDetail,
    apqp: renderApqpDetail
};

/* Built-in types whose old side panel carried no Edit button - the
   record is driven by attaching deliverables / advancing phases, not
   by the schema form. Keep it that way: chrome shows only Print / PDF. */
const NO_EDIT = new Set(["di", "apqp"]);

/* Every built-in type. One not in here is a type someone created. */
const BUILT_IN = new Set([
    "ncr", "capa", "eightd", "complaint", "scar",
    "audit", "ecn", "risk", "apqp", "di", "fair", "ppap"
]);

export function converted(type) {
    return GENERIC.has(type) || Boolean(BESPOKE[type]) || !BUILT_IN.has(type);
}

/* Types whose record IS its schema form: opening one goes straight to
   the editable form + context panel (one surface, S3), not a
   read-only view with an Edit button. The bespoke types keep the
   view + Edit model - their screens are not plain forms. */
function editInPlace(type) {
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

    /* The merged surface: the record opens as its editable form with a
       context panel below it (forms.js openRecordEditor). No separate
       read-only view, no Edit button. */
    if (editInPlace(type)) {
        const back = opts.returnView || currentViewName() || "dashboard";
        await show("record-editor", { reload: false });
        await openRecordEditor(type, {
            number: n, returnView: back, stayOnSave: true, custom: !BUILT_IN.has(type)
        });
        return true;
    }

    if (!opts.keepReturn) {
        returnTo = { view: opts.returnView || currentViewName() || "dashboard", scrollY: window.scrollY };
    }

    await show("record", { reload: false });
    const shell = buildShell();
    shell.dataset.type = type;
    current = { number: n, type };

    const isCustom = !BUILT_IN.has(type);

    const heading = document.getElementById(SLOT + "-detail-number");
    if (heading) heading.textContent = n;
    document.getElementById(SLOT + "-detail-status").replaceChildren();
    document.getElementById(SLOT + "-detail")
        .replaceChildren(el("p", { class: "sm dim", text: "Loading…" }));
    document.title = n + " · QMS Guardian";

    /* A built-in type leans on the chrome's Edit / Print / PDF;
       renderCustomDetail builds its own button row in the panel body,
       so for a custom type the chrome bar is hidden. */
    document.getElementById(SLOT + "-actions").hidden = isCustom;
    document.getElementById(SLOT + "-edit").hidden = NO_EDIT.has(type);

    try {
        if (isCustom) {
            await renderCustomDetail(type, n, { slot: SLOT });
        } else if (BESPOKE[type]) {
            await BESPOKE[type](n, { slot: SLOT });
        } else {
            await renderRecordDetail(type, n, { slot: SLOT });
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

/* The page frame, built once. It provides the id-suffixed slots the
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
