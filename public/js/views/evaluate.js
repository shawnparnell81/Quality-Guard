/* ============================================================
   Drawings, vendor onboarding, management review, scorecards.

   The scorecard is the one worth reading twice: wherever an actual
   can be measured from the records it is, and the screen says which
   figures are computed and which were typed in. A number nobody can
   trace is worse than no number.
   ============================================================ */

import { api } from "../api.js";
import { can, applyPermissions } from "../session.js";
import { confirmStep } from "../forms.js";
import { openEntityForm } from "../entity-form.js";
import { openDocumentWindow, openFileWindow } from "../doc-windows.js";
import {
    el, pill, severity, recordId, fillTable, loadingRow, errorRow,
    formatDate, humanize, toast
} from "../dom.js";

/* ============================================================
   Drawings, clause 8.3
   ============================================================ */

const ACCESS_LABEL = {
    all_plant: ["All plant", "info"],
    eng_qa:    ["Eng and QA", "info"],
    eng_only:  ["Engineering only", "hold"]
};

let selectedDrawing = null;

export async function renderDrawings() {
    const tbody = document.getElementById("drawing-table");
    loadingRow(tbody, 6);

    try {
        const { drawings } = await api.drawings();

        fillTable(tbody, drawings, [
            { className: "mono sm nowrap", render: (row) => recordId(row.drawing_number) },
            { className: "sm", render: (row) => row.title },
            { className: "mono sm", render: (row) => row.current_revision || "-" },
            { className: "sm", render: (row) => row.customer || "-" },
            { className: "mono sm", render: (row) => row.open_ecn || "-" },
            { render: (row) => {
                const [label, kind] = ACCESS_LABEL[row.access_level] || ["Unknown", "hold"];
                return pill(label, kind);
            } }
        ], "No drawings");

        tbody.querySelectorAll("tr").forEach((tr, index) => {
            if (!drawings[index]) return;
            tr.dataset.drawing = drawings[index].drawing_number;
            tr.classList.add("row-clickable");
        });

        const target = drawings.some((d) => d.drawing_number === selectedDrawing)
            ? selectedDrawing
            : (drawings[0] && drawings[0].drawing_number);

        if (target) {
            mark(tbody, "drawing", target);
            await renderDrawing(target);
        }
    } catch (error) {
        errorRow(tbody, 6, error);
    }
}

async function renderDrawing(number) {
    selectedDrawing = number;

    const heading = document.getElementById("drawing-number");
    const revBody = document.getElementById("revision-table");
    const panel = document.getElementById("drawing-detail");

    if (revBody) loadingRow(revBody, 5);

    try {
        const { drawing, revisions, can_release } = await api.drawing(number);

        if (heading) heading.textContent = drawing.drawing_number;

        fillTable(revBody, revisions, [
            { className: "mono sm", render: (row) => row.revision },
            { className: "sm", render: (row) => row.change_summary },
            { className: "mono sm dim", render: (row) => row.ecn_number || "-" },
            { className: "sm dim", render: (row) => row.released_by
                ? row.released_by + ", " + formatDate(row.released_at) : "-" },
            { render: (row) => {
                if (row.status === "released") return pill("Released", "done");
                if (row.status === "superseded") return pill("Superseded", "hold");
                if (!can_release) return pill(humanize(row.status), "prog");

                const button = el("button", { class: "btn btn-primary", type: "button" }, "Release");
                button.addEventListener("click", () => {
                    confirmStep({
                        title: "Release " + drawing.drawing_number + " rev " + row.revision,
                        body: "This becomes the revision production works to, and supersedes "
                            + "whatever is current. Clause 8.3 expects design output to be "
                            + "verified by somebody other than its author.",
                        confirmLabel: "Release revision " + row.revision,
                        onConfirm: async (reason) => {
                            await api.releaseDrawing(number, row.revision, { reason });
                            await renderDrawings();
                        }
                    });
                });
                return button;
            } }
        ], "No revision history");

        const children = [
            el("dl", { class: "kv" }, [
                el("dt", { text: "Title" }),
                el("dd", { text: drawing.title }),
                el("dt", { text: "Part" }),
                el("dd", { class: "mono", text: drawing.part_number || "-" }),
                el("dt", { text: "Customer" }),
                el("dd", { text: drawing.customer || "-" }),
                el("dt", { text: "Current revision" }),
                el("dd", { class: "mono", text: drawing.current_revision || "-" }),
                el("dt", { text: "Owner" }),
                el("dd", { text: drawing.owner || "-" })
            ]),
            el("div", { class: "section-label", text: "Who may see it" }),
            el("p", { class: "sm dim", style: "margin:0", text:
                drawing.access_level === "all_plant"
                    ? "Readable across the plant. Production sees the released revision only."
                    : drawing.access_level === "eng_only"
                        ? "Engineering only while the change is in work."
                        : "Engineering and quality. Production sees the released revision only." })
        ];

        if (panel) panel.replaceChildren(...children);
    } catch (error) {
        errorRow(revBody, 5, error);
    }
}

