/* ============================================================
   Discrepancy Investigation detail.

   A DI bridges an internal audit finding to the corrective forms. It
   is a records row with a four-state workflow, and it carries the
   three completed forms the finding needs - the NCR form, the 8D
   report, the CAPA form - each a controlled document in a slot. The
   forms are attached here (upload a filled-out copy, or link one
   already in Document Control); the DI cannot close until all three
   are on file, and the audit that raised it cannot close until the DI
   is closed.
   ============================================================ */

import { api } from "../api.js";
import { can, applyPermissions } from "../session.js";
import { confirmStep } from "../forms.js";
import { openEntityForm } from "../entity-form.js";
import { openDocumentWindow } from "../doc-windows.js";
import { renderDocumentsPanel } from "./resources.js";
import { el, pill, toast, humanize, formatDate } from "../dom.js";

const STATE_LABEL = {
    open:           "Open",
    investigating:  "Investigating",
    linked_closure: "Awaiting form closure",
    closed:         "Closed"
};

async function openAttachForm(number, slot) {
    let documents = [];
    try { ({ documents } = await api.documents()); } catch { documents = []; }

    openEntityForm({
        title: (slot.document ? "Replace " : "Attach ") + slot.label,
        fields: [
            { key: "source", label: "Where from", type: "select", required: true,
              options: ["Upload a file", "Link a controlled document"] },
            { key: "file", label: "File", type: "file",
              accept: ".pdf,.xlsx,.xls,.docx,.doc,.csv",
              hint: "For \"Upload a file\" - the completed form." },
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
            return api.attachDiForm(number, slot.slot, form);
        },
        onSaved: () => renderDiDetail(number)
    });
}

function confirmRemove(number, slot) {
    confirmStep({
        title: "Remove " + slot.label,
        body: "This takes the form off the DI slot. It stays in Document Control.",
        confirmLabel: "Remove",
        onConfirm: async () => {
            await api.removeDiForm(number, slot.slot);
            toast(slot.label + " removed");
            await renderDiDetail(number);
        }
    });
}

function formsPanel(number, packet) {
    const canManage = can("di.manage");

    return el("div", { class: "di-forms" }, packet.forms.map((slot) => {
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
                dataset: { requires: "di.manage" }, text: doc ? "Replace" : "Attach"
            });
            attach.addEventListener("click", () => openAttachForm(number, slot));
            actions.append(attach);

            if (doc) {
                const remove = el("button", {
                    class: "btn btn-xs", type: "button",
                    dataset: { requires: "di.manage" }, text: "Remove"
                });
                remove.addEventListener("click", () => confirmRemove(number, slot));
                actions.append(remove);
            }
        }

        return el("div", { class: "di-form-slot" }, [
            el("div", {}, [
                el("div", { class: "di-form-name", text: slot.label }),
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
}

function transitionsRow(number, record, transitions) {
    if (!transitions || transitions.length === 0) {
        return el("p", { class: "sm dim no-print", text: "This DI is closed." });
    }

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
                title: "Move " + number + " to " + step.label,
                body: step.is_terminal
                    ? "This closes the DI. The audit finding is signed off as resolved."
                    : "The DI moves from " + (STATE_LABEL[record.status] || humanize(record.status))
                      + " to " + step.label + ".",
                confirmLabel: "Move to " + step.label,
                onConfirm: async (reason) => {
                    await api.transition(number, { to: step.to, reason });
                    await renderDiDetail(number);
                }
            });
        });

        return button;
    });

    const blocked = transitions.find((s) => !s.allowed);

    return el("div", { class: "no-print" }, [
        el("div", { class: "section-label", text: "Move this forward" }),
        el("div", { class: "row" }, buttons),
        blocked
            ? el("p", { class: "sm dim", style: "margin:8px 0 0", text: blocked.blocked_because })
            : null
    ]);
}

export async function renderDiDetail(number) {
    const numberEl = document.getElementById("di-detail-number");
    const statusEl = document.getElementById("di-detail-status");
    const body = document.getElementById("di-detail");
    if (!body) return;

    body.replaceChildren(el("p", { class: "sm dim", text: "Loading..." }));

    try {
        const [{ record, links, transitions }, packet] = await Promise.all([
            api.record(number),
            api.diForms(number)
        ]);

        if (numberEl) numberEl.textContent = number;
        if (statusEl) {
            statusEl.replaceChildren(pill(
                STATE_LABEL[record.status] || humanize(record.status),
                record.status === "closed" ? "done" : "prog"
            ));
        }

        const d = record.data || {};
        const header = el("dl", { class: "kv" }, [
            el("dt", { text: "Department" }),      el("dd", { text: d.department || "-" }),
            el("dt", { text: "Investigator" }),    el("dd", { text: d.investigator || "-" }),
            el("dt", { text: "Finding" }),         el("dd", { text: d.finding || "-" }),
            el("dt", { text: "Root cause" }),      el("dd", { text: d.root_cause || "-" }),
            el("dt", { text: "Containment" }),     el("dd", { text: d.containment || "-" }),
            el("dt", { text: "Corrective plan" }), el("dd", { text: d.corrective_plan || "-" })
        ]);

        const auditLink = (links || []).find((l) => l.type === "audit");

        body.replaceChildren(
            header,
            auditLink
                ? el("p", { class: "sm dim", style: "margin:10px 0 0" }, [
                    document.createTextNode("Raised from audit "),
                    (() => {
                        const a = el("button", { class: "link-btn", type: "button", text: auditLink.number });
                        a.addEventListener("click", () => document.dispatchEvent(
                            new CustomEvent("navigate", { detail: { view: "audit" } })));
                        return a;
                    })()
                ])
                : null,
            el("div", { class: "section-label", text: "Investigation forms" }),
            packet.gate.all_attached
                ? el("p", { class: "sm", style: "color:var(--ok);margin:0 0 8px", text: "All three forms on file." })
                : el("p", { class: "sm", style: "color:var(--warn);margin:0 0 8px",
                    text: "Still to attach: " + packet.gate.missing.join(", ") + "." }),
            formsPanel(number, packet),
            transitionsRow(number, record, transitions)
        );
        applyPermissions(body);

        renderDocumentsPanel(number, "di-documents-panel");
    } catch (error) {
        body.replaceChildren(el("p", { class: "sm", style: "color:var(--crit)", text: error.message }));
    }
}
