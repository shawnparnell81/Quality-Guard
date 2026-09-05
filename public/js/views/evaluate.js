/* ============================================================
   Drawings, vendor onboarding, management review, scorecards.

   The scorecard is the one worth reading twice: wherever an actual
   can be measured from the records it is, and the screen says which
   figures are computed and which were typed in. A number nobody can
   trace is worse than no number.
   ============================================================ */

import { api } from "../api.js";
import { can } from "../session.js";
import { confirmStep } from "../forms.js";
import {
    el, pill, severity, recordId, fillTable, loadingRow, errorRow,
    formatDate, humanize
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

let selectedCandidate = null;

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

        const target = candidates.some((c) => c.vendor === selectedCandidate)
            ? selectedCandidate
            : (candidates[0] && candidates[0].vendor);

        if (target) {
            mark(tbody, "vendor", target);
            await renderCandidate(target);
        }
    } catch (error) {
        errorRow(tbody, 4, error);
    }
}

async function renderCandidate(vendor) {
    selectedCandidate = vendor;

    const heading = document.getElementById("candidate-name");
    const pipe = document.getElementById("onboarding-pipe");

    if (pipe) pipe.replaceChildren(el("p", { class: "sm dim", text: "Loading..." }));

    try {
        const { stages, can_advance } = await api.onboardingStages(vendor);

        if (heading) heading.textContent = vendor;

        pipe.replaceChildren(...stages.map((stage) => {
            const done = stage.status === "complete";
            const active = stage.status === "in_progress";

            const right = done
                ? pill(formatDate(stage.completed_at), "done")
                : active ? pill("In progress", "prog") : pill("-", "hold");

            const node = el("div", {
                class: "pipe-step" + (done ? " done" : active ? " active" : "")
            }, [
                el("span", { class: "pipe-dot" }),
                el("div", {}, [
                    el("div", { class: "pipe-name", text: stage.name }),
                    el("div", { class: "pipe-meta", text: stage.detail
                        || (done && stage.completed_by ? "Signed by " + stage.completed_by : "Not started") })
                ]),
                right
            ]);

            if (!done && can_advance) {
                const button = el("button", { class: "btn", type: "button" }, "Complete");
                button.addEventListener("click", () => {
                    confirmStep({
                        title: stage.name,
                        body: "Stages run in order. Completing the last one puts the vendor "
                            + "on the approved list, which is the only way onto it.",
                        confirmLabel: "Mark complete",
                        onConfirm: async (reason) => {
                            await api.completeOnboardingStage(vendor, stage.stage_key, { reason });
                            await renderOnboarding();
                        }
                    });
                });
                node.replaceChild(button, node.lastChild);
            }

            return node;
        }));
    } catch (error) {
        if (pipe) {
            pipe.replaceChildren(
                el("p", { class: "sm", style: "color:var(--crit)", text: error.message })
            );
        }
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
        ["candidate-table", "vendor", renderCandidate],
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
