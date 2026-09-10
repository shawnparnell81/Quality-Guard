/* ============================================================
   Layered Process Audit, IATF 16949 clause 9.2.2.

   One screen: a health strip, the due / recent audits, the schedules
   and the templates. Clicking an audit opens it for taking - pass /
   fail / n-a per question, a note, and "Raise NCR" on a fail - and
   "Complete" once every question is answered. Schedules roll forward
   server-side; this screen just shows what came due.
   ============================================================ */

import { api } from "../api.js";
import { confirmStep, ensureDialog } from "../forms.js";
import { openEntityForm } from "../entity-form.js";
import { can, applyPermissions } from "../session.js";
import { paintAuditAutomationPanel } from "./audit-automation-panel.js";
import { el, pill, toast, formatDate, humanize } from "../dom.js";

let cache = null;         // last /api/lpa payload, for the create-form option lists
let currentAudit = null;  // id of the audit open in the sub-view, if any

const STATUS_PILL = {
    scheduled: ["Scheduled", "hold"], in_progress: ["In progress", "prog"],
    complete: ["Complete", "done"], missed: ["Missed", "open"]
};

function showMain() {
    document.getElementById("lpa-main").hidden = false;
    document.getElementById("lpa-audit").hidden = true;
    currentAudit = null;
}

/* ---------- the list screen ---------- */

export async function renderLpa() {
    const stats = document.getElementById("lpa-stats");
    const auditsBox = document.getElementById("lpa-audits");
    if (!auditsBox) return;

    if (currentAudit) return renderLpaAudit(currentAudit);
    showMain();
    auditsBox.replaceChildren(el("p", { class: "sm dim", text: "Loading..." }));

    try {
        /* Materialise anything now due before we read the board. The
           server also rolls on a timer, so a failure here is not
           fatal - it just means the next tick catches it. */
        await api.lpaRoll().catch(() => {});
        const data = await api.lpa();
        cache = data;
        const canAudit = can("lpa.audit");
        const canManage = can("lpa.manage");

        stats.replaceChildren(
            kpi("Open audits", data.stats.open),
            kpi("Overdue / missed (30 d)", data.stats.missed_30d, data.stats.missed_30d > 0 ? "is-crit" : ""),
            kpi("Completed (30 d)", data.stats.completed_30d),
            kpi("Pass rate (30 d)", data.stats.pass_rate_30d == null ? "-" : data.stats.pass_rate_30d + "%")
        );

        auditsBox.replaceChildren(
            data.audits.length
                ? el("ul", { class: "lpa-list" }, data.audits.map((a) => {
                    const [label, kind] = STATUS_PILL[a.status] || ["?", "hold"];
                    const row = el("li", { class: "lpa-audit-row" + (a.status === "missed" ? " is-missed" : "") }, [
                        el("div", {}, [
                            el("div", { class: "sm", style: "font-weight:600",
                                text: a.layer + "  -  " + a.area }),
                            el("div", { class: "sm dim", text:
                                a.template + "  -  due " + formatDate(a.due_on)
                                + (a.auditor ? "  -  " + a.auditor : "")
                                + (a.score_total ? "  -  " + a.score_pass + "/" + a.score_total : "") })
                        ]),
                        el("div", { class: "row-actions" }, [
                            pill(label, kind),
                            (canAudit && a.status !== "complete")
                                ? el("button", { class: "btn btn-xs", type: "button",
                                    dataset: { lpaOpen: a.id }, text: a.status === "missed" ? "Record late" : "Take audit" })
                                : el("button", { class: "btn btn-xs", type: "button",
                                    dataset: { lpaOpen: a.id }, text: "View" })
                        ])
                    ]);
                    return row;
                }))
                : el("p", { class: "sm dim", text: "Nothing due. Add a schedule to get started." })
        );

        renderSchedules(data.schedules, canManage);
        renderTemplates(data.templates, canManage);
        applyPermissions(document.getElementById("view-lpa"));
    } catch (error) {
        auditsBox.replaceChildren(el("p", { class: "sm", style: "color:var(--crit)", text: error.message }));
    }
}

function kpi(label, value, cls) {
    return el("div", { class: "kpi" }, [
        el("div", { class: "kpi-label", text: label }),
        el("div", { class: "kpi-value " + (cls || ""), text: String(value) })
    ]);
}