/* ============================================================
   Vendor onboarding, clause 8.4.1
   ============================================================ */

export async function renderOnboarding() {
    const tbody = document.getElementById("candidate-table");
    loadingRow(tbody, 4);

    try {
        const { candidates } = await api.onboarding();

        fillTable(tbody, candidates, [
            { className: "sm", render: (row) => row.vendor },
            { className: "sm dim", render: (row) => row.scope || "-" },
            { className: "mono sm", render: (row) => row.complete + " of " + row.stages },
            { render: (row) => row.vendor_status === "approved"
                ? pill("Approved", "done")
                : pill("Onboarding", "prog") }
        ], "No candidates");

        tbody.querySelectorAll("tr").forEach((tr, index) => {
            if (!candidates[index]) return;
            tr.dataset.vendor = candidates[index].vendor;
            tr.classList.add("row-clickable");
        });
    } catch (error) {
        errorRow(tbody, 4, error);
    }
}

/* ---------- the packet page ---------- */

let packetVendor = null;

function openOnboardingPacket(vendor) {
    packetVendor = vendor;
    document.dispatchEvent(new CustomEvent("navigate", { detail: { view: "onboarding-packet" } }));
}

const PACKET_STATUS = {
    complete: ["Complete", "done"],
    in_progress: ["In progress", "prog"],
    pending: ["Not started", "hold"],
    skipped: ["Skipped", "hold"]
};

function fileLabel(doc) {
    if (doc.kind === "link") {
        return doc.doc_number
            ? doc.doc_number + " rev " + (doc.current_revision || "-") + " - " + (doc.doc_title || "")
            : "Linked document (removed)";
    }
    return doc.original_filename || "file";
}

function openPacketFile(vendor, stageKey, doc) {
    if (doc.kind === "link" && doc.doc_number) {
        openDocumentWindow(doc.doc_number, doc.current_revision, doc.doc_number);
    } else {
        openFileWindow(api.onboardingDocumentUrl(vendor, stageKey, doc.id),
            doc.original_filename || "file", doc.mime_type);
    }
}

async function openAddDocumentForm(vendor, stage) {
    let documents = [];
    try { ({ documents } = await api.documents()); } catch { documents = []; }

    openEntityForm({
        title: "Add a document - " + stage.name,
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
        successMessage: "Document added to " + stage.name,
        onSubmit: ({ values, files }) => {
            const form = new FormData();
            if (values.note) form.append("note", values.note);
            if (values.source === "Link a controlled document") {
                if (!values.document) throw new Error("Choose a controlled document to link");
                form.append("document", values.document);
            } else {
                if (!files.file) throw new Error("Choose a file to upload");
                form.append("file", files.file);
            }
            return api.addOnboardingDocument(vendor, stage.stage_key, form);
        },
        onSaved: () => renderOnboardingPacket()
    });
}

