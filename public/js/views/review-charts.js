/* ============================================================
   Charts for the management review, clause 9.3.

   The review screen shows the 9.3.2 inputs and the 9.3.3 actions;
   this adds the pictures the meeting actually runs on - a trend line,
   a Pareto, a target-versus-actual bar - built and edited in the app,
   drawn as inline SVG (same house style as the dashboard sparkline,
   no chart library), and seen by anyone who opens the review.

   One chart is one series of (label, value) points plus a type and
   axis captions. renderReviewCharts(reference) draws them under the
   review; the editor is a small modal with a live preview.
   ============================================================ */

import { api } from "../api.js";
import { can, applyPermissions } from "../session.js";
import { ensureDialog } from "../forms.js";
import { el, toast, formatDate } from "../dom.js";

const NS = "http://www.w3.org/2000/svg";

const SEEDS = [
    ["ncr_by_month",        "NCRs by month (trend)"],
    ["complaints_by_month", "Complaints by month (trend)"],
    ["capa_by_status",      "CAPA by status (bar)"],
    ["ncr_by_disposition",  "NCRs by disposition (Pareto)"],
    ["objectives_target",   "Quality objectives target (bar)"]
];

const TYPE_LABEL = { bar: "Bar", line: "Line", pareto: "Pareto" };

/* ---------- SVG drawing ---------- */

const W = 640;
const H = 260;
const M = { top: 14, right: 46, bottom: 46, left: 46 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;

function svgEl(name, attrs) {
    const node = document.createElementNS(NS, name);
    for (const [key, value] of Object.entries(attrs || {})) {
        if (value === undefined || value === null) continue;
        node.setAttribute(key, String(value));
    }
    return node;
}

/* <title> child = the native hover tooltip. append() returns undefined,
   so build the title node, set its text, then attach it. */
function withTitle(node, text) {
    const title = svgEl("title", {});
    title.textContent = text;
    node.appendChild(title);
    return node;
}

function svgText(x, y, text, extra) {
    return svgEl("text", {
        x, y, "font-size": 10, fill: "var(--ink-3)",
        "font-family": "'IBM Plex Mono', monospace", ...extra
    });
}

function niceTop(max) {
    if (max <= 0) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(max)));
    const step = pow <= max / 5 ? pow : pow / 2;
    return Math.ceil(max / step) * step;
}

function xLabel(text, x, y) {
    const node = svgText(x, y, "", { "text-anchor": "middle" });
    const short = text.length > 12 ? text.slice(0, 11) + "…" : text;
    node.textContent = short;
    if (short !== text) withTitle(node, text);
    return node;
}

function yAxis(svg, top, unitFromRight) {
    const axisX = unitFromRight ? M.left + PLOT_W : M.left;
    for (let i = 0; i <= 2; i += 1) {
        const value = (top / 2) * i;
        const y = M.top + PLOT_H - (value / top) * PLOT_H;
        svg.append(svgEl("line", {
            x1: M.left, y1: y, x2: M.left + PLOT_W, y2: y,
            stroke: "var(--hairline)", "stroke-width": 1,
            "stroke-dasharray": i === 0 ? "0" : "3 3"
        }));
        const label = svgText(
            unitFromRight ? axisX + 6 : axisX - 6,
            y + 3,
            unitFromRight ? Math.round(value) + "%" : trimNumber(value),
            { "text-anchor": unitFromRight ? "start" : "end" }
        );
        svg.append(label);
    }
}

