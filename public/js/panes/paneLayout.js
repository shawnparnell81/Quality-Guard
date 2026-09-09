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
    wireDragReorder(row, ws, cb);
    root.replaceChildren(toolbar(ws, cb), row);
}

/* Drag a pane by its header to a new slot. Pointer-based (not HTML5
   DnD) so it also works on touch. A short move threshold keeps a
   plain header click from starting a drag. */
function wireDragReorder(row, ws, cb) {
    const horizontal = () => ws.layout === "row";

    row.addEventListener("pointerdown", (event) => {
        const head = event.target.closest(".pane-head");
        if (!head) return;
        if (event.target.closest("button, input, select, textarea, a")) return;

        const pane = head.closest(".pane[data-pane-id]");
        if (!pane) return;
        const id = pane.dataset.paneId;
        const start = horizontal() ? event.clientX : event.clientY;
        let dragging = false;

        const panesNow = () => [...row.querySelectorAll(".pane[data-pane-id]")];
        const clearMarks = () => panesNow().forEach((p) =>
            p.classList.remove("drop-before", "drop-after"));

        const targetIndex = (ev) => {
            const rects = panesNow().map((p) => p.getBoundingClientRect());
            const pos = horizontal() ? ev.clientX : ev.clientY;
            for (let i = 0; i < rects.length; i++) {
                const mid = horizontal()
                    ? rects[i].left + rects[i].width / 2
                    : rects[i].top + rects[i].height / 2;
                if (pos < mid) return i;
            }
            return rects.length;
        };

        const onMove = (ev) => {
            if (!dragging) {
                if (Math.abs((horizontal() ? ev.clientX : ev.clientY) - start) < 6) return;
                dragging = true;
                pane.classList.add("is-dragreorder");
                try { row.setPointerCapture(event.pointerId); } catch { /* synthetic pointer */ }
            }
            const t = targetIndex(ev);
            clearMarks();
            const panes = panesNow();
            if (t >= panes.length) panes[panes.length - 1].classList.add("drop-after");
            else panes[t].classList.add("drop-before");
        };

        const onUp = (ev) => {
            row.removeEventListener("pointermove", onMove);
            row.removeEventListener("pointerup", onUp);
            row.removeEventListener("pointercancel", onUp);
            if (!dragging) return;
            clearMarks();
            pane.classList.remove("is-dragreorder");
            cb.onReorder(id, targetIndex(ev));
        };

        row.addEventListener("pointermove", onMove);
        row.addEventListener("pointerup", onUp);
        row.addEventListener("pointercancel", onUp);
    });
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
    const canCompare = ws.panes.length === 2
        && ws.panes[0].type === ws.panes[1].type
        && ws.panes[0].number && ws.panes[1].number;

    return el("div", { class: "pane-toolbar no-print" }, [
        el("button", { class: "btn btn-xs", type: "button", onClick: cb.onCollapse }, "⇔ Single view"),
        el("button", {
            class: "btn btn-xs", type: "button",
            onClick: () => cb.onLayout(ws.layout === "row" ? "column" : "row")
        }, ws.layout === "row" ? "Stack" : "Side by side"),
        canCompare ? el("button", {
            class: "btn btn-xs", type: "button", onClick: cb.onCompare
        }, "Compare fields") : null,
        el("span", { class: "sm dim", text: ws.panes.length + (ws.panes.length === 1 ? " form open" : " forms open") })
    ]);
}
