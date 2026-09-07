/* ============================================================
   QMS GUARDIAN front end

   Three jobs:
     1. Switch between the views already present in index.html.
     2. Ask the matching view module to fetch its own data.
     3. Light and dark toggle.

   Views that have no server endpoint yet are simply absent from the
   LOADERS table below, so they show their static markup and nothing
   tries to fetch for them.
   ============================================================ */

import { getOrganization, describeCountdown } from "./org.js";
import {
    loadSession, applyPermissions, paintCurrentUser, wireSignOut
} from "./session.js";
import { renderDashboard, renderReadiness, wireReadiness } from "./views/dashboard.js";
import { renderRegister, wireRegisterClicks } from "./views/events.js";
import { renderRoles, renderPeople, wireMatrixEditing, wirePeopleActions } from "./views/access.js";
import { renderProduction, wireProduction } from "./views/production.js";
import { renderEightD, renderChange, wireChangeScreens } from "./views/change.js";
import { renderReceiving, renderShipping, wireOperations } from "./views/operations.js";
import {
    renderDrawings, renderOnboarding, renderReview, renderScorecards, wireEvaluate
} from "./views/evaluate.js";
import { renderForms, wireForms } from "./views/formbuilder.js";
import { wireRecordEditor } from "./forms.js";
import { renderFloorReport } from "./views/floorreport.js";
import { badgePlaceholders } from "./placeholders.js";
import {
    renderCalibration, renderTraining, renderDocuments,
    renderVendors, renderWarehouse, wireDocuments, wireVendors, wireCalibration
} from "./views/resources.js";
import { wirePalette } from "./palette.js";
import { buildSidebar, expandDeptFor } from "./nav.js";

/* The sidebar is data-driven now (nav.js). Render it before anything
   queries .nav-item. */
buildSidebar(document.getElementById("dept-nav"));

/* view name -> the function that populates it */
const LOADERS = {
    dashboard:   renderDashboard,
    readiness:   renderReadiness,
    ncr:         () => renderRegister("ncr"),
    capa:        () => renderRegister("capa"),
    complaints:  () => renderRegister("complaint"),
    "floor-report": renderFloorReport,
    audit:       () => renderRegister("audit"),
    risk:        () => renderRegister("risk"),
    apqp:        () => renderRegister("apqp"),
    calibration: renderCalibration,
    training:    renderTraining,
    documents:   renderDocuments,
    avl:         renderVendors,
    warehouse:   renderWarehouse,
    workflows:   renderRoles,
    people:      renderPeople,
    production:  renderProduction,
    d8:          renderEightD,
    change:      renderChange,
    drawings:    renderDrawings,
    receiving:   renderReceiving,
    shipping:    renderShipping,
    onboarding:  renderOnboarding,
    review:      renderReview,
    scorecards:  renderScorecards,
    forms:       renderForms
};

const views = document.querySelectorAll(".view");
const sidebar = document.querySelector(".sidebar");

/* Exported so the command palette can await a view switch finishing
   before it deep-selects a specific record - the "navigate" custom
   event every other caller uses is fire-and-forget, which would race
   against the view's own default "select the first record" load.
   Safe despite the import cycle this creates with palette.js: show is
   a hoisted function declaration, so the live binding exists before
   either module's top-level code has finished running. */
export async function show(name) {
    const target = document.getElementById("view-" + name);
    if (!target) return;

    views.forEach((view) => {
        view.hidden = (view !== target);
    });

    /* Re-queried every call: the sidebar is rendered by nav.js, so a
       NodeList captured once could go stale. */
    document.querySelectorAll(".nav-item").forEach((button) => {
        button.setAttribute(
            "aria-current",
            button.dataset.view === name ? "true" : "false"
        );
    });

    /* Open the department this screen lives in (accordion in nav.js). */
    expandDeptFor(name);

    /* Send focus to the new heading so keyboard and screen reader
       users land in the content rather than staying on the sidebar. */
    const heading = target.querySelector(".view-title");
    if (heading) {
        heading.setAttribute("tabindex", "-1");
        heading.focus();
    }

    window.scrollTo(0, 0);

    /* Refetch on every visit. These are live quality figures, and a
       cached "2 overdue CAPAs" that is actually 3 is worse than a
       few milliseconds of latency on localhost. */
    const load = LOADERS[name];
    if (load) {
        try {
            await load();
        } catch (error) {
            console.error("Failed to load view " + name + ":", error);
        }
    }
}

/* One delegated listener. Adding a module is a markup change plus one
   line in LOADERS, never a change here. */
sidebar.addEventListener("click", (event) => {
    const button = event.target.closest(".nav-item");
    if (!button) return;

    show(button.dataset.view);
    closeMobileNav();
});

/* Anything on a screen can ask to navigate by firing this event, so a
   view never has to import the router. The clause table uses it to
   jump to the module holding a clause's evidence. */
document.addEventListener("navigate", (event) => {
    show(event.detail.view);
    closeMobileNav();
});

/* ---------- mobile nav ----------
   Below the breakpoint (style.css) the sidebar is an off-canvas
   overlay rather than part of the page flow, so it needs an explicit
   open/close rather than just being there. Above the breakpoint none
   of this does anything: the toggle button is display:none and the
   sidebar is never given the "open" class. */
const navToggle = document.getElementById("nav-toggle");
const sidebarBackdrop = document.getElementById("sidebar-backdrop");

function openMobileNav() {
    sidebar.classList.add("open");
    navToggle?.setAttribute("aria-expanded", "true");
}

function closeMobileNav() {
    sidebar.classList.remove("open");
    navToggle?.setAttribute("aria-expanded", "false");
}