export async function renderOnboardingPacket() {
    const title = document.getElementById("packet-title");
    const sub = document.getElementById("packet-sub");
    const body = document.getElementById("packet-body");
    if (!body) return;

    if (!packetVendor) {
        body.replaceChildren(el("p", { class: "sm dim", text: "No vendor selected." }));
        return;
    }

    if (title) title.textContent = "Onboarding packet - " + packetVendor;
    body.replaceChildren(el("p", { class: "sm dim", text: "Loading..." }));

    try {
        const packet = await api.onboardingPacket(packetVendor);
        const { vendor, stages, can_advance } = packet;

        if (sub) {
            sub.textContent = vendor.scope
                + (vendor.grade ? " - grade " + vendor.grade : "");
        }

        const header = el("div", { class: "panel" }, el("div", { class: "panel-body" }, [
            el("dl", { class: "kv" }, [
                el("dt", { text: "Vendor" }), el("dd", { text: vendor.name }),
                el("dt", { text: "Scope" }), el("dd", { text: vendor.scope || "-" }),
                el("dt", { text: "Status" }), el("dd", {}, pill(
                    vendor.status === "approved" ? "Approved" : humanize(vendor.status),
                    vendor.status === "approved" ? "done" : "prog"))
            ])
        ]));

        const stageCards = stages.map((stage) => {
            const [label, kind] = PACKET_STATUS[stage.status] || ["Unknown", "hold"];

            const docList = stage.documents.length === 0
                ? el("p", { class: "sm dim", text: "No documents on this stage." })
                : el("ul", { class: "packet-docs" }, stage.documents.map((doc) => {
                    const open = el("button", {
                        class: "btn btn-xs", type: "button",
                        dataset: { packetOpen: doc.id, packetStage: stage.stage_key }
                    }, "Open");
                    const remove = el("button", {
                        class: "btn btn-xs", type: "button",
                        dataset: { requires: "vendor.approve", packetRemove: doc.id, packetStage: stage.stage_key }
                    }, "Remove");
                    return el("li", {}, [
                        el("span", { class: "packet-doc-kind", text: doc.kind === "link" ? "LINK" : "FILE" }),
                        el("span", { class: "sm", text: fileLabel(doc) }),
                        doc.note ? el("span", { class: "sm dim", text: " - " + doc.note }) : null,
                        el("span", { class: "row-actions", style: "margin-left:auto" }, [open, remove])
                    ]);
                }));

            const actions = el("div", { class: "row-actions", style: "margin-top:10px" }, [
                el("button", {
                    class: "btn btn-xs", type: "button",
                    dataset: { requires: "vendor.approve", packetAdd: stage.stage_key }
                }, "Add document")
            ]);

            if (stage.status !== "complete" && can_advance) {
                actions.append(el("button", {
                    class: "btn btn-xs btn-primary", type: "button",
                    dataset: { packetComplete: stage.stage_key }
                }, "Complete stage"));
            }

            return el("div", { class: "panel packet-stage" }, el("div", { class: "panel-body" }, [
                el("div", { class: "packet-stage-head" }, [
                    el("h3", { class: "packet-stage-name", text: stage.name }),
                    pill(label, kind),
                    stage.completed_at
                        ? el("span", { class: "sm dim", text: "Signed "
                            + formatDate(stage.completed_at)
                            + (stage.completed_by ? " by " + stage.completed_by : "") })
                        : null
                ]),
                stage.detail ? el("p", { class: "sm dim", style: "margin:6px 0", text: stage.detail }) : null,
                docList,
                actions
            ]));
        });

        body.replaceChildren(header, ...stageCards);
        applyPermissions(body);
    } catch (error) {
        body.replaceChildren(el("p", { class: "sm", style: "color:var(--crit)", text: error.message }));
    }
}

/* ============================================================
   Management review, clause 9.3
   ============================================================ */

let selectedReview = null;

