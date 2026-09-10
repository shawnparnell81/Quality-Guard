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

   For an existing record the header's Summary / Severity / Due are
   editable and save the same way; a debounced PATCH carries an
   expected_version so a concurrent save is caught (a "reload" bar,
   not a silent overwrite); a presence heartbeat shows who else has it
   open; and a standing, non-blocking checklist lists the still-empty
   required fields and any form-rule violation. The workflow /
   links / attachments / audit trail below the form is the shared
   buildRecordContext panel. The same builder renders the ?print= page
   read-only.

   Reuses:
     buildField / readValue        public/js/forms.js
     validate                      public/js/forms.js
     createTableEditor (via table)  public/js/table-editor.js
     evaluate                       shared/expr.js  (inside the editor)
     validateRecord                 shared/validate.js
     beginEditing                  public/js/presence.js
     buildRecordContext            ./record-context.js
   ============================================================ */

import { api } from "../api.js";
import { buildField, readValue, validate } from "../forms.js";
import { el, humanize, formatDate, debounce, toast } from "../dom.js";
import { validateRecord } from "../../../shared/validate.js";
import { beginEditing } from "../presence.js";
import { renderDocumentsPanel } from "./resources.js";
import { buildRecordContext } from "./record-context.js";

/* Severity lives on records.severity, not in the data payload - the
   same three the record editor offers. */
const SEVERITY_OPTIONS = [["ok", "OK"], ["warn", "Warning"], ["crit", "Critical"]];

/* Per-type client calc that isn't a plain compute/expr column - keyed
   by record-type key. recompute(entries, { tables }) runs on each edit
   and before every save; `tables` is false on a keystroke (only cheap
   flat-field aggregates) and true on blur / before save (also writes
   derived table cells, which re-renders that grid). RPN and
   product/sum columns need nothing here. */
const RECOMPUTE = {
    calibration_log: recomputeCalibration,
    internal_audit_checklist: recomputeAuditTally,
    process_capability: recomputeCpk,
    training_matrix: recomputeTrainingMatrix,
    ncr_report: recomputeNcrBalance
};

/* Suspect quantity not yet accounted for by scrap + rework. */
function recomputeNcrBalance(entries) {
    const n = (k) => { const v = numOf(entries, k); return Number.isFinite(v) ? v : 0; };
    setDerived(entries, "qty_balance_unaccounted",
        String(n("total_qty_suspect") - n("qty_scrap") - n("qty_rework")));
}

/* Station Qualification % per operator row: share of the three
   stations at L2 (certified) or L3 (trainer). */
function recomputeTrainingMatrix(entries, { tables } = {}) {
    if (!tables) return;
    const t = entries.find((e) => e.field.key === "operators" && e.readTable);
    if (!t) return;
    const rows = t.readTable();
    const capable = (s) => s === "L2: Certified" || s === "L3: Trainer";
    let touched = false;
    for (const r of rows) {
        const n = [r.station_1, r.station_2, r.station_3].filter(capable).length;
        const pct = ((n / 3) * 100).toFixed(1);
        if (r.station_qualification_pct !== pct) { r.station_qualification_pct = pct; touched = true; }
    }
    if (touched) t.writeTable(rows);
}

/* set a flat field's input read-only to a computed value */
function setDerived(entries, key, value) {
    const e = entries.find((x) => x.field.key === key);
    if (e && e.input) { e.input.value = value; e.input.readOnly = true; }
}
const numOf = (entries, key) => {
    const e = entries.find((x) => x.field.key === key);
    return e && e.input ? Number(e.input.value) : NaN;
};

/* Live Compliant / OFI / NC counts from the findings table. */
function recomputeAuditTally(entries) {
    const t = entries.find((e) => e.field.key === "findings" && e.readTable);
    if (!t) return;
    const n = { count_compliant: 0, count_ofi: 0, count_nc: 0 };
    for (const r of t.readTable()) {
        if (r.finding === "Compliant") n.count_compliant += 1;
        else if (r.finding === "Opportunity for improvement") n.count_ofi += 1;
        else if (r.finding === "Non-conformance") n.count_nc += 1;
    }
    for (const [key, val] of Object.entries(n)) setDerived(entries, key, String(val));
}

/* Cpk study: mean / sigma / count / Cpk from the observed values, and
   a WITHIN / OUT OF SPEC per sample row against the form's USL / LSL. */
