/* ============================================================
   8D investigations and change control.

   Both ride on the ordinary records machinery, so the register and
   the workflow buttons are the same code the NCR screen uses. What
   is specific to each is the panel in the middle: eight disciplines
   for an 8D, an impact assessment for a change.
   ============================================================ */

import { api } from "../api.js";
import { confirmStep, editDueDate } from "../forms.js";
import {
    el, pill, severity, recordId, fillTable, loadingRow, errorRow,
    formatDate, humanize, statusKind, toast, debounce
} from "../dom.js";
import { renderDocumentsPanel } from "./resources.js";
import { recordLink, recordOpenLink } from "../record-nav.js";
import { openRecordPage } from "./record-page.js";

/* ============================================================
   8D
   ============================================================ */

const DISCIPLINES = [
    ["d1", "Team formed",            "Champion and members named"],
    ["d2", "Problem described",      "Is and is-not analysis"],
    ["d3", "Interim containment",    "Customer protected while the cause is found"],
    ["d4", "Root cause",             "Verified, not suspected"],
    ["d5", "Corrective action",      "Chosen and justified"],
    ["d6", "Implement and validate", "In place and proven effective"],
    ["d7", "Prevent recurrence",     "Read across to similar processes"],
    ["d8", "Recognise the team",     "Closed out"]
];

/* ============================================================
   The designed 8D form.

   buildEightDForm(record, { editable }) returns the whole D1-D8 form
   as one node - a controlled-document header, the discipline status
   strip, and eight titled blocks. The built-in eightd schema stays
   minimal (customer, summary); this layout owns the D1-D8 content and
   reads / writes it as flat keys and two small arrays on record.data:

     d1_champion d1_leader d1_members
     d2_problem  d2_is     d2_is_not
     d3_containment d3_pct_effective d3_target d3_actual
     d4_root_cause  five_why[]            (array of strings - kept)
     d5_actions[]   {action,owner,target,completion,pct_effective}
     d6_implemented d6_target d6_actual
     d7_prevention  d7_read_across
     d8_recognition d8_close_date

   PATCH /api/records/:number merges the data object it is sent over
   record.data, so an edit posts the whole working copy - safe and
   idempotent, arrays included. Unknown keys are accepted (the schema
   validator only checks keys it declares) and still audited.
   ============================================================ */

