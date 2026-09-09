/* ============================================================
   APQP program detail, driven by its deliverables.

   An APQP program is still a records row with a five-phase workflow,
   but the screen is now built around the three controlled documents
   that carry the process - Process Flow Diagram, FMEA, Control Plan.
   Each has a slot: attach a file or link an existing controlled
   document, open it in a window, replace or remove it. Phase 3 will
   not open until all three are attached - there is no typed-in
   transition note any more.
   ============================================================ */

import { api } from "../api.js";
import { can, applyPermissions } from "../session.js";
import { ensureDialog } from "../forms.js";
import { openEntityForm } from "../entity-form.js";
import { openDocumentWindow } from "../doc-windows.js";
import { renderDocumentsPanel } from "./resources.js";
import { el, pill, toast, humanize, formatDate } from "../dom.js";

const PHASES = [
    "draft", "plan_define", "product_design", "process_design",
    "validation", "production", "closed"
];
const PHASE_LABEL = {
    draft:          "Draft",
    plan_define:    "Phase 1 · Plan & Define",
    product_design: "Phase 2 · Product Design",
    process_design: "Phase 3 · Process Design",
    validation:     "Phase 4 · Validation",
    production:     "Phase 5 · Feedback",
    closed:         "Closed"
};

/* A confirm with no reason textarea - the deliverable gate is the
   safeguard, not a paragraph somebody types. */
function confirm2(title, message, confirmLabel, onConfirm) {
    const node = ensureDialog();
    const errorBox = el("div", { class: "signin-error", hidden: "hidden" });
    const go = el("button", { class: "btn btn-primary", type: "button", text: confirmLabel });

    node.replaceChildren(
        el("div", { class: "modal-head" }, el("h2", { class: "modal-title", text: title })),
        el("div", { class: "modal-body" }, [errorBox, el("p", { class: "sm", style: "margin:0", text: message })]),
        el("div", { class: "modal-foot" }, [
            el("button", { class: "btn", type: "button", text: "Cancel", onClick: () => node.close() }),
            go
        ])
    );

    go.addEventListener("click", async () => {
        go.disabled = true;
        go.textContent = "Working...";
        try {
            await onConfirm();
            node.close();
        } catch (error) {
            errorBox.textContent = error.message;
            errorBox.hidden = false;
        } finally {
            go.disabled = false;
            go.textContent = confirmLabel;
        }
    });

    node.showModal();
}

async function openAttachForm(number, slot, viewSlot) {
    let documents = [];
    try { ({ documents } = await api.documents()); } catch { documents = []; }

    openEntityForm({
        title: (slot.document ? "Replace " : "Attach ") + slot.label,
        fields: [
            { key: "source", label: "Where from", type: "select", required: true,
              options: ["Upload a file", "Link a controlled document"] },
            { key: "file", label: "File", type: "file",
              accept: ".pdf,.xlsx,.xls,.docx,.doc,.csv",
              hint: "For \"Upload a file\"." },
            { key: "document", label: "Controlled document", type: "select",
              options: documents.map((d) => d.doc_number),
              hint: "For \"Link a controlled document\"." }
        ],
        submitLabel: slot.document ? "Replace" : "Attach",
        successMessage: slot.label + " attached",
        onSubmit: ({ values, files }) => {
            const form = new FormData();
            if (values.source === "Link a controlled document") {
                if (!values.document) throw new Error("Choose a controlled document to link");
                form.append("document", values.document);
            } else {
                if (!files.file) throw new Error("Choose a file to upload");
                form.append("file", files.file);
            }
            return api.attachApqpDeliverable(number, slot.slot, form);
        },
        onSaved: () => renderApqpDetail(number, { slot: viewSlot })
    });
}

function buildAdvance(number, record, transitions, gate, viewSlot) {
    const next = (transitions || []).find((t) => !t.is_terminal) || (transitions || [])[0];
    if (!next) return el("p", { class: "sm dim no-print", text: "This program is closed." });

    const gatedOnPhase3 = next.to === "process_design" && !gate.phase3_ready;

    const button = el("button", {
        class: "btn btn-primary no-print", type: "button",
        dataset: { requires: "apqp.manage" }, text: "Advance to " + next.label
    });

    if (gatedOnPhase3) {
        button.disabled = true;
        button.title = "Attach " + gate.missing.join(", ") + " first.";
    } else if (!next.allowed) {
        button.disabled = true;
        button.title = next.blocked_because || "You cannot advance this program.";
    } else {
        button.addEventListener("click", () => {
            confirm2(
                "Advance to " + next.label,
                next.is_terminal
                    ? "This closes the program. The audit trail is sealed."
                    : "The program moves to " + next.label + ".",
                "Advance",
                async () => {
                    await api.transition(number, {
                        to: next.to,
                        reason: "Advanced via the APQP deliverables screen — phase gate met"
                    });
                    toast("Advanced to " + next.label);
                    await renderApqpDetail(number, { slot: viewSlot });
                }
            );
        });
    }

    const note = gatedOnPhase3
        ? el("p", { class: "sm no-print", style: "color:var(--warn);margin:8px 0 0",
            text: "Attach the " + gate.missing.join(", ") + " to advance to " + next.label + "." })
        : null;

    return el("div", { class: "no-print" }, [
        el("div", { class: "section-label", text: "Advance the program" }),
        button,
        note
    ]);
}

