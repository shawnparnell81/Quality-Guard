/* ============================================================
   Dashboard and ISO 9001 coverage.

   Every figure here is fetched, never hard-coded. If a KPI and the
   register behind it ever disagree, that is a bug in one query, not
   two copies of the truth drifting apart.
   ============================================================ */

import { api } from "../api.js";
import { getOrganization, describeCountdown } from "../org.js";
import { VENDOR_STATUS } from "./resources.js";
import { show } from "../app.js";
import { renderRecordDetail } from "./events.js";
import { openRecordPage } from "./record-page.js";
import { can } from "../session.js";
import { onStreamEvent } from "../stream.js";
import {
    el, pill, severity, recordId, fillTable, loadingRow, errorRow,
    setText, formatDate, humanize, statusKind, drawSparkline, toast
} from "../dom.js";

/* ============================================================
   Dashboard layout (org-level, admin-set - see routes/layout.js).

   The panels ship in a default arrangement (captured from the markup
   the first time the dashboard renders). An admin with layout.manage
   can reorder them across the two columns and hide the ones the org
   does not use; that arrangement is saved for everyone. A stored
   layout is { order: [{ key, col }], hidden: [key] }.
   ============================================================ */

/* The KPI strip stays pinned at the top; these six panels are the
   ones an org arranges. */
const DASH_WIDGETS = [
    "events", "coming-due", "suppliers",
    "clause-readiness", "calibration-due", "training-gaps"
];
const DASH_MOVABLE = DASH_WIDGETS;

/* ---------- data-urgency metric cards ----------
   The three cards under the KPI strip. Each turns green / amber / red
   (data-urgency) once its number from GET /api/metrics crosses a
   threshold. Thresholds are per metric: one overdue document review
   is already a problem; ten open NCs is a bad week. */
const METRIC_CARDS = [
    { key: "open_ncs",            valueId: "metric-open-ncs",      hintId: "metric-open-ncs-hint",      medium: 5, high: 10, empty: "None open" },
    { key: "pending_capas",       valueId: "metric-pending-capas", hintId: "metric-pending-capas-hint", medium: 3, high: 6,  empty: "None pending" },
    { key: "overdue_doc_reviews", valueId: "metric-overdue-docs",  hintId: "metric-overdue-docs-hint",  medium: 1, high: 3,  empty: "All current" }
];

function urgencyFor(value, cfg) {
    if (value >= cfg.high) return "high";
    if (value >= cfg.medium) return "medium";
    return "low";
}

function metricCard(key) {
    return document.querySelector('#dashboard-metrics [data-metric="' + key + '"]');
}

function paintMetricCards(data) {
    for (const cfg of METRIC_CARDS) {
        const card = metricCard(cfg.key);
        if (!card) continue;
        const value = Number(data?.[cfg.key] ?? 0);
        const urgency = urgencyFor(value, cfg);
        card.dataset.state = "ready";
        card.dataset.urgency = urgency;
        setText(cfg.valueId, value.toLocaleString());
        setText(cfg.hintId, value === 0 ? cfg.empty : urgency + " urgency");
        const label = card.querySelector(".metric-card__label")?.textContent || cfg.key;
        card.setAttribute("aria-label", label + ": " + value + ", " + urgency + " urgency");
    }
}

function failMetricCards() {
    for (const cfg of METRIC_CARDS) {
        const card = metricCard(cfg.key);
        if (!card) continue;
        card.dataset.state = "error";
        delete card.dataset.urgency;
        setText(cfg.valueId, "!");
        setText(cfg.hintId, "Couldn't load");
    }
}

let defaultDashLayout = null;   // captured once from the markup
let dashLayout = undefined;     // the org's stored layout, or null; undefined = not fetched
let dashEditing = false;

function dashWidgetEl(key) {
    return document.querySelector('#view-dashboard [data-widget="' + key + '"]');
}

function captureDefaultDashLayout() {
    if (defaultDashLayout) return;
    const order = [];
    document.querySelectorAll("#view-dashboard [data-col]").forEach((col) => {
        const c = Number(col.dataset.col);
        col.querySelectorAll('.panel[data-widget]').forEach((panel) => {
            order.push({ key: panel.dataset.widget, col: c });
        });
    });
    defaultDashLayout = { order, hidden: [] };
}