export function buildEightDForm(record, { editable = true } = {}) {
    const data = JSON.parse(JSON.stringify(record.data || {}));
    if (!Array.isArray(data.five_why)) data.five_why = [];
    if (!Array.isArray(data.d5_actions)) data.d5_actions = [];

    const save = editable
        ? debounce(async () => {
            try { await api.updateRecord(record.number, { data }); }
            catch (error) { toast(error.message, "error"); }
        }, 500)
        : () => {};

    /* a labelled cell: an input/textarea when editable, else the value
       (or a blank rule) as static text */
    function cell(label, key, { area = false, type = "text", wide = false } = {}) {
        let control;
        if (editable) {
            control = area
                ? el("textarea", { class: "d8-in", rows: "2", onInput: (e) => { data[key] = e.target.value; save(); } })
                : el("input", { class: "d8-in", type, onInput: (e) => { data[key] = e.target.value; save(); } });
            if (data[key] != null) { if (area) control.value = data[key]; else control.setAttribute("value", data[key]); }
        } else {
            control = el("div", { class: "d8-val", text: data[key] != null && data[key] !== "" ? String(data[key]) : "—" });
        }
        return el("div", { class: "d8-field" + (wide ? " d8-field-wide" : "") }, [
            el("span", { class: "d8-label", text: label }),
            control
        ]);
    }

    /* an add/remove row grid backed by one array on data */
    function grid(key, columns, { addLabel = "Add row" } = {}) {
        const rows = data[key];
        const body = el("tbody");
        const draw = () => {
            body.replaceChildren(...rows.map((row, i) => el("tr", {}, [
                ...columns.map((c) => el("td", {}, [
                    editable
                        ? (() => {
                            const inp = el(c.area ? "textarea" : "input", {
                                class: "d8-cell", type: c.type || "text", rows: "1",
                                onInput: (e) => { row[c.key] = e.target.value; save(); }
                            });
                            if (row[c.key] != null) { if (c.area) inp.value = row[c.key]; else inp.setAttribute("value", row[c.key]); }
                            return inp;
                        })()
                        : el("div", { class: "d8-cell-val", text: row[c.key] != null && row[c.key] !== "" ? String(row[c.key]) : "—" })
                ])),
                editable ? el("td", { class: "d8-rm no-print" }, el("button", {
                    class: "link-btn", type: "button", text: "✕", title: "Remove row",
                    onClick: () => { rows.splice(i, 1); draw(); save(); }
                })) : null
            ])));
        };
        draw();
        return el("div", { class: "d8-grid-wrap" }, [
            el("table", { class: "d8-grid" }, [
                el("thead", {}, el("tr", {}, [
                    ...columns.map((c) => el("th", { scope: "col", text: c.label })),
                    editable ? el("th", { scope: "col", class: "no-print" }) : null
                ])),
                body
            ]),
            editable ? el("button", {
                class: "btn btn-xs no-print", type: "button", text: "+ " + addLabel,
                onClick: () => {
                    rows.push(Object.fromEntries(columns.map((c) => [c.key, ""])));
                    draw(); save();
                }
            }) : null
        ]);
    }

    function whyGrid() {
        const list = data.five_why;
        const box = el("div", { class: "d8-why" });
        const draw = () => {
            box.replaceChildren(...list.map((why, i) => el("div", { class: "d8-why-row" }, [
                el("span", { class: "d8-why-n", text: "Why " + (i + 1) }),
                editable
                    ? (() => {
                        const inp = el("input", { class: "d8-cell",
                            onInput: (e) => { list[i] = e.target.value; save(); } });
                        if (why != null) inp.setAttribute("value", why);
                        return inp;
                    })()
                    : el("div", { class: "d8-cell-val", text: why || "—" }),
                editable ? el("button", { class: "link-btn no-print", type: "button", text: "✕",
                    title: "Remove", onClick: () => { list.splice(i, 1); draw(); save(); } }) : null
            ])));
        };
        draw();
        return el("div", {}, [
            box,
            editable ? el("button", { class: "btn btn-xs no-print", type: "button", text: "+ Why",
                onClick: () => { list.push(""); draw(); save(); } }) : null
        ]);
    }

    function block(tag, title, ...fields) {
        return el("section", { class: "d8-block" }, [
            el("h3", { class: "d8-block-head" }, [
                el("span", { class: "d8-block-tag", text: tag }), title
            ]),
            el("div", { class: "d8-block-body" }, fields)
        ]);
    }

    /* discipline status strip - done = everything before the current
       state, exactly as the old summary computed it */
    const currentIndex = DISCIPLINES.findIndex(([k]) => k === record.status);
    const closed = record.status === "closed";
    const strip = el("div", { class: "d8-strip" }, DISCIPLINES.map(([k, name], i) => {
        const done = closed || (currentIndex > -1 && i < currentIndex);
        const active = !closed && i === currentIndex;
        return el("div", { class: "d8-strip-step" + (done ? " done" : active ? " active" : "") }, [
            el("span", { class: "d8-strip-tag", text: k.toUpperCase() }),
            el("span", { class: "d8-strip-name", text: name })
        ]);
    }));

    const header = el("div", { class: "d8-doc-head" }, [
        el("div", { class: "d8-doc-title" }, [
            el("span", { class: "d8-doc-kicker", text: "8D Problem Solving Report" }),
            el("span", { class: "d8-doc-no", text: record.number })
        ]),
        el("div", { class: "d8-doc-facts" }, [
            cell("Customer", "customer"),
            cell("Problem title / summary", "summary", { area: true, wide: true }),
            el("div", { class: "d8-field" }, [
                el("span", { class: "d8-label", text: "Status" }),
                el("div", { class: "d8-val", text: humanize(record.status) })
            ]),
            el("div", { class: "d8-field" }, [
                el("span", { class: "d8-label", text: "Owner" }),
                el("div", { class: "d8-val", text: record.owner || "—" })
            ]),
            el("div", { class: "d8-field" }, [
                el("span", { class: "d8-label", text: "Opened" }),
                el("div", { class: "d8-val", text: formatDate(record.opened_at) })
            ]),
            el("div", { class: "d8-field" }, [
                el("span", { class: "d8-label", text: "Target close" }),
                el("div", { class: "d8-val", text: record.due_at ? formatDate(record.due_at) : "—" })
            ])
        ])
    ]);

    return el("div", { class: "d8-form" }, [
        header,
        strip,
        block("D1", "Team", cell("Champion", "d1_champion"), cell("Team leader", "d1_leader"),
            cell("Team members (name / dept)", "d1_members", { area: true, wide: true })),
        block("D2", "Problem description",
            cell("Problem statement (quantified)", "d2_problem", { area: true, wide: true }),
            cell("IS", "d2_is", { area: true }), cell("IS NOT", "d2_is_not", { area: true })),
        block("D3", "Interim containment action(s)",
            cell("Containment action(s)", "d3_containment", { area: true, wide: true }),
            cell("% effective", "d3_pct_effective"),
            cell("Target date", "d3_target", { type: "date" }),
            cell("Actual date", "d3_actual", { type: "date" })),
        block("D4", "Root cause",
            cell("Verified root cause", "d4_root_cause", { area: true, wide: true }),
            el("div", { class: "d8-field d8-field-wide" }, [
                el("span", { class: "d8-label", text: "5-Why analysis" }), whyGrid()
            ])),
        block("D5 / D6", "Permanent corrective action(s)",
            el("div", { class: "d8-field d8-field-wide" }, [
                el("span", { class: "d8-label", text: "Corrective actions" }),
                grid("d5_actions", [
                    { key: "action", label: "Action", area: true },
                    { key: "owner", label: "Owner" },
                    { key: "target", label: "Target", type: "date" },
                    { key: "completion", label: "Completed", type: "date" },
                    { key: "pct_effective", label: "% eff." }
                ], { addLabel: "Action" })
            ]),
            cell("Implemented & validated", "d6_implemented", { area: true, wide: true }),
            cell("Target date", "d6_target", { type: "date" }),
            cell("Actual date", "d6_actual", { type: "date" })),
        block("D7", "Prevent recurrence",
            cell("Systemic prevention / mistake-proofing", "d7_prevention", { area: true, wide: true }),
            cell("Read-across to similar processes", "d7_read_across", { area: true, wide: true })),
        block("D8", "Recognise the team",
            cell("Recognition", "d8_recognition", { area: true, wide: true }),
            cell("Close date", "d8_close_date", { type: "date" }))
    ]);
}

