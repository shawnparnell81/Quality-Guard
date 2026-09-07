/* ============================================================
   Jump straight to a linked record.

   Given a record number (and optionally its type), switch to the
   right screen and open that record. Used by the "Linked records"
   list and by any field whose value is another record's number.

   The type -> screen map and the deep-select mechanics are the same
   ones the command palette uses (palette.js); this is that logic
   made reusable, plus deep-select for 8D and ECN and a prefix
   fallback for the records that live in their own tables (receiving,
   work orders, purchase orders / requests).
   ============================================================ */

import { show } from "./app.js";
import { api } from "./api.js";
import { renderRecordDetail } from "./views/events.js";
import { renderEightD, renderChange } from "./views/change.js";
import { el, toast } from "./dom.js";

const TYPE_VIEW = {
    ncr: "ncr", capa: "capa", complaint: "complaints",
    audit: "audit", risk: "risk", eightd: "d8", ecn: "change",
    di: "di", apqp: "apqp"
};

/* Records that are not in the `records` table - matched on their
   number prefix. The view may not exist in this build yet (the
   Customer Service screens ship separately); navigate() no-ops
   cleanly in that case and we fall back to a toast. */
const PREFIX_VIEW = [
    [/^RCV-/i, "receiving", "receiving inspection"],
    [/^WO-/i, "wo-log", "work order"],
    [/^PO-/i, "po-log", "purchase order"],
    [/^PR-/i, "pr-log", "purchase request"]
];

function viewExists(view) {
    return Boolean(document.getElementById("view-" + view));
}

/* The number formats this app hands out:
   NCR-2026-0142, CAPA-2026-0005, 8D-2026-0003, COMP-2026-0011,
   AUD-2026-0002, ECN-2026-0114, R-2026-0007, APQP-2026-0001,
   DI-2026-0004, PO-2026-0003, PR-2026-0009, RCV-20260907-2,
   WO-31882, and PREFIX-YYYY-NNNN for a custom type. */
const RECORD_NUMBER_RX =
    /^(?:[A-Z][A-Z0-9]{0,11}-\d{4}-\d{3,4}|RCV-\d{8}-\d+|WO-\d+)$/i;

export function looksLikeRecordNumber(value) {
    return typeof value === "string" && RECORD_NUMBER_RX.test(value.trim());
}

export async function openRecord(number, typeHint) {
    const n = String(number || "").trim();
    if (!n) return;

    for (const [rx, view, label] of PREFIX_VIEW) {
        if (rx.test(n)) {
            if (viewExists(view)) {
                document.dispatchEvent(new CustomEvent("navigate", { detail: { view } }));
            } else {
                toast(n + " - open it from the " + label + " screen", "error");
            }
            return;
        }
    }

    let type = typeHint || null;
    if (!type) {
        try {
            type = (await api.record(n)).record.type;
        } catch {
            toast("Could not open " + n, "error");
            return;
        }
    }

    const view = TYPE_VIEW[type];
    if (!view) {
        /* A custom form type: the generic Custom Forms screen, if this
           build has it. */
        if (viewExists("form-record")) {
            document.dispatchEvent(new CustomEvent("navigate", { detail: { view: "form-record" } }));
        } else {
            toast(n + " - open it from its own screen", "error");
        }
        return;
    }

    await show(view);
    if (type === "eightd") await renderEightD(n);
    else if (type === "ecn") await renderChange(n);
    else await renderRecordDetail(type, n);
}

/* A clickable chip / hyperlink for a record number. `link` may be a
   plain string or an object { number, type?, link_type?, title? }. */
export function recordLink(link, { chip = true, suffix = "" } = {}) {
    const number = typeof link === "string" ? link : link.number;
    const type = typeof link === "string" ? undefined : link.type;
    const title = typeof link === "string" ? "" : (link.title || "");
    const rel = typeof link === "string" ? "" : (link.link_type || "");

    const text = number
        + (rel ? "  " + rel.replace(/_/g, " ") : "")
        + (suffix ? "  " + suffix : "");

    return el("button", {
        class: (chip ? "chip chip-link" : "link-btn") + " no-print",
        type: "button",
        title: "Open " + number + (title ? " - " + title : ""),
        onClick: () => openRecord(number, type)
    }, text);
}