/* Places every movable panel into the column and position the layout
   asks for; anything the layout does not mention keeps its default
   spot. Hidden panels are removed from view unless the editor is
   open, where they show greyed so they can be brought back. */
function applyDashLayout(layout) {
    captureDefaultDashLayout();

    const effective = layout && Array.isArray(layout.order) ? layout : defaultDashLayout;
    const hidden = new Set((layout && Array.isArray(layout.hidden)) ? layout.hidden : []);
    const cols = [
        document.getElementById("dash-col-0"),
        document.getElementById("dash-col-1")
    ];
    if (!cols[0] || !cols[1]) return;

    const placed = new Set();
    for (const entry of effective.order) {
        if (!DASH_MOVABLE.includes(entry.key) || placed.has(entry.key)) continue;
        const panel = dashWidgetEl(entry.key);
        const target = cols[entry.col] || cols[0];
        if (panel && target) {
            target.appendChild(panel);   // append in layout order
            placed.add(entry.key);
        }
    }
    /* A widget added to the app after this layout was saved: leave it
       in its markup column, at the end. */
    for (const key of DASH_MOVABLE) {
        if (placed.has(key)) continue;
        const fallback = defaultDashLayout.order.find((o) => o.key === key);
        const panel = dashWidgetEl(key);
        if (panel && fallback && cols[fallback.col]) cols[fallback.col].appendChild(panel);
    }

    for (const key of DASH_WIDGETS) {
        const node = dashWidgetEl(key);
        if (!node) continue;
        const isHidden = hidden.has(key);
        node.classList.toggle("widget-hidden", isHidden);
        node.hidden = isHidden && !dashEditing;
    }
}

/* Reads the current arrangement back out of the DOM into a layout
   object to save. */
function readDashLayoutFromDom() {
    const order = [];
    [0, 1].forEach((c) => {
        const col = document.getElementById("dash-col-" + c);
        col.querySelectorAll('.panel[data-widget]').forEach((panel) => {
            order.push({ key: panel.dataset.widget, col: c });
        });
    });
    const hidden = DASH_WIDGETS.filter((key) => {
        const node = dashWidgetEl(key);
        return node && node.classList.contains("widget-hidden");
    });
    return { order, hidden };
}

/* ---------- the drag-and-drop editor ---------- */

function panelAfterPoint(col, y) {
    const panels = [...col.querySelectorAll(".panel[data-widget]:not(.dragging)")];
    return panels.reduce((closest, panel) => {
        const box = panel.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) return { offset, panel };
        return closest;
    }, { offset: Number.NEGATIVE_INFINITY, panel: null }).panel;
}

function decoratePanelForEdit(panel) {
    if (panel.querySelector(".widget-edit-bar")) return;
    const key = panel.dataset.widget;

    const handle = el("span", { class: "widget-handle", title: "Drag to move", text: "⠿" });
    const hideBtn = el("button", {
        class: "widget-hide", type: "button",
        title: panel.classList.contains("widget-hidden") ? "Show this panel" : "Hide this panel",
        text: panel.classList.contains("widget-hidden") ? "Show" : "Hide"
    });
    hideBtn.addEventListener("click", () => {
        const nowHidden = !panel.classList.contains("widget-hidden");
        panel.classList.toggle("widget-hidden", nowHidden);
        hideBtn.textContent = nowHidden ? "Show" : "Hide";
        hideBtn.title = nowHidden ? "Show this panel" : "Hide this panel";
    });

    const bar = el("div", { class: "widget-edit-bar" }, [
        handle, el("span", { class: "widget-key", text: key }), hideBtn
    ]);
    panel.prepend(bar);

    panel.setAttribute("draggable", "true");
    panel.addEventListener("dragstart", (e) => {
        panel.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", key);
    });
    panel.addEventListener("dragend", () => panel.classList.remove("dragging"));
}

