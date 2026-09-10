/* ============================================================
   Calibration Log - a designed, print-first bespoke layout for the
   `calibration_log` custom form.

   The schema (server/src/form-templates/calibration_log.json) is one
   `equipment` table, 14 columns. This renders it as a controlled
   measurement-equipment register: a document header, then a bordered
   grid with add / remove rows.

   Client calc (schema columns, stored on save so the register / PDF /
   Excel export all show them):
     next_cal_due_date = last_cal_date + interval_months
     days_until_due    = next_cal_due_date - today
     calibration_status = Past due (<0) / Due within 30 days (<=30) /
                          Current, or Inactive when record_status is.
   ============================================================ */

import { api } from "../api.js";
import { el, formatDate, humanize, debounce, toast } from "../dom.js";
import { recordLink } from "../record-nav.js";
import { renderDocumentsPanel } from "./resources.js";
import { workflowButtons } from "./change.js";

const COLUMNS = [
    { key: "equipment_id", label: "Equipment ID" },
    { key: "item_description", label: "Item description" },
    { key: "manufacturer", label: "Manufacturer" },
    { key: "model", label: "Model" },
    { key: "serial_number", label: "Serial no." },
    { key: "location", label: "Location" },
    { key: "last_cal_date", label: "Last cal", type: "date" },
    { key: "interval_months", label: "Interval (mo)", type: "number" },
    { key: "next_cal_due_date", label: "Next due", computed: true },
    { key: "days_until_due", label: "Days", computed: true },
    { key: "calibration_status", label: "Status", computed: true },
    { key: "calibrated_by", label: "Calibrated by" },
    { key: "cert_report_number", label: "Cert / report #" },
    { key: "record_status", label: "Active", type: "select", options: ["Active", "Inactive"] }
];

const DAY = 86400000;

function addMonths(iso, months) {
    if (!iso || !Number.isFinite(Number(months))) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    d.setMonth(d.getMonth() + Number(months));
    return d.toISOString().slice(0, 10);
}

/* fills next_cal_due_date, days_until_due, calibration_status from the
   row's own inputs - returns a { flag } class for the status cell */
function recompute(row) {
    row.next_cal_due_date = addMonths(row.last_cal_date, row.interval_months);
    let flag = "";
    if (row.record_status === "Inactive") {
        row.days_until_due = "";
        row.calibration_status = "Inactive";
        flag = "cal-inactive";
    } else if (row.next_cal_due_date) {
        const days = Math.round((new Date(row.next_cal_due_date).getTime() - Date.now()) / DAY);
        row.days_until_due = String(days);
        if (days < 0) { row.calibration_status = "Past due"; flag = "cal-past"; }
        else if (days <= 30) { row.calibration_status = "Due within 30 days"; flag = "cal-soon"; }
        else { row.calibration_status = "Current"; flag = "cal-ok"; }
    } else {
        row.days_until_due = "";
        row.calibration_status = "";
    }
    return flag;
}