function renderSchedules(schedules, canManage) {
    const box = document.getElementById("lpa-schedules");
    box.replaceChildren(
        schedules.length
            ? el("ul", { class: "lpa-list" }, schedules.map((s) => el("li", {}, [
                el("div", {}, [
                    el("div", { class: "sm", style: "font-weight:600", text: s.layer + "  -  " + s.area }),
                    el("div", { class: "sm dim", text:
                        s.template + "  -  every " + s.frequency_days + " d  -  next " + formatDate(s.next_due)
                        + (s.last_done ? "  -  last " + formatDate(s.last_done) : "")
                        + (s.active ? "" : "  -  paused") })
                ]),
                canManage
                    ? el("div", { class: "row-actions no-print" }, [
                        el("button", { class: "btn btn-xs", type: "button",
                            dataset: { lpaSchedToggle: s.id, lpaSchedActive: String(s.active) },
                            text: s.active ? "Pause" : "Resume" }),
                        el("button", { class: "btn btn-xs", type: "button",
                            dataset: { lpaSchedDelete: s.id }, text: "Delete" })
                    ])
                    : null
            ])))
            : el("p", { class: "sm dim", text: "No schedules yet." })
    );
}

function renderTemplates(templates, canManage) {
    const box = document.getElementById("lpa-templates");
    box.replaceChildren(
        templates.length
            ? el("ul", { class: "lpa-list" }, templates.map((t) => el("li", {}, [
                el("div", {}, [
                    el("div", { class: "sm", style: "font-weight:600", text: t.name }),
                    el("div", { class: "sm dim", text:
                        t.questions + " question" + (t.questions === 1 ? "" : "s")
                        + (t.active ? "" : "  -  inactive") })
                ]),
                canManage
                    ? el("button", { class: "btn btn-xs no-print", type: "button",
                        dataset: { lpaTemplateEdit: t.id }, text: "Questions" })
                    : null
            ])))
            : el("p", { class: "sm dim", text: "No templates. Create one, then add its questions." })
    );
}

/* ---------- taking an audit ---------- */

const RESULTS = [["pass", "Pass"], ["fail", "Fail"], ["na", "N/A"]];

export async function renderLpaAudit(id) {
    currentAudit = id;
    document.getElementById("lpa-main").hidden = true;
    const panel = document.getElementById("lpa-audit");
    panel.hidden = false;
    const titleEl = document.getElementById("lpa-audit-title");
    const scoreEl = document.getElementById("lpa-audit-score");
    const body = document.getElementById("lpa-audit-body");
    body.replaceChildren(el("p", { class: "sm dim", text: "Loading..." }));

    try {
        const audit = await api.lpaAudit(id);
        const canAudit = can("lpa.audit") && audit.status !== "complete";

        titleEl.textContent = audit.layer + " - " + audit.area;
        const answered = audit.questions.filter((q) => q.result).length;
        scoreEl.replaceChildren(el("span", { class: "sm", text:
            answered + " / " + audit.questions.length + " answered"
            + (audit.score_total ? "   ·   " + audit.score_pass + "/" + audit.score_total + " pass" : "") }));

        const rows = audit.questions.map((q) => {
            const noteInput = el("input", { type: "text", class: "lpa-note",
                placeholder: "Note", value: q.note || "" });

            const setResult = async (result) => {
                try {
                    await api.answerLpa(id, q.question_id, { result, note: noteInput.value.trim() });
                    await renderLpaAudit(id);
                } catch (error) { toast(error.message, "error"); }
            };

            const buttons = RESULTS.map(([value, label]) => {
                const b = el("button", {
                    class: "btn btn-xs lpa-res" + (q.result === value ? " is-" + value : ""),
                    type: "button", text: label
                });
                if (canAudit) b.addEventListener("click", () => setResult(value));
                else b.disabled = true;
                return b;
            });

            const raiseNcr = (canAudit && q.result === "fail" && !q.ncr_number)
                ? (() => {
                    const b = el("button", { class: "btn btn-xs", type: "button", text: "Raise NCR" });
                    b.addEventListener("click", () => openRaiseNcr(id, q, audit, noteInput.value.trim()));
                    return b;
                })()
                : null;

            return el("div", { class: "lpa-q" + (q.result ? " is-" + q.result : "") + (q.critical ? " is-critical" : "") }, [
                el("div", { class: "lpa-q-text" }, [
                    el("span", { class: "sm", style: "font-weight:600", text: q.text }),
                    q.critical ? el("span", { class: "chip", style: "margin-left:6px", text: "critical" }) : null,
                    q.guidance ? el("div", { class: "sm dim", text: q.guidance }) : null,
                    q.ncr_number
                        ? el("div", { class: "sm" }, [
                            document.createTextNode("NCR "),
                            el("button", { class: "link-btn", type: "button", dataset: { view: "ncr" }, text: q.ncr_number })
                        ])
                        : null
                ]),
                el("div", { class: "lpa-q-controls no-print" }, [...buttons, canAudit ? noteInput : null, raiseNcr])
            ]);
        });

        const complete = el("button", {
            class: "btn btn-primary no-print", type: "button",
            text: audit.status === "complete" ? "Completed " + formatDate(audit.performed_on) : "Complete audit"
        });
        if (audit.status === "complete" || !canAudit || answered < audit.questions.length) {
            complete.disabled = true;
        }
        complete.addEventListener("click", () => confirmStep({
            title: "Complete this audit",
            body: "Records it as done today with " + audit.score_pass + " of " + audit.score_total + " passing.",
            confirmLabel: "Complete",
            onConfirm: async () => {
                await api.completeLpaAudit(id);
                await renderLpaAudit(id);
            }
        }));

        const autoHost = el("div", { class: "audit-automation", style: "margin-top:18px" },
            el("p", { class: "sm dim", text: "Loading automation…" }));

        body.replaceChildren(
            el("p", { class: "sm dim", text: audit.template + "  -  due " + formatDate(audit.due_on) }),
            ...rows,
            el("div", { class: "row", style: "margin-top:14px" }, [complete]),
            el("div", { class: "section-label", text: "Automation" }),
            autoHost
        );
        applyPermissions(panel);
        paintAuditAutomationPanel(autoHost, "in_process", id, () => renderLpaAudit(id));
    } catch (error) {
        body.replaceChildren(el("p", { class: "sm", style: "color:var(--crit)", text: error.message }));
    }
}

