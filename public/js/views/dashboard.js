/* ============================================================
   Dashboard and ISO 9001 coverage.

   Every figure here is fetched, never hard-coded. If a KPI and the
   register behind it ever disagree, that is a bug in one query, not
   two copies of the truth drifting apart.
   ============================================================ */

import { api } from "../api.js";
import { getOrganization, describeCountdown } from "../org.js";
import { show } from "../app.js";
import { renderRecordDetail } from "./events.js";
import {
    el, pill, severity, recordId, fillTable, loadingRow, errorRow,
    setText, formatDate, humanize, statusKind, drawSparkline, toast
} from "../dom.js";

/* A sparkline point's record numbers are oldest-first within the
   week; the most recent one is the most useful thing to land on.
   Same view names as the type keys for all three of these charts, so
   no translation table is needed the way palette.js needs one for
   every type. */
async function jumpToTrendPoint(type, numbers) {
    if (!numbers || numbers.length === 0) return;

    await show(type);
    await renderRecordDetail(type, numbers[numbers.length - 1]);

    if (numbers.length > 1) {
        toast(numbers.length + " records that week - showing " + numbers[numbers.length - 1]);
    }
}

export async function renderDashboard() {
    const events = document.getElementById("dashboard-events");
    const calibration = document.getElementById("dashboard-cal");
    const training = document.getElementById("dashboard-training");

    loadingRow(events, 5);
    loadingRow(calibration, 3);
    loadingRow(training, 2);

    try {
        const [summary, feed, gages, gaps] = await Promise.all([
            api.dashboard(),
            api.openEvents(),
            api.gages(),
            api.trainingGaps()
        ]);

        /* ---- KPI strip ---- */
        setText("kpi-ncr-open",       summary.events.ncr?.open ?? 0);
        setText("kpi-capa-overdue",   summary.events.capa?.overdue ?? 0);
        setText("kpi-gages-due",      summary.calibration.due_soon);
        setText("kpi-supplier-ppm",   Number(summary.suppliers.avg_ppm).toLocaleString());
        setText("kpi-training-gaps",  summary.training.gaps);
        setText("kpi-audits-overdue", summary.audits.overdue);

        setText("kpi-ncr-foot",      summary.events.ncr?.total + " total this year");
        setText("kpi-capa-foot",     "of " + (summary.events.capa?.open ?? 0) + " open");
        setText("kpi-gages-foot",    summary.calibration.past_due + " past due");
        setText("kpi-ppm-foot",      summary.suppliers.total + " active vendors");
        setText("kpi-training-foot", "clause 7.2");
        setText("kpi-audits-foot",   "clause 9.2");

        /* Real history (opened_at, bucketed by week server-side), not
           a decoration - eight weeks, oldest to newest. Every point
           with real records behind it is clickable straight through
           to them (trend_records carries the same shape as trends,
           one array of record numbers per week instead of a count). */
        drawSparkline("kpi-ncr-spark", summary.trends?.ncr, {
            recordsByWeek: summary.trend_records?.ncr,
            onPointClick: (index, numbers) => jumpToTrendPoint("ncr", numbers)
        });
        drawSparkline("kpi-capa-spark", summary.trends?.capa, {
            recordsByWeek: summary.trend_records?.capa,
            onPointClick: (index, numbers) => jumpToTrendPoint("capa", numbers)
        });
        drawSparkline("kpi-audits-spark", summary.trends?.audit, {
            recordsByWeek: summary.trend_records?.audit,
            onPointClick: (index, numbers) => jumpToTrendPoint("audit", numbers)
        });

        /* ---- open events ----
           Five columns, not seven. Part, lot and quantity belong on the
           module screens; crammed in here they force every description
           to wrap over four lines and the table stops being scannable. */
        fillTable(events, feed.events, [
            { className: "nowrap", render: (row) => [severity(row.severity), recordId(row.number)] },
            { className: "sm", render: (row) => row.title },
            { className: "sm", render: (row) => row.owner || "-" },
            { className: "mono sm", render: (row) => row.age_days + " d" },
            { render: (row) => pill(humanize(row.status), statusKind(row.status)) }
        ], "No open quality events");

        /* ---- calibration due ---- */
        const dueSoon = gages.gages.filter((gage) => gage.status !== "current").slice(0, 5);

        fillTable(calibration, dueSoon, [
            { className: "mono sm", render: (row) => row.gage_id },
            { className: "sm", render: (row) => row.description },
            { className: "mono sm", render: (row) =>
                row.status === "past_due"
                    ? el("span", { style: "color:var(--crit)",
                                   text: "PAST DUE " + Math.abs(row.days_remaining) + " d" })
                    : formatDate(row.next_due) }
        ], "All gages current");

        /* ---- training gaps ---- */
        fillTable(training, gaps.gaps.slice(0, 5), [
            { className: "sm", render: (row) => row.operator },
            { className: "mono sm dim", render: (row) => row.doc_number + " rev " + row.current_revision }
        ], "No training gaps");

    } catch (error) {
        errorRow(events, 5, error);
        errorRow(calibration, 3, error);
        errorRow(training, 2, error);
    }
}

