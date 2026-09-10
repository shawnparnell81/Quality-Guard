/* ============================================================
   Sales & Marketing: the customer list, customer onboarding, and
   each customer's folder.

   This is the Vendor Onboarding screens (views/evaluate.js) reshaped
   for the sell side. `renderCustomers` is the list; `renderCustomerFile`
   is one customer's whole folder - profile, an Automation panel, the
   onboarding stages, and the seven numbered document folders
   (01_Admin ... 07_Projects) the onboarding automation builds. Every
   document is a file upload or a link to a controlled document.
   ============================================================ */

import { api } from "../api.js";
import { applyPermissions } from "../session.js";
import { confirmStep } from "../forms.js";
import { openEntityForm } from "../entity-form.js";
import { openDocumentWindow, openFileWindow } from "../doc-windows.js";
import {
    el, pill, fillTable, loadingRow, errorRow, formatDate, humanize, toast
} from "../dom.js";

const STAGE_STATUS = {
    complete: ["Complete", "done"],
    in_progress: ["In progress", "prog"],
    pending: ["Not started", "hold"],
    skipped: ["Skipped", "hold"]
};

const CUSTOMER_STATUS = {
    active: ["Active", "done"],
    prospect: ["Onboarding", "prog"],
    inactive: ["Inactive", "hold"]
};

const AUTOMATION_STATUS = {
    done: ["Done", "done"],
    running: ["Running", "prog"],
    failed: ["Failed", "open"],
    skipped: ["Skipped", "hold"],
    pending: ["Not run", "hold"]
};

const STEP_LABEL = {
    folders: "Folder structure",
    metadata: "Metadata snapshot",
    quality: "Quality profile",
    engineering: "Engineering profile",
    starter_docs: "Starter documents"
};

const FOLDER_STATUS = {
    created: ["Ready", "done"],
    pending: ["Pending", "hold"]
};

/* ---------- the list ---------- */

export async function renderCustomers({ onboardingOnly = false } = {}) {
    const tbody = document.getElementById(
        onboardingOnly ? "customer-onboarding-table" : "customer-table"
    );
    if (!tbody) return;
    loadingRow(tbody, 4);

    try {
        let { customers } = await api.customers();
        if (onboardingOnly) customers = customers.filter((c) => c.status !== "active");

        fillTable(tbody, customers, [
            { className: "sm", render: (row) => row.name },
            { className: "mono sm dim", render: (row) => row.code || "-" },
            { className: "mono sm", render: (row) => row.complete + " of " + row.stages },
            { render: (row) => {
                const [label, kind] = CUSTOMER_STATUS[row.status] || [humanize(row.status), "hold"];
                return pill(label, kind);
            } }
        ], onboardingOnly ? "No customers being onboarded" : "No customers yet");

        tbody.querySelectorAll("tr").forEach((tr, index) => {
            if (!customers[index]) return;
            tr.dataset.customerId = customers[index].id;
            tr.classList.add("row-clickable");
        });
    } catch (error) {
        errorRow(tbody, 4, error);
    }
}

function openNewCustomerForm() {
    openEntityForm({
        title: "New customer",
        fields: [
            { key: "name", label: "Customer name", type: "text", required: true },
            { key: "code", label: "Short code", type: "text", hint: "Optional. Shown in lists and on the folder." },
            { key: "primary_contact_name", label: "Primary contact", type: "text" },
            { key: "primary_contact_email", label: "Contact email", type: "text" },
            { key: "phone", label: "Phone", type: "text" }
        ],
        submitLabel: "Create",
        successMessage: "Customer created",
        onSubmit: ({ values }) => api.createCustomer(values),
        onSaved: (result) => openCustomerFile(result.id)
    });
}

export function wireNewCustomerButtons() {
    document.querySelectorAll("[data-new-customer]").forEach((btn) => {
        if (btn.dataset.wired) return;
        btn.dataset.wired = "1";
        btn.addEventListener("click", openNewCustomerForm);
    });
}

/* ---------- the folder ---------- */

let currentCustomerId = null;

function openCustomerFile(id) {
    currentCustomerId = id;
    document.dispatchEvent(new CustomEvent("navigate", { detail: { view: "customer-file" } }));
}