function recomputeCpk(entries, { tables } = {}) {
    const usl = numOf(entries, "usl");
    const lsl = numOf(entries, "lsl");
    const t = entries.find((e) => e.field.key === "samples" && e.readTable);
    if (!t) return;
    const rows = t.readTable();
    const vals = rows.map((r) => Number(r.observed_value)).filter(Number.isFinite);
    const n = vals.length;
    const mean = n ? vals.reduce((a, b) => a + b, 0) / n : NaN;
    const sigma = n >= 2
        ? Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1))
        : NaN;
    let cpk = NaN;
    if (n >= 2 && Number.isFinite(usl) && Number.isFinite(lsl) && usl > lsl && sigma > 0) {
        cpk = Math.min((usl - mean) / (3 * sigma), (mean - lsl) / (3 * sigma));
    }
    setDerived(entries, "stat_count", String(n));
    setDerived(entries, "stat_mean", Number.isFinite(mean) ? mean.toFixed(3) : "");
    setDerived(entries, "stat_sigma", Number.isFinite(sigma) ? sigma.toFixed(4) : "");
    setDerived(entries, "cpk_value", Number.isFinite(cpk) ? cpk.toFixed(2) : "");

    if (tables && Number.isFinite(usl) && Number.isFinite(lsl)) {
        let touched = false;
        for (const r of rows) {
            const v = Number(r.observed_value);
            const s = !Number.isFinite(v) ? "" : (v > usl || v < lsl) ? "Out of spec" : "Within spec";
            if (r.spec_status !== s) { r.spec_status = s; touched = true; }
        }
        if (touched) t.writeTable(rows);
    }
}

const DAY = 86400000;

