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
    formatDate, humanize, statusKind
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

        /* The disciplines are workflow states, so "done" is simply
           everything before the one the record is sitting on. */
        const currentIndex = DISCIPLINES.findIndex(([key]) => key === record.status);
        const closed = record.status === "closed";
        const dates = record.data.disciplines || {};

        const stepEls = DISCIPLINES.map(([key, name, detail], index) => {
            const done = closed || (currentIndex > -1 && index < currentIndex);
            const active = !closed && index === currentIndex;

            return el("div", {
                class: "d8-step" + (done ? " done" : active ? " active" : "")
            }, [
                el("span", { class: "d8-tag", text: key.toUpperCase() }),
                el("div", {}, [
                    el("div", { class: "d8-name", text: name }),
                    el("div", { class: "d8-meta", text: detail })
                ]),
                done && dates[key] && dates[key] !== "in_progress"
                    ? pill(formatDate(dates[key]), "done")
                    : active ? pill("Current", "prog") : pill("-", "hold")
            ]);
        });

        /* ---- five why, links, and the next step ---- */
        const children = [];

        const fiveWhy = record.data.five_why || [];

        if (fiveWhy.length > 0) {
            children.push(el("div", { class: "section-label", style: "margin-top:0", text: "Five why, D4" }));

            const list = el("dl", { class: "kv" });
            fiveWhy.forEach((why, index) => {
                list.append(el("dt", { text: "Why " + (index + 1) }));
                list.append(el("dd", {
                    class: index === fiveWhy.length - 1 ? "mono" : null,
                    style: index === fiveWhy.length - 1 ? "color:var(--crit)" : null,
                    text: why
                }));
            });
            children.push(list);
        }

        if (links.length > 0) {
            children.push(el("div", { class: "section-label", text: "Linked records" }));
            children.push(el("div", { class: "chip-list" },
                links.map((link) => recordLink(link))
            ));
        }

        const refresh = full ? () => renderEightDDetail(number, { slot }) : renderEightD;
        children.push(...workflowButtons(record, transitions, refresh));

        if (full) {
            const docsHost = el("div", { class: "panel-body", id: slot + "-documents-panel" });
            track.replaceChildren(
                el("div", { class: "d8" }, stepEls),
                el("div", { class: "section-label", text: "Investigation detail" }),
                ...children,
                el("div", { class: "section-label", text: "Documents" }),
                docsHost
            );
            renderDocumentsPanel(record.number, slot + "-documents-panel");
        } else {
            track.replaceChildren(...stepEls);
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
                        .map((h) => el("th", { text: h })))),
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
function workflowButtons(record, transitions, refresh) {
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
