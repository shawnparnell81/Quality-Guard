/* ============================================================
   Quality event registers.

   NCR, CAPA, complaint, audit and risk all render through the same
   function, because on the server they are all rows in the records
   table. Only the column list differs, so only the column list is
   written out per module - and the same is true of the detail panel
   below the register: one function, driven by whichever type it was
   asked for, rather than a screen written per type.
   ============================================================ */

import { api } from "../api.js";
import { can, applyPermissions } from "../session.js";
import { openRecordEditor, confirmStep, editDueDate, ensureDialog } from "../forms.js";
import { renderEightD, renderChange } from "./change.js";
import { renderApqpDetail } from "./apqp.js";
import { renderDiDetail } from "./di.js";
import { renderFairDetail } from "./fair.js";
import { renderPpapDetail } from "./ppap.js";
import { openEntityForm } from "../entity-form.js";
import { buildUploader } from "../attach-upload.js";
import { renderDocumentsPanel } from "./resources.js";
import { openFileWindow } from "../doc-windows.js";
import { recordLink, recordOpenLink, looksLikeRecordNumber, openRecord } from "../record-nav.js";
import { openRecordPage, converted } from "./record-page.js";
import { onStreamEvent } from "../stream.js";
import {
    el, pill, severity, recordId, fillTable, loadingRow, errorRow,
    formatDate, humanize, statusKind, toast
} from "../dom.js";

/* 8D and ECN keep their own register + detail rendering (change.js) -
   the eight-discipline track and the impact sign-off table are not
   the generic key/value detail every other type shares - so creating
   or editing one of these refreshes through those functions instead
   of REGISTERS/renderRecordDetail below. */
const OWN_SCREEN_REFRESH = {
    eightd: renderEightD,
    ecn: renderChange,
    apqp: (number) => renderApqpDetail(number),
    di: (number) => renderDiDetail(number),
    fair: (number) => renderFairDetail(number),
    ppap: (number) => renderPpapDetail(number)
};

/* Which sidebar screen "New X" and "Edit X" should return to once the
   full-page editor is done - the nav-item data-view values, not the
   record type keys, since a few of them differ (complaint -> the
   "complaints" screen, eightd -> "d8", ecn -> "change"). */
const TYPE_VIEW = {
    ncr: "ncr", capa: "capa", complaint: "complaints",
    audit: "audit", risk: "risk", eightd: "d8", ecn: "change", scar: "scar", fair: "fair", ppap: "ppap"
};

/* Shared first column: severity stripe plus record number. */
const idColumn = {
    className: "nowrap",
    sortKey: "number",
    render: (row) => [severity(row.severity), recordId(row.number)]
};

const statusColumn = {
    sortKey: "status",
    render: (row) => pill(humanize(row.status), statusKind(row.status))
};

const REGISTERS = {
    ncr: {
        tbody: "ncr-register",
        columns: [
            idColumn,
            { className: "mono sm nowrap", render: (row) => row.data.part_number || "-" },
            { className: "sm", sortKey: "title", render: (row) => row.title },
            { className: "num", render: (row) =>
                row.data.qty_affected != null ? row.data.qty_affected.toLocaleString() : "-" },
            { className: "sm", render: (row) => row.data.disposition || "-" },
            statusColumn
        ]
    },

    capa: {
        tbody: "capa-register",
        columns: [
            idColumn,
            { className: "sm", sortKey: "title", render: (row) => row.title },
            { className: "sm", render: (row) => row.owner || "-" },
            { className: "mono sm", render: (row) => dueCell(row) },
            statusColumn
        ]
    },

    complaint: {
        tbody: "complaint-register",
        columns: [
            idColumn,
            { className: "sm", render: (row) => row.data.customer || "-" },
            { className: "sm", sortKey: "title", render: (row) => row.title },
            { className: "num", render: (row) =>
                row.data.qty != null ? row.data.qty.toLocaleString() : "-" },
            { className: "mono sm", render: (row) =>
                row.closed_at ? "closed" : dueCell(row) },
            statusColumn
        ]
    },

    audit: {
        tbody: "audit-register",
        columns: [
            idColumn,
            { className: "sm", render: (row) => row.data.scope || row.title },
            { className: "sm", render: (row) => row.data.auditor || "-" },
            { className: "mono sm", render: (row) => formatDate(row.data.planned) },
            statusColumn
        ]
    },

    risk: {
        tbody: "risk-table",
        columns: [
            { className: "mono sm", render: (row) => row.number },
            { className: "sm", sortKey: "title", render: (row) => row.title },
            { className: "sm dim", render: (row) => row.data.process || "-" },
            { className: "num", render: (row) => row.data.severity ?? "-" },
            { className: "num", render: (row) => row.data.occurrence ?? "-" },
            { className: "num", render: (row) => row.data.detection ?? "-" },
            { className: "num", render: (row) => rpnCell(row.data.rpn) },
            { className: "sm", render: (row) => row.data.action || "-" },
            statusColumn
        ]
    },

    apqp: {
        tbody: "apqp-register",
        columns: [
            idColumn,
            { className: "sm", render: (row) => row.data.customer || "-" },
            { className: "sm", sortKey: "title", render: (row) => row.title },
            { className: "mono sm nowrap", render: (row) => row.data.part_number || "-" },
            { className: "mono sm", render: (row) => formatDate(row.data.target_sop) },
            { className: "sm dim", render: (row) => row.data.psw_status || "-" },
            statusColumn
        ]
    },

    di: {
        tbody: "di-register",
        columns: [
            idColumn,
            { className: "sm", render: (row) => row.data.department || "-" },
            { className: "sm", render: (row) => row.data.finding || row.title },
            { className: "sm dim", render: (row) => row.data.investigator || "-" },
            statusColumn
        ]
    },

    scar: {
        tbody: "scar-register",
        columns: [
            idColumn,
            { className: "sm", render: (row) => row.data.supplier || "-" },
            { className: "sm", sortKey: "title", render: (row) => row.title },
            { className: "mono sm nowrap", render: (row) => row.data.part_number || "-" },
            { className: "mono sm", render: (row) => scarDueCell(row) },
            statusColumn
        ]
    },

    fair: {
        tbody: "fair-register",
        columns: [
            idColumn,
            { className: "mono sm nowrap", render: (row) =>
                (row.data.part_number || "-") + (row.data.revision ? " / " + row.data.revision : "") },
            { className: "sm", render: (row) => row.data.customer || "-" },
            { className: "mono sm", render: (row) => formatDate(row.data.inspection_date) },
            { className: "num", render: (row) => {
                const checked = Number(row.data.checked_count) || 0;
                if (checked === 0) return "-";
                const nc = checked - (Number(row.data.conforming_count) || 0);
                const text = (checked - nc) + " / " + checked;
                return nc > 0 ? el("span", { style: "color:var(--crit)", text }) : text;
            } },
            statusColumn
        ]
    },

    ppap: {
        tbody: "ppap-register",
        columns: [
            idColumn,
            { className: "mono sm nowrap", render: (row) =>
                (row.data.part_number || "-") + (row.data.revision ? " / " + row.data.revision : "") },
            { className: "sm", render: (row) => row.data.customer || "-" },
            { className: "sm", render: (row) => (row.data.submission_level || "-").replace("Level ", "L") },
            { className: "sm dim", render: (row) => row.data.reason || "-" },
            statusColumn
        ]
    }
};

