/* ============================================================
   Command palette.

   Ctrl/Cmd+K from anywhere: type a screen name to jump straight to
   it, or a record number or a word from its title to jump straight
   to that record. Indexes the sidebar's own nav buttons rather than
   keeping a second list of screens that could drift from it.
   ============================================================ */

import { api } from "./api.js";
import { show } from "./app.js";
import { renderRecordDetail } from "./views/events.js";
import { el } from "./dom.js";

/* Screen a record type's search results should jump to. */
const TYPE_TO_VIEW = {
    ncr: "ncr", capa: "capa", complaint: "complaints",
    audit: "audit", risk: "risk", eightd: "d8", ecn: "change"
};

/* These five share events.js's generic detail renderer, so the
   palette can deep-select the exact record. 8D and change control
   have their own screens (change.js) worth navigating to even though
   this cannot pick out the specific record within them yet. */
const DIRECT_JUMP_TYPES = new Set(["ncr", "capa", "complaint", "audit", "risk"]);

let overlay = null;
let input = null;
let list = null;
let items = [];
let activeIndex = -1;
let searchToken = 0;

function navItems() {
    return [...document.querySelectorAll(".nav-item")].map((button) => ({
        kind: "nav",
        label: button.querySelector("span")?.textContent?.trim() || button.dataset.view,
        view: button.dataset.view
    }));
}

function buildOverlay() {
    if (overlay) return;

    input = el("input", {
        type: "text", class: "palette-input",
        placeholder: "Search records, or jump to a screen…",
        autocomplete: "off", spellcheck: "false"
    });

    list = el("div", { class: "palette-list" });

    const box = el("div", { class: "palette-box" }, [
        el("div", { class: "palette-input-row" }, [input]),
        list,
        el("div", { class: "palette-hint" }, [
            el("span", {}, [el("kbd", {}, "↑"), el("kbd", {}, "↓"), " navigate"]),
            el("span", {}, [el("kbd", {}, "↵"), " open"]),
            el("span", {}, [el("kbd", {}, "esc"), " close"])
        ])
    ]);

    overlay = el("div", { class: "palette-overlay" }, box);
    overlay.hidden = true;
    document.body.append(overlay);

    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) closePalette();
    });

    input.addEventListener("input", () => runSearch(input.value.trim()));
    input.addEventListener("keydown", onKeydown);
}

function onKeydown(event) {
    if (event.key === "Escape") { event.preventDefault(); closePalette(); return; }
    if (event.key === "ArrowDown") { event.preventDefault(); move(1); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); move(-1); return; }
    if (event.key === "Enter") { event.preventDefault(); activate(activeIndex); }
}

function move(delta) {
    if (items.length === 0) return;
    activeIndex = (activeIndex + delta + items.length) % items.length;
    paintActive();
}

function paintActive() {
    [...list.children].forEach((node, index) => {
        node.classList.toggle("palette-item-active", index === activeIndex);
    });
    list.children[activeIndex]?.scrollIntoView({ block: "nearest" });
}

async function runSearch(text) {
    const query = text.toLowerCase();
    const matchingNav = query
        ? navItems().filter((item) => item.label.toLowerCase().includes(query))
        : navItems();

    let records = [];

    if (text.length >= 2) {
        /* A later keystroke can have its response arrive before an
           earlier one's - the token means the earlier response is
           just discarded instead of briefly flashing stale results. */
        const token = ++searchToken;
        try {
            const result = await api.searchRecords(text);
            if (token !== searchToken) return;
            records = result.records.map((record) => ({
                kind: "record",
                label: record.number + "  —  " + record.title,
                type: record.type,
                number: record.number
            }));
        } catch {
            records = [];
        }
    }

    items = [...records, ...matchingNav];
    paintList();
}

function paintList() {
    if (items.length === 0) {
        list.replaceChildren(el("div", { class: "palette-empty", text: "Nothing found" }));
        activeIndex = -1;
        return;
    }

    list.replaceChildren(...items.map((item, index) => {
        const row = el("button", {
            type: "button", class: "palette-item", dataset: { index: String(index) }
        }, [
            el("span", { class: "palette-item-kind", text: item.kind === "nav" ? "GO TO" : "RECORD" }),
            el("span", { class: "palette-item-label", text: item.label })
        ]);
        row.addEventListener("click", () => activate(index));
        return row;
    }));

    activeIndex = 0;
    paintActive();
}

async function activate(index) {
    const item = items[index];
    if (!item) return;

    closePalette();

    if (item.kind === "nav") {
        await show(item.view);
        return;
    }

    const view = TYPE_TO_VIEW[item.type];
    if (view) await show(view);

    if (DIRECT_JUMP_TYPES.has(item.type)) {
        await renderRecordDetail(item.type, item.number);
    }
}

export function openPalette() {
    buildOverlay();
    overlay.hidden = false;
    input.value = "";
    runSearch("");
    input.focus();
}

export function closePalette() {
    if (overlay) overlay.hidden = true;
}

export function wirePalette() {
    document.addEventListener("keydown", (event) => {
        const isCombo = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
        if (!isCombo) return;

        event.preventDefault();
        !overlay || overlay.hidden ? openPalette() : closePalette();
    });
}