let selectedEightD = null;

/* preferNumber wins over whatever was selected before - used right
   after creating or editing one, so the screen lands on that record
   rather than wherever it happens to sort in the register. */
export async function renderEightD(preferNumber) {
    if (preferNumber) selectedEightD = preferNumber;

    const tbody = document.getElementById("eightd-register");
    loadingRow(tbody, 5);

    try {
        const { records } = await api.records({ type: "eightd" });

        fillTable(tbody, records, [
            { className: "nowrap", render: (row) => [severity(row.severity), recordId(row.number)] },
            { className: "sm", render: (row) => row.title },
            { className: "sm", render: (row) => row.data.customer || "-" },
            { className: "sm", render: (row) => row.owner || "-" },
            { render: (row) => pill(humanize(row.status).toUpperCase(), statusKind(row.status)) }
        ], "No investigations open");

        tbody.querySelectorAll("tr").forEach((tr, index) => {
            if (!records[index]) return;
            tr.dataset.number = records[index].number;
            tr.classList.add("row-clickable");
        });

        const target = records.some((r) => r.number === selectedEightD)
            ? selectedEightD
            : (records[0] && records[0].number);

        if (target) {
            markSelected(tbody, target);
            await renderEightDDetail(target);
        }
    } catch (error) {
        errorRow(tbody, 5, error);
    }
}

