/* ============================================================
   The audit automation panel - a derived-phase pill, one line per
   step (folders / checklist / findings / actions / report) with its
   latest status, and the run buttons.

   Shared by the internal-audit context panel (record-context.js) and
   the in-process audit detail (views/lpa.js). `mode` picks which set
   of api.* calls to use; `id` is the audit number (internal) or the
   lpa_audits id (in_process).
   ============================================================ */

import { api } from "../api.js";
import { applyPermissions } from "../session.js";
import { el, pill, formatDate, toast } from "../dom.js";

const STEP_LABEL = {
    folders: "Folder structure",
    checklist: "Checklist",
    findings: "Findings",
    actions: "Actions",
    report: "Report"
};

const STATUS_KIND = {
    done: "done", skipped: "hold", running: "prog", failed: "open", pending: "hold"
};

function calls(mode, id) {
    return mode === "internal"
        ? {
            summary: () => api.auditAutomation(id),
            run: () => api.runAuditAutomation(id),
            step: (s) => api.auditAutomationStep(id, s),
            requires: "audit.schedule"
        }
        : {
            summary: () => api.lpaAuditAutomation(id),
            run: () => api.runLpaAuditAutomation(id),
            step: (s) => api.lpaAuditAutomationStep(id, s),
            requires: "lpa.audit"
        };
}

/* Fill `host` with the panel and keep it current. `onDone` (optional)
   is called after a run so an outer view can refresh too. */
export function paintAuditAutomationPanel(host, mode, id, onDone) {
    const c = calls(mode, id);

    async function paint() {
        let summary;
        try {
            summary = await c.summary();
        } catch (error) {
            host.replaceChildren(el("p", { class: "sm", style: "color:var(--crit)", text: error.message }));
            return;
        }

        const rows = summary.steps.map((s) => el("li", {}, [
            el("span", { class: "sm", text: STEP_LABEL[s.step] || s.step }),
            pill(s.status === "pending" ? "Not run" : s.status[0].toUpperCase() + s.status.slice(1),
                STATUS_KIND[s.status] || "hold"),
            s.error
                ? el("span", { class: "sm", style: "color:var(--crit)", text: " " + s.error })
                : s.detail ? el("span", { class: "sm dim", text: " " + s.detail }) : null,
            s.finished_at || s.created_at
                ? el("span", { class: "sm dim", style: "margin-left:auto",
                    text: formatDate(s.finished_at || s.created_at) })
                : null
        ]));

        const scoreText = summary.score && summary.score.pct !== null && summary.score.pct !== undefined
            ? "  ·  score " + summary.score.pct + "% (" + summary.score.pass + "/" + summary.score.total + ")"
            : "";

        const runBtn = el("button", {
            class: "btn btn-xs btn-primary no-print", type: "button",
            dataset: { requires: c.requires }
        }, "Run automation");
        runBtn.addEventListener("click", () => act(runBtn, () => c.run(), "Automation complete"));

        const actions = el("div", { class: "row-actions", style: "margin-top:10px;flex-wrap:wrap" },
            [runBtn]);
        for (const step of ["checklist", "findings", "actions", "report"]) {
            const b = el("button", {
                class: "btn btn-xs no-print", type: "button", dataset: { requires: c.requires }
            }, STEP_LABEL[step]);
            b.addEventListener("click", () => act(b, () => c.step(step), STEP_LABEL[step] + " done"));
            actions.append(b);
        }

        host.replaceChildren(
            el("p", { class: "sm" }, [
                el("strong", { text: "Phase: " }),
                pill(summary.phase, "info"),
                el("span", { class: "sm dim", text: scoreText })
            ]),
            el("ul", { class: "packet-docs" }, rows),
            actions
        );
        applyPermissions(host);
    }

    async function act(button, fn, okMsg) {
        button.disabled = true;
        try {
            const out = await fn();
            const failed = (out.steps || []).filter((s) => s.status === "failed");
            toast(failed.length ? failed.length + " step(s) failed - see the panel" : okMsg);
        } catch (error) {
            toast(error.message);
        }
        button.disabled = false;
        await paint();
        if (onDone) onDone();
    }

    paint();
}