/* A SCAR's own due date is the supplier's response deadline, carried
   in data.response_due rather than the shared records.due_at column,
   so it needs its own overdue check. */
function scarDueCell(row) {
    const due = row.data.response_due;
    if (!due) return "-";
    const overdue = row.status !== "closed" && new Date(due) < new Date();
    const text = formatDate(due) + (overdue ? " overdue" : "");
    return overdue ? el("span", { style: "color:var(--crit)", text }) : text;
}

/* An overdue date is worth colouring, because it is the one thing on
   these screens that means someone has to act today. */
function dueCell(row) {
    if (!row.due_at) return "-";

    const overdue = !row.closed_at && new Date(row.due_at) < new Date();
    const text = formatDate(row.due_at) + (overdue ? " overdue" : "");

    return overdue
        ? el("span", { style: "color:var(--crit)", text })
        : text;
}

function rpnCell(rpn) {
    if (rpn == null) return "-";

    const colour = rpn >= 150 ? "var(--crit)" : rpn >= 100 ? "var(--warn)" : null;
    return colour ? el("span", { style: "color:" + colour, text: rpn }) : String(rpn);
}

/* A detail-view <dd>. A value that is just another record's number
   ("Work order", "Source", a receipt's NCR) becomes a link to it. */
function fieldValueDd(field, value) {
    if (field && field.type === "boolean") {
        return el("dd", { text: (value === true || value === "true") ? "Yes" : "No" });
    }
    const text = String(value).trim();
    if (looksLikeRecordNumber(text)) {
        return el("dd", {}, recordLink(text, { chip: false }));
    }
    return el("dd", { text: field && field.type === "date" ? formatDate(value) : text });
}

/* Severity and open-only, per type. The server already understood
   these query params (records.js) - nothing here needed a backend
   change, only a control to actually send them. */
const activeFilters = {};
const PAGE_SIZE = 50;

/* tbody id -> register type, so selectRow (which only gets the tbody)
   can remember what is selected without every call site passing the
   type in. */
const TBODY_TYPE = Object.fromEntries(
    Object.entries(REGISTERS).map(([type, config]) => [config.tbody, type])
);
/* The record the user last had selected in each register. A live
   refresh keeps it selected instead of snapping back to the first
   row. */
const lastSelected = {};

/* A register's sort / search / page state survives navigation and a
   reload, per type and browser. The severity and open filters from
   the markup feed the same object. */
function loadView(type) {
    if (activeFilters[type]) return activeFilters[type];
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem("qmsg:regview:v1:" + type) || "{}"); }
    catch { stored = {}; }
    activeFilters[type] = {
        severity: stored.severity || "",
        open: Boolean(stored.open),
        q: stored.q || "",
        sort: stored.sort || "opened",
        dir: stored.dir === "asc" ? "asc" : "desc",
        offset: 0
    };
    return activeFilters[type];
}

function saveView(type) {
    const v = activeFilters[type] || {};
    try {
        localStorage.setItem("qmsg:regview:v1:" + type, JSON.stringify({
            severity: v.severity || "", open: !!v.open, q: v.q || "",
            sort: v.sort || "opened", dir: v.dir || "desc"
        }));
    } catch { /* private mode */ }
}

function currentFilterParams(type) {
    const v = loadView(type);
    return {
        type,
        severity: v.severity || undefined,
        open: v.open ? "true" : undefined,
        q: v.q || undefined,
        sort: v.sort || undefined,
        dir: v.dir || undefined,
        limit: PAGE_SIZE,
        offset: v.offset || 0
    };
}

function hasActiveFilter(type) {
    const v = activeFilters[type] || {};
    return Boolean(v.severity || v.open || (v.q && v.q.trim()));
}

/* Injects a search box + a paging footer into a register's panel the
   first time it renders, so index.html needs no per-register markup.
   Returns the two nodes to update on each render. */
function registerChrome(type, config) {
    const tbody = document.getElementById(config.tbody);
    const panel = tbody && tbody.closest(".panel");
    if (!panel) return {};

    let toolbar = panel.querySelector(":scope > .reg-toolbar");
    if (!toolbar) {
        const search = el("input", {
            type: "search", class: "reg-search", placeholder: "Search number or title...",
            "aria-label": "Search this register by number or title",
            value: (activeFilters[type] || {}).q || ""
        });
        let debounce = null;
        search.addEventListener("input", () => {
            clearTimeout(debounce);
            debounce = setTimeout(() => {
                const v = loadView(type);
                v.q = search.value;
                v.offset = 0;
                saveView(type);
                renderRegister(type);
            }, 250);
        });
        const exportLink = el("a", {
            class: "btn btn-xs reg-export", text: "Export", title: "Download this view as Excel"
        });
        const kids = [search, exportLink];

        /* Import sits next to the panel's own "New" button and follows
           the same permission - if that button is not on the page,
           this user cannot create records of this type. */
        const newBtn = panel.querySelector("[data-new-record]");
        if (newBtn && !newBtn.hidden) {
            const importBtn = el("button", {
                class: "btn btn-xs reg-import", type: "button", text: "Import",
                title: "Create records in bulk from an Excel file"
            });
            importBtn.addEventListener("click", () => openRegisterImport(type));
            kids.push(importBtn);
        }

        toolbar = el("div", { class: "reg-toolbar no-print" }, kids);
        const head = panel.querySelector(":scope > .panel-head");
        if (head) head.after(toolbar); else panel.prepend(toolbar);
    }

    /* Keep the export link pointed at the currently filtered / sorted
       set (never the page - the server export ignores limit/offset). */
    const exportLink = toolbar.querySelector(".reg-export");
    if (exportLink) {
        const p = currentFilterParams(type);
        delete p.limit;
        delete p.offset;
        exportLink.href = api.recordsExportUrl(p);
    }

    let pager = panel.querySelector(":scope > .reg-pager");
    if (!pager) {
        pager = el("div", { class: "reg-pager no-print" });
        (panel.querySelector(":scope > .table-wrap") || panel).after(pager);
    }

    /* Sort headers: match each <th> to a column's sortKey by position.
       The control is a real <button> inside the cell rather than a
       role on the <th> itself - the cell has to stay a columnheader
       for aria-sort below to mean anything, and for the data cells
       under it to keep their header. Enter and Space come free. */
    const headRow = tbody.closest("table")?.tHead?.rows[0];
    if (headRow && !headRow.dataset.sortWired) {
        headRow.dataset.sortWired = "1";
        config.columns.forEach((col, index) => {
            const th = headRow.cells[index];
            if (!th || !col.sortKey) return;
            th.classList.add("th-sortable");
            const sort = () => {
                const v = loadView(type);
                if (v.sort === col.sortKey) v.dir = v.dir === "asc" ? "desc" : "asc";
                else { v.sort = col.sortKey; v.dir = "asc"; }
                v.offset = 0;
                saveView(type);
                renderRegister(type);
            };
            const button = el("button", {
                class: "th-sort-btn", type: "button", text: th.textContent
            });
            button.addEventListener("click", sort);
            th.replaceChildren(button);
        });
    }
    const v = activeFilters[type] || {};
    if (headRow) {
        config.columns.forEach((col, index) => {
            const th = headRow.cells[index];
            if (!th || !col.sortKey) return;
            const active = v.sort === col.sortKey;
            th.dataset.sortDir = active ? v.dir : "";
            th.setAttribute("aria-sort",
                active ? (v.dir === "asc" ? "ascending" : "descending") : "none");
        });
    }

    /* Keep the markup's severity / open controls showing the restored
       view. */
    const sevSelect = panel.querySelector('.filter-severity[data-type="' + type + '"]');
    if (sevSelect && sevSelect.value !== (v.severity || "")) sevSelect.value = v.severity || "";
    const openBox = panel.querySelector('.filter-open input[data-type="' + type + '"]');
    if (openBox) openBox.checked = Boolean(v.open);
    const search = toolbar.querySelector(".reg-search");
    if (search && document.activeElement !== search && search.value !== (v.q || "")) {
        search.value = v.q || "";
    }

    return { pager };
}