function recomputeCalibration(entries, { tables } = {}) {
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
    if (touched && tables) t.writeTable(rows);
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

/* Returns { node, entries, meta }. `node` is the whole .live-form
   document; `entries` are buildField's return values, for save-time
   collection; `meta` (editable only) is { titleInput, severitySelect,
   dueInput } - the records.* columns that live outside `data`. */
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

    let meta = null;
    let factNodes;
    if (editable) {
        const titleInput = el("input", {
            type: "text", class: "lf-meta-input", value: record.title || "",
            "aria-label": "Summary", placeholder: "What is wrong, in one line"
        });
        const severitySelect = el("select", { class: "lf-meta-input", "aria-label": "Severity" },
            SEVERITY_OPTIONS.map(([value, label]) => el("option", {
                value, text: label,
                selected: (record.severity || "warn") === value ? "selected" : undefined
            })));
        const dueInput = el("input", {
            type: "date", class: "lf-meta-input", "aria-label": "Due date",
            value: record.due_at ? String(record.due_at).slice(0, 10) : ""
        });
        meta = { titleInput, severitySelect, dueInput };
        factNodes = [
            fact("Summary", titleInput),
            fact("Owner", record.owner || "—"),
            fact("Status", humanize(record.status)),
            fact("Severity", severitySelect),
            fact("Opened", formatDate(record.opened_at)),
            fact("Due", dueInput)
        ];
    } else {
        factNodes = [
            fact("Title", record.title || "—"),
            fact("Owner", record.owner || "—"),
            fact("Status", humanize(record.status)),
            fact("Opened", formatDate(record.opened_at)),
            fact("Due", record.due_at ? formatDate(record.due_at) : "—"),
            fact("Printed", formatDate(new Date().toISOString()))
        ];
    }

    const header = el("div", { class: "lf-head" }, [
        el("div", { class: "lf-head-title" }, [
            el("span", { class: "lf-kicker", text: definition.name || humanize(record.type) }),
            el("span", { class: "lf-no", text: record.number })
        ]),
        el("div", { class: "lf-facts" }, factNodes)
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
    return { node, entries, meta };
}

/* ---------- the screen ---------- */

/* One live form is mounted on the record page at a time. Its presence
   heartbeat has to stop when the next record (or a re-render) takes
   over, and when the record view is navigated away from - the same
   single-owner teardown openRecordEditor keeps. */
let liveTeardown = null;

document.addEventListener("view-left", (event) => {
    if (event.detail && event.detail.view === "record" && liveTeardown) {
        liveTeardown();
        liveTeardown = null;
    }
});

export async function renderLiveForm(number, { slot = "record-view" } = {}) {
    if (liveTeardown) { liveTeardown(); liveTeardown = null; }

    const track = document.getElementById(slot + "-detail");
    const heading = document.getElementById(slot + "-detail-number");
    if (!track) return;
    track.replaceChildren(el("p", { class: "sm dim", text: "Loading…" }));

    let record, definition, version;
    try {
        const got = await api.record(number);
        record = got.record;
        version = got.version || null;
        definition = await api.recordForm(record.type, { version: record.form_version });
    } catch (error) {
        track.replaceChildren(el("p", { class: "sm", style: "color:var(--crit)", text: error.message }));
        return;
    }
    if (heading) heading.textContent = record.number;

    const { node, entries, meta } = buildLiveForm(record, definition, { editable: true });

    const recompute = RECOMPUTE[record.type];
    const runRecompute = (tables) => {
        if (recompute) { try { recompute(entries, { tables }); } catch { /* leave as typed */ } }
    };

    const collectData = () => {
        const data = {};
        for (const e of entries) {
            const v = readValue(e);
            if (v !== undefined) data[e.field.key] = v;
        }
        return data;
    };

    /* ---- standing "still needed" checklist (never blocks typing) ---- */
    const todoBox = el("div", { class: "lf-todo no-print", hidden: "hidden" });
    function paintTodo(extraTitle, extraItems) {
        if (extraItems && extraItems.length) {
            todoBox.replaceChildren(
                el("div", { class: "section-label", text: extraTitle }),
                el("ul", { class: "lf-todo-list" }, extraItems.map((m) => el("li", { text: m })))
            );
            todoBox.hidden = false;
            return;
        }
        const collected = collectData();
        const rules = validateRecord(definition, collected, {
            phase: "update", prior: record.data
        });
        const items = [...validate(entries), ...rules.rule_violations, ...rules.warnings];
        if (!items.length) { todoBox.hidden = true; return; }
        todoBox.replaceChildren(
            el("div", { class: "section-label", text: "Before this record can move forward" }),
            el("ul", { class: "lf-todo-list" }, items.map((m) => el("li", { text: m })))
        );
        todoBox.hidden = false;
    }

    /* ---- concurrency: an expected_version stamp + a reload bar ---- */
    const staleBar = el("div", { class: "lf-stale-bar no-print", hidden: "hidden" });
    let stale = false;
    function goStale() {
        stale = true;
        staleBar.replaceChildren(
            el("span", { text: "Someone else saved this record. Reload to pick up their change before editing further." }),
            el("button", {
                class: "btn sm", type: "button", text: "Reload",
                onClick: () => renderLiveForm(number, { slot })
            })
        );
        staleBar.hidden = false;
    }

    const save = debounce(async () => {
        if (stale) return;
        runRecompute(true);   // make sure persisted derived values are current
        const payload = { data: collectData() };
        if (meta) {
            payload.title = meta.titleInput.value.trim() || record.title;
            payload.severity = meta.severitySelect.value;
            payload.due_at = meta.dueInput.value || null;
        }
        if (version) payload.expected_version = version;
        try {
            const res = await api.updateRecord(number, payload);
            if (res && res.version) version = res.version;
            paintTodo();
        } catch (error) {
            if (error.status === 409 && error.payload && error.payload.code === "stale") { goStale(); return; }
            if (error.status === 422 && error.payload) {
                paintTodo("The last change was not saved", error.payload.rule_violations
                    || error.payload.schema_violations || [error.message]);
                return;
            }
            toast(error.message, "error");
        }
    }, 500);

    /* A keystroke updates the cheap flat-field aggregates only; leaving
       a field (change/blur) also writes derived table cells (one grid
       redraw) and refreshes the checklist. The record saves 500ms
       after the burst settles. */
    node.addEventListener("input", () => { runRecompute(false); save(); });
    node.addEventListener("change", () => { runRecompute(true); save(); paintTodo(); });
    runRecompute(true);
    paintTodo();

    /* ---- presence: who else has this open ---- */
    const presenceBar = el("div", { class: "presence-banner no-print", hidden: "hidden" });
    function paintPresence(editors) {
        if (!editors || !editors.length) { presenceBar.hidden = true; return; }
        const names = editors.map((e) => e.name);
        const who = names.length === 1
            ? names[0]
            : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
        presenceBar.textContent = who + (names.length === 1 ? " also has" : " also have")
            + " this record open. Whoever saves last wins.";
        presenceBar.hidden = false;
    }
    const stopPresence = beginEditing(number, paintPresence, () => false);
    liveTeardown = () => { stopPresence(); };

    /* ---- the rest of the record: workflow / links / files / history ---- */
    const context = buildRecordContext(record.type, number, {
        onWorkflow: () => renderLiveForm(number, { slot })
    });

    track.replaceChildren(
        staleBar,
        presenceBar,
        node,
        todoBox,
        el("div", { class: "no-print" }, [context]),
        el("div", { class: "section-label no-print", text: "Documents" }),
        el("div", { class: "panel-body no-print", id: slot + "-documents-panel" })
    );
    renderDocumentsPanel(record.number, slot + "-documents-panel");
}

/* A header fact - a label and either plain text or an editable control
   (Summary / Severity / Due when the record is being edited). */
function fact(label, value) {
    const valueNode = typeof value === "string"
        ? el("span", { class: "lf-fact-val", text: value })
        : value;
    if (typeof value !== "string") valueNode.classList.add("lf-fact-val");
    return el("div", { class: "lf-fact" }, [
        el("span", { class: "lf-fact-label", text: label }),
        valueNode
    ]);
}