function stripPanelEditDecoration(panel) {
    panel.querySelector(".widget-edit-bar")?.remove();
    panel.removeAttribute("draggable");
}

function wireColumnDrop(col) {
    if (col.dataset.dropWired) return;
    col.dataset.dropWired = "1";
    col.addEventListener("dragover", (e) => {
        if (!dashEditing) return;
        e.preventDefault();
        const dragging = document.querySelector("#view-dashboard .panel.dragging");
        if (!dragging) return;
        const after = panelAfterPoint(col, e.clientY);
        if (after) col.insertBefore(dragging, after);
        else col.appendChild(dragging);
    });
}

function setEditControls(on) {
    document.getElementById("dash-edit").hidden = on;
    document.getElementById("dash-save").hidden = !on;
    document.getElementById("dash-reset").hidden = !on;
    document.getElementById("dash-cancel").hidden = !on;
    const hint = document.getElementById("dash-edit-hint");
    if (hint) hint.hidden = !on;
}

function enterDashEdit() {
    if (!can("layout.manage")) return;
    dashEditing = true;
    document.getElementById("view-dashboard").classList.add("dash-editing");
    applyDashLayout(dashLayout);           // reveal hidden panels, greyed
    document.querySelectorAll("#view-dashboard .panel[data-widget]").forEach(decoratePanelForEdit);
    [0, 1].forEach((c) => wireColumnDrop(document.getElementById("dash-col-" + c)));
    setEditControls(true);
}

function exitDashEdit() {
    dashEditing = false;
    document.getElementById("view-dashboard").classList.remove("dash-editing");
    document.querySelectorAll("#view-dashboard .panel[data-widget]").forEach(stripPanelEditDecoration);
    applyDashLayout(dashLayout);
    setEditControls(false);
}

export function wireDashboard() {
    const editBtn = document.getElementById("dash-edit");
    if (!editBtn) return;

    editBtn.addEventListener("click", enterDashEdit);
    document.getElementById("dash-cancel").addEventListener("click", exitDashEdit);

    document.getElementById("dash-save").addEventListener("click", async () => {
        const layout = readDashLayoutFromDom();
        try {
            const saved = await api.saveLayout("dashboard", layout);
            dashLayout = saved.layout;
            toast("Dashboard layout saved for the organisation");
            exitDashEdit();
        } catch (error) {
            toast(error.message, "error");
        }
    });

    document.getElementById("dash-reset").addEventListener("click", async () => {
        try {
            await api.saveLayout("dashboard", null);
            dashLayout = null;
            toast("Dashboard layout reset to default");
            exitDashEdit();
        } catch (error) {
            toast(error.message, "error");
        }
    });

    /* Live updates: a record or document changed somewhere. Rebuild
       the dashboard if it is the screen on show and not being
       rearranged. Debounced against bursts. */
    let liveTimer = null;
    const refreshIfLive = () => {
        const view = document.getElementById("view-dashboard");
        if (!view || view.hidden || dashEditing) return;
        clearTimeout(liveTimer);
        liveTimer = setTimeout(() => {
            const still = document.getElementById("view-dashboard");
            if (still && !still.hidden && !dashEditing) renderDashboard();
        }, 500);
    };
    onStreamEvent("records", refreshIfLive);
    onStreamEvent("documents", refreshIfLive);
}

/* A sparkline point's record numbers are oldest-first within the
   week; the most recent one is the most useful thing to land on.
   Same view names as the type keys for all three of these charts, so
   no translation table is needed the way palette.js needs one for
   every type. */
async function jumpToTrendPoint(type, numbers) {
    if (!numbers || numbers.length === 0) return;

    const number = numbers[numbers.length - 1];
    if (!await openRecordPage(number, { type, returnView: type })) {
        await show(type);
        await renderRecordDetail(type, number);
    }

    if (numbers.length > 1) {
        toast(numbers.length + " records that week - showing " + numbers[numbers.length - 1]);
    }
}

