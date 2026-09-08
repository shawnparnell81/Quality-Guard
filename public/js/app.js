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
import { renderDashboard, renderReadiness, wireReadiness, wireDashboard } from "./views/dashboard.js";
import { renderRegister, wireRegisterClicks } from "./views/events.js";
import { renderRoles, renderPeople, wireMatrixEditing, wirePeopleActions } from "./views/access.js";
import { renderProduction, wireProduction } from "./views/production.js";
import { renderEightD, renderChange, wireChangeScreens } from "./views/change.js";
import { renderReceiving, renderShipping, wireOperations } from "./views/operations.js";
import {
    renderDrawings, renderOnboarding, renderOnboardingPacket,
    renderReview, renderScorecards, wireEvaluate
} from "./views/evaluate.js";
import { renderForms, wireForms } from "./views/formbuilder.js";
import { wireRecordEditor } from "./forms.js";
import { renderFloorReport } from "./views/floorreport.js";
import { renderTurtle, wireTurtle } from "./views/turtle.js";
import { wireReviewCharts } from "./views/review-charts.js";
import { wirePpap } from "./views/ppap.js";
import { renderLpa, wireLpa } from "./views/lpa.js";
import { renderWorkflowHelp } from "./views/workflow-help.js";
import { renderEngDocuments } from "./views/eng-documents.js";
import { renderFormRecord, wireFormRecord } from "./views/form-record.js";
import { renderFormImport, wireFormImport } from "./views/form-import.js";
import { renderFormLibrary } from "./views/form-library.js";
import { renderPoLog, renderWoLog, renderPrLog, wireLogs } from "./views/logs.js";
import { renderMenuLayout } from "./views/menu-layout.js";
import { badgePlaceholders } from "./placeholders.js";
import {
    renderCalibration, renderTraining, renderDocuments,
    renderVendors, renderWarehouse,
    wireDocuments, wireVendors, wireCalibration, wireTraining
} from "./views/resources.js";
import { wirePalette } from "./palette.js";
import { buildNav, markActiveDept, applyNavLayout } from "./nav.js";
import { startStream } from "./stream.js";
import { wireNotifications } from "./notifications.js";
import { maybeShowOnboarding } from "./onboarding.js";

/* The department menu bar is data-driven (nav.js). Render it before
   anything queries .nav-item. */
buildNav(document.getElementById("dept-nav"));

/* view name -> the function that populates it */
const LOADERS = {
    dashboard:   renderDashboard,
    readiness:   renderReadiness,
    ncr:         () => renderRegister("ncr"),
    capa:        () => renderRegister("capa"),
    complaints:  () => renderRegister("complaint"),
    "floor-report": renderFloorReport,
    audit:       () => renderRegister("audit"),
    scar:        () => renderRegister("scar"),
    fair:        () => renderRegister("fair"),
    ppap:        () => renderRegister("ppap"),
    risk:        () => renderRegister("risk"),
    apqp:        () => renderRegister("apqp"),
    di:          () => renderRegister("di"),
    "audit-workflow": renderWorkflowHelp,
    lpa:         renderLpa,
    calibration: renderCalibration,
    training:    renderTraining,
    documents:   renderDocuments,
    avl:         renderVendors,
    warehouse:   renderWarehouse,
    workflows:   renderRoles,
    "menu-layout": renderMenuLayout,
    people:      renderPeople,
    production:  renderProduction,
    d8:          renderEightD,
    change:      renderChange,
    drawings:    renderDrawings,
    "eng-documents": renderEngDocuments,
    receiving:   renderReceiving,
    "po-log":    renderPoLog,
    "wo-log":    renderWoLog,
    "pr-log":    renderPrLog,
    shipping:    renderShipping,
    onboarding:  renderOnboarding,
    "onboarding-packet": renderOnboardingPacket,
    review:      renderReview,
    turtle:      renderTurtle,
    scorecards:  renderScorecards,
    forms:       renderForms,
    "form-library": renderFormLibrary,
    "form-record": renderFormRecord,
    "form-import": renderFormImport
};