export async function renderReview() {
    const tbody = document.getElementById("review-table");
    loadingRow(tbody, 5);

    try {
        const { reviews } = await api.reviews();

        fillTable(tbody, reviews, [
            { className: "mono sm nowrap", render: (row) => recordId(row.reference) },
            { className: "sm", render: (row) => row.period },
            { className: "mono sm", render: (row) => row.held_on ? formatDate(row.held_on) : "not held" },
            { className: "sm", render: (row) => row.chair || "-" },
            { render: (row) => row.status === "closed"
                ? pill("Closed", "done")
                : row.status === "in_progress" ? pill("In progress", "prog") : pill("Planned", "hold") }
        ], "No reviews");

        tbody.querySelectorAll("tr").forEach((tr, index) => {
            if (!reviews[index]) return;
            tr.dataset.review = reviews[index].reference;
            tr.classList.add("row-clickable");
        });

        const target = reviews.some((r) => r.reference === selectedReview)
            ? selectedReview
            : (reviews[0] && reviews[0].reference);

        if (target) {
            mark(tbody, "review", target);
            await renderReviewDetail(target);
        }
    } catch (error) {
        errorRow(tbody, 5, error);
    }
}

async function renderReviewDetail(reference) {
    selectedReview = reference;

    const heading = document.getElementById("review-reference");
    const inputBody = document.getElementById("review-inputs");
    const actionBody = document.getElementById("review-actions");

    if (inputBody) loadingRow(inputBody, 4);

    try {
        const { review, inputs, actions } = await api.reviewInputs(reference);

        if (heading) heading.textContent = review.reference + ", " + review.period;

        fillTable(inputBody, inputs, [
            { className: "mono sm nowrap", render: (row) => row.clause },
            { className: "sm", render: (row) => row.input },
            { render: (row) => el("button", {
                class: "link-btn", type: "button",
                dataset: { view: moduleView(row.module) },
                title: "Open " + row.module
            }, row.module) },
            { className: "mono sm", render: (row) => row.summary }
        ]);

        fillTable(actionBody, actions, [
            { className: "sm", render: (row) => row.decision },
            { className: "sm", render: (row) => row.owner || "-" },
            { className: "mono sm", render: (row) => formatDate(row.due_on) },
            { render: (row) => {
                if (row.status === "done") return pill("Done", "done");
                if (row.status === "in_progress") return pill("In progress", "prog");
                if (row.status === "dropped") return pill("Dropped", "hold");
                return pill("Open", "open");
            } }
        ], "No actions recorded");
    } catch (error) {
        errorRow(inputBody, 4, error);
    }
}

/* The inputs table names a module; this maps it to the screen. */
const MODULE_VIEWS = {
    "Management Review": "review",
    "Risk Register": "risk",
    "Customer Complaints": "complaints",
    "Scorecards": "scorecards",
    "Nonconformance": "ncr",
    "CAPA": "capa",
    "Calibration": "calibration",
    "Internal Audit": "audit",
    "Approved Vendor List": "avl",
    "Training": "training"
};

function moduleView(name) {
    return MODULE_VIEWS[name] || "dashboard";
}

/* ============================================================
   Scorecards, clause 6.2
   ============================================================ */

export async function renderScorecards() {
    const tbody = document.getElementById("objective-table");
    loadingRow(tbody, 7);

    try {
        const { objectives, on_target, count } = await api.objectives();

        const note = document.getElementById("objective-note");
        if (note) note.textContent = on_target + " of " + count + " on target";

        fillTable(tbody, objectives, [
            { className: "sm", render: (row) => row.name },
            { className: "mono sm dim", render: (row) => row.clause || "-" },
            { className: "num", render: (row) => row.target + (row.unit === "percent" ? "%" : "") },
            { className: "num", render: (row) => row.actual === null
                ? el("span", { class: "dim", text: "-" })
                : row.actual + (row.unit === "percent" ? "%" : "") },
            { className: "sm dim", render: (row) => row.unit || "-" },
            { className: "sm", render: (row) => row.owner || "-" },

            /* Says whether the figure is measured or typed. A number
               nobody can trace is worse than no number. */
            { render: (row) => {
                const state = row.on_target === null
                    ? pill("No data", "hold")
                    : row.on_target ? pill("On target", "done") : pill("Off target", "open");

                return el("span", { class: "row", style: "gap:6px" }, [
                    state,
                    el("span", {
                        class: "chip",
                        title: row.measurement === "computed"
                            ? "Calculated from the records every time this page loads"
                            : "Entered by hand, not yet measured by the system",
                        text: row.measurement === "computed" ? "live" : "manual"
                    })
                ]);
            } }
        ], "No objectives set");
    } catch (error) {
        errorRow(tbody, 7, error);
    }
}