export async function renderDashboard() {
    const events = document.getElementById("dashboard-events");
    const escalations = document.getElementById("dashboard-escalations");
    const suppliers = document.getElementById("dashboard-suppliers");
    const calibration = document.getElementById("dashboard-cal");
    const training = document.getElementById("dashboard-training");

    loadingRow(events, 5);
    loadingRow(escalations, 4);
    loadingRow(suppliers, 6);
    loadingRow(calibration, 3);
    loadingRow(training, 2);

    /* The metric strip fetches on its own: a hiccup there should not
       blank the panels below it, and vice versa. */
    api.metrics().then(paintMetricCards).catch(failMetricCards);

    try {
        const [summary, feed, dueSoonRecords, vendors, gages, gaps] = await Promise.all([
            api.dashboard(),
            api.openEvents(),
            api.escalations(14),
            api.vendors(),
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

        /* ---- open events ---- */
        const eventsNote = document.getElementById("open-events-note");
        if (eventsNote) {
            const counts = [
                ["ncr", "NCR"], ["capa", "CAPA"], ["complaint", "COMP"]
            ].map(([key, label]) => [summary.events[key]?.open ?? 0, label])
             .filter(([count]) => count > 0);

            eventsNote.textContent = counts.length > 0
                ? counts.map(([count, label]) => count + " " + label).join(" / ")
                : "Nothing open";
        }

        /* Five columns, not seven. Part, lot and quantity belong on the
           module screens; crammed in here they force every description
           to wrap over four lines and the table stops being scannable. */
        fillTable(events, feed.events, [
            { className: "nowrap", render: (row) => [severity(row.severity), recordId(row.number)] },
            { className: "sm", render: (row) => row.title },
            { className: "sm", render: (row) => row.owner || "-" },
            { className: "mono sm", render: (row) => row.age_days + " d" },
            { render: (row) => pill(humanize(row.status), statusKind(row.status)) }
        ], "No open quality events");

        /* ---- coming due ----
           Who would get a warning, and about what, computed live -
           there is no email provider wired up yet, so this is the
           honest version: the answer to "who needs telling," visible,
           rather than a notification nobody can actually send. */
        const note = document.getElementById("escalations-note");
        if (note) {
            note.textContent = dueSoonRecords.count + " in the next 14 d"
                + (dueSoonRecords.unowned > 0 ? ", " + dueSoonRecords.unowned + " unowned" : "");
        }

        fillTable(escalations, dueSoonRecords.escalations, [
            { className: "mono sm", render: (row) => row.number },
            { className: "sm dim", render: (row) => humanize(row.type) },
            { className: "sm", render: (row) => row.owner_name
                || el("span", { class: "dim", text: "Unowned" }) },
            { className: "mono sm", render: (row) => row.overdue
                ? el("span", { style: "color:var(--crit)", text: formatDate(row.due_at) + " overdue" })
                : formatDate(row.due_at) }
        ], "Nothing coming due");

        /* ---- supplier scorecard ----
           The full list lives on the Approved Vendor List screen; the
           dashboard only needs the ones actually worth a second look -
           already sorted scar_open, then on_watch, then everyone else
           by the endpoint itself, so taking the first few is taking
           the ones that need attention, not an arbitrary slice. */
        fillTable(suppliers, vendors.vendors.slice(0, 5), [
            { render: (row) => row.name },
            { className: "sm dim", render: (row) => row.scope },
            { className: "num", render: (row) => row.otd_pct != null ? row.otd_pct + "%" : "-" },
            { className: "num", render: (row) => row.ppm != null ? row.ppm.toLocaleString() : "-" },
            { className: "num", render: (row) => row.grade || "-" },
            { render: (row) => {
                const [label, kind] = VENDOR_STATUS[row.status] || ["Unknown", "hold"];
                return pill(label, kind);
            } }
        ], "No vendors tracked yet");

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

        /* ---- apply the org's saved arrangement ---- */
        if (dashLayout === undefined) {
            try {
                dashLayout = (await api.layout("dashboard")).layout;
            } catch {
                dashLayout = null;
            }
        }
        applyDashLayout(dashLayout);

    } catch (error) {
        errorRow(events, 5, error);
        errorRow(escalations, 4, error);
        errorRow(suppliers, 6, error);
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