navToggle?.addEventListener("click", () => {
    sidebar.classList.contains("open") ? closeMobileNav() : openMobileNav();
});

sidebarBackdrop?.addEventListener("click", closeMobileNav);

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMobileNav();
});

/* ---------- connection banner ----------
   A prototype that silently shows empty tables when the server is
   down wastes ten minutes of someone's afternoon. Say it plainly. */

/* ---------- page header ----------
   Plant name and audit countdown come from the certifications table,
   so nothing here is a date typed into the markup. */
async function fillHeader() {
    const crumb = document.getElementById("org-crumb");
    const countdown = document.getElementById("audit-countdown");

    try {
        const org = await getOrganization();

        crumb.replaceChildren(
            document.createTextNode(org.organization.toUpperCase() + " / "),
            Object.assign(document.createElement("b"), {
                textContent: (org.site_name || "").toUpperCase()
            })
        );

        if (org.next_audit) {
            const days = org.next_audit.days_to_audit;
            countdown.textContent =
                org.next_audit.standard + " " + org.next_audit.audit_type.replace(/_/g, " ")
                + " " + describeCountdown(days);

            /* An audit inside a month is worth colouring. */
            countdown.style.color = days <= 30 ? "var(--warn)" : "";
        } else {
            countdown.textContent = "No audit scheduled";
        }
    } catch {
        crumb.textContent = "";
        countdown.textContent = "";
    }
}

/* The sidebar badge is the whole point of the rename: the number of
   things an auditor would write up is visible without opening the
   screen. Zero hides the badge rather than showing a reassuring "0". */
async function showReadinessBadge() {
    const badge = document.getElementById("nav-readiness-count");
    if (!badge) return;

    try {
        const { summary } = await (await fetch("/api/dashboard/readiness")).json();
        badge.textContent = summary.clauses_flagged;
        badge.hidden = summary.clauses_flagged === 0;
    } catch {
        badge.hidden = true;
    }
}

/* Every other sidebar badge, the same way: real counts or no badge at
   all, never a number frozen in the markup regardless of what is
   actually open. One fetch already returns everything these need. */
async function updateNavCounts() {
    const badges = document.querySelectorAll("[data-nav-count]");
    if (badges.length === 0) return;

    try {
        const summary = await (await fetch("/api/dashboard")).json();

        const counts = {
            ncr: summary.events.ncr?.open,
            capa: summary.events.capa?.open,
            eightd: summary.events.eightd?.open,
            complaint: summary.events.complaint?.open,
            ecn: summary.events.ecn?.open,
            audit: summary.events.audit?.overdue,
            apqp: summary.events.apqp?.open,
            calibration_due: summary.calibration?.due_soon
        };

        badges.forEach((badge) => {
            const n = Number(counts[badge.dataset.navCount]) || 0;
            badge.textContent = n;
            badge.hidden = n === 0;
        });
    } catch {
        badges.forEach((badge) => { badge.hidden = true; });
    }
}

async function checkConnection() {
    const banner = document.getElementById("connection-banner");
    if (!banner) return;

    try {
        const health = await (await fetch("/api/health")).json();
        banner.hidden = health.status === "ok";
    } catch {
        banner.hidden = false;
    }
}

/* ---------- theme ---------- */

const STORAGE_KEY = "qualityguard-theme";
const toggle = document.getElementById("themeToggle");
const root = document.documentElement;

function storedTheme() {
    try {
        return localStorage.getItem(STORAGE_KEY);
    } catch {
        /* Private windows and blocked site data both throw here. */
        return null;
    }
}

function storeTheme(value) {
    try {
        localStorage.setItem(STORAGE_KEY, value);
    } catch {
        /* Nothing to do. The toggle still works for this session. */
    }
}

function currentTheme() {
    const stamped = root.getAttribute("data-theme");
    if (stamped) return stamped;

    /* Unstamped means the page is following the operating system. */
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme) {
    root.setAttribute("data-theme", theme);
    toggle.textContent = theme === "dark" ? "Light" : "Dark";
}

const saved = storedTheme();

if (saved === "dark" || saved === "light") {
    applyTheme(saved);
} else {
    toggle.textContent = currentTheme() === "dark" ? "Light" : "Dark";
}

toggle.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    applyTheme(next);
    storeTheme(next);
});

/* ---------- start ---------- */

/* Session first, and nothing paints before it.

   If there is no valid session the api layer has already sent the
   browser to the sign-in page, so there is no point rendering a
   dashboard that is about to be replaced. */
async function start() {
    try {
        const me = await loadSession();

        /* /api/me answers during a forced change, so catch it here
           rather than waiting for the first blocked call to bounce. */
        if (me.must_change_password) {
            window.location.href = "/change-password.html";
            return;
        }
    } catch (error) {
        /* A 401 or 428 has already redirected. Anything else is a
           genuine failure worth showing. */
        if (error.message !== "Session ended"
            && error.message !== "Password change required") {
            console.error("Could not load session:", error);
        }
        return;
    }

    paintCurrentUser();
    applyPermissions();
    wireSignOut();

    badgePlaceholders();

    wireRegisterClicks();
    wireReadiness();
    wireMatrixEditing();
    wirePeopleActions();
    wireRecordEditor();
    wireProduction();
    wireChangeScreens();
    wireOperations();
    wireEvaluate();
    wireForms();
    wireDocuments();
    wireVendors();
    wireCalibration();
    wirePalette();
    checkConnection();
    fillHeader();
    showReadinessBadge();
    updateNavCounts();
    show("dashboard");
}

start();
