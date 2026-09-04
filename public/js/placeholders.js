/* ============================================================
   Marks the screens that are still mock-ups.

   Ten modules show invented numbers that never change. That was fine
   while this was a pitch deck; now that real records are going in, a
   screen you cannot tell apart from a working one will waste an
   afternoon and, worse, could get quoted at somebody as if it were
   true.

   So each one says what it is, and what it would take to make it
   real. The banner doubles as the build list.
   ============================================================ */

import { el } from "./dom.js";

/* view key -> what the module still needs before it holds real data */
const PLACEHOLDERS = {
    drawings: {
        name: "Engineering Drawings",
        needs: "A drawings table with revision history, and file storage for the drawing itself. "
             + "Parts exist; drawings as controlled documents do not."
    },
    receiving: {
        name: "Receiving Inspection",
        needs: "A receipts table linked to purchase orders and vendors, with the "
             + "sampling plan driven by vendor grade."
    },
    shipping: {
        name: "Shipping",
        needs: "A shipments table and a release checklist. The shipping.release "
             + "permission is already enforced server side and has nothing to guard."
    },
    onboarding: {
        name: "Vendor Onboarding",
        needs: "A stage pipeline per candidate vendor. The vendors table already "
             + "carries an onboarding status; the stages themselves are not stored."
    },
    review: {
        name: "Management Review",
        needs: "Management review records with the twelve clause 9.3.2 inputs. "
             + "Every input is already computed by other endpoints and could be assembled."
    },
    scorecards: {
        name: "Scorecards and KPIs",
        needs: "A quality_objectives table holding target, owner and measurement source. "
             + "Several actuals are already live on the dashboard."
    },
    forms: {
        name: "Form Builder",
        needs: "Editing endpoints for form_versions. The schema is real and already drives "
             + "the NCR form, but this screen cannot change it yet."
    }
};

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

        /* Mark it in the sidebar too, so it is obvious before clicking
           rather than after. */
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
