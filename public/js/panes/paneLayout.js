/* ============================================================
   Pane layout - pure DOM. Given the workspace object, (re)build the
   pane shells and the draggable dividers inside #view-multi. Knows
   nothing about records; content is a body element handed in by
   paneManager (from paneRenderer's cache).
   ============================================================ */

import { el } from "../dom.js";

/* Build the whole row from scratch. Cheap even on every open/close/
   reorder because the body elements are reused from the cache, so no
   record is re-fetched and scroll survives. */
export function paintAll(root, ws, cb, bodyFor) {
    root.className = "view";

    if (ws.panes.length === 0) {
        root.replaceChildren(emptyState());
        return;
    }

    const row = el("div", { class: "pane-row pane-row-" + ws.layout });
    ws.panes.forEach((pane, index) => {
        if (index > 0) row.append(divider(ws.panes[index - 1], pane, ws, cb, row));
        row.append(shell(pane, index, ws, cb, bodyFor(pane)));
    });
    root.replaceChildren(toolbar(ws, cb), row);
}

function emptyState() {
    return el("div", { class: "pane-empty" }, [
        el("p", { class: "view-title", text: "Split view" }),
        el("p", { class: "view-sub", text:
            "Alt-click a record in any register to open it here, then add more to compare them side by side." })
    ]);
}

function shell(pane, index, ws, cb, body) {
    const last = index === ws.panes.length - 1;
    const editing = pane.mode === "edit";
    const s = el("section", {
        class: "pane"
            + (pane.id === ws.active ? " is-active" : "")
            + (editing ? " is-editing" : ""),
        "data-pane-id": pane.id, tabindex: "0",
        style: "flex-grow:" + pane.weight
    });
    s.addEventListener("pointerdown", () => cb.onActivate(pane.id), { capture: true });

    const head = el("div", { class: "pane-head no-print" }, [
        el("button", {
            class: "pane-btn", type: "button", title: "Move left",
            disabled: index === 0 ? "disabled" : undefined,
            onClick: () => cb.onMove(pane.id, -1)
        }, "‹"),
        el("span", { class: "pane-title", id: "pane-" + pane.id + "-detail-number", text: pane.title }),
        el("span", { id: "pane-" + pane.id + "-detail-status", class: "pane-status" }),
        el("span", { class: "pane-head-sp" }),
        editing
            ? el("span", { class: "pane-editing-tag", text: "editing" })
            : (pane.number ? el("button", {
                class: "pane-btn pane-edit", type: "button", title: "Edit this record",
                "aria-label": "Edit " + (pane.title || "record"),
                disabled: (ws.editing && ws.editing !== pane.id) ? "disabled" : undefined,
                onClick: () => cb.onEdit(pane.id)
            }, "✎") : null),
        el("button", {
            class: "pane-btn", type: "button", title: "Move right",
            disabled: last ? "disabled" : undefined,
            onClick: () => cb.onMove(pane.id, 1)
        }, "›"),
        el("button", {
            class: "pane-btn pane-x", type: "button", title: "Close pane",
            "aria-label": "Close pane", onClick: () => cb.onClose(pane.id)
        }, "×")
    ]);

    body.addEventListener("scroll", () => { pane.scrollTop = body.scrollTop; }, { passive: true });

    s.append(head, body);
    return s;
}

function divider(left, right, ws, cb, row) {
    const d = el("div", {
        class: "pane-divider no-print", role: "separator",
        "aria-orientation": ws.layout === "row" ? "vertical" : "horizontal",
        title: "Drag to resize · double-click to even out"
    });

    d.addEventListener("dblclick", () => cb.onResize(left.id, right.id, "even"));

    d.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        d.setPointerCapture(event.pointerId);
        d.classList.add("is-dragging");

        const horizontal = ws.layout === "row";
        const rowPx = row.getBoundingClientRect()[horizontal ? "width" : "height"];
        const start = horizontal ? event.clientX : event.clientY;
        const L = row.querySelector('.pane[data-pane-id="' + left.id + '"]');
        const R = row.querySelector('.pane[data-pane-id="' + right.id + '"]');

        const onMove = (moveEvent) => {
            const now = horizontal ? moveEvent.clientX : moveEvent.clientY;
            cb.onResize(left.id, right.id, (now - start) / rowPx);
            if (L) L.style.flexGrow = left.weight;
            if (R) R.style.flexGrow = right.weight;
        };
        const onUp = () => {
            d.classList.remove("is-dragging");
            d.removeEventListener("pointermove", onMove);
            d.removeEventListener("pointerup", onUp);
            cb.onResizeEnd();
        };
        d.addEventListener("pointermove", onMove);
        d.addEventListener("pointerup", onUp);
    });

    return d;
}

function toolbar(ws, cb) {
    return el("div", { class: "pane-toolbar no-print" }, [
        el("button", { class: "btn btn-xs", type: "button", onClick: cb.onCollapse }, "⇔ Single view"),
        el("button", {
            class: "btn btn-xs", type: "button",
            onClick: () => cb.onLayout(ws.layout === "row" ? "column" : "row")
        }, ws.layout === "row" ? "Stack" : "Side by side"),
        el("span", { class: "sm dim", text: ws.panes.length + (ws.panes.length === 1 ? " form open" : " forms open") })
    ]);
}
