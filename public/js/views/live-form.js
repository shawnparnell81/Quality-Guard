/* ============================================================
   Live document form - the generic version of the Calibration Log
   layout, driven by any record type's schema.

   A record opens straight into its form: a navy controlled-document
   header, fields grouped into gridded sections, and every
   `type:"table"` field as a bordered register with add / remove rows.
   Edits save in place (debounced PATCH); computed columns (RPN and any
   compute / expr column) recalculate as you type because the grid is
   the shared table editor. The same builder renders the ?print= page
   read-only.

   Reuses:
     buildField / readValue        public/js/forms.js
     createTableEditor (via table)  public/js/table-editor.js
     evaluate                       public/js/expr.js  (inside the editor)
     workflowButtons                ./change.js
     buildUploader                  ../attach-upload.js
   ============================================================ */

import { api } from "../api.js";
import { buildField, readValue } from "../forms.js";
import { el, humanize, formatDate, debounce, toast } from "../dom.js";
import { recordLink } from "../record-nav.js";
import { buildUploader } from "../attach-upload.js";
import { renderDocumentsPanel } from "./resources.js";
import { workflowButtons } from "./change.js";

/* Per-type client calc that isn't a plain compute/expr column - keyed
   by record-type key. Given (record, entries) after each edit and
   before a save; mutates a table entry's rows through its editor.
   RPN and product/sum columns need nothing here. */
const RECOMPUTE = {
    calibration_log: recomputeCalibration
};

const DAY = 86400000;

function recomputeCalibration(entries) {
    const t = entries.find((e) => e.field.key === "equipment" && e.readTable);
    if (!t) return;
    const rows = t.readTable();
    let touched = false;
    for (const r of rows) {
        const nextDue = addMonths(r.last_cal_date, r.interval_months);
        let days = "", status = r.calibration_status || "";
        if (String(r.record_status).toLowerCase() === "inactive") {
            status = "Inactive";
        } else if (nextDue) {
            days = String(Math.round((new Date(nextDue).getTime() - Date.now()) / DAY));
            const n = Number(days);
            status = n < 0 ? "Past due" : n <= 30 ? "Due within 30 days" : "Current";
        }
        if (r.next_cal_due_date !== nextDue || String(r.days_until_due) !== days
            || r.calibration_status !== status) {
            r.next_cal_due_date = nextDue;
            r.days_until_due = days;
            r.calibration_status = status;
            touched = true;
        }
    }
    if (touched) t.writeTable(rows);
}

function addMonths(iso, months) {
    const n = Number(months);
    if (!iso || !Number.isFinite(n)) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    d.setMonth(d.getMonth() + n);
    return d.toISOString().slice(0, 10);
}

/* ---------- the form ---------- */

/* Returns { node, entries }. `node` is the whole .live-form document;
   `entries` are buildField's return values, for save-time collection. */
export function buildLiveForm(record, definition, { editable = true } = {}) {
    const fields = Array.isArray(definition && definition.fields) ? definition.fields : [];
    const options = (definition && definition.options) || {};

    const entries = fields.map((f) => buildField(
        f, options, record.data ? record.data[f.key] : undefined,
        { recordNumber: record.number }
    ));

    /* group entries by section, first-seen order */
    const sections = [];
    const bySection = new Map();
    for (const entry of entries) {
        const key = entry.field.section || "";
        if (!bySection.has(key)) { bySection.set(key, []); sections.push(key); }
        bySection.get(key).push(entry);
    }

    const header = el("div", { class: "lf-head" }, [
        el("div", { class: "lf-head-title" }, [
            el("span", { class: "lf-kicker", text: definition.name || humanize(record.type) }),
            el("span", { class: "lf-no", text: record.number })
        ]),
        el("div", { class: "lf-facts" }, [
            fact("Title", record.title || "—"),
            fact("Owner", record.owner || "—"),
            fact("Status", humanize(record.status)),
            fact("Opened", formatDate(record.opened_at)),
            fact("Due", record.due_at ? formatDate(record.due_at) : "—"),
            fact("Printed", formatDate(new Date().toISOString()))
        ])
    ]);

    const blocks = sections.map((sectionKey) => {
        const list = bySection.get(sectionKey);
        const flat = list.filter((e) => e.field.type !== "table");
        const tables = list.filter((e) => e.field.type === "table");

        const children = [];
        if (flat.length) {
            children.push(el("div", { class: "lf-grid" },
                flat.map((e) => { e.wrapper.classList.add("lf-field"); return e.wrapper; })));
        }
        for (const e of tables) {
            e.wrapper.classList.add("lf-tablewrap");
            if (Array.isArray(e.field.columns) && e.field.columns.length > 8) {
                e.wrapper.classList.add("lf-grid--wide");
            }
            children.push(e.wrapper);
        }

        return el("section", { class: "lf-block" }, [
            sectionKey
                ? el("h3", { class: "lf-block-head", text: sectionKey })
                : null,
            el("div", { class: "lf-block-body" }, children)
        ]);
    });

    const node = el("div", { class: "live-form" + (editable ? "" : " is-print") }, [header, ...blocks]);
    return { node, entries };
}

/* ---------- the screen ---------- */

export async function renderLiveForm(number, { slot = "record-view" } = {}) {
    const track = document.getElementById(slot + "-detail");
    const heading = document.getElementById(slot + "-detail-number");
    if (!track) return;
    track.replaceChildren(el("p", { class: "sm dim", text: "Loading…" }));

    let record, transitions, links, definition;
    try {
        const got = await api.record(number);
        record = got.record;
        transitions = got.transitions || [];
        links = got.links || [];
        definition = await api.recordForm(record.type);
    } catch (error) {
        track.replaceChildren(el("p", { class: "sm", style: "color:var(--crit)", text: error.message }));
        return;
    }
    if (heading) heading.textContent = record.number;

    const { node, entries } = buildLiveForm(record, definition, { editable: true });

    const recompute = RECOMPUTE[record.type];
    const save = debounce(async () => {
        if (recompute) { try { recompute(entries); } catch { /* leave the row as typed */ } }
        const data = {};
        for (const e of entries) {
            const v = readValue(e);
            if (v !== undefined) data[e.field.key] = v;
        }
        try { await api.updateRecord(number, { data }); }
        catch (error) { toast(error.message, "error"); }
    }, 500);
    node.addEventListener("input", save);
    node.addEventListener("change", save);

    const tail = [];
    if (links.length) {
        tail.push(el("div", { class: "section-label", text: "Linked records" }));
        tail.push(el("div", { class: "chip-list" }, links.map((l) => recordLink(l))));
    }
    tail.push(...workflowButtons(record, transitions, () => renderLiveForm(number, { slot })));
    tail.push(el("div", { class: "section-label", text: "Attachments" }));
    tail.push(buildUploader({
        url: api.recordAttachmentsUrl(number),
        onComplete: () => renderLiveForm(number, { slot })
    }));

    track.replaceChildren(
        node,
        el("div", { class: "no-print" }, tail),
        el("div", { class: "section-label no-print", text: "Documents" }),
        el("div", { class: "panel-body no-print", id: slot + "-documents-panel" })
    );
    renderDocumentsPanel(record.number, slot + "-documents-panel");
}

function fact(label, value) {
    return el("div", { class: "lf-fact" }, [
        el("span", { class: "lf-fact-label", text: label }),
        el("span", { class: "lf-fact-val", text: value })
    ]);
}