/* ---------- shared ---------- */

function mark(tbody, key, value) {
    tbody.querySelectorAll("tr").forEach((tr) => {
        tr.classList.toggle("row-selected", tr.dataset[key] === value);
    });
}

export function wireEvaluate() {
    const pairs = [
        ["drawing-table", "drawing", renderDrawing],
        ["candidate-table", "vendor", openOnboardingPacket],
        ["review-table", "review", renderReviewDetail]
    ];

    for (const [id, key, handler] of pairs) {
        const tbody = document.getElementById(id);
        if (!tbody) continue;

        tbody.addEventListener("click", (event) => {
            const row = event.target.closest("tr[data-" + key + "]");
            if (!row) return;
            mark(tbody, key, row.dataset[key]);
            handler(row.dataset[key]);
        });
    }

    /* ---------- onboarding packet page ---------- */
    const packetBack = document.getElementById("packet-back");
    if (packetBack) {
        packetBack.addEventListener("click", () => {
            document.dispatchEvent(new CustomEvent("navigate", { detail: { view: "onboarding" } }));
        });
    }

    const packetBody = document.getElementById("packet-body");
    if (packetBody) {
        packetBody.addEventListener("click", async (event) => {
            const addBtn = event.target.closest("button[data-packet-add]");
            if (addBtn && !addBtn.disabled) {
                const packet = await api.onboardingPacket(packetVendor).catch(() => null);
                const stage = packet && packet.stages.find((s) => s.stage_key === addBtn.dataset.packetAdd);
                if (stage) openAddDocumentForm(packetVendor, stage);
                return;
            }

            const openBtn = event.target.closest("button[data-packet-open]");
            if (openBtn) {
                const packet = await api.onboardingPacket(packetVendor).catch(() => null);
                if (!packet) return;
                const stageKey = openBtn.dataset.packetStage;
                const stage = packet.stages.find((s) => s.stage_key === stageKey);
                const doc = stage && stage.documents.find((d) => d.id === openBtn.dataset.packetOpen);
                if (doc) openPacketFile(packetVendor, stageKey, doc);
                return;
            }

            const removeBtn = event.target.closest("button[data-packet-remove]");
            if (removeBtn && !removeBtn.disabled) {
                confirmStep({
                    title: "Remove document",
                    body: "This takes the document off the stage. The file itself is not affected if it also lives in Document Control.",
                    confirmLabel: "Remove",
                    onConfirm: async () => {
                        await api.deleteOnboardingDocument(packetVendor, removeBtn.dataset.packetStage, removeBtn.dataset.packetRemove);
                        toast("Document removed");
                        await renderOnboardingPacket();
                    }
                });
                return;
            }

            const completeBtn = event.target.closest("button[data-packet-complete]");
            if (completeBtn && !completeBtn.disabled) {
                confirmStep({
                    title: "Complete stage",
                    body: "Stages run in order. Completing the last one puts the vendor on the approved list, which is the only way onto it.",
                    confirmLabel: "Mark complete",
                    onConfirm: async (reason) => {
                        await api.completeOnboardingStage(packetVendor, completeBtn.dataset.packetComplete, { reason });
                        await renderOnboardingPacket();
                    }
                });
            }
        });
    }

    /* Module links inside the management review inputs table. */
    const inputs = document.getElementById("review-inputs");
    if (inputs) {
        inputs.addEventListener("click", (event) => {
            const button = event.target.closest(".link-btn[data-view]");
            if (!button) return;
            document.dispatchEvent(new CustomEvent("navigate", {
                detail: { view: button.dataset.view }
            }));
        });
    }

    const objectivesPdf = document.getElementById("objectives-pdf");
    if (objectivesPdf) {
        objectivesPdf.addEventListener("click", () => {
            window.location.href = "/api/objectives/pdf";
        });
    }
}