/* `slot` is the id prefix the detail renders into. "eightd" (default)
   writes to the register screen's own three panels (#eightd-number,
   #eightd-track, #eightd-side, #eightd-documents-panel). "record-view"
   composes the track, the detail and the documents into the one
   #record-view-detail body of the full-page record view. */
export async function renderEightDDetail(number, { slot = "eightd" } = {}) {
    selectedEightD = number;
    const full = slot !== "eightd";

    const heading = document.getElementById(full ? slot + "-detail-number" : "eightd-number");
    const track = document.getElementById(full ? slot + "-detail" : "eightd-track");
    const side = full ? null : document.getElementById("eightd-side");
    const editButton = document.getElementById(full ? slot + "-edit" : "eightd-edit");

    /* No target: the register's own side panel was retired (8D now
       opens full-page), or the full-page host is not mounted. */
    if (!track) return;
    if (!full) track.replaceChildren(el("p", { class: "sm dim", text: "Loading..." }));

    try {
        const { record, links, transitions } = await api.record(number);

        if (heading) {
            heading.replaceChildren(full
                ? document.createTextNode(record.number)
                : recordOpenLink(record.number));
        }
        if (editButton) editButton.dataset.number = record.number;

        /* the designed, editable D1-D8 form */
        const form = buildEightDForm(record, { editable: true });

        /* ---- links + the next step ---- */
        const children = [];

        if (links.length > 0) {
            children.push(el("div", { class: "section-label", text: "Linked records" }));
            children.push(el("div", { class: "chip-list" },
                links.map((link) => recordLink(link))
            ));
        }

        const refresh = full ? () => renderEightDDetail(number, { slot }) : renderEightD;
        children.push(...workflowButtons(record, transitions, refresh));

        if (full) {
            track.replaceChildren(
                form,
                el("div", { class: "section-label no-print", text: "Links & workflow" }),
                el("div", { class: "no-print" }, children),
                el("div", { class: "section-label no-print", text: "Documents" }),
                el("div", { class: "panel-body no-print", id: slot + "-documents-panel" })
            );
            renderDocumentsPanel(record.number, slot + "-documents-panel");
        } else {
            track.replaceChildren(form);
            if (side) side.replaceChildren(...children);
            renderDocumentsPanel(record.number, "eightd-documents-panel");
        }
    } catch (error) {
        if (track) {
            track.replaceChildren(
                el("p", { class: "sm", style: "color:var(--crit)", text: error.message })
            );
        }
    }
}

/* ============================================================
   Change control
   ============================================================ */

let selectedChange = null;

export async function renderChange(preferNumber) {
    if (preferNumber) selectedChange = preferNumber;

    const tbody = document.getElementById("ecn-register");
    loadingRow(tbody, 5);

    try {
        const { records } = await api.records({ type: "ecn" });

        fillTable(tbody, records, [
            { className: "nowrap", render: (row) => [severity(row.severity), recordId(row.number)] },
            { className: "sm", render: (row) => row.title },
            { className: "mono sm nowrap", render: (row) => row.data.part_number || "-" },
            { className: "mono sm", render: (row) => formatDate(row.due_at) },
            { render: (row) => pill(humanize(row.status), statusKind(row.status)) }
        ], "No changes raised");

        tbody.querySelectorAll("tr").forEach((tr, index) => {
            if (!records[index]) return;
            tr.dataset.number = records[index].number;
            tr.classList.add("row-clickable");
        });

        const target = records.some((r) => r.number === selectedChange)
            ? selectedChange
            : (records[0] && records[0].number);

        if (target) {
            markSelected(tbody, target);
            await renderChangeDetail(target);
        }
    } catch (error) {
        errorRow(tbody, 5, error);
    }
}