/* ---------- bulk import ----------
   A small two-step dialog: pick a file and preview (the server's
   dry run), then commit. The blank template link and every row-level
   problem come straight from the API. */
function openRegisterImport(type) {
    const dialog = ensureDialog();
    const label = humanize(type);
    let lastValidCount = 0;

    const fileInput = el("input", { type: "file", accept: ".xlsx", class: "imp-file" });
    const report = el("div", { class: "imp-report" });
    const previewBtn = el("button", { class: "btn btn-xs", type: "button", text: "Preview" });
    const commitBtn = el("button", { class: "btn btn-primary", type: "button", text: "Import", disabled: true });

    const setBusy = (busy) => {
        previewBtn.disabled = busy || !fileInput.files.length;
        commitBtn.disabled = busy || lastValidCount === 0;
    };

    const renderResult = (data, committed) => {
        report.replaceChildren();
        if (committed) {
            report.append(el("p", { class: "imp-ok",
                text: data.created_count + " " + label + " record" + (data.created_count === 1 ? "" : "s")
                    + " created" + (data.skipped ? ", " + data.skipped + " skipped" : "") + "." }));
        } else {
            report.append(el("p", {
                text: data.will_create + " of " + data.total_rows + " row"
                    + (data.total_rows === 1 ? "" : "s") + " will be created"
                    + (data.errors.length ? ", " + data.errors.length + " skipped." : ".")
            }));
        }
        for (const w of data.warnings || []) {
            report.append(el("p", { class: "imp-warn", text: w }));
        }
        if (data.errors && data.errors.length) {
            const list = el("ul", { class: "imp-errs" });
            for (const e of data.errors.slice(0, 50)) {
                list.append(el("li", {}, [
                    el("span", { class: "imp-row", text: "Row " + e.row + " " }),
                    el("span", { text: (e.title ? "“" + e.title + "”: " : "") + e.messages.join("; ") })
                ]));
            }
            report.append(list);
        }
    };

    const run = async (dryRun) => {
        if (!fileInput.files.length) return;
        setBusy(true);
        const fd = new FormData();
        fd.append("file", fileInput.files[0]);
        try {
            const data = await api.importRecords(type, fd, dryRun);
            if (dryRun) {
                lastValidCount = data.will_create;
                renderResult(data, false);
            } else {
                renderResult(data, true);
                fileInput.value = "";
                lastValidCount = 0;
                toast(data.created_count + " record" + (data.created_count === 1 ? "" : "s") + " imported");
                renderRegister(type);
            }
        } catch (err) {
            lastValidCount = 0;
            const payload = err.payload || {};
            report.replaceChildren(el("p", { class: "imp-warn", text: payload.error || err.message }));
            if (Array.isArray(payload.errors)) {
                const list = el("ul", { class: "imp-errs" });
                for (const e of payload.errors.slice(0, 50)) {
                    list.append(el("li", { text: "Row " + e.row + ": " + (e.messages || []).join("; ") }));
                }
                report.append(list);
            }
        } finally {
            setBusy(false);
        }
    };

    /* Same create permission as raising one of these. Fetched rather
       than linked, so a refusal is a toast instead of a JSON tab. */
    const createPermission = document.querySelector('[data-new-record="' + type + '"]')
        ?.dataset.requires;
    const downloadTemplate = async () => {
        try {
            await api.downloadRecordsImportTemplate(type);
        } catch (err) {
            toast(err.message, "error");
        }
    };

    fileInput.addEventListener("change", () => {
        lastValidCount = 0;
        report.replaceChildren();
        setBusy(false);
    });
    previewBtn.addEventListener("click", () => run(true));
    commitBtn.addEventListener("click", () => run(false));

    dialog.replaceChildren(
        el("div", { class: "modal-head" },
            el("h2", { class: "modal-title", text: "Import " + label + " from Excel" })),
        el("div", { class: "modal-body imp" }, [
            el("p", { class: "sm", style: "margin:0 0 12px" }, [
                "One row per record. ",
                el("button", {
                    class: "link-btn", type: "button", text: "Download a blank template",
                    "data-requires": createPermission || undefined,
                    onClick: downloadTemplate
                }),
                " with the right columns."
            ]),
            fileInput,
            el("div", { class: "row", style: "gap:8px; margin:10px 0" }, [previewBtn]),
            report
        ]),
        el("div", { class: "modal-foot" }, [
            el("button", { class: "btn", type: "button", text: "Close", onClick: () => dialog.close() }),
            commitBtn
        ])
    );
    applyPermissions(dialog);
    dialog.showModal();
}

