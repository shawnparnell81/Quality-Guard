/* ============================================================
   Small DOM helpers.

   Deliberately not a framework. These exist so view code reads as
   "what to show" rather than a wall of createElement calls, and so
   loading and error states look the same everywhere.
   ============================================================ */

/* Builds an element. Text content is set with textContent, never
   innerHTML, so a lot number containing < or & can never become
   markup. */
export function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);

    for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null) continue;

        if (key === "class") {
            node.className = value;
        } else if (key === "text") {
            node.textContent = value;
        } else if (key === "dataset") {
            Object.assign(node.dataset, value);
        } else if (key.startsWith("on") && typeof value === "function") {
            node.addEventListener(key.slice(2).toLowerCase(), value);
        } else {
            node.setAttribute(key, value);
        }
    }

    for (const child of [].concat(children)) {
        if (child === null || child === undefined || child === false) continue;
        node.append(typeof child === "object" ? child : document.createTextNode(String(child)));
    }

    return node;
}

/* ---------- shared visual vocabulary ---------- */

/* Status pill. The kind maps to the same four classes the static
   markup already uses, so wired and unwired views look identical. */
export function pill(text, kind = "hold") {
    return el("span", { class: "pill pill-" + kind, text });
}

/* Severity stripe. Colour alone never carries the meaning: the
   stripe is a shape as well, and the row text says the same thing. */
export function severity(level) {
    return el("span", { class: "sev sev-" + (level || "ok") });
}

export function recordId(number) {
    return el("span", { class: "rec-id", text: number });
}

/* ---------- table rendering ---------- */

/* columns: [{ label, className, headerClass, render(row) }]
   render may return a string, a node, or an array of nodes. */
export function fillTable(tbody, rows, columns, emptyMessage = "Nothing to show") {
    if (!tbody) return;

    if (!rows || rows.length === 0) {
        tbody.replaceChildren(
            el("tr", {}, el("td", {
                colspan: columns.length,
                class: "dim sm",
                text: emptyMessage,
                style: "text-align:center;padding:24px"
            }))
        );
        return;
    }

    tbody.replaceChildren(...rows.map((row) => {
        const tr = el("tr");

        for (const column of columns) {
            const value = column.render ? column.render(row) : "";
            tr.append(el("td", { class: column.className }, value));
        }

        return tr;
    }));
}

export function loadingRow(tbody, columnCount) {
    if (!tbody) return;

    tbody.replaceChildren(
        el("tr", {}, el("td", {
            colspan: columnCount,
            class: "dim sm",
            text: "Loading...",
            style: "text-align:center;padding:24px"
        }))
    );
}

export function errorRow(tbody, columnCount, error) {
    if (!tbody) return;

    tbody.replaceChildren(
        el("tr", {}, el("td", {
            colspan: columnCount,
            style: "text-align:center;padding:24px;color:var(--crit)"
        }, [
            el("div", { class: "sm", text: error.message }),
            el("div", { class: "sm dim", text: "Start the server with: npm run dev" })
        ]))
    );
}

/* ---------- toasts ---------- */

/* A brief, dismissable confirmation - "NCR-2026-0151 created", "Moved
   to Containment", "Published version 3" - for actions that used to
   have no feedback beyond the screen quietly updating. aria-live on
   the container (index.html) means a screen reader announces these
   without needing anything added here. */
export function toast(message, kind = "ok") {
    const container = document.getElementById("toast-container");
    if (!container) return;

    const node = el("div", { class: "toast toast-" + kind }, message);
    container.append(node);

    /* Removed by its own timeout, not a click - a toast that requires
       action to dismiss is a dialog, not a toast. */
    setTimeout(() => {
        node.classList.add("toast-out");
        node.addEventListener("transitionend", () => node.remove(), { once: true });
    }, 3200);
}

/* ---------- sparklines ----------
   A tiny real trend, not decoration: values is real history (weekly
   counts from opened_at, computed server-side - nothing invented on
   the client). Draws into an existing inline <svg viewBox="0 0 100
   28">, sized in CSS like any other element; stroke uses currentColor
   so a tile's own text colour (is-crit / is-warn) controls it without
   this needing to know about severity at all. */