/* `slot` is the id prefix the detail renders into. "ecn" (default)
   writes to the register screen's own panels (#ecn-number, #ecn-note,
   #impact-table, #ecn-side). "record-view" composes the impact table
   and the change detail into the one #record-view-detail body of the
   full-page record view. */
export async function renderChangeDetail(number, { slot = "ecn" } = {}) {
    selectedChange = number;
    const full = slot !== "ecn";

    const heading = document.getElementById(full ? slot + "-detail-number" : "ecn-number");
    const note = full ? null : document.getElementById("ecn-note");
    const body = full ? el("tbody") : document.getElementById("impact-table");
    const side = full ? null : document.getElementById("ecn-side");
    const editButton = document.getElementById(full ? slot + "-edit" : "ecn-edit");
    const host = full ? document.getElementById(slot + "-detail") : null;

    if (!full && !body) return;
    if (body && !full) loadingRow(body, 4);

    try {
        const [{ record, links, transitions }, impact] = await Promise.all([
            api.record(number),
            api.changeImpact(number)
        ]);

        if (editButton) editButton.dataset.number = record.number;

        if (heading) {
            heading.replaceChildren(full
                ? document.createTextNode(record.number)
                : recordOpenLink(record.number));
        }

        const noteText = impact.complete
            ? "All areas signed"
            : impact.outstanding + " area(s) outstanding";
        if (note) note.textContent = noteText;

        fillTable(body, impact.areas, [
            { className: "sm", render: (row) => row.area },
            { className: "sm", render: (row) => row.impact },
            { className: "sm dim", render: (row) => row.signed_by
                ? row.signed_by + ", " + formatDate(row.signed_at)
                : "-" },
            { render: (row) => {
                if (row.status === "signed") return pill("Signed", "done");
                if (row.status === "not_applicable") return pill("N/A", "hold");

                if (!row.can_sign) {
                    return el("span", {
                        class: "pill pill-hold",
                        title: "Needs " + row.required_permission,
                        text: "Not yours"
                    });
                }

                const button = el("button", { class: "btn", type: "button" }, "Sign");
                button.addEventListener("click", () => {
                    confirmStep({
                        title: "Sign off " + row.area,
                        body: row.impact,
                        confirmLabel: "Sign for " + row.area,
                        onConfirm: async (reason) => {
                            await api.signImpact(number, row.area, { note: reason });
                            await renderChangeDetail(number, { slot });
                        }
                    });
                });
                return button;
            } }
        ], "No impact assessment recorded");

        /* ---- side ---- */
        const changeEffectivity = el("button", {
            class: "btn no-print", type: "button",
            style: "margin-left:8px;padding:1px 8px;font-size:11px"
        }, record.due_at ? "Change" : "Set");

        changeEffectivity.addEventListener("click", () => {
            editDueDate({
                title: "Effectivity date for " + record.number,
                currentValue: record.due_at,
                onSave: async (value) => {
                    await api.updateRecord(record.number, { due_at: value });
                    await renderChangeDetail(record.number, { slot });
                }
            });
        });

        const children = [
            el("dl", { class: "kv" }, [
                el("dt", { text: "Part" }),
                el("dd", { class: "mono", text: record.data.part_number || "-" }),
                el("dt", { text: "Revision" }),
                el("dd", { class: "mono", text: (record.data.from_rev || "?")
                    + " to " + (record.data.to_rev || "?") }),
                el("dt", { text: "Reason" }),
                el("dd", { text: record.data.reason || "-" }),
                el("dt", { text: "Effectivity" }),
                el("dd", {}, [
                    el("span", { class: "mono", text: formatDate(record.due_at) }),
                    changeEffectivity
                ]),
                el("dt", { text: "Raised by" }),
                el("dd", { text: record.owner || "-" })
            ])
        ];

        if (links.length > 0) {
            children.push(el("div", { class: "section-label", text: "Linked records" }));
            children.push(el("div", { class: "chip-list" },
                links.map((link) => recordLink(link))
            ));
        }

        /* An unsigned area should stop the change moving on, and saying
           so is more use than a button that fails. */
        const blockedByImpact = !impact.complete && record.status === "impact";

        if (blockedByImpact) {
            children.push(el("div", { class: "section-label", text: "Next step" }));
            children.push(el("p", {
                class: "sm dim", style: "margin:0",
                text: "Every area has to sign before this change goes to review."
            }));
        } else {
            const refresh = full ? () => renderChangeDetail(number, { slot }) : renderChange;
            children.push(...workflowButtons(record, transitions, refresh));
        }

        if (full && host) {
            host.replaceChildren(
                el("p", { class: "sm dim", style: "margin:0 0 8px", text: noteText }),
                el("div", { class: "section-label", style: "margin-top:0", text: "Impact assessment" }),
                el("div", { class: "table-wrap" }, el("table", {}, [
                    el("thead", {}, el("tr", {}, ["Area", "Impact", "Signed", "Sign-off"]
                        .map((h) => el("th", { scope: "col", text: h })))),
                    body
                ])),
                el("div", { class: "section-label", text: "Change detail" }),
                ...children
            );
        } else if (side) {
            side.replaceChildren(...children);
        }
    } catch (error) {
        if (full && host) {
            host.replaceChildren(el("p", { class: "sm", style: "color:var(--crit)", text: error.message }));
        } else {
            errorRow(body, 4, error);
        }
    }
}

