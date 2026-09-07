/* ============================================================
   Menu Layout editor (org-level, layout.manage).

   Drag a menu item from one department into another, reorder items
   within a department, reorder the departments, or hide an item the
   org does not use. The arrangement is saved for everyone (the
   user's choice - org-set, not per-person), stored as
   { order: [{ dept, items: [view] }], hidden: [view] } via
   /api/layout/nav.

   The Administration department and its "Menu Layout" item are
   locked so an admin can never hide the way back in.
   ============================================================ */

import { api } from "../api.js";
import { can } from "../session.js";
import {
    applyNavLayout, defaultNavDepartments, navItemLabels,
    NAV_LOCKED_VIEW, NAV_LOCKED_DEPT
} from "../nav.js";
import { el, toast } from "../dom.js";

const LABELS = navItemLabels();

/* Merge the stored layout over the defaults so the editor always
   shows every department and every item exactly once. */
function editorModel(layout) {
    const defaults = defaultNavDepartments();
    const hidden = new Set((layout && layout.hidden) || []);
    const placed = new Set();
    const order = [];

    const wanted = (layout && Array.isArray(layout.order)) ? layout.order : defaults;
    const defaultByDept = new Map(defaults.map((d) => [d.dept, d]));

    for (const entry of wanted) {
        if (!defaultByDept.has(entry.dept)) continue;
        const items = (entry.items || []).filter((v) => LABELS[v] && !placed.has(v));
        items.forEach((v) => placed.add(v));
        order.push({ dept: entry.dept, items });
    }
    /* Append any department or item the layout left out. */
    for (const def of defaults) {
        let block = order.find((o) => o.dept === def.dept);
        if (!block) { block = { dept: def.dept, items: [] }; order.push(block); }
        for (const v of def.items) {
            if (placed.has(v) || !LABELS[v]) continue;
            placed.add(v);
            block.items.push(v);
        }
    }

    return { order, hidden: [...placed].filter((v) => hidden.has(v)) };
}

function readModelFromDom(root) {
    const order = [];
    root.querySelectorAll(".ml-dept").forEach((deptEl) => {
        order.push({
            dept: deptEl.dataset.dept,
            items: [...deptEl.querySelectorAll(".ml-item[data-view]")].map((i) => i.dataset.view)
        });
    });
    const hidden = [...root.querySelectorAll('.ml-item[data-view].is-hidden')].map((i) => i.dataset.view);
    return { order, hidden };
}

/* ---------- drag and drop ---------- */

let dragged = null;

function itemAfterPoint(container, y) {
    const items = [...container.querySelectorAll(".ml-item:not(.dragging)")];
    return items.reduce((closest, item) => {
        const box = item.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) return { offset, item };
        return closest;
    }, { offset: Number.NEGATIVE_INFINITY, item: null }).item;
}

function makeItem(view) {
    const locked = view === NAV_LOCKED_VIEW;
    const item = el("div", {
        class: "ml-item" + (locked ? " is-locked" : ""),
        draggable: locked ? "false" : "true",
        dataset: { view }
    }, [
        el("span", { class: "ml-grip", text: locked ? "🔒" : "⠿" }),
        el("span", { class: "ml-item-label", text: LABELS[view] || view }),
        el("span", { class: "ml-item-view", text: view })
    ]);

    if (!locked) {
        const hideBtn = el("button", { class: "ml-hide", type: "button", text: "Hide" });
        hideBtn.addEventListener("click", () => {
            const nowHidden = !item.classList.contains("is-hidden");
            item.classList.toggle("is-hidden", nowHidden);
            hideBtn.textContent = nowHidden ? "Show" : "Hide";
        });
        item.append(hideBtn);

        item.addEventListener("dragstart", (e) => {
            dragged = item;
            item.classList.add("dragging");
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", view);
        });
        item.addEventListener("dragend", () => {
            item.classList.remove("dragging");
            dragged = null;
        });
    }
    return item;
}

function makeDept(block, isLocked) {
    const list = el("div", { class: "ml-dept-items" });
    block.items.forEach((view) => list.append(makeItem(view)));

    const deptEl = el("div", {
        class: "ml-dept" + (isLocked ? " is-locked" : ""),
        dataset: { dept: block.dept }
    }, [
        el("div", { class: "ml-dept-head" }, [
            el("span", { class: "ml-grip", text: isLocked ? "🔒" : "⠿" }),
            el("span", { class: "ml-dept-name", text: block.dept })
        ]),
        list
    ]);

    /* Drop an item into this department's list. */
    list.addEventListener("dragover", (e) => {
        if (!dragged) return;
        e.preventDefault();
        const after = itemAfterPoint(list, e.clientY);
        if (dragged.dataset.view === NAV_LOCKED_VIEW && block.dept !== NAV_LOCKED_DEPT) return;
        if (after) list.insertBefore(dragged, after);
        else list.appendChild(dragged);
    });

    return deptEl;
}

export async function renderMenuLayout() {
    const host = document.getElementById("menu-layout-body");
    if (!host) return;

    if (!can("layout.manage")) {
        host.replaceChildren(el("p", { class: "sm dim", text:
            "Arranging the menu needs the layout.manage permission." }));
        return;
    }

    host.replaceChildren(el("p", { class: "sm dim", text: "Loading..." }));

    let layout = null;
    try {
        layout = (await api.layout("nav")).layout;
    } catch (error) {
        host.replaceChildren(el("p", { class: "sm", style: "color:var(--crit)", text: error.message }));
        return;
    }

    const model = editorModel(layout);
    const hidden = new Set(model.hidden);
    const board = el("div", { class: "ml-board" });

    model.order.forEach((block) => {
        const deptEl = makeDept(block, block.dept === NAV_LOCKED_DEPT);
        deptEl.querySelectorAll(".ml-item[data-view]").forEach((item) => {
            if (hidden.has(item.dataset.view)) {
                item.classList.add("is-hidden");
                const btn = item.querySelector(".ml-hide");
                if (btn) btn.textContent = "Show";
            }
        });
        board.append(deptEl);
    });

    const save = el("button", { class: "btn btn-primary", type: "button", text: "Save menu" });
    const reset = el("button", { class: "btn", type: "button", text: "Reset to default" });

    save.addEventListener("click", async () => {
        const next = readModelFromDom(board);
        save.disabled = true;
        try {
            const saved = await api.saveLayout("nav", next);
            applyNavLayout(saved.layout);
            toast("Menu layout saved for the organisation");
        } catch (error) {
            toast(error.message, "error");
        } finally {
            save.disabled = false;
        }
    });

    reset.addEventListener("click", async () => {
        try {
            await api.saveLayout("nav", null);
            applyNavLayout(null);
            toast("Menu layout reset to default");
            renderMenuLayout();
        } catch (error) {
            toast(error.message, "error");
        }
    });

    host.replaceChildren(
        el("p", { class: "sm dim", style: "margin:0 0 12px", text:
            "Drag an item by its handle to reorder it or move it to another department. "
            + "Use Hide for items the organisation does not use. Changes apply to everyone once saved." }),
        board,
        el("div", { class: "row", style: "margin-top:16px" }, [save, reset])
    );
}
