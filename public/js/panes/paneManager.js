/* ============================================================
   Multi-pane workspace - open several records side by side inside the
   app (never a browser tab). Owns the panes[] array, its persistence
   (localStorage + the ?panes= URL param), and the open / close /
   move / resize operations. Layout is drawn by paneLayout; each
   pane's content by paneRenderer.

   The workspace is one screen (#view-multi) and one workspace tab
   ("Split view"), so it slots into the existing SPA model with no
   new routing machinery.
   ============================================================ */

import { show } from "../app.js";
import { closeTab } from "../tabs.js";
import { paintAll } from "./paneLayout.js";
import { mountPane, bodyFor, dropPane, dropAll } from "./paneRenderer.js";

const STORE = "qmsg:panes:v1";
const MIN_WEIGHT = 0.16;

/* Panes carry mode "view" | "edit" (M2/M3). Several may be in "edit"
   at once - each owns a pane._editor handle. Not persisted: a reload
   comes back read-only and the editor's own draft-restore offers any
   unsaved work. */
let ws = { version: 1, layout: "row", panes: [], active: null };

const uid = () => "p_" + Math.random().toString(36).slice(2, 8);
const root = () => document.getElementById("view-multi");

/* ---------- persistence + URL ---------- */

function persist() {
    try {
        localStorage.setItem(STORE, JSON.stringify({
            version: 1, layout: ws.layout, active: ws.active,
            panes: ws.panes.map((p) => ({
                id: p.id, type: p.type, number: p.number, title: p.title, weight: p.weight
            }))
        }));
    } catch { /* private mode / full - the layout just will not survive a reload */ }

    const params = new URLSearchParams(location.search);
    if (ws.panes.length) params.set("panes", encode()); else params.delete("panes");
    history.replaceState(null, "", location.pathname + (params.toString() ? "?" + params : ""));
}

export function encode() {
    return ws.panes.map((p) =>
        p.type + ":" + (p.number || "new") + (p.weight !== 1 ? ":" + round(p.weight) : "")
    ).join(",");
}
function decode(str) {
    return (str || "").split(",").filter(Boolean).map((seg) => {
        const [type, number, weight] = seg.split(":");
        return {
            id: uid(), type,
            number: number && number !== "new" ? number : null,
            title: number && number !== "new" ? number : "New " + type,
            weight: Number(weight) > 0 ? Number(weight) : 1,
            scrollTop: 0
        };
    }).filter((p) => p.type);
}
const round = (n) => Math.round(n * 100) / 100;

/* ---------- lifecycle ---------- */

/* Called once from app.js start(), after wireTabs(). Loads the
   workspace from the URL (deep link wins) or the last visit. */
export function wirePanes() {
    const fromUrl = new URLSearchParams(location.search).get("panes");
    if (fromUrl) {
        ws.panes = decode(fromUrl);
        ws.active = ws.panes[0] ? ws.panes[0].id : null;
        return;
    }
    try {
        const saved = JSON.parse(localStorage.getItem(STORE) || "null");
        if (saved && Array.isArray(saved.panes)) {
            ws.layout = saved.layout === "column" ? "column" : "row";
            ws.panes = saved.panes
                .filter((p) => p && p.type)
                .map((p) => ({ ...p, weight: Number(p.weight) > 0 ? Number(p.weight) : 1, scrollTop: 0 }));
            ws.active = saved.active && ws.panes.some((p) => p.id === saved.active)
                ? saved.active : (ws.panes[0] ? ws.panes[0].id : null);
        }
    } catch { /* keep the empty workspace */ }
}

export function hasPanes() { return ws.panes.length > 0; }
export function paneCount() { return ws.panes.length; }

/* ---------- operations ---------- */

export async function openPane({ type, number, title }) {
    if (!type) return;
    const key = (p) => p.type + ":" + (p.number || "new");
    const wanted = type + ":" + (number || "new");
    const existing = ws.panes.find((p) => key(p) === wanted);

    if (existing) {
        ws.active = existing.id;
    } else {
        const pane = {
            id: uid(), type, number: number || null,
            title: title || number || ("New " + type), weight: 1, scrollTop: 0
        };
        ws.panes.push(pane);
        ws.active = pane.id;
    }

    await show("multi", { reload: false });
    persist();
    await render();
    focusPane(ws.active);
}