function fileLabel(doc) {
    if (doc.kind === "link") {
        return doc.doc_number
            ? doc.doc_number + " rev " + (doc.current_revision || "-") + " - " + (doc.doc_title || "")
            : "Linked document (removed)";
    }
    return doc.original_filename || "file";
}

function openDoc(doc) {
    if (doc.kind === "link" && doc.doc_number) {
        openDocumentWindow(doc.doc_number, doc.current_revision, doc.doc_number);
    } else {
        openFileWindow(api.customerDocumentUrl(currentCustomerId, doc.id),
            doc.original_filename || "file", doc.mime_type);
    }
}

async function openAddDocumentForm({ stage, folderKey, folderName }) {
    let documents = [];
    try { ({ documents } = await api.documents()); } catch { documents = []; }

    openEntityForm({
        title: stage ? "Add a document - " + stage.name : "Add a document - " + folderName,
        fields: [
            { key: "source", label: "Where from", type: "select", required: true,
              options: ["Upload a file", "Link a controlled document"] },
            { key: "file", label: "File", type: "file",
              accept: ".pdf,.xlsx,.xls,.docx,.doc,.csv,.png,.jpg,.jpeg",
              hint: "For \"Upload a file\"." },
            { key: "document", label: "Controlled document", type: "select",
              options: documents.map((d) => d.doc_number),
              hint: "For \"Link a controlled document\"." },
            { key: "note", label: "Note", type: "memo" }
        ],
        submitLabel: "Add",
        successMessage: "Document added",
        onSubmit: ({ values, files }) => {
            const form = new FormData();
            if (stage) form.append("stage_key", stage.stage_key);
            else form.append("folder_key", folderKey);
            if (values.note) form.append("note", values.note);
            if (values.source === "Link a controlled document") {
                if (!values.document) throw new Error("Choose a controlled document to link");
                form.append("document", values.document);
            } else {
                if (!files.file) throw new Error("Choose a file to upload");
                form.append("file", files.file);
            }
            return api.addCustomerDocument(currentCustomerId, form);
        },
        onSaved: () => renderCustomerFile()
    });
}

function openEditCustomerForm(customer) {
    openEntityForm({
        title: "Edit " + customer.name,
        values: {
            name: customer.name, code: customer.code || "",
            status: customer.status,
            primary_contact_name: customer.primary_contact_name || "",
            primary_contact_email: customer.primary_contact_email || "",
            phone: customer.phone || "", address: customer.address || "",
            notes: customer.notes || ""
        },
        fields: [
            { key: "name", label: "Customer name", type: "text", required: true },
            { key: "code", label: "Short code", type: "text" },
            { key: "status", label: "Status", type: "select", required: true,
              options: ["prospect", "active", "inactive"] },
            { key: "primary_contact_name", label: "Primary contact", type: "text" },
            { key: "primary_contact_email", label: "Contact email", type: "text" },
            { key: "phone", label: "Phone", type: "text" },
            { key: "address", label: "Address", type: "memo" },
            { key: "notes", label: "Notes", type: "memo" }
        ],
        submitLabel: "Save",
        successMessage: "Customer updated",
        onSubmit: ({ values }) => api.updateCustomer(currentCustomerId, values),
        onSaved: () => renderCustomerFile()
    });
}

function docList(docs, onOpen, onRemove, canManage) {
    if (docs.length === 0) {
        return el("p", { class: "sm dim", text: "Nothing here yet." });
    }
    return el("ul", { class: "packet-docs" }, docs.map((doc) => {
        const open = el("button", { class: "btn btn-xs", type: "button" }, "Open");
        open.addEventListener("click", () => onOpen(doc));
        const kids = [
            el("span", { class: "packet-doc-kind", text: doc.kind === "link" ? "LINK" : "FILE" }),
            el("span", { class: "sm", text: fileLabel(doc) }),
            doc.note ? el("span", { class: "sm dim", text: " - " + doc.note }) : null
        ];
        const actions = el("span", { class: "row-actions", style: "margin-left:auto" }, [open]);
        if (canManage) {
            const remove = el("button", {
                class: "btn btn-xs", type: "button", dataset: { requires: "customer.manage" }
            }, "Remove");
            remove.addEventListener("click", () => onRemove(doc));
            actions.append(remove);
        }
        return el("li", {}, [...kids, actions]);
    }));
}