export function buildCalLogForm(record, { editable = true } = {}) {
    const data = JSON.parse(JSON.stringify(record.data || {}));
    if (!Array.isArray(data.equipment)) data.equipment = [];
    data.equipment.forEach(recompute);

    const save = editable
        ? debounce(async () => {
            try { await api.updateRecord(record.number, { data: { equipment: data.equipment } }); }
            catch (error) { toast(error.message, "error"); }
        }, 500)
        : () => {};

    const body = el("tbody");

    function draw() {
        body.replaceChildren(...data.equipment.map((row, i) => {
            const flag = recompute(row);
            const tr = el("tr");
            for (const col of COLUMNS) {
                if (col.computed) {
                    tr.append(el("td", {
                        class: "cal-computed" + (col.key === "calibration_status" && flag ? " " + flag : "")
                    }, row[col.key] != null && row[col.key] !== ""
                        ? (col.type === "date" ? formatDate(row[col.key]) : String(row[col.key])) : "—"));
                    continue;
                }
                let control;
                if (!editable) {
                    control = el("div", { class: "cal-cell-val",
                        text: row[col.key] != null && row[col.key] !== ""
                            ? (col.type === "date" ? formatDate(row[col.key]) : String(row[col.key])) : "—" });
                } else if (col.type === "select") {
                    control = el("select", { class: "cal-in",
                        onChange: (e) => { row[col.key] = e.target.value; draw(); save(); } },
                    col.options.map((o) => el("option", { value: o, text: o,
                        selected: row[col.key] === o ? "selected" : undefined })));
                } else {
                    control = el("input", { class: "cal-in", type: col.type || "text",
                        onInput: (e) => {
                            row[col.key] = e.target.value;
                            if (col.key === "last_cal_date" || col.key === "interval_months") draw();
                            save();
                        } });
                    if (row[col.key] != null) control.setAttribute("value", row[col.key]);
                }
                tr.append(el("td", {}, control));
            }
            if (editable) {
                tr.append(el("td", { class: "cal-rm no-print" }, el("button", {
                    class: "link-btn", type: "button", text: "✕", title: "Remove row",
                    onClick: () => { data.equipment.splice(i, 1); draw(); save(); }
                })));
            }
            return tr;
        }));
    }
    draw();

    const grid = el("div", { class: "cal-grid-wrap" }, [
        el("table", { class: "cal-grid" }, [
            el("thead", {}, el("tr", {}, [
                ...COLUMNS.map((c) => el("th", { text: c.label })),
                editable ? el("th", { class: "no-print" }) : null
            ])),
            body
        ]),
        editable ? el("button", {
            class: "btn btn-xs no-print", type: "button", text: "+ Equipment",
            onClick: () => { data.equipment.push({ record_status: "Active" }); draw(); save(); }
        }) : null
    ]);

    const header = el("div", { class: "cal-doc-head" }, [
        el("div", { class: "cal-doc-title" }, [
            el("span", { class: "cal-doc-kicker", text: "Master Calibration Log" }),
            el("span", { class: "cal-doc-no", text: record.number })
        ]),
        el("div", { class: "cal-doc-facts" }, [
            el("div", {}, [el("span", { class: "cal-label", text: "Title" }),
                el("span", { class: "cal-val", text: record.title || "—" })]),
            el("div", {}, [el("span", { class: "cal-label", text: "Owner" }),
                el("span", { class: "cal-val", text: record.owner || "—" })]),
            el("div", {}, [el("span", { class: "cal-label", text: "Status" }),
                el("span", { class: "cal-val", text: humanize(record.status) })]),
            el("div", {}, [el("span", { class: "cal-label", text: "Opened" }),
                el("span", { class: "cal-val", text: formatDate(record.opened_at) })]),
            el("div", {}, [el("span", { class: "cal-label", text: "Printed" }),
                el("span", { class: "cal-val", text: formatDate(new Date().toISOString()) })])
        ])
    ]);

    return el("div", { class: "callog-sheet" }, [header, grid]);
}

export async function renderCalibrationLog(number, { slot = "record-view" } = {}) {
    const track = document.getElementById(slot + "-detail");
    const heading = document.getElementById(slot + "-detail-number");
    if (!track) return;
    track.replaceChildren(el("p", { class: "sm dim", text: "Loading…" }));

    try {
        const { record, links, transitions } = await api.record(number);
        if (heading) heading.textContent = record.number;

        const form = buildCalLogForm(record, { editable: true });

        const tail = [];
        if (links.length > 0) {
            tail.push(el("div", { class: "section-label", text: "Linked records" }));
            tail.push(el("div", { class: "chip-list" }, links.map((l) => recordLink(l))));
        }
        tail.push(...workflowButtons(record, transitions,
            () => renderCalibrationLog(number, { slot })));

        track.replaceChildren(
            form,
            el("div", { class: "section-label no-print", text: "Links & workflow" }),
            el("div", { class: "no-print" }, tail),
            el("div", { class: "section-label no-print", text: "Documents" }),
            el("div", { class: "panel-body no-print", id: slot + "-documents-panel" })
        );
        renderDocumentsPanel(record.number, slot + "-documents-panel");
    } catch (error) {
        track.replaceChildren(el("p", { class: "sm", style: "color:var(--crit)", text: error.message }));
    }
}