/* ============================================================
   Audit readiness

   Deliberately not a compliance scorecard. A screen that says
   "92 percent covered" is decoration; this one leads with what an
   auditor will write up, so it reads as a to-do list.
   ============================================================ */

/* Kept between renders so switching the filter does not refetch. */
let readinessCache = null;
let showAllClauses = false;

export async function renderReadiness() {
    const body = document.getElementById("readiness-table");
    loadingRow(body, 5);

    try {
        const [readiness, org] = await Promise.all([
            api.readiness(),
            getOrganization()
        ]);

        readinessCache = readiness;

        /* The subtitle names the real audit this screen is preparing
           for, read from the certifications table. */
        const sub = document.getElementById("readiness-sub");
        if (sub && org.next_audit) {
            sub.textContent =
                org.next_audit.standard + " " + org.next_audit.audit_type.replace(/_/g, " ")
                + " " + describeCountdown(org.next_audit.days_to_audit)
                + ", " + org.next_audit.registrar
                + ". What an auditor would write up, worst first.";
        }

        paintReadiness();
    } catch (error) {
        errorRow(body, 5, error);
    }
}

function paintReadiness() {
    if (!readinessCache) return;

    const { summary, clauses } = readinessCache;
    const body = document.getElementById("readiness-table");

    /* ---- what is broken, at the top ---- */
    setText("gap-flagged",  summary.clauses_flagged);
    setText("gap-audits",   summary.audits_overdue);
    setText("gap-capas",    summary.capas_overdue);
    setText("gap-gages",    summary.gages_past_due);
    setText("gap-training", summary.training_gaps);
    setText("gap-evidence", summary.no_evidence);

    setText("gap-flagged-foot", "of " + summary.clauses_total + " clauses");

    /* ---- the list ----
       Flagged clauses first and critical before minor, because the
       order of this table is the order to work through it. */
    const rows = showAllClauses ? clauses : clauses.filter((row) => row.finding);

    const ranked = [...rows].sort((a, b) => {
        const weight = (row) =>
            !row.finding ? 2 : row.finding.severity === "crit" ? 0 : 1;
        return weight(a) - weight(b);
    });

    setText("readiness-count",
        showAllClauses
            ? clauses.length + " clauses"
            : summary.clauses_flagged + " needing attention");

    fillTable(body, ranked, [
        { className: "nowrap", render: (row) =>
            row.finding
                ? [severity(row.finding.severity), el("span", { class: "mono sm", text: row.clause })]
                : el("span", { class: "mono sm dim", text: row.clause }) },

        { className: "sm", render: (row) => row.requirement },

        /* What an auditor would write, or nothing at all. A clause with
           no finding should look uneventful. */
        { render: (row) => row.finding
            ? el("span", {
                class: "sm",
                style: "color:var(--" + row.finding.severity + ")",
                text: row.finding.text
              })
            : el("span", { class: "sm dim", text: "No findings" }) },

        /* A real button, so it takes keyboard focus and Enter. */
        { render: (row) => el("button", {
            class: "link-btn",
            type: "button",
            dataset: { view: row.view },
            title: "Open " + row.module
        }, row.module) },

        { className: "num", render: (row) =>
            row.evidence ? row.evidence.records.toLocaleString() : "-" }
    ], "No findings. Everything an auditor checks is current.");
}

/* One delegated listener for the whole screen.

   Navigation is requested by firing an event rather than importing the
   router: app.js already imports this module, so importing it back
   would be a cycle. The event keeps the dependency one-directional. */
export function wireReadiness() {
    const section = document.getElementById("view-readiness");
    if (!section) return;

    section.addEventListener("click", (event) => {
        const link = event.target.closest(".link-btn[data-view]");
        if (link) {
            document.dispatchEvent(new CustomEvent("navigate", {
                detail: { view: link.dataset.view }
            }));
            return;
        }

        const toggle = event.target.closest("#readiness-filter");
        if (toggle) {
            showAllClauses = !showAllClauses;
            toggle.textContent = showAllClauses ? "Show findings only" : "Show all clauses";
            paintReadiness();
        }
    });
}
