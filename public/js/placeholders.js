/* ============================================================
   Marks screens that are still mock-ups.

   Every module now reads from the database, so this list is empty.
   The mechanism stays: the next screen built ahead of its data goes
   in here rather than quietly showing invented numbers, which is the
   failure this file exists to prevent.
   ============================================================ */

import { el } from "./dom.js";

/* view key -> what the module still needs before it holds real data */
const PLACEHOLDERS = {};

export function badgePlaceholders() {
    for (const [view, info] of Object.entries(PLACEHOLDERS)) {
        const section = document.getElementById("view-" + view);
        if (!section || section.querySelector(".placeholder-note")) continue;

        const banner = el("div", { class: "placeholder-note" }, [
            el("div", { class: "placeholder-head" }, [
                el("span", { class: "placeholder-tag", text: "Mock-up" }),
                el("span", {
                    class: "placeholder-lead",
                    text: "Nothing on this screen comes from the database. The figures are invented and never change."
                })
            ]),
            el("p", { class: "placeholder-needs" }, [
                el("strong", { text: "To make it real: " }),
                info.needs
            ])
        ]);

        const head = section.querySelector(".view-head");
        head ? head.after(banner) : section.prepend(banner);

        const navItem = document.querySelector('.nav-item[data-view="' + view + '"]');
        if (navItem && !navItem.querySelector(".nav-mock")) {
            navItem.classList.add("is-mock");
            navItem.append(el("span", {
                class: "nav-mock",
                title: info.name + " is a mock-up",
                text: "mock"
            }));
        }
    }
}

export function placeholderCount() {
    return Object.keys(PLACEHOLDERS).length;
}
