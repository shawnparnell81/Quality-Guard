/* ============================================================
   The department menu bar.

   One data structure describes the whole tree; buildNav() renders it
   into #dept-nav as a horizontal bar of department buttons, each with
   its own dropdown panel. The leaf markup it produces is exactly what
   the count/badge code in app.js already looks for
   (.nav-item[data-view], .nav-count[data-nav-count], #nav-readiness-count).

   Dropdowns are independent: opening one never closes another. A click
   opens a panel; it closes again as soon as the pointer leaves that
   department (its button and its panel are one hover region), on a
   second click of its own button, or on a click anywhere outside the
   bar. Picking a screen navigates and leaves the panel as it is. On
   narrow screens the whole bar is an off-canvas drawer (style.css)
   with every panel shown inline and hover does nothing.
   ============================================================ */

import { el } from "./dom.js";

/* leaf:  { label, view, countKey?, countId?, hot?, disabled? }
   group: { label, items: leaf[] }        (a labelled section in a panel)
   dept:  { dept, items?: leaf[], groups?: group[] }
   flat:  { flat: true, items: leaf[] }   (bar links, no dropdown) */
export const NAV = [
    { flat: true, items: [
        { label: "Dashboard", view: "dashboard" },
        { label: "Audit Readiness", view: "readiness", countId: "nav-readiness-count", hot: true }
    ] },

    { dept: "Purchasing", items: [
        { label: "Approved Vendor List", view: "avl" },
        { label: "Vendor Onboarding", view: "onboarding" },
        { label: "Receiving Inspection", view: "receiving" },
        { label: "Supplier Scorecards", view: "scorecards" }
    ] },

    { dept: "Production", items: [
        { label: "Production Control", view: "production" },
        { label: "Warehouse & Material", view: "warehouse" },
        { label: "Shipping", view: "shipping" },
        { label: "Floor Report", view: "floor-report" }
    ] },

    { dept: "Tooling", items: [
        { label: "Calibration / Gages", view: "calibration", countKey: "calibration_due" }
    ] },

    { dept: "Quality", groups: [
        { label: "Events", items: [
            { label: "Nonconformance", view: "ncr", countKey: "ncr", hot: true },
            { label: "CAPA", view: "capa", countKey: "capa" },
            { label: "8D Investigations", view: "d8", countKey: "eightd" },
            { label: "Customer Complaints", view: "complaints", countKey: "complaint" }
        ] },
        { label: "Audit & Review", items: [
            { label: "Internal Audit", view: "audit", countKey: "audit", hot: true },
            { label: "Discrepancy Investigations", view: "di", countKey: "di" },
            { label: "Management Review", view: "review" },
            { label: "Risk Register", view: "risk" },
            { label: "Turtle Diagrams", view: "turtle" },
            { label: "Audit → CAPA Workflow", view: "audit-workflow" }
        ] },
        { label: "Control", items: [
            { label: "Document Control", view: "documents" },
            { label: "Training & Competence", view: "training" }
        ] }
    ] },

    { dept: "Engineering", items: [
        { label: "Engineering Drawings", view: "drawings" },
        { label: "Engineering Documents", view: "eng-documents" },
        { label: "Change Control (ECN)", view: "change", countKey: "ecn" },
        { label: "APQP Programs", view: "apqp", countKey: "apqp" }
    ] },

    { dept: "Administration", items: [
        { label: "People & Access", view: "people" },
        { label: "Form Builder", view: "forms" },
        { label: "Roles & Permissions", view: "workflows" }
    ] }
];

let mount = null;
let outsideCloseWired = false;

function leafButton(leaf) {
    if (leaf.disabled) {
        return el("button", { class: "nav-item is-mock", type: "button", disabled: "disabled" }, [
            el("span", { text: leaf.label }),
            el("span", { class: "nav-mock", text: "soon" })
        ]);
    }

    const children = [el("span", { text: leaf.label })];

    if (leaf.countId) {
        children.push(el("span", {
            class: "nav-count" + (leaf.hot ? " hot" : ""),
            id: leaf.countId, text: "-"
        }));
    } else if (leaf.countKey) {
        children.push(el("span", {
            class: "nav-count" + (leaf.hot ? " hot" : ""),
            "data-nav-count": leaf.countKey, hidden: "hidden"
        }));
    }

    return el("button", { class: "nav-item", type: "button", "data-view": leaf.view }, children);
}

