/* ============================================================
   The department sidebar.

   One data structure describes the whole tree; buildSidebar() renders
   it into #dept-nav. Rearranging a screen is an edit to NAV below,
   nothing else - the leaf markup it produces is exactly what the
   count/badge code in app.js already looks for
   (.nav-item[data-view], .nav-count[data-nav-count], #nav-readiness-count).

   Departments are an accordion: opening one closes the others, and a
   department header only ever expands/collapses - it never navigates.
   The department holding the current screen is opened by
   expandDeptFor(), called from app.js's show().
   ============================================================ */

import { el } from "./dom.js";

/* leaf:  { label, view, countKey?, countId?, hot?, disabled? }
   group: { label, items: leaf[] }        (a sub-folder inside a dept)
   dept:  { dept, items?: leaf[], groups?: group[] }
   flat:  { flat: true, items: leaf[] }   (always-visible, no toggle) */
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
            { label: "Management Review", view: "review" },
            { label: "Risk Register", view: "risk" },
            { label: "Turtle Diagrams", view: "turtle" }
        ] },
        { label: "Control", items: [
            { label: "Document Control", view: "documents" },
            { label: "Training & Competence", view: "training" }
        ] }
    ] },

    { dept: "Engineering", items: [
        { label: "Engineering Drawings", view: "drawings" },
        { label: "Change Control (ECN)", view: "change", countKey: "ecn" },
        { label: "APQP Programs", view: "apqp", countKey: "apqp" },
        { label: "FMEA", disabled: true }
    ] },

    { dept: "Administration", items: [
        { label: "People & Access", view: "people" },
        { label: "Form Builder", view: "forms" },
        { label: "Roles & Permissions", view: "workflows" }
    ] }
];

let mount = null;

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

function chevron() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "nav-chevron");
    svg.setAttribute("viewBox", "0 0 12 12");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M4 2 L8 6 L4 10");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
    return svg;
}

function deptBlock(section) {
    const body = el("div", { class: "nav-dept-body" });

    if (section.groups) {
        for (const group of section.groups) {
            body.append(el("div", { class: "nav-subgroup" }, [
                el("div", { class: "nav-subgroup-label", text: group.label }),
                ...group.items.map(leafButton)
            ]));
        }
    } else {
        for (const leaf of section.items) body.append(leafButton(leaf));
    }

    const toggle = el("button", {
        class: "nav-dept-toggle", type: "button", "aria-expanded": "false"
    }, [el("span", { text: section.dept }), chevron()]);

    const wrapper = el("div", { class: "nav-dept", "data-dept": section.dept }, [toggle, body]);

    toggle.addEventListener("click", () => {
        const willOpen = !wrapper.classList.contains("open");
        for (const other of mount.querySelectorAll(".nav-dept")) {
            other.classList.toggle("open", other === wrapper && willOpen);
            other.querySelector(".nav-dept-toggle")
                .setAttribute("aria-expanded", other === wrapper && willOpen ? "true" : "false");
        }
    });

    return wrapper;
}

export function buildSidebar(mountEl) {
    if (!mountEl) return;
    mount = mountEl;
    mount.replaceChildren();

    for (const section of NAV) {
        if (section.flat) {
            mount.append(el("div", { class: "nav-flat" }, section.items.map(leafButton)));
        } else {
            mount.append(deptBlock(section));
        }
    }
}

/* Open the department that contains `view`, closing the others. A flat
   item (Dashboard, Audit Readiness) has no department - leave whatever
   is open as it is. */
export function expandDeptFor(view) {
    if (!mount) return;

    const leaf = mount.querySelector('.nav-item[data-view="' + view + '"]');
    const dept = leaf ? leaf.closest(".nav-dept") : null;
    if (!dept) return;

    for (const other of mount.querySelectorAll(".nav-dept")) {
        const on = other === dept;
        other.classList.toggle("open", on);
        other.querySelector(".nav-dept-toggle").setAttribute("aria-expanded", on ? "true" : "false");
    }
}