async function runAutomation(label, call) {
    try {
        const result = await call();
        const failed = (result.steps || []).filter((s) => s.status === "failed");
        toast(failed.length
            ? label + ": " + failed.length + " step(s) failed - see the panel"
            : label + " complete");
    } catch (error) {
        toast(label + " failed: " + error.message);
    }
    await renderCustomerFile();
}

function renderAutomationPanel(automation, canManage) {
    const steps = automation?.steps || [];

    const list = el("ul", { class: "packet-docs" }, steps.map((step) => {
        const [label, kind] = AUTOMATION_STATUS[step.status] || [humanize(step.status), "hold"];
        const when = step.finished_at || step.created_at;
        return el("li", {}, [
            el("span", { class: "sm", text: STEP_LABEL[step.step] || humanize(step.step) }),
            pill(label, kind),
            step.error
                ? el("span", { class: "sm", style: "color:var(--crit)", text: " - " + step.error })
                : step.detail
                    ? el("span", { class: "sm dim", text: " - " + step.detail })
                    : null,
            when ? el("span", { class: "sm dim", style: "margin-left:auto",
                text: formatDate(when) }) : null
        ]);
    }));

    const actions = el("div", { class: "row-actions", style: "margin-top:12px;flex-wrap:wrap" }, []);
    if (canManage) {
        const buttons = [
            ["Run full automation", () => api.runCustomerAutomation(currentCustomerId), "btn-primary"],
            ["Create folders", () => api.customerCreateFolders(currentCustomerId)],
            ["Sync metadata", () => api.customerSyncMetadata(currentCustomerId)],
            ["Generate starter docs", () => api.customerGenerateStarterDocs(currentCustomerId)]
        ];
        for (const [label, call, extra] of buttons) {
            const b = el("button", {
                class: "btn btn-xs" + (extra ? " " + extra : ""),
                type: "button", dataset: { requires: "customer.manage" }
            }, label);
            b.addEventListener("click", () => {
                b.disabled = true;
                runAutomation(label, call).finally(() => { b.disabled = false; });
            });
            actions.append(b);
        }
    }

    return el("div", { class: "panel" }, el("div", { class: "panel-body" }, [
        steps.length
            ? list
            : el("p", { class: "sm dim", text: "This customer predates the automation - run it to build the folders and starter documents." }),
        canManage ? actions : null
    ]));
}