export function drawSparkline(svgId, values, { recordsByWeek, onPointClick } = {}) {
    const svg = document.getElementById(svgId);
    if (!svg || !values || values.length === 0) return;

    const width = 100, height = 28, pad = 3;
    const max = Math.max(...values, 1);
    const stepX = values.length > 1 ? width / (values.length - 1) : 0;

    const points = values.map((value, index) => {
        const x = index * stepX;
        const y = height - pad - (value / max) * (height - pad * 2);
        return [x, y];
    });

    svg.replaceChildren();

    const ns = "http://www.w3.org/2000/svg";

    const polyline = document.createElementNS(ns, "polyline");
    polyline.setAttribute("points", points.map(([x, y]) => x + "," + y).join(" "));
    polyline.setAttribute("fill", "none");
    polyline.setAttribute("stroke", "currentColor");
    polyline.setAttribute("stroke-width", "2");
    polyline.setAttribute("stroke-linecap", "round");
    polyline.setAttribute("stroke-linejoin", "round");
    svg.append(polyline);

    const [lastX, lastY] = points[points.length - 1];
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", lastX);
    dot.setAttribute("cy", lastY);
    dot.setAttribute("r", "2.3");
    dot.setAttribute("fill", "currentColor");
    svg.append(dot);

    /* Every point with real records behind it gets an invisible,
       generously-sized hit target - the visible dot is only 2.3px,
       far too small to click reliably, and only weeks that actually
       happened respond at all. recordsByWeek carries the same shape
       as values: one array of record numbers per week, from the
       dashboard endpoint's trend_records. */
    if (onPointClick && recordsByWeek) {
        points.forEach(([x, y], index) => {
            const numbers = recordsByWeek[index];
            if (!numbers || numbers.length === 0) return;

            const hit = document.createElementNS(ns, "circle");
            hit.setAttribute("cx", x);
            hit.setAttribute("cy", y);
            hit.setAttribute("r", "6");
            hit.setAttribute("fill", "transparent");
            hit.setAttribute("role", "button");
            hit.setAttribute("tabindex", "0");
            hit.setAttribute("aria-label", numbers.length + " record" + (numbers.length === 1 ? "" : "s") + " this week - open");
            hit.style.cursor = "pointer";

            const activate = (event) => { event.stopPropagation(); onPointClick(index, numbers); };
            hit.addEventListener("click", activate);
            hit.addEventListener("keydown", (event) => {
                if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(event); }
            });

            svg.append(hit);
        });
    }
}

/* ---------- printing ---------- */

/* Prints one element in isolation, using the .print-area rule in
   style.css: everything else on the page is hidden for the duration
   of the print, and put back the moment the print dialog closes
   (afterprint fires whether the person printed or cancelled). A
   button or other control inside the printed node still needs its
   own "no-print" class - marking the container alone is not enough,
   since .print-area makes everything under it visible again. */
export function printElement(node) {
    if (!node) return;

    node.classList.add("print-area");

    function cleanup() {
        node.classList.remove("print-area");
        window.removeEventListener("afterprint", cleanup);
    }

    window.addEventListener("afterprint", cleanup);
    window.print();
}

/* ---------- formatting ---------- */

export function setText(id, value) {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
}

export function formatDate(value) {
    if (!value) return "-";

    return new Date(value).toLocaleDateString("en-GB", {
        day: "2-digit", month: "short", year: "numeric"
    });
}

export function daysAgo(value) {
    if (!value) return "-";
    const days = Math.floor((Date.now() - new Date(value)) / 86400000);
    return days + " d";
}

/* Workflow states and statuses come back as snake_case keys. Render
   them as words without hard-coding a lookup table for every one. */
export function humanize(value) {
    if (!value) return "-";
    const words = String(value).replace(/_/g, " ");
    return words.charAt(0).toUpperCase() + words.slice(1);
}

/* Maps a record status onto one of the four pill styles. Anything
   unrecognised falls through to the neutral one rather than throwing. */
export function statusKind(status) {
    const open = ["draft", "containment", "investigation", "overdue", "unmitigated", "awaiting_8d"];
    const progress = ["mrb", "root_cause", "action_plan", "in_progress", "scheduled",
                      "eightd_linked", "investigating", "response_drafted", "with_logistics",
                      "response_received", "d4", "d7"];
    const done = ["closed", "verify", "effectiveness", "controlled", "disposition"];

    if (open.includes(status)) return "open";
    if (progress.includes(status)) return "prog";
    if (done.includes(status)) return "done";
    return "hold";
}