function caret() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "nav-caret");
    svg.setAttribute("viewBox", "0 0 12 12");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M2 4 L6 8 L10 4");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
    return svg;
}

function closeAllMenus() {
    if (!mount) return;
    for (const menu of mount.querySelectorAll(".deptbar-menu")) menu.hidden = true;
    for (const btn of mount.querySelectorAll(".deptbar-btn")) {
        btn.setAttribute("aria-expanded", "false");
    }
}

function deptItem(section) {
    const menu = el("div", { class: "deptbar-menu", hidden: "hidden" });

    if (section.groups) {
        section.groups.forEach((group) => {
            menu.append(el("div", { class: "deptbar-section" }, [
                el("div", { class: "deptbar-section-label", text: group.label }),
                ...group.items.map(leafButton)
            ]));
        });
    } else {
        for (const leaf of section.items) menu.append(leafButton(leaf));
    }

    const btn = el("button", {
        class: "deptbar-btn", type: "button",
        "aria-haspopup": "true", "aria-expanded": "false"
    }, [el("span", { text: section.dept }), caret()]);

    const setOpen = (open) => {
        menu.hidden = !open;
        btn.setAttribute("aria-expanded", open ? "true" : "false");
    };

    /* Toggle THIS panel only. Opening it never touches the others. */
    btn.addEventListener("click", () => setOpen(menu.hidden));

    const wrapper = el("div", { class: "deptbar-item", "data-dept": section.dept }, [btn, menu]);

    /* Leaving the department - button or panel, they are one region
       because the panel is a child of the wrapper - closes it. Moving
       between the button and the panel stays inside the wrapper, so it
       never fires there. Pointer only: on the mobile drawer the panel
       is shown inline regardless and there is nothing to hover. */
    wrapper.addEventListener("mouseleave", () => setOpen(false));

    return wrapper;
}

export function buildNav(mountEl) {
    if (!mountEl) return;
    mount = mountEl;
    mount.replaceChildren();

    for (const section of NAV) {
        if (section.flat) {
            for (const leaf of section.items) {
                const link = leafButton(leaf);
                link.classList.add("deptbar-link");
                mount.append(link);
            }
        } else {
            mount.append(deptItem(section));
        }
    }

    /* One listener for the life of the page: a click anywhere that is
       not inside the bar closes every open panel. The click that opens
       a panel lands on a button inside #dept-nav, so it is naturally
       excluded - no set-timeout dance needed. */
    if (!outsideCloseWired) {
        document.addEventListener("click", (event) => {
            if (!event.target.closest("#dept-nav")) closeAllMenus();
        });
        outsideCloseWired = true;
    }
}

/* Purchasing / Production etc. -> the [data-dept] slug style.css keys
   its accent off. */
const DEPT_SLUG = { administration: "admin" };

/* Underline the department button whose panel contains the current
   screen, and set the per-department accent on .app. Never opens a
   panel - a dropdown appearing over the content on every screen switch
   would be intrusive. A flat item (Dashboard, Audit Readiness) has no
   department, so the accent clears back to the brand default. */
export function markActiveDept(view) {
    if (!mount) return;

    const leaf = mount.querySelector('.nav-item[data-view="' + view + '"]');
    const item = leaf ? leaf.closest(".deptbar-item") : null;

    const app = document.querySelector(".app");
    if (app) {
        const raw = item ? (item.dataset.dept || "").toLowerCase() : "";
        const slug = DEPT_SLUG[raw] || raw;
        if (slug) app.dataset.dept = slug;
        else app.removeAttribute("data-dept");
    }

    for (const btn of mount.querySelectorAll(".deptbar-btn")) {
        btn.classList.toggle("is-active", Boolean(item) && item.contains(btn));
    }
}