export async function renderCustomerFile() {
    const title = document.getElementById("customer-file-title");
    const sub = document.getElementById("customer-file-sub");
    const body = document.getElementById("customer-file-body");
    if (!body) return;

    if (!currentCustomerId) {
        body.replaceChildren(el("p", { class: "sm dim", text: "No customer selected." }));
        return;
    }

    body.replaceChildren(el("p", { class: "sm dim", text: "Loading..." }));

    try {
        const { customer, stages, folders, automation, can_manage, can_onboard } =
            await api.customer(currentCustomerId);

        if (title) title.textContent = customer.name;
        if (sub) {
            const [label] = CUSTOMER_STATUS[customer.status] || [humanize(customer.status)];
            sub.textContent = (customer.code ? customer.code + " - " : "") + label;
        }

        /* profile */
        const editBtn = el("button", { class: "btn btn-xs", type: "button", dataset: { requires: "customer.manage" } }, "Edit");
        editBtn.addEventListener("click", () => openEditCustomerForm(customer));
        const profile = el("div", { class: "panel" }, el("div", { class: "panel-body" }, [
            el("div", { class: "row", style: "justify-content:space-between;align-items:start" }, [
                el("dl", { class: "kv" }, [
                    el("dt", { text: "Customer" }), el("dd", { text: customer.name }),
                    el("dt", { text: "Code" }), el("dd", { text: customer.code || "-" }),
                    el("dt", { text: "Status" }), el("dd", {}, pill(
                        ...(CUSTOMER_STATUS[customer.status] || [humanize(customer.status), "hold"]))),
                    el("dt", { text: "Contact" }), el("dd", { text: customer.primary_contact_name || "-" }),
                    el("dt", { text: "Email" }), el("dd", { text: customer.primary_contact_email || "-" }),
                    el("dt", { text: "Phone" }), el("dd", { text: customer.phone || "-" })
                ]),
                editBtn
            ])
        ]));

        /* onboarding stages */
        const stageCards = stages.map((stage) => {
            const [label, kind] = STAGE_STATUS[stage.status] || ["Unknown", "hold"];
            const actions = el("div", { class: "row-actions", style: "margin-top:10px" }, []);
            if (can_manage) {
                const add = el("button", { class: "btn btn-xs", type: "button" }, "Add document");
                add.addEventListener("click", () => openAddDocumentForm({ stage }));
                actions.append(add);
            }
            if (stage.status !== "complete" && can_onboard) {
                const complete = el("button", { class: "btn btn-xs btn-primary", type: "button" }, "Complete stage");
                complete.addEventListener("click", () => confirmStep({
                    title: "Complete " + stage.name,
                    body: "Stages run in order. Completing the last one moves the customer to Active.",
                    confirmLabel: "Mark complete",
                    onConfirm: async (reason) => {
                        await api.completeCustomerStage(currentCustomerId, stage.stage_key, { reason });
                        await renderCustomerFile();
                    }
                }));
                actions.append(complete);
            }
            return el("div", { class: "panel packet-stage" }, el("div", { class: "panel-body" }, [
                el("div", { class: "packet-stage-head" }, [
                    el("h3", { class: "packet-stage-name", text: stage.name }),
                    pill(label, kind),
                    stage.completed_at
                        ? el("span", { class: "sm dim", text: "Signed " + formatDate(stage.completed_at)
                            + (stage.completed_by ? " by " + stage.completed_by : "") })
                        : null
                ]),
                stage.detail ? el("p", { class: "sm dim", style: "margin:6px 0", text: stage.detail }) : null,
                docList(stage.documents, openDoc, (doc) => removeDoc(doc), can_manage),
                actions
            ]));
        });

        /* automation */
        const automationPanel = renderAutomationPanel(automation, can_manage);

        /* the seven numbered document folders */
        const folderCards = (folders || []).map((folder) => {
            const [fLabel, fKind] = FOLDER_STATUS[folder.status] || [humanize(folder.status), "hold"];
            const add = can_manage
                ? (() => {
                    const b = el("button", { class: "btn btn-xs", type: "button" }, "Add");
                    b.addEventListener("click", () => openAddDocumentForm({
                        folderKey: folder.folder_key, folderName: folder.name
                    }));
                    return b;
                })()
                : null;
            return el("div", { class: "panel" }, el("div", { class: "panel-body" }, [
                el("div", { class: "row", style: "justify-content:space-between;align-items:center" }, [
                    el("div", { class: "row", style: "gap:8px;align-items:center" }, [
                        el("h3", { class: "packet-stage-name", text: folder.name.replace(/^\d+_/, "") }),
                        pill(fLabel, fKind)
                    ]),
                    add
                ]),
                docList(folder.documents || [], openDoc, (doc) => removeDoc(doc), can_manage)
            ]));
        });

        const folderSection = folderCards.length
            ? folderCards
            : [el("p", { class: "sm dim", text:
                "No folders yet. Run the onboarding automation to build them." })];

        body.replaceChildren(
            profile,
            el("div", { class: "section-label", text: "Onboarding automation" }),
            automationPanel,
            el("div", { class: "section-label", text: "Onboarding" }),
            ...stageCards,
            el("div", { class: "section-label", text: "Document folders" }),
            ...folderSection
        );
        applyPermissions(body);
    } catch (error) {
        body.replaceChildren(el("p", { class: "sm", style: "color:var(--crit)", text: error.message }));
    }
}

function removeDoc(doc) {
    confirmStep({
        title: "Remove document",
        body: "This takes the document off the customer's folder. A linked controlled document is not affected.",
        confirmLabel: "Remove",
        onConfirm: async () => {
            await api.removeCustomerDocument(currentCustomerId, doc.id);
            toast("Document removed");
            await renderCustomerFile();
        }
    });
}

/* ---------- wiring ---------- */

export function wireCustomers() {
    wireNewCustomerButtons();

    for (const id of ["customer-table", "customer-onboarding-table"]) {
        const tbody = document.getElementById(id);
        if (!tbody) continue;
        tbody.addEventListener("click", (event) => {
            const row = event.target.closest("tr[data-customer-id]");
            if (row) openCustomerFile(row.dataset.customerId);
        });
    }

    const back = document.getElementById("customer-file-back");
    if (back) {
        back.addEventListener("click", () => {
            document.dispatchEvent(new CustomEvent("navigate", { detail: { view: "customers" } }));
        });
    }
}