/* `slot` is the id prefix the detail is written into - "apqp" for the
   register side panel (unchanged), "record-view" for the full-page
   record view (record-page.js). Bound to `viewSlot` here because the
   deliverables .map() below already uses `slot` for a deliverable. */
export async function renderApqpDetail(number, { slot: viewSlot = "apqp" } = {}) {
    const full = viewSlot !== "apqp";
    const numberEl = document.getElementById(viewSlot + "-detail-number");
    const statusEl = document.getElementById(viewSlot + "-detail-status");
    const body = document.getElementById(viewSlot + "-detail");
    if (!body) return;

    body.replaceChildren(el("p", { class: "sm dim", text: "Loading..." }));

    try {
        const [{ record, transitions }, deliverables] = await Promise.all([
            api.record(number),
            api.apqpDeliverables(number)
        ]);

        if (numberEl) numberEl.textContent = number;
        if (statusEl) {
            statusEl.replaceChildren(pill(
                PHASE_LABEL[record.status] || humanize(record.status),
                record.status === "closed" ? "done" : "prog"
            ));
        }

        const d = record.data || {};
        const header = el("dl", { class: "kv" }, [
            el("dt", { text: "Customer" }),     el("dd", { text: d.customer || "-" }),
            el("dt", { text: "Part number" }),  el("dd", { class: "mono", text: d.part_number || "-" }),
            el("dt", { text: "Target SOP" }),   el("dd", { text: d.target_sop ? formatDate(d.target_sop) : "-" }),
            el("dt", { text: "PPAP level" }),   el("dd", { text: d.ppap_level || "-" }),
            el("dt", { text: "PSW status" }),   el("dd", { text: d.psw_status || "-" })
        ]);

        const currentIndex = PHASES.indexOf(record.status);
        const stepper = el("div", { class: "apqp-phases" }, PHASES.map((p, index) => {
            const state = index < currentIndex ? "done" : index === currentIndex ? "current" : "todo";
            return el("div", { class: "apqp-phase is-" + state }, [
                el("span", { class: "apqp-phase-dot" }),
                el("span", { class: "apqp-phase-label", text: PHASE_LABEL[p] })
            ]);
        }));

        const canManage = can("apqp.manage");
        const grid = el("div", { class: "apqp-deliverables" }, deliverables.deliverables.map((slot) => {
            const doc = slot.document;
            const actions = el("div", { class: "row-actions" });

            if (doc) {
                const view = el("button", { class: "btn btn-xs", type: "button", text: "View" });
                view.addEventListener("click", () => openDocumentWindow(
                    doc.doc_number, doc.current_revision || "A", doc.doc_number + " - " + doc.title
                ));
                actions.append(view);
            }
            if (canManage) {
                const attach = el("button", {
                    class: "btn btn-xs", type: "button",
                    dataset: { requires: "apqp.manage" }, text: doc ? "Replace" : "Attach"
                });
                attach.addEventListener("click", () => openAttachForm(number, slot, viewSlot));
                actions.append(attach);

                if (doc) {
                    const remove = el("button", {
                        class: "btn btn-xs", type: "button",
                        dataset: { requires: "apqp.manage" }, text: "Remove"
                    });
                    remove.addEventListener("click", () => confirm2(
                        "Remove " + slot.label,
                        "This takes the document off the APQP slot. It stays in Document Control.",
                        "Remove",
                        async () => {
                            await api.removeApqpDeliverable(number, slot.slot);
                            toast(slot.label + " removed");
                            await renderApqpDetail(number, { slot: viewSlot });
                        }
                    ));
                    actions.append(remove);
                }
            }

            return el("div", { class: "apqp-deliverable" }, [
                el("div", {}, [
                    el("div", { class: "apqp-deliverable-name", text: slot.label }),
                    doc
                        ? el("div", { class: "sm dim" }, [
                            document.createTextNode(doc.doc_number + "  "),
                            pill(doc.has_released ? "Released " + doc.current_revision : "Uploaded",
                                doc.has_released ? "done" : "prog")
                        ])
                        : el("div", { class: "sm", style: "color:var(--warn)", text: "Not attached" })
                ]),
                actions
            ]);
        }));

        body.replaceChildren(
            header,
            el("div", { class: "section-label", text: "Phases" }), stepper,
            el("div", { class: "section-label", text: "APQP deliverables" }), grid,
            buildAdvance(number, record, transitions, deliverables.gate, viewSlot),
            full ? el("div", { class: "section-label", text: "Other program documents" }) : null,
            full ? el("div", { class: "panel-body", id: viewSlot + "-documents-panel" }) : null
        );
        applyPermissions(body);

        renderDocumentsPanel(number, full ? viewSlot + "-documents-panel" : "apqp-documents-panel");
    } catch (error) {
        body.replaceChildren(el("p", { class: "sm", style: "color:var(--crit)", text: error.message }));
    }
}