const views = document.querySelectorAll(".view");
const deptbar = document.querySelector(".deptbar");

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

    /* Re-queried every call: the menu bar is rendered by nav.js, so a
       NodeList captured once could go stale. */
    document.querySelectorAll(".nav-item").forEach((button) => {
        button.setAttribute(
            "aria-current",
            button.dataset.view === name ? "true" : "false"
        );
    });

    /* The Forms sub-tab strip (shared across the four form screens). */
    document.querySelectorAll(".forms-subnav a[data-goto]").forEach((a) => {
        a.setAttribute("aria-current", a.dataset.goto === name ? "true" : "false");
    });

    /* Underline the department button this screen belongs to. */
    markActiveDept(name);

    /* Send focus to the new heading so keyboard and screen reader
       users land in the content rather than staying on the menu bar. */
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

/* One delegated listener for the leaf buttons. Adding a module is a
   markup change plus one line in LOADERS, never a change here. The
   department-button dropdown toggles are wired inside nav.js. */
deptbar.addEventListener("click", (event) => {
    const button = event.target.closest(".nav-item");
    if (!button || !button.dataset.view) return;

    show(button.dataset.view);
    /* On mobile the whole bar is a drawer - close it. On desktop the
       dropdown deliberately stays open. */
    closeMobileNav();
});

/* Anything on a screen can ask to navigate by firing this event, so a
   view never has to import the router. The clause table uses it to
   jump to the module holding a clause's evidence. */
document.addEventListener("navigate", (event) => {
    show(event.detail.view);
    closeMobileNav();
});

/* An in-page link carrying data-goto="<view>" jumps there, so prose
   can point at another screen without importing the router. */
document.addEventListener("click", (event) => {
    const link = event.target.closest("[data-goto]");
    if (!link) return;
    event.preventDefault();
    show(link.dataset.goto);
    closeMobileNav();
});

/* ---------- mobile nav ----------
   Below the breakpoint (style.css) the whole department bar is an
   off-canvas drawer rather than part of the page flow, so it needs an
   explicit open/close. Above the breakpoint none of this does
   anything: the toggle button is display:none and the bar is never
   given the "open" class. */
const navToggle = document.getElementById("nav-toggle");
const sidebarBackdrop = document.getElementById("sidebar-backdrop");

function openMobileNav() {
    deptbar.classList.add("open");
    navToggle?.setAttribute("aria-expanded", "true");
}

function closeMobileNav() {
    deptbar.classList.remove("open");
    navToggle?.setAttribute("aria-expanded", "false");
}

navToggle?.addEventListener("click", () => {
    deptbar.classList.contains("open") ? closeMobileNav() : openMobileNav();
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
            scar: summary.events.scar?.open,
            ecn: summary.events.ecn?.open,
            audit: summary.events.audit?.overdue,
            apqp: summary.events.apqp?.open,
            di: summary.events.di?.open,
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

    /* Re-render the menu bar under the org's saved layout, if any,
       before counts and the active-department underline are wired to
       its buttons. The default bar is already on screen from the
       module-level buildNav call, so this is invisible when there is
       no custom layout. */
    try {
        const response = await fetch("/api/layout/nav", { credentials: "same-origin" });
        const nav = response.ok ? await response.json() : null;
        if (nav && nav.layout) {
            applyNavLayout(nav.layout);
            applyPermissions();   // re-gate the freshly rebuilt menu buttons
        }
    } catch { /* keep the default menu */ }

    badgePlaceholders();

    wireRegisterClicks();
    wireReadiness();
    wireDashboard();
    wireMatrixEditing();
    wirePeopleActions();
    wireRecordEditor();
    wireProduction();
    wireChangeScreens();
    wireOperations();
    wireLogs();
    wireEvaluate();
    wireReviewCharts();
    wirePpap();
    wireLpa();
    wireForms();
    wireFormRecord();
    wireFormImport();
    wireTurtle();
    wireDocuments();
    wireVendors();
    wireCalibration();
    wireTraining();
    wirePalette();
    startStream();
    wireNotifications();
    checkConnection();
    fillHeader();
    showReadinessBadge();
    updateNavCounts();
    show("dashboard");

    /* First-run wizard, for an admin whose org has not been set up.
       After the dashboard so it opens over a populated page. */
    maybeShowOnboarding();
}

start();