export async function renderRegister(type) {
    const config = REGISTERS[type];
    if (!config) return;

    loadView(type);
    const tbody = document.getElementById(config.tbody);
    loadingRow(tbody, config.columns.length);
    const { pager } = registerChrome(type, config);

    try {
        const { records, total } = await api.records(currentFilterParams(type));
        const view = activeFilters[type];

        fillTable(tbody, records, config.columns,
            hasActiveFilter(type) ? "No records match this filter" : "No records of this type yet");

        if (pager) {
            const t = Number(total ?? records.length);
            const from = t === 0 ? 0 : view.offset + 1;
            const to = view.offset + records.length;
            const prev = el("button", { class: "btn btn-xs", type: "button", text: "Prev" });
            const next = el("button", { class: "btn btn-xs", type: "button", text: "Next" });
            prev.disabled = view.offset === 0;
            next.disabled = to >= t;
            prev.addEventListener("click", () => {
                view.offset = Math.max(0, view.offset - PAGE_SIZE);
                renderRegister(type);
            });
            next.addEventListener("click", () => {
                view.offset += PAGE_SIZE;
                renderRegister(type);
            });
            pager.replaceChildren(
                el("span", { class: "sm dim", text: t === 0 ? "No records" : "Showing " + from + "-" + to + " of " + t }),
                el("span", { class: "row", style: "gap:6px" }, [prev, next])
            );
        }

        /* Tag each row with its record number so one delegated listener
           can work out what was clicked. fillTable emits rows in the
           order it was given them, so index lines up with the data. */
        tbody.querySelectorAll("tr").forEach((tr, index) => {
            if (!records[index]) return;
            tr.dataset.number = records[index].number;
            tr.classList.add("row-clickable");
            /* roving tabindex: the list is one tab stop, arrows move
               within it (selectRow keeps the 0 on the current row) */
            tr.tabIndex = -1;
        });

        /* Every register shows one record in full, not only NCR. On a
           re-render (a live update, a filter change) keep whatever was
           selected if it is still in the list, rather than snapping
           back to the top. */
        if (records.length > 0) {
            const remembered = lastSelected[type];
            const keep = remembered && records.some((r) => r.number === remembered)
                ? remembered : records[0].number;
            selectRow(tbody, keep);
            await renderRecordDetail(type, keep);
        } else {
            clearDetail(type);
        }

        /* Computed from exactly what is on screen right now (so it
           tracks whatever filter is active), the same overdue rule
           every other module uses: still open, and past its due date. */
        const overdueNote = document.getElementById(type + "-overdue-note");
        if (overdueNote) {
            const overdue = records.filter((r) =>
                !r.closed_at && r.due_at && new Date(r.due_at) < new Date()).length;
            overdueNote.textContent = overdue === 1 ? "1 overdue" : overdue + " overdue";
            overdueNote.hidden = overdue === 0;
        }

        if (type === "risk") renderRiskMatrix(records);
    } catch (error) {
        errorRow(tbody, config.columns.length, error);
    }
}

/* ============================================================
   Risk matrix - severity x occurrence, the standard FMEA heat map.
   Detection is deliberately left out of the grid itself (it already
   factors into RPN, shown in the register below); severity x
   occurrence is what a risk matrix conventionally plots.
   ============================================================ */

let riskRecordsCache = [];

function riskLevel(score) {
    if (score >= 50) return "crit";
    if (score >= 20) return "warn";
    return "ok";
}

function renderRiskMatrix(records) {
    const container = document.getElementById("risk-matrix");
    if (!container) return;

    riskRecordsCache = records;

    const counts = {};
    for (const record of records) {
        const sev = record.data?.severity;
        const occ = record.data?.occurrence;
        /* Opportunities and anything scored outside 1-10 do not plot
           on a risk matrix - skipped rather than forced into a cell
           that would misrepresent them. */
        if (!Number.isInteger(sev) || !Number.isInteger(occ)) continue;
        if (sev < 1 || sev > 10 || occ < 1 || occ > 10) continue;

        const key = sev + "," + occ;
        counts[key] = (counts[key] || 0) + 1;
    }

    const grid = el("div", { class: "risk-matrix-grid" });

    grid.append(el("div", { class: "rm-corner", text: "Sev \\ Occ" }));
    for (let occ = 1; occ <= 10; occ++) {
        grid.append(el("div", { class: "rm-axis-label", text: String(occ) }));
    }

    for (let sev = 10; sev >= 1; sev--) {
        grid.append(el("div", { class: "rm-axis-label", text: String(sev) }));

        for (let occ = 1; occ <= 10; occ++) {
            const n = counts[sev + "," + occ] || 0;
            const level = riskLevel(sev * occ);

            const cell = el("button", {
                type: "button",
                class: "rm-cell rm-" + level + (n === 0 ? " rm-empty" : ""),
                title: "Severity " + sev + " × occurrence " + occ + ": " + n + " risk(s)"
            }, n > 0 ? String(n) : "");

            if (n > 0) {
                cell.addEventListener("click", () => filterRiskMatrixCell(sev, occ));
            }

            grid.append(cell);
        }
    }

    container.replaceChildren(
        grid,
        el("div", { class: "risk-matrix-legend" }, [
            el("span", { class: "rm-legend-item" }, [el("span", { class: "rm-swatch rm-ok" }), "Low"]),
            el("span", { class: "rm-legend-item" }, [el("span", { class: "rm-swatch rm-warn" }), "Medium"]),
            el("span", { class: "rm-legend-item" }, [el("span", { class: "rm-swatch rm-crit" }), "High"])
        ])
    );
}

/* Filters the already-fetched list client-side rather than adding a
   backend query param nothing else needs - clicking a cell is asking
   "which of what I already have sits here," not a new search. */
function filterRiskMatrixCell(severity, occurrence) {
    const config = REGISTERS.risk;
    const tbody = document.getElementById(config.tbody);
    if (!tbody) return;

    const matching = riskRecordsCache.filter((r) =>
        r.data?.severity === severity && r.data?.occurrence === occurrence);

    fillTable(tbody, matching, config.columns, "No records match this cell");

    tbody.querySelectorAll("tr").forEach((tr, index) => {
        if (!matching[index]) return;
        tr.dataset.number = matching[index].number;
        tr.classList.add("row-clickable");
    });

    if (matching.length > 0) {
        selectRow(tbody, matching[0].number);
        renderRecordDetail("risk", matching[0].number);
    }
}

function selectRow(tbody, number) {
    tbody.querySelectorAll("tr").forEach((tr) => {
        const on = tr.dataset.number === number;
        tr.classList.toggle("row-selected", on);
        if (tr.dataset.number) {
            tr.tabIndex = on ? 0 : -1;
            tr.setAttribute("aria-selected", on ? "true" : "false");
        }
    });
    const type = TBODY_TYPE[tbody.id];
    if (type && number) lastSelected[type] = number;
}

function clearDetail(type) {
    const heading = document.getElementById(type + "-detail-number");
    const statusSlot = document.getElementById(type + "-detail-status");
    const panel = document.getElementById(type + "-detail");
    const pdfButton = document.getElementById(type + "-pdf");
    const editButton = document.getElementById(type + "-edit");

    if (heading) heading.textContent = "Select a record";
    if (statusSlot) statusSlot.replaceChildren();
    if (panel) panel.replaceChildren();
    if (pdfButton) delete pdfButton.dataset.number;
    if (editButton) delete editButton.dataset.number;
}