function trimNumber(value) {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function baseSvg(title) {
    const svg = svgEl("svg", {
        viewBox: "0 0 " + W + " " + H, class: "chart-svg",
        role: "img", "aria-label": title
    });
    svg.append(svgEl("line", {
        x1: M.left, y1: M.top + PLOT_H, x2: M.left + PLOT_W, y2: M.top + PLOT_H,
        stroke: "var(--ink-3)", "stroke-width": 1
    }));
    return svg;
}

function drawBars(svg, points, top, { color = "var(--accent, var(--brand))" } = {}) {
    const slot = PLOT_W / points.length;
    const barW = Math.min(slot * 0.6, 60);

    points.forEach((point, index) => {
        const cx = M.left + slot * (index + 0.5);
        const value = Math.max(point.value, 0);
        const barH = top > 0 ? (value / top) * PLOT_H : 0;
        const rect = svgEl("rect", {
            x: cx - barW / 2, y: M.top + PLOT_H - barH,
            width: barW, height: barH, rx: 2, fill: color
        });
        withTitle(rect, point.label + ": " + trimNumber(point.value));
        svg.append(rect);
        svg.append(xLabel(point.label, cx, M.top + PLOT_H + 14));
    });
}

function drawBar(points) {
    const svg = baseSvg("Bar chart");
    const top = niceTop(Math.max(...points.map((p) => p.value), 0));
    yAxis(svg, top, false);
    drawBars(svg, points, top);
    return svg;
}

function drawLine(points) {
    const svg = baseSvg("Line chart");
    const top = niceTop(Math.max(...points.map((p) => p.value), 0));
    yAxis(svg, top, false);

    const stepX = points.length > 1 ? PLOT_W / (points.length - 1) : 0;
    const coords = points.map((point, index) => {
        const x = points.length > 1 ? M.left + index * stepX : M.left + PLOT_W / 2;
        const y = M.top + PLOT_H - (top > 0 ? (Math.max(point.value, 0) / top) * PLOT_H : 0);
        return [x, y];
    });

    svg.append(svgEl("polyline", {
        points: coords.map(([x, y]) => x + "," + y).join(" "),
        fill: "none", stroke: "var(--accent-fg, var(--brand))", "stroke-width": 2,
        "stroke-linecap": "round", "stroke-linejoin": "round"
    }));

    coords.forEach(([x, y], index) => {
        const dot = svgEl("circle", { cx: x, cy: y, r: 3, fill: "var(--accent-fg, var(--brand))" });
        withTitle(dot, points[index].label + ": " + trimNumber(points[index].value));
        svg.append(dot);
        svg.append(xLabel(points[index].label, x, M.top + PLOT_H + 14));
    });

    return svg;
}

function drawPareto(rawPoints) {
    const points = [...rawPoints].sort((a, b) => b.value - a.value);
    const svg = baseSvg("Pareto chart");
    const total = points.reduce((sum, p) => sum + Math.max(p.value, 0), 0) || 1;
    const top = niceTop(Math.max(...points.map((p) => p.value), 0));

    yAxis(svg, top, false);
    yAxis(svg, 100, true);

    drawBars(svg, points, top);

    /* 80% reference line on the right (cumulative) axis. */
    const y80 = M.top + PLOT_H - 0.8 * PLOT_H;
    svg.append(svgEl("line", {
        x1: M.left, y1: y80, x2: M.left + PLOT_W, y2: y80,
        stroke: "var(--warn)", "stroke-width": 1, "stroke-dasharray": "4 3"
    }));

    const slot = PLOT_W / points.length;
    let running = 0;
    const cumulative = points.map((point) => {
        running += Math.max(point.value, 0);
        return running / total;
    });
    const coords = cumulative.map((fraction, index) => [
        M.left + slot * (index + 0.5),
        M.top + PLOT_H - fraction * PLOT_H
    ]);

    svg.append(svgEl("polyline", {
        points: coords.map(([x, y]) => x + "," + y).join(" "),
        fill: "none", stroke: "var(--ink)", "stroke-width": 1.5,
        "stroke-linecap": "round", "stroke-linejoin": "round"
    }));
    coords.forEach(([x, y], index) => {
        const dot = svgEl("circle", { cx: x, cy: y, r: 2.6, fill: "var(--ink)" });
        withTitle(dot, points[index].label + ": " + Math.round(cumulative[index] * 100) + "% cumulative");
        svg.append(dot);
    });

    return svg;
}

function drawChart(chart) {
    const points = chart.points || [];
    if (points.length === 0) {
        return el("p", { class: "sm dim", text: "No data points yet." });
    }
    if (chart.chart_type === "line") return drawLine(points);
    if (chart.chart_type === "pareto") return drawPareto(points);
    return drawBar(points);
}

/* ---------- screen ---------- */

export async function renderReviewCharts(reference) {
    const host = document.getElementById("review-charts");
    if (!host) return;

    host.dataset.reference = reference;
    host.replaceChildren(el("p", { class: "sm dim", text: "Loading charts..." }));

    try {
        const { charts } = await api.reviewCharts(reference);
        const manage = can("review.manage");

        if (charts.length === 0 && !manage) {
            host.replaceChildren(el("p", { class: "sm dim", text: "No charts on this review." }));
            return;
        }

        const cards = charts.map((chart) => {
            const actions = el("div", { class: "row-actions no-print" });
            if (manage) {
                const edit = el("button", { class: "btn btn-xs", type: "button", text: "Edit" });
                edit.addEventListener("click", () => openChartEditor(reference, chart));
                const remove = el("button", { class: "btn btn-xs btn-danger", type: "button", text: "Delete" });
                remove.addEventListener("click", () => confirmDelete(reference, chart));
                actions.append(edit, remove);
            }

            const caption = chart.points
                .map((p) => p.label + " " + trimNumber(p.value))
                .join("  ·  ");

            return el("div", { class: "review-chart-card" }, [
                el("div", { class: "review-chart-head" }, [
                    el("div", {}, [
                        el("h3", { class: "review-chart-title", text: chart.title }),
                        el("div", { class: "sm dim", text:
                            TYPE_LABEL[chart.chart_type] + " chart"
                            + (chart.updated_at ? " · updated " + formatDate(chart.updated_at) : "")
                            + (chart.updated_by ? " by " + chart.updated_by : "") })
                    ]),
                    actions
                ]),
                drawChart(chart),
                (chart.x_label || chart.y_label)
                    ? el("div", { class: "sm dim review-chart-axes", text:
                        [chart.y_label && "y: " + chart.y_label, chart.x_label && "x: " + chart.x_label]
                            .filter(Boolean).join("   ") })
                    : null,
                el("div", { class: "sm dim review-chart-caption", text: caption })
            ]);
        });

        host.replaceChildren(...(cards.length ? cards
            : [el("p", { class: "sm dim", text: "No charts yet. Add one to show a trend or a Pareto in the review." })]));
        applyPermissions(host);
    } catch (error) {
        host.replaceChildren(el("p", { class: "sm", style: "color:var(--crit)", text: error.message }));
    }
}

function confirmDelete(reference, chart) {
    const node = ensureDialog();
    const go = el("button", { class: "btn btn-danger", type: "button", text: "Delete chart" });
    node.replaceChildren(
        el("div", { class: "modal-head" }, el("h2", { class: "modal-title", text: "Delete “" + chart.title + "”" })),
        el("div", { class: "modal-body" }, el("p", { class: "sm", style: "margin:0",
            text: "The chart and its data points are removed from this review." })),
        el("div", { class: "modal-foot" }, [
            el("button", { class: "btn", type: "button", text: "Cancel", onClick: () => node.close() }),
            go
        ])
    );
    go.addEventListener("click", async () => {
        go.disabled = true;
        try {
            await api.deleteReviewChart(reference, chart.id);
            node.close();
            toast("Chart deleted");
            await renderReviewCharts(reference);
        } catch (error) {
            go.disabled = false;
            toast(error.message);
        }
    });
    node.showModal();
}

/* ---------- editor ---------- */

function pointRow(point, onChange, onRemove) {
    const label = el("input", {
        type: "text", class: "chart-grid-label", placeholder: "Label",
        value: point.label || ""
    });
    const value = el("input", {
        type: "number", step: "any", class: "chart-grid-value", placeholder: "0",
        value: point.value ?? ""
    });
    label.addEventListener("input", onChange);
    value.addEventListener("input", onChange);

    const remove = el("button", { class: "btn btn-xs", type: "button", text: "✕", title: "Remove row" });
    remove.addEventListener("click", onRemove);

    const row = el("div", { class: "chart-grid-row" }, [label, value, remove]);
    row.readPoint = () => ({ label: label.value.trim(), value: Number(value.value) });
    return row;
}

/* `existing` with an id  -> editing that chart (PUT).
   `existing` without one  -> a seed draft to start from (POST).
   no `existing`           -> a blank new chart (POST). */
function openChartEditor(reference, existing) {
    const node = ensureDialog();
    const isEdit = Boolean(existing && existing.id);

    const titleInput = el("input", { type: "text", id: "chart-title", value: existing?.title || "" });
    const typeSelect = el("select", { id: "chart-type" },
        ["bar", "line", "pareto"].map((t) => el("option", {
            value: t, text: TYPE_LABEL[t], selected: existing?.chart_type === t ? "selected" : undefined
        })));
    if (!existing) typeSelect.value = "bar";
    const xInput = el("input", { type: "text", id: "chart-x", value: existing?.x_label || "" });
    const yInput = el("input", { type: "text", id: "chart-y", value: existing?.y_label || "" });

    const grid = el("div", { class: "chart-grid" });
    const preview = el("div", { class: "chart-preview" });
    const errorBox = el("div", { class: "signin-error", hidden: "hidden" });

    function collect() {
        return {
            title: titleInput.value.trim(),
            chart_type: typeSelect.value,
            x_label: xInput.value.trim() || null,
            y_label: yInput.value.trim() || null,
            points: Array.from(grid.querySelectorAll(".chart-grid-row"))
                .map((row) => row.readPoint())
                .filter((p) => p.label !== "")
                .map((p) => ({ label: p.label, value: Number.isFinite(p.value) ? p.value : 0 }))
        };
    }

    function redraw() {
        const draft = collect();
        preview.replaceChildren(
            draft.points.length
                ? drawChart(draft)
                : el("p", { class: "sm dim", text: "Add a labelled row to see the chart." })
        );
    }

    function addRow(point) {
        const row = pointRow(point || { label: "", value: "" }, redraw, () => {
            row.remove();
            redraw();
        });
        grid.append(row);
    }

    (existing?.points?.length ? existing.points : [{ label: "", value: "" }, { label: "", value: "" }])
        .forEach(addRow);

    const addRowButton = el("button", { class: "btn btn-xs", type: "button", text: "+ Add row" });
    addRowButton.addEventListener("click", () => { addRow(); });

    titleInput.addEventListener("input", redraw);
    typeSelect.addEventListener("change", redraw);
    xInput.addEventListener("input", redraw);
    yInput.addEventListener("input", redraw);

    const save = el("button", { class: "btn btn-primary", type: "button", text: isEdit ? "Save chart" : "Add chart" });
    save.addEventListener("click", async () => {
        errorBox.hidden = true;
        const draft = collect();
        if (!draft.title) { showError("Give the chart a title"); return; }
        if (draft.points.length === 0) { showError("Add at least one row with a label"); return; }

        save.disabled = true;
        save.textContent = "Saving...";
        try {
            if (isEdit) await api.updateReviewChart(reference, existing.id, draft);
            else await api.createReviewChart(reference, draft);
            node.close();
            toast(isEdit ? "Chart saved" : "Chart added");
            await renderReviewCharts(reference);
        } catch (error) {
            save.disabled = false;
            save.textContent = isEdit ? "Save chart" : "Add chart";
            showError(error.message);
        }
    });

    function showError(message) {
        errorBox.textContent = message;
        errorBox.hidden = false;
    }

    const field = (label, control) => el("label", { class: "chart-field" }, [
        el("span", { class: "chart-field-label", text: label }), control
    ]);

    node.replaceChildren(
        el("div", { class: "modal-head" },
            el("h2", { class: "modal-title", text: isEdit ? "Edit chart" : "New review chart" })),
        el("div", { class: "modal-body chart-editor" }, [
            errorBox,
            el("div", { class: "chart-editor-fields" }, [
                field("Title", titleInput),
                field("Type", typeSelect),
                field("X axis caption", xInput),
                field("Y axis caption", yInput)
            ]),
            el("div", { class: "chart-editor-split" }, [
                el("div", {}, [
                    el("div", { class: "section-label", text: "Data" }),
                    el("div", { class: "chart-grid-head" }, [
                        el("span", { text: "Label" }), el("span", { text: "Value" }), el("span", {})
                    ]),
                    grid,
                    addRowButton
                ]),
                el("div", {}, [
                    el("div", { class: "section-label", text: "Preview" }),
                    preview
                ])
            ])
        ]),
        el("div", { class: "modal-foot" }, [
            el("button", { class: "btn", type: "button", text: "Cancel", onClick: () => node.close() }),
            save
        ])
    );

    redraw();
    node.showModal();
}

/* ---------- wiring ---------- */

export function wireReviewCharts() {
    const addButton = document.getElementById("review-add-chart");
    const seedSelect = document.getElementById("review-chart-seed");
    if (!addButton && !seedSelect) return;

    function reference() {
        return document.getElementById("review-charts")?.dataset.reference || null;
    }

    if (addButton) {
        addButton.addEventListener("click", () => {
            const ref = reference();
            if (ref) openChartEditor(ref, null);
        });
    }

    if (seedSelect) {
        seedSelect.replaceChildren(
            el("option", { value: "", text: "Start from data…" }),
            ...SEEDS.map(([kind, label]) => el("option", { value: kind, text: label }))
        );
        seedSelect.addEventListener("change", async () => {
            const kind = seedSelect.value;
            const ref = reference();
            seedSelect.value = "";
            if (!kind || !ref) return;
            try {
                const { draft } = await api.reviewChartSeed(ref, kind);
                openChartEditor(ref, { ...draft, id: null, points: draft.points });
            } catch (error) {
                toast(error.message);
            }
        });
    }
}
