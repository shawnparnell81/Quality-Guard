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
import { el, toast, printRecord } from "../dom.js";
import { openRecordEditor } from "../forms.js";
import { renderRecordDetail } from "./events.js";
import { renderFairDetail } from "./fair.js";
import { renderPpapDetail } from "./ppap.js";
import { renderEightDDetail, renderChangeDetail } from "./change.js";
import { renderDiDetail } from "./di.js";
import { renderApqpDetail } from "./apqp.js";
import { renderLiveForm } from "./live-form.js";
import { openPane, hasPanes } from "../panes/paneManager.js";

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

/* Custom (user-installed) record types render as a live document -
   buildLiveForm from the schema. A key here overrides that with a
   bespoke renderer; there are none right now (the calibration due-date
   calc rides the RECOMPUTE hook in live-form.js instead). */
const CUSTOM_BESPOKE = {};

/* Types whose paper copy is a designed one-sheet form (print-view.js),
   not the generic pdfkit PDF: the built-in 8D plus every custom type
   (they are all live documents now). */
function isBespokePrint(type) {
    return type === "eightd" || !BUILT_IN.has(type);
}

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

    /* A split is open - every record opened from anywhere joins it as
       a pane rather than replacing the surface. */
    if (hasPanes() && !opts.keepReturn) { await openPane({ type, number: n }); return true; }

    if (!converted(type)) return false;

    /* Every custom (user-installed) type is a live document now -
       full-page view path, buildLiveForm from its schema, chrome =
       Back + Print + Fill from Excel + Duplicate. */
    const liveForm = !BUILT_IN.has(type);

    /* GENERIC built-ins (NCR, CAPA, ...) open straight into their
       editable schema form + context panel (forms.js openRecordEditor).
       Custom types no longer take this path. */
    if (GENERIC.has(type)) {
        const back = opts.returnView || currentViewName() || "dashboard";
        await show("record-editor", { reload: false });
        await openRecordEditor(type, {
            number: n, returnView: back, stayOnSave: true, custom: false
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

    const heading = document.getElementById(SLOT + "-detail-number");
    if (heading) heading.textContent = n;
    document.getElementById(SLOT + "-detail-status").replaceChildren();
    document.getElementById(SLOT + "-detail")
        .replaceChildren(el("p", { class: "sm dim", text: "Loading…" }));
    document.title = n + " · QMS Guardian";

    /* Chrome: a live-document (custom) type edits in place and prints
       its designed sheet, so it shows Back + Print + Fill from Excel +
       Duplicate, no Edit / PDF. A built-in bespoke type keeps
       Edit / Print / PDF. */
    document.getElementById(SLOT + "-actions").hidden = false;
    document.getElementById(SLOT + "-edit").hidden = NO_EDIT.has(type) || liveForm;
    document.getElementById(SLOT + "-pdf").hidden = liveForm;
    setFillFromExcel(liveForm ? type : null, n);
    setDuplicate(liveForm ? { type, number: n } : null);

    try {
        if (liveForm) {
            await (CUSTOM_BESPOKE[type] || renderLiveForm)(n, { slot: SLOT });
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
                actionBtn(SLOT + "-fillxl", "Fill from Excel"),
                actionBtn(SLOT + "-dup", "Duplicate"),
                actionBtn(SLOT + "-print", "Print"),
                actionBtn(SLOT + "-pdf", "PDF"),
                el("input", { id: SLOT + "-xlfile", type: "file", accept: ".xlsx", hidden: "hidden" })
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
        if (!current) return;
        if (isBespokePrint(current.type)) {
            printRecord(current.number);   // the designed one-sheet form
        } else {
            window.open(
                "/api/records/" + encodeURIComponent(current.number) + "/pdf?inline=1", "_blank");
        }
    });
    document.getElementById(SLOT + "-pdf").addEventListener("click", () => {
        if (!current) return;
        api.downloadRecordPdf(current.number, { onWait: () => toast("Preparing the PDF…") })
            .catch((error) => toast(error.message, "error"));
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

    /* Fill from Excel - upload a filled copy of this form's template,
       the server reads it into a new record of this type. */
    const xlBtn = document.getElementById(SLOT + "-fillxl");
    const xlFile = document.getElementById(SLOT + "-xlfile");
    xlBtn.addEventListener("click", () => { xlFile.value = ""; xlFile.click(); });
    xlFile.addEventListener("change", async () => {
        if (!xlFile.files.length || !current) return;
        const fd = new FormData();
        fd.append("file", xlFile.files[0]);
        xlBtn.disabled = true;
        xlBtn.textContent = "Reading…";
        try {
            const r = await api.importRecordExcel(current.type, fd);
            toast(r.number + " created from Excel"
                + (r.source_attached ? " (spreadsheet attached)" : ""));
            openRecordPage(r.number, { type: current.type });
        } catch (error) {
            const errs = error.payload && error.payload.errors;
            toast(errs && errs.length ? errs[0] : error.message, "error");
        } finally {
            xlBtn.disabled = false;
            xlBtn.textContent = "Fill from Excel";
        }
    });

    document.getElementById(SLOT + "-dup").addEventListener("click", async () => {
        if (!current) return;
        try {
            const r = await api.cloneRecord(current.number);
            toast(r.number + " created from " + current.number);
            openRecordPage(r.number, { type: current.type });
        } catch (error) { toast(error.message, "error"); }
    });
}

/* Show the Fill-from-Excel button only for a type whose published form
   version carries an Excel layout (excel_map). */
async function setFillFromExcel(type, number) {
    const btn = document.getElementById(SLOT + "-fillxl");
    if (!btn) return;
    btn.hidden = true;
    if (!type) return;
    try {
        const { has_template } = await api.excelMap(type);
        if (current && current.number === number) btn.hidden = !has_template;
    } catch { /* leave hidden */ }
}

function setDuplicate(ctx) {
    const btn = document.getElementById(SLOT + "-dup");
    if (btn) btn.hidden = !ctx;
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