export function closePane(id) {
    const index = ws.panes.findIndex((p) => p.id === id);
    if (index === -1) return;

    if (!tearDownPaneEdit(ws.panes[index])) return;

    dropPane(id);
    ws.panes.splice(index, 1);

    if (ws.panes.length === 0) {
        ws.active = null;
        persist();
        closeTab("multi");
        show("dashboard");
        return;
    }
    ws.active = (ws.panes[index] || ws.panes[index - 1]).id;
    persist();
    render();
}

export function movePane(id, dir) {
    const i = ws.panes.findIndex((p) => p.id === id);
    const j = i + dir;
    if (i === -1 || j < 0 || j >= ws.panes.length) return;
    [ws.panes[i], ws.panes[j]] = [ws.panes[j], ws.panes[i]];
    persist();
    render();
    focusPane(id);
}

/* toIndex is the drop slot in the current array (0..length); the
   drag-reorder handler passes it from the cursor position. */
export function reorderPane(id, toIndex) {
    const from = ws.panes.findIndex((p) => p.id === id);
    if (from === -1) return;
    let to = Math.max(0, Math.min(ws.panes.length, toIndex));
    if (from < to) to -= 1;
    if (to === from) return;
    const [pane] = ws.panes.splice(from, 1);
    ws.panes.splice(to, 0, pane);
    persist();
    render();
    focusPane(id);
}

export async function comparePanes() {
    if (ws.panes.length !== 2) return;
    const { openCompare } = await import("./paneCompare.js");
    openCompare(ws.panes[0], ws.panes[1]);
}

/* delta: a fraction of the row (from a divider drag) or "even". */
export function resize(leftId, rightId, delta) {
    const L = ws.panes.find((p) => p.id === leftId);
    const R = ws.panes.find((p) => p.id === rightId);
    if (!L || !R) return;
    const total = L.weight + R.weight;
    if (delta === "even") {
        L.weight = R.weight = total / 2;
        persist();
        render();
        return;
    }
    L.weight = Math.max(MIN_WEIGHT, Math.min(total - MIN_WEIGHT, L.weight + delta * total));
    R.weight = total - L.weight;
}
export function resizeEnd() { persist(); }

export function setActive(id) {
    if (ws.active === id) return;
    ws.active = id;
    root()?.querySelectorAll(".pane").forEach((n) =>
        n.classList.toggle("is-active", n.dataset.paneId === id));
    persist();
}

export function setLayout(layout) {
    ws.layout = layout === "column" ? "column" : "row";
    persist();
    render();
}

export function collapseToSingle() {
    if (ws.panes.some((p) => p._editor && p._editor.isDirty && p._editor.isDirty())
        && !window.confirm("Discard unsaved changes in the open editors?")) return;
    ws.panes.forEach((p) => { if (p._editor) p._editor.destroy(); });
    const keep = ws.panes.find((p) => p.id === ws.active) || ws.panes[0];
    ws.panes = [];
    ws.active = null;
    dropAll();
    persist();
    closeTab("multi");
    if (keep && keep.number) {
        import("../record-nav.js").then((m) => m.openRecord(keep.number, keep.type));
    } else {
        show("dashboard");
    }
}

/* Confirm + tear down one pane's live editor. Returns false if the
   user cancels out of discarding unsaved changes. */
function tearDownPaneEdit(pane) {
    if (!pane || !pane._editor) return true;
    if (pane._editor.isDirty && pane._editor.isDirty()
        && !window.confirm("Discard unsaved changes to " + pane.number + "?")) {
        return false;
    }
    pane._editor.destroy();
    pane._editor = null;
    return true;
}

/* ---------- render (also the LOADERS.multi entry) ---------- */

export async function render() {
    const node = root();
    if (!node) return;
    paintAll(node, ws, {
        onClose: closePane, onMove: movePane, onReorder: reorderPane, onActivate: setActive,
        onResize: resize, onResizeEnd: resizeEnd, onEdit: editPane,
        onCollapse: collapseToSingle, onLayout: setLayout, onCompare: comparePanes
    }, bodyFor);
    await Promise.all(ws.panes.map((p) => mountPane(p, () => finishEdit(p.id))));
}

/* ---------- edit a pane in place (M2 one at a time, M3 concurrent) ---------- */

export function editPane(id) {
    const p = ws.panes.find((x) => x.id === id);
    if (!p || !p.number || p.mode === "edit") return;
    p.mode = "edit";
    ws.active = id;
    render();
}

export function finishEdit(id) {
    const p = ws.panes.find((x) => x.id === id);
    if (p) { p.mode = "view"; p._editor = null; }
    render();
}

function focusPane(id) {
    root()?.querySelector('.pane[data-pane-id="' + id + '"]')?.focus?.();
}
