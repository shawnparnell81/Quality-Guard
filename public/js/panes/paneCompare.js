/* ============================================================
   Field-by-field compare of two same-type records shown side by side
   (M4). A modal with one row per field - Summary, Severity, Due date,
   then the schema fields - and the rows that differ highlighted. Read
   only; it is a "what changed between rev A and rev B" aid, most
   useful on two PFMEA / Control Plan revisions.
   ============================================================ */

import { api } from "../api.js";
import { ensureDialog } from "../forms.js";
import { el, formatDate, humanize, toast } from "../dom.js";
import { formatValue } from "../format.js";

const HEAD_FIELDS = [
    { label: "Summary", get: (r) => r.title },
    { label: "Severity", get: (r) => humanize(r.severity || "") },
    { label: "Due date", get: (r) => (r.due_at ? formatDate(r.due_at) : "") }
];

export async function openCompare(paneA, paneB) {
    let ra, rb, def;
    try {
        [{ record: ra }, { record: rb }, def] = await Promise.all([
            api.record(paneA.number),
            api.record(paneB.number),
            api.recordForm(paneA.type).catch(() => ({ fields: [] }))
        ]);
    } catch (error) {
        toast(error.message, "error");
        return;
    }

    const rows = [
        ...HEAD_FIELDS.map((f) => ({ label: f.label, a: f.get(ra) || "", b: f.get(rb) || "" })),
        ...((def.fields || []).map((field) => ({
            label: field.label,
            a: cell(field, ra.data ? ra.data[field.key] : undefined),
            b: cell(field, rb.data ? rb.data[field.key] : undefined)
        })))
    ];
    const diffCount = rows.filter((r) => r.a !== r.b).length;

    const node = ensureDialog();
    node.replaceChildren(
        el("div", { class: "modal-head" }, [
            el("h2", { class: "modal-title", text: "Compare  " + paneA.number + "  vs  " + paneB.number }),
            el("span", { class: "panel-note",
                text: diffCount === 0 ? "identical" : diffCount + (diffCount === 1 ? " field differs" : " fields differ") })
        ]),
        el("div", { class: "modal-body" }, [
            el("div", { class: "table-wrap" }, el("table", { class: "sm compare-table" }, [
                el("thead", {}, el("tr", {}, [
                    el("th", { scope: "col", text: "Field" }),
                    el("th", { scope: "col", text: paneA.number }),
                    el("th", { scope: "col", text: paneB.number })
                ])),
                el("tbody", {}, rows.map((r) => {
                    const differ = r.a !== r.b;
                    return el("tr", { class: differ ? "compare-diff" : undefined }, [
                        el("td", { class: "sm dim", text: r.label }),
                        el("td", { class: "sm", text: r.a || "—" }),
                        el("td", { class: "sm", text: r.b || "—" })
                    ]);
                }))
            ]))
        ]),
        el("div", { class: "modal-foot" }, [
            el("button", { class: "btn", type: "button", text: "Close", onClick: () => node.close() })
        ])
    );
    node.showModal();
}

/* Table fields collapse to a "N rows" summary - a full grid diff is
   out of scope here. */
function cell(field, value) {
    if (field.type === "table") {
        const n = Array.isArray(value) ? value.length : 0;
        return n === 1 ? "1 row" : n + " rows";
    }
    return formatValue(field, value, { empty: "" });
}