function openRaiseNcr(auditId, question, audit, note) {
    openEntityForm({
        title: "Raise an NCR for this finding",
        fields: [
            { key: "title", label: "What is wrong, in one line", type: "text", required: true },
            { key: "description", label: "Detail", type: "memo", required: true }
        ],
        values: {
            title: (audit.area + ": " + question.text).slice(0, 120),
            description: question.text + (note ? "\n\nObserved: " + note : "")
        },
        submitLabel: "Raise NCR and link",
        successMessage: (row) => row.number + " raised",
        onSubmit: async ({ values }) => {
            const ncr = await api.createRecord({
                type: "ncr", severity: question.critical ? "crit" : "warn", title: values.title,
                data: { detection_point: "Internal audit", description: values.description,
                    department: audit.area }
            });
            await api.answerLpa(auditId, question.question_id,
                { result: "fail", note, ncr_number: ncr.number });
            return ncr;
        },
        onSaved: () => renderLpaAudit(auditId)
    });
}

/* ---------- create forms ---------- */

function openNewTemplateForm() {
    openEntityForm({
        title: "New LPA template",
        fields: [
            { key: "name", label: "Name", type: "text", required: true, hint: "e.g. Machining cell daily check" },
            { key: "description", label: "Description", type: "memo" }
        ],
        submitLabel: "Create",
        successMessage: (row) => row.name + " created - add its questions",
        onSubmit: ({ values }) => api.createLpaTemplate(values),
        onSaved: (row) => { renderLpa(); openTemplateEditor(row.id); }
    });
}

/* buildField's select uses the option string as both value and label,
   so the picker offers template names and this maps back to the id. */
function templateIdByName(name) {
    return (cache && cache.templates || []).find((t) => t.name === name)?.id;
}

function openNewScheduleForm() {
    const templates = (cache && cache.templates || []).filter((t) => t.active);
    if (templates.length === 0) {
        toast("Create a template first", "error");
        return;
    }
    openEntityForm({
        title: "New LPA schedule",
        fields: [
            { key: "template", label: "Template", type: "select", required: true,
              options: templates.map((t) => t.name) },
            { key: "layer", label: "Layer", type: "text", required: true,
              hint: "e.g. Shift supervisor, Area manager, Plant manager" },
            { key: "area", label: "Area / process", type: "text", required: true },
            { key: "frequency_days", label: "Every N days", type: "number", required: true, min: 1 },
            { key: "start_on", label: "First due", type: "date" }
        ],
        submitLabel: "Create schedule",
        successMessage: () => "Schedule created",
        onSubmit: ({ values }) => api.createLpaSchedule({
            template_id: templateIdByName(values.template),
            layer: values.layer, area: values.area,
            frequency_days: values.frequency_days, start_on: values.start_on
        }),
        onSaved: () => renderLpa()
    });
}

