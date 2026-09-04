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