/* Open a register row. A converted type (record-page.js) takes over
   the whole content area; a type still on the old layout renders into
   its side panel as before. */
async function openRow(type, tbody, number) {
    if (await openRecordPage(number, { type, returnView: type })) return;
    renderRecordDetail(type, number);
}

/* One listener per register, attached once when this module loads.
   Rows are replaced on every fetch, so a listener per row would have
   to be rebuilt each time; these never are. */
export function wireRegisterClicks() {
    for (const [type, config] of Object.entries(REGISTERS)) {
        const tbody = document.getElementById(config.tbody);
        if (!tbody) continue;

        tbody.addEventListener("click", (event) => {
            const row = event.target.closest("tr[data-number]");
            if (!row) return;

            /* Alt-click opens the record in the side-by-side workspace,
               beside anything already there, instead of replacing the
               current surface. */
            if (event.altKey) {
                event.preventDefault();
                selectRow(tbody, row.dataset.number);
                openRecord(row.dataset.number, type, { pane: true });
                return;
            }

            /* A modified click (Ctrl/Cmd/middle/Shift) on the record-
               number link opens the record in its own browser tab -
               let the browser do that and leave the side panel alone.
               A plain click stays on the fast in-page side panel. */
            const onIdLink = event.target.closest("a.rec-id");
            if (onIdLink && (event.ctrlKey || event.metaKey || event.shiftKey)) return;
            if (onIdLink) event.preventDefault();

            selectRow(tbody, row.dataset.number);
            openRow(type, tbody, row.dataset.number);
        });

        /* Arrow keys walk the register, Home/End jump to the ends,
           Enter re-opens the selected row's detail. The list is a
           single tab stop (roving tabindex, set in selectRow). */
        tbody.addEventListener("keydown", (event) => {
            const rows = [...tbody.querySelectorAll("tr[data-number]")];
            if (rows.length === 0) return;
            const current = event.target.closest("tr[data-number]")
                || tbody.querySelector("tr.row-selected");
            const at = current ? rows.indexOf(current) : -1;

            let next = null;
            if (event.key === "ArrowDown") next = rows[Math.min(at + 1, rows.length - 1)];
            else if (event.key === "ArrowUp") next = rows[Math.max(at - 1, 0)];
            else if (event.key === "Home") next = rows[0];
            else if (event.key === "End") next = rows[rows.length - 1];
            else if (event.key === "Enter" && current) {
                event.preventDefault();
                openRow(type, tbody, current.dataset.number);
                return;
            } else {
                return;
            }

            event.preventDefault();
            if (!next) return;
            selectRow(tbody, next.dataset.number);
            next.focus();
            renderRecordDetail(type, next.dataset.number);
        });

        /* Both buttons act on whatever record the detail panel is
           showing - renderRecordDetail stamps its number onto the PDF
           button's dataset each time. Print opens the branded, full-
           page PDF form inline in a new tab (the on-screen panel is a
           summary, not a form); PDF downloads the same file. */
        const currentNumber = () => document.getElementById(type + "-pdf")?.dataset.number;

        const printButton = document.getElementById(type + "-print");
        if (printButton) {
            printButton.addEventListener("click", () => {
                const number = currentNumber();
                if (number) {
                    window.open("/api/records/" + encodeURIComponent(number) + "/pdf?inline=1", "_blank");
                }
            });
        }

        const pdfButton = document.getElementById(type + "-pdf");
        if (pdfButton) {
            pdfButton.addEventListener("click", () => {
                const number = pdfButton.dataset.number;
                if (!number) return;
                api.downloadRecordPdf(number, { onWait: () => toast("Preparing the PDF…") })
                    .catch((error) => toast(error.message, "error"));
            });
        }
    }

    /* "/" from anywhere but a text field jumps to the search box of
       whichever register is on screen. */
    document.addEventListener("keydown", (event) => {
        if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
        const t = event.target;
        if (t && (t.isContentEditable
            || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
        const view = [...document.querySelectorAll(".view")].find((v) => !v.hidden);
        const search = view && view.querySelector(".reg-search");
        if (search) {
            event.preventDefault();
            search.focus();
            search.select();
        }
    });

    /* One delegated listener for every severity dropdown and every
       "open only" checkbox, across every register - each element
       says which type it belongs to, so this never needs to know how
       many registers exist. */
    document.addEventListener("change", (event) => {
        const severitySelect = event.target.closest(".filter-severity");
        if (severitySelect && severitySelect.dataset.type) {
            const type = severitySelect.dataset.type;
            const v = loadView(type);
            v.severity = severitySelect.value;
            v.offset = 0;
            saveView(type);
            renderRegister(type);
            return;
        }

        const openCheckbox = event.target.closest(".filter-open input");
        if (openCheckbox && openCheckbox.dataset.type) {
            const type = openCheckbox.dataset.type;
            const v = loadView(type);
            v.open = openCheckbox.checked;
            v.offset = 0;
            saveView(type);
            renderRegister(type);
        }
    });

    /* Live updates: when the server says a record changed, refresh the
       register that is currently on screen. Debounced so a bulk import
       (dozens of frames) redraws once, and held off while a dialog is
       open so an edit in progress is never yanked out from under the
       user. renderRegister keeps the current selection. */
    const visibleRegister = () => {
        const entry = Object.entries(REGISTERS).find(([, config]) => {
            const tbody = document.getElementById(config.tbody);
            const view = tbody && tbody.closest(".view");
            return view && !view.hidden;
        });
        return entry ? entry[0] : null;
    };
    let liveTimer = null;
    onStreamEvent("records", () => {
        if (document.querySelector("dialog[open]") || !visibleRegister()) return;
        clearTimeout(liveTimer);
        liveTimer = setTimeout(() => {
            const type = visibleRegister();
            if (type && !document.querySelector("dialog[open]")) renderRegister(type);
        }, 400);
    });

    /* Every "raise a record" and "edit this record" button on every
       screen, through one listener each. The button says which type
       it opens, and edit buttons carry the currently-shown record's
       number in their dataset (stamped by renderRecordDetail, or by
       the type's own detail renderer for 8D and ECN). */
    document.addEventListener("click", (event) => {
        const newButton = event.target.closest("[data-new-record]");
        if (newButton && !newButton.disabled) {
            const type = newButton.dataset.newRecord;

            document.dispatchEvent(new CustomEvent("navigate", { detail: { view: "record-editor" } }));
            openRecordEditor(type, {
                returnView: TYPE_VIEW[type] || type,
                onSaved: async (created) => {
                    /* A converted type lands back on its register (the
                       navigate below reopens it and its LOADER re-runs);
                       the new record is in the list, a click opens its
                       full page. */
                    if (converted(type)) return;

                    if (OWN_SCREEN_REFRESH[type]) {
                        await OWN_SCREEN_REFRESH[type](created.number);
                    } else if (REGISTERS[type]) {
                        await renderRegister(type);

                        /* Land on the thing that was just created rather
                           than leaving somebody to hunt for it. */
                        const register = document.getElementById(REGISTERS[type].tbody);
                        if (register) selectRow(register, created.number);
                        await renderRecordDetail(type, created.number);
                    }
                }
            });
            return;
        }

        const editButton = event.target.closest("[data-edit-record]");
        if (editButton && !editButton.disabled) {
            const type = editButton.dataset.editRecord;
            const number = editButton.dataset.number;
            if (!number) return;

            document.dispatchEvent(new CustomEvent("navigate", { detail: { view: "record-editor" } }));
            openRecordEditor(type, {
                number,
                returnView: converted(type) ? "record" : (TYPE_VIEW[type] || type),
                onSaved: async (updated) => {
                    if (converted(type)) {
                        await openRecordPage(updated.number, { type, keepReturn: true });
                    } else if (OWN_SCREEN_REFRESH[type]) {
                        await OWN_SCREEN_REFRESH[type](updated.number);
                    } else if (REGISTERS[type]) {
                        await renderRegister(type);
                        const register = document.getElementById(REGISTERS[type].tbody);
                        if (register) selectRow(register, updated.number);
                        await renderRecordDetail(type, updated.number);
                    }
                }
            });
        }
    });
}

/* ---------- detail panel ---------- */

const DETAIL_FIELDS = [
    ["Customer",              (d) => d.customer],
    ["Contact",               (d) => d.contact],
    ["Part",                  (d) => d.part_number],
    ["Lot / serial",          (d) => d.lot_number],
    ["Work order",            (d) => d.work_order],
    ["Operation",             (d) => d.operation],
    ["Characteristic",        (d) => d.characteristic],
    ["Measured",              (d) => d.measured],
    ["Gage",                  (d) => d.gage_id],
    ["Detected at",           (d) => d.detected_at],
    ["Qty affected",          (d) => d.qty_affected],
    ["Quantity",              (d) => d.qty],
    ["Disposition",           (d) => d.disposition],
    ["Containment",           (d) => d.containment],
    ["Source",                (d) => d.source],
    ["Problem statement",     (d) => d.problem_statement],
    ["Root cause",            (d) => d.root_cause],
    ["Corrective action",     (d) => d.corrective_action],
    ["Effectiveness criterion", (d) => d.effectiveness_criterion],
    ["Description",           (d) => d.description],
    ["Scope",                 (d) => d.scope],
    ["Auditor",                (d) => d.auditor],
    ["Planned",               (d) => d.planned],
    ["Process",               (d) => d.process],
    ["Severity",              (d) => d.severity],
    ["Occurrence",            (d) => d.occurrence],
    ["Detection",             (d) => d.detection],
    ["Action",                (d) => d.action],
    ["Target SOP",            (d) => d.target_sop],
    ["PPAP level",            (d) => d.ppap_level],
    ["PSW status",            (d) => d.psw_status],
    ["Top program risks",     (d) => d.program_risk_summary],
    ["Lessons learned",       (d) => d.lessons_learned]
];

/* `slot` is the id prefix the detail is written into. It defaults to
   `type` (the old per-register side panel: #<type>-detail,
   #<type>-pdf, ...); every record screen now passes slot:"record-view"
   from record-page.js so the detail fills the full-page #view-record
   instead. The `slot === type` branches below are the retired
   side-panel path, kept only so a stray call no-ops cleanly. */
export async function renderRecordDetail(type, number, { slot = type } = {}) {
    /* Re-render this same record in the same place - used by the
       in-panel mutators (link, unlink, attach, change due date). */
    const rerender = () => renderRecordDetail(type, number, { slot });

    /* APQP is not the generic key/value detail - it is built around its
       three deliverable documents and a phase gate (apqp.js). */
    if (type === "apqp") {
        const pdfButton = document.getElementById(slot + "-pdf");
        if (pdfButton) pdfButton.dataset.number = number;
        const editButton = document.getElementById(slot + "-edit");
        if (editButton) editButton.dataset.number = number;
        return renderApqpDetail(number, { slot });
    }

    /* A DI is built around its three investigation-form slots (di.js). */
    if (type === "di") {
        const pdfButton = document.getElementById(slot + "-pdf");
        if (pdfButton) pdfButton.dataset.number = number;
        return renderDiDetail(number, { slot });
    }

    /* A FAIR renders its characteristic table with computed pass/fail
       (fair.js). */
    if (type === "fair") {
        const pdfButton = document.getElementById(slot + "-pdf");
        if (pdfButton) pdfButton.dataset.number = number;
        const editButton = document.getElementById(slot + "-edit");
        if (editButton) editButton.dataset.number = number;
        return renderFairDetail(number, { slot });
    }

    /* A PPAP is built around its 18 element slots and the submit gate
       (ppap.js). */
    if (type === "ppap") {
        const pdfButton = document.getElementById(slot + "-pdf");
        if (pdfButton) pdfButton.dataset.number = number;
        const editButton = document.getElementById(slot + "-edit");
        if (editButton) editButton.dataset.number = number;
        return renderPpapDetail(number, { slot });
    }

    const panel = document.getElementById(slot + "-detail");
    const heading = document.getElementById(slot + "-detail-number");
    const statusSlot = document.getElementById(slot + "-detail-status");

    if (!panel) return;

    panel.replaceChildren(el("p", { class: "sm dim", text: "Loading..." }));

    try {
        const { record, links, history, transitions } = await api.record(number);
        const [attachData, schemaDef] = await Promise.all([
            api.attachments(number),
            api.recordForm(type, { version: record.form_version }).catch(() => null)
        ]);
        const attachments = attachData.attachments;

        /* On a register side panel the heading doubles as an
           open-in-new-tab link; on the full-page view it is the page
           <h1>, so just the number. */
        if (heading) {
            heading.replaceChildren(slot === type
                ? recordOpenLink(record.number)
                : document.createTextNode(record.number));
        }

        const pdfButton = document.getElementById(slot + "-pdf");
        if (pdfButton) pdfButton.dataset.number = record.number;

        const editButton = document.getElementById(slot + "-edit");
        if (editButton) editButton.dataset.number = record.number;

        /* Only apqp has a Documents panel in the markup today - this
           is written to key off that element's presence rather than
           the type, so any other record type that gets one later
           (an 8D's own, added below in change.js, or a future type)
           picks this up with no change here. */
        if (document.getElementById(slot + "-documents-panel")) {
            renderDocumentsPanel(record.number, slot + "-documents-panel");
        }

        if (statusSlot) {
            statusSlot.replaceChildren(
                pill(humanize(record.status), statusKind(record.status))
            );
        }

        const list = el("dl", { class: "kv" });

        /* due_at lives on the record itself, not in the type-specific
           data payload, so it is not one of DETAIL_FIELDS below - it
           gets its own row, always shown, with the same overdue rule
           the register colouring and the dashboard both use. */
        const isOverdue = !record.closed_at && record.due_at && new Date(record.due_at) < new Date();
        const changeDue = el("button", {
            class: "btn no-print", type: "button",
            style: "margin-left:8px;padding:1px 8px;font-size:11px"
        }, record.due_at ? "Change" : "Set");

        changeDue.addEventListener("click", () => {
            editDueDate({
                title: "Due date for " + record.number,
                currentValue: record.due_at,
                onSave: async (value) => {
                    await api.updateRecord(record.number, { due_at: value });

                    if (slot !== type) { await rerender(); return; }

                    /* renderRegister re-selects its own first row, so
                       the just-edited record - not necessarily first -
                       has to be re-selected and re-rendered after it,
                       not before, or this screen would silently jump
                       back to whatever record happens to sort first. */
                    await renderRegister(type);
                    const tbody = document.getElementById(REGISTERS[type].tbody);
                    if (tbody) selectRow(tbody, record.number);
                    await renderRecordDetail(type, record.number);
                }
            });
        });

        list.append(el("dt", { text: "Due date" }));
        list.append(el("dd", {}, [
            record.due_at
                ? el("span", {
                    style: isOverdue ? "color:var(--crit)" : null,
                    text: formatDate(record.due_at) + (isOverdue ? " (overdue)" : "")
                  })
                : el("span", { class: "dim", text: "Not set" }),
            changeDue
        ]));

        const children = [list];

        /* The record's own fields. Driven by the published form schema
           so a field added in the Form Builder (or imported from a
           spreadsheet) shows here with no change to this screen. The
           known-good labels from DETAIL_FIELDS win where they apply;
           everything else falls back to the schema's own label. Fields
           are grouped by their `section`, and a `table` field renders
           as a read-only grid. */
        const schemaFields = (schemaDef && Array.isArray(schemaDef.fields)) ? schemaDef.fields : null;

        if (schemaFields) {
            /* Reverse the DETAIL_FIELDS reader functions into a
               key -> nice-label map, once, by probing each with a
               Proxy that records which data key it touches. */
            const keyLabels = {};
            for (const [label, read] of DETAIL_FIELDS) {
                const probe = new Proxy({}, {
                    get: (_t, prop) => { if (!keyLabels[prop]) keyLabels[prop] = label; }
                });
                try { read(probe); } catch { /* reader touched more than one key */ }
            }
            const labelFor = (field) => keyLabels[field.key] || field.label;

            /* Scalar fields collect into a shared key/value list; a
               section heading or a table flushes it and starts a new
               one, so the groups stay visually distinct. */
            let kv = null;
            let lastSection;
            const flushKv = () => { if (kv && kv.childElementCount) children.push(kv); kv = null; };

            for (const field of schemaFields) {
                const value = record.data ? record.data[field.key] : undefined;
                const hasValue = field.type === "table"
                    ? Array.isArray(value) && value.length > 0
                    : value !== undefined && value !== null && value !== "";
                if (!hasValue) continue;

                if ((field.section || null) !== (lastSection || null)) {
                    lastSection = field.section || null;
                    if (lastSection) {
                        flushKv();
                        children.push(el("div", { class: "section-label", text: lastSection }));
                    }
                }

                if (field.type === "table") {
                    flushKv();
                    const columns = Array.isArray(field.columns) ? field.columns : [];
                    children.push(el("div", { class: "sm", style: "font-weight:600;margin:6px 0 4px",
                        text: labelFor(field) }));
                    children.push(el("div", { class: "table-wrap" }, el("table", { class: "sm" }, [
                        el("thead", {}, el("tr", {}, columns.map((c) => el("th", { scope: "col", text: c.label })))),
                        el("tbody", {}, value.map((row) => el("tr", {},
                            columns.map((c) => {
                                const raw = row[c.key];
                                const shown = c.type === "boolean"
                                    ? (raw === true || raw === "true" ? "Yes" : "No")
                                    : (raw != null ? String(raw) : "-");
                                const td = el("td", { class: "sm", text: shown });
                                if (c.type === "computed" && c.thresholds && raw != null) {
                                    const n = Number(raw);
                                    if (c.thresholds.crit != null && n >= c.thresholds.crit) td.classList.add("rpn-crit");
                                    else if (c.thresholds.warn != null && n >= c.thresholds.warn) td.classList.add("rpn-warn");
                                }
                                return td;
                            }))))
                    ])));
                } else {
                    if (!kv) kv = el("dl", { class: "kv" });
                    kv.append(el("dt", { text: labelFor(field) }), fieldValueDd(field, value));
                }
            }
            flushKv();
        } else {
            for (const [label, read] of DETAIL_FIELDS) {
                const value = read(record.data);
                if (value === undefined || value === null || value === "") continue;
                list.append(el("dt", { text: label }));
                list.append(fieldValueDd(null, value));
            }
        }

        /* Workflow. Every legal next step is shown, including the ones
           this person may not take, because "you cannot, the quality
           manager can" is more useful than a missing button. Buttons
           that only make sense on screen, not on paper. */
        if (transitions && transitions.length > 0) {
            children.push(el("div", { class: "section-label no-print", text: "Move this forward" }));

            children.push(el("div", { class: "row no-print" }, transitions.map((step) => {
                const button = el("button", {
                    class: "btn" + (step.allowed ? " btn-primary" : " not-permitted"),
                    type: "button",
                    title: step.blocked_because || "Move to " + step.label
                }, step.label);

                if (!step.allowed) {
                    button.disabled = true;
                    return button;
                }

                button.addEventListener("click", () => {
                    confirmStep({
                        title: "Move " + record.number + " to " + step.label,
                        body: step.is_terminal
                            ? "This closes the record. The audit trail is sealed and it cannot be reopened."
                            : "The record moves from " + humanize(record.status)
                              + " to " + step.label + ".",
                        confirmLabel: "Move to " + step.label,
                        onConfirm: async (reason) => {
                            await api.transition(record.number, { to: step.to, reason });
                            if (slot === type) await renderRegister(type);
                            else await rerender();
                        }
                    });
                });

                return button;
            })));

            const blocked = transitions.filter((step) => !step.allowed);
            if (blocked.length > 0) {
                children.push(el("p", {
                    class: "sm dim no-print",
                    style: "margin:8px 0 0",
                    text: blocked[0].blocked_because
                }));
            }
        }

        children.push(el("div", { class: "section-label", text: "Linked records" }));
        if (links.length > 0) {
            children.push(el("div", { class: "chip-list" },
                links.map((link) => el("span", { class: "linked-rec" }, [
                    recordLink(link),
                    el("button", {
                        class: "linked-rec-x no-print", type: "button",
                        title: "Unlink " + link.number, "aria-label": "Unlink " + link.number,
                        onClick: async () => {
                            try {
                                await api.unlinkRecord(record.number, link.number);
                                await rerender();
                            } catch (error) { toast(error.message, "error"); }
                        }
                    }, "×")
                ]))
            ));
        } else {
            children.push(el("p", { class: "sm dim", style: "margin:0", text: "No linked records." }));
        }

        /* Link another record by its number. */
        const linkInput = el("input", { type: "text", class: "sm", placeholder: "e.g. CAPA-2026-0005" });
        const linkKind = el("select", { class: "sm" }, [
            "related", "caused_by", "corrects", "supersedes", "child_of"
        ].map((k) => el("option", { value: k, text: humanize(k) })));
        const linkBtn = el("button", { class: "btn no-print", type: "button" }, "Link");
        linkBtn.addEventListener("click", async () => {
            const to = linkInput.value.trim();
            if (!to) { toast("Enter a record number", "error"); return; }
            try {
                await api.linkRecord(record.number, { to, link_type: linkKind.value });
                await rerender();
            } catch (error) { toast(error.message, "error"); }
        });
        children.push(el("div", {
            class: "row no-print", style: "gap:6px;margin:6px 0 4px;flex-wrap:wrap"
        }, [linkInput, linkKind, linkBtn]));

        /* An uploaded file is served straight back (openFileWindow); a
           link-only row points at a network share and just carries the
           path. A CAPA cannot close without at least one attachment;
           the disabled close button above already says so before this
           section is even reached. */
        children.push(el("div", { class: "section-label", text: "Attachments" }));

        if (attachments.length > 0) {
            /* A file tagged to one table row (row_ref = "<fieldKey>:<id>")
               carries that field's name so it does not look loose. */
            const rowTag = (a) => {
                if (!a.row_ref) return "";
                const key = String(a.row_ref).split(":")[0];
                return "[" + humanize(key) + "]  ";
            };
            children.push(el("div", { class: "chip-list" },
                attachments.map((a) => {
                    const meta = "  " + formatDate(a.uploaded_at)
                        + (a.uploaded_by ? "  " + a.uploaded_by : "");
                    if (a.has_file) {
                        return el("button", {
                            class: "chip chip-link no-print", type: "button",
                            title: "Open " + a.filename,
                            onClick: () => openFileWindow(
                                api.attachmentFileUrl(record.number, a.id), a.filename, a.mime_type)
                        }, rowTag(a) + a.filename + meta);
                    }
                    return el("span", {
                        class: "chip", title: a.storage_key || "",
                        text: rowTag(a) + a.filename + meta + "  (link)"
                    });
                })
            ));
        } else {
            children.push(el("p", { class: "sm dim", text: "No attachments yet." }));
        }

        /* Drop one file or a dozen; each gets its own progress bar and
           the panel refreshes once the batch settles. */
        children.push(buildUploader({
            url: "/records/" + encodeURIComponent(record.number) + "/attachments",
            onComplete: () => rerender()
        }));

        /* Or point at a file kept on a network share. */
        const addFilename = el("input", { type: "text", placeholder: "Filename", class: "sm" });
        const addLocation = el("input", { type: "text", placeholder: "or a path / link on a share", class: "sm" });
        const addButton = el("button", { class: "btn no-print", type: "button" }, "Link");

        addButton.addEventListener("click", async () => {
            const filename = addFilename.value.trim();
            const location = addLocation.value.trim();

            if (!filename || !location) {
                toast("Filename and location are both required", "error");
                return;
            }

            try {
                await api.addAttachment(record.number, { filename, storage_key: location });
                await rerender();
            } catch (error) {
                toast(error.message, "error");
            }
        });

        children.push(el("div", {
            class: "row no-print", style: "gap:6px;margin:0 0 12px;flex-wrap:wrap"
        }, [addFilename, addLocation, addButton]));

        if (history.length > 0) {
            children.push(el("div", { class: "section-label", text: "Audit trail" }));
            children.push(el("div", { class: "chip-list" },
                history.slice(0, 6).map((entry) => el("span", {
                    class: "chip",
                    text: formatDate(entry.changed_at) + "  " + entry.changed_by
                           + " set " + entry.field
                           + (entry.new_value ? " to " + entry.new_value : "")
                }))
            ));
        }

        /* An audit that turned up a discrepancy is worked through a
           Discrepancy Investigation - raised here, once, and shown
           here after. The DI is a child_of link on the audit. */
        if (type === "audit") {
            children.push(el("div", { class: "section-label", text: "Discrepancy Investigation" }));
            const existingDi = links.find((l) => l.type === "di");
            if (existingDi) {
                const open = el("button", { class: "link-btn", type: "button", text: existingDi.number });
                open.addEventListener("click", () => {
                    document.dispatchEvent(new CustomEvent("navigate", { detail: { view: "di" } }));
                    renderDiDetail(existingDi.number);
                });
                children.push(el("p", { class: "sm" }, [
                    open,
                    document.createTextNode("  "),
                    pill(humanize(existingDi.status), statusKind(existingDi.status))
                ]));
            } else if (can("di.manage")) {
                const raise = el("button", {
                    class: "btn no-print", type: "button", dataset: { requires: "di.manage" },
                    text: "Raise Discrepancy Investigation"
                });
                raise.addEventListener("click", () => raiseDiFromAudit(record));
                children.push(raise);
            } else {
                children.push(el("p", { class: "sm dim", text: "No DI raised for this audit." }));
            }
        }

        panel.replaceChildren(...children);
    } catch (error) {
        panel.replaceChildren(
            el("p", { class: "sm", style: "color:var(--crit)", text: error.message })
        );
    }
}

/* Raise a DI from an audit finding: department + what the audit found,
   then land on the new DI. The DI is created and linked to the audit
   in one call (POST /api/di). Exported so the merged record surface
   (record-context.js) can offer it from an audit's context panel. */
export function raiseDiFromAudit(audit) {
    openEntityForm({
        title: "Raise a Discrepancy Investigation",
        fields: [
            { key: "department", label: "Department under review", type: "text", required: true,
              value: audit.data?.scope || "" },
            { key: "finding", label: "What the audit found", type: "memo", required: true }
        ],
        submitLabel: "Raise DI",
        successMessage: "Discrepancy Investigation raised",
        onSubmit: ({ values }) => api.raiseDi({
            audit_number: audit.number,
            department: values.department,
            finding: values.finding
        }),
        onSaved: (di) => { openRecordPage(di.number, { type: "di" }); }
    });
}