/* Add / remove questions on a template, in the shared dialog. */
async function openTemplateEditor(templateId) {
    const node = ensureDialog();
    const list = el("div", { class: "field-row-list" });
    const errorBox = el("div", { class: "signin-error", hidden: "hidden" });

    async function paint() {
        try {
            const t = await api.lpaTemplate(templateId);
            list.replaceChildren(
                el("div", { class: "sm dim", style: "margin-bottom:8px", text: t.description || "" }),
                ...(t.questions.length
                    ? t.questions.map((q) => el("div", { class: "lpa-q-edit" }, [
                        el("span", { class: "sm" }, [
                            q.text,
                            q.critical ? el("span", { class: "chip", style: "margin-left:6px", text: "critical" }) : null
                        ]),
                        el("button", { class: "btn btn-xs", type: "button", text: "Remove",
                            onClick: async () => { await api.deleteLpaQuestion(templateId, q.id); paint(); } })
                    ]))
                    : [el("p", { class: "sm dim", text: "No questions yet." })])
            );
        } catch (error) {
            errorBox.textContent = error.message; errorBox.hidden = false;
        }
    }

    const textInput = el("input", { type: "text", placeholder: "New question" });
    const criticalBox = el("input", { type: "checkbox" });
    const add = el("button", { class: "btn btn-primary", type: "button", text: "Add" });
    add.addEventListener("click", async () => {
        if (!textInput.value.trim()) return;
        try {
            await api.addLpaQuestion(templateId, { text: textInput.value.trim(), critical: criticalBox.checked });
            textInput.value = ""; criticalBox.checked = false;
            await paint();
        } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; }
    });

    node.replaceChildren(
        el("div", { class: "modal-head" }, el("h2", { class: "modal-title", text: "Template questions" })),
        el("div", { class: "modal-body" }, [
            errorBox,
            list,
            el("div", { class: "row", style: "margin-top:12px;gap:8px;align-items:center" }, [
                textInput,
                el("label", { class: "sm", style: "display:flex;gap:5px;align-items:center" }, [criticalBox, " Critical"]),
                add
            ])
        ]),
        el("div", { class: "modal-foot" }, [
            el("button", { class: "btn", type: "button", onClick: () => { node.close(); renderLpa(); } }, "Done")
        ])
    );
    node.showModal();
    paint();
}

/* ---------- wiring ---------- */

export function wireLpa() {
    const view = document.getElementById("view-lpa");
    if (!view) return;

    view.addEventListener("click", (event) => {
        const open = event.target.closest("[data-lpa-open]");
        if (open) { renderLpaAudit(open.dataset.lpaOpen); return; }

        const tmplEdit = event.target.closest("[data-lpa-template-edit]");
        if (tmplEdit) { openTemplateEditor(tmplEdit.dataset.lpaTemplateEdit); return; }

        const toggle = event.target.closest("[data-lpa-sched-toggle]");
        if (toggle) {
            api.updateLpaSchedule(toggle.dataset.lpaSchedToggle,
                { active: toggle.dataset.lpaSchedActive !== "true" })
                .then(renderLpa).catch((e) => toast(e.message, "error"));
            return;
        }

        const del = event.target.closest("[data-lpa-sched-delete]");
        if (del) {
            confirmStep({
                title: "Delete schedule",
                body: "Removes the schedule. Audits already generated from it are kept.",
                confirmLabel: "Delete",
                onConfirm: async () => { await api.deleteLpaSchedule(del.dataset.lpaSchedDelete); await renderLpa(); }
            });
            return;
        }

        const link = event.target.closest(".link-btn[data-view]");
        if (link) {
            document.dispatchEvent(new CustomEvent("navigate", { detail: { view: link.dataset.view } }));
        }
    });

    const back = document.getElementById("lpa-audit-back");
    if (back) back.addEventListener("click", () => { showMain(); renderLpa(); });

    const newTemplate = document.getElementById("lpa-new-template");
    if (newTemplate) newTemplate.addEventListener("click", openNewTemplateForm);

    const newSchedule = document.getElementById("lpa-new-schedule");
    if (newSchedule) newSchedule.addEventListener("click", openNewScheduleForm);

    const newAudit = document.getElementById("lpa-new-audit");
    if (newAudit) {
        newAudit.addEventListener("click", () => {
            const templates = (cache && cache.templates || []).filter((t) => t.active);
            if (templates.length === 0) { toast("Create a template first", "error"); return; }
            openEntityForm({
                title: "Ad-hoc LPA",
                fields: [
                    { key: "template", label: "Template", type: "select", required: true,
                      options: templates.map((t) => t.name) },
                    { key: "layer", label: "Layer", type: "text", required: true },
                    { key: "area", label: "Area / process", type: "text", required: true }
                ],
                submitLabel: "Start audit",
                successMessage: () => "Audit created",
                onSubmit: ({ values }) => api.createLpaAudit({
                    template_id: templateIdByName(values.template),
                    layer: values.layer, area: values.area
                }),
                onSaved: (row) => renderLpaAudit(row.id)
            });
        });
    }
}