/* ============================================================
   Shared
   ============================================================ */

function markSelected(tbody, number) {
    tbody.querySelectorAll("tr").forEach((tr) => {
        tr.classList.toggle("row-selected", tr.dataset.number === number);
    });
}

/* The same workflow buttons the NCR screen uses. Every record type
   gets them because every record type is a row in the same table. */
export function workflowButtons(record, transitions, refresh) {
    if (!transitions || transitions.length === 0) return [];

    const buttons = transitions.map((step) => {
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
                    ? "This closes the record. The audit trail is sealed."
                    : "The record moves from " + humanize(record.status) + " to " + step.label + ".",
                confirmLabel: "Move to " + step.label,
                onConfirm: async (reason) => {
                    await api.transition(record.number, { to: step.to, reason });
                    await refresh();
                }
            });
        });

        return button;
    });

    const blocked = transitions.find((step) => !step.allowed);

    return [
        el("div", { class: "section-label", text: "Move this forward" }),
        el("div", { class: "row" }, buttons),
        blocked
            ? el("p", { class: "sm dim", style: "margin:8px 0 0", text: blocked.blocked_because })
            : null
    ].filter(Boolean);
}

export function wireChangeScreens() {
    for (const [tbodyId, type, returnView, renderDetail] of [
        ["eightd-register", "eightd", "d8", renderEightDDetail],
        ["ecn-register", "ecn", "change", renderChangeDetail]
    ]) {
        const tbody = document.getElementById(tbodyId);
        if (!tbody) continue;
        tbody.addEventListener("click", async (event) => {
            const row = event.target.closest("tr[data-number]");
            if (!row) return;
            markSelected(tbody, row.dataset.number);
            if (event.altKey) {
                event.preventDefault();
                const { openRecord } = await import("../record-nav.js");
                openRecord(row.dataset.number, type, { pane: true });
                return;
            }
            if (!await openRecordPage(row.dataset.number, { type, returnView })) {
                await renderDetail(row.dataset.number);
            }
        });
    }
}
