/* ============================================================
   Pane content - the seam between a pane and the existing engine.

   M1 is read-only: a pane shows a record exactly as its full-page
   view does, using the per-type detail renderers with a per-pane
   `slot` id prefix (the same seam S0-S2 added). Nothing here fetches
   or renders on its own; it just routes to the right renderer.

   Rendered bodies are cached by pane id so re-laying-out the row
   (open / close / reorder another pane) does not re-fetch or lose
   scroll - only a genuinely new pane hits the network.
   ============================================================ */

import { el } from "../dom.js";
import { renderRecordDetail } from "../views/events.js";
import { renderFairDetail } from "../views/fair.js";
import { renderPpapDetail } from "../views/ppap.js";
import { renderEightDDetail, renderChangeDetail } from "../views/change.js";
import { renderDiDetail } from "../views/di.js";
import { renderApqpDetail } from "../views/apqp.js";
import { renderCustomDetail } from "../views/form-record.js";

const BESPOKE = {
    fair: renderFairDetail, ppap: renderPpapDetail,
    eightd: renderEightDDetail, ecn: renderChangeDetail,
    di: renderDiDetail, apqp: renderApqpDetail
};
const BUILT_IN = new Set([
    "ncr", "capa", "eightd", "complaint", "scar",
    "audit", "ecn", "risk", "apqp", "di", "fair", "ppap"
]);

/* paneId -> the .pane-body element with its rendered content. */
const bodyCache = new Map();

export function slotOf(pane) { return "pane-" + pane.id; }

/* The body element for a pane - the cached one (already rendered) or
   a fresh empty div. paneLayout calls this while building shells. */
export function bodyFor(pane) {
    /* mode is in the key so switching a pane to "edit" gets a fresh
       body (the form, not the read-only detail) and switching back
       gets a fresh read-only body with the saved values. */
    const key = pane.type + ":" + (pane.number || "new") + ":" + (pane.mode || "view");
    const cached = bodyCache.get(pane.id);
    if (cached && cached.dataset.paneKey === key) return cached;
    const fresh = el("div", { class: "pane-body", id: slotOf(pane) + "-detail" });
    fresh.dataset.paneKey = key;
    bodyCache.set(pane.id, fresh);
    return fresh;
}

/* Load a pane's content into its body, unless it is already loaded.
   onEditDone (from paneManager) is what an in-pane editor calls on
   save or cancel. */
export async function mountPane(pane, onEditDone) {
    const body = document.getElementById(slotOf(pane) + "-detail");
    if (!body || body.dataset.loaded === "1") { restoreScroll(pane, body); return; }

    if (pane.mode === "edit") return mountEditor(pane, body, onEditDone);

    body.replaceChildren(el("p", { class: "sm dim", text: "Loading…" }));
    const slot = slotOf(pane);
    try {
        if (!BUILT_IN.has(pane.type)) {
            await renderCustomDetail(pane.type, pane.number, { slot });
        } else if (BESPOKE[pane.type]) {
            await BESPOKE[pane.type](pane.number, { slot });
        } else {
            await renderRecordDetail(pane.type, pane.number, { slot });
        }
        body.dataset.loaded = "1";
    } catch (error) {
        body.replaceChildren(el("p", { class: "sm", style: "color:var(--crit)", text: error.message }));
    }
    restoreScroll(pane, body);
}

async function mountEditor(pane, body, onEditDone) {
    body.replaceChildren(el("p", { class: "sm dim", text: "Loading…" }));
    try {
        const { openRecordEditor } = await import("../forms.js");
        await openRecordEditor(pane.type, {
            number: pane.number,
            host: body,
            headerless: true,
            custom: !BUILT_IN.has(pane.type),
            onDone: () => { if (onEditDone) onEditDone(); }
        });
        body.dataset.loaded = "1";
    } catch (error) {
        body.replaceChildren(el("p", { class: "sm", style: "color:var(--crit)", text: error.message }));
    }
}

function restoreScroll(pane, body) {
    if (body && pane.scrollTop) body.scrollTop = pane.scrollTop;
}

export function dropPane(paneId) { bodyCache.delete(paneId); }
export function dropAll() { bodyCache.clear(); }
