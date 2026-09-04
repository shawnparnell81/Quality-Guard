/* ============================================================
   Organization context.

   Who this plant is and when its next certification audit falls.
   Fetched once and shared, because both the page header and the
   Audit Readiness screen need it and they must never disagree.
   ============================================================ */

import { api } from "./api.js";

let pending = null;

/* Returns the same promise to every caller, so several screens asking
   at once still make a single request. */
export function getOrganization() {
    if (!pending) {
        pending = api.organization().catch((error) => {
            /* Clear the cache so a later call can retry rather than
               being stuck with a rejected promise forever. */
            pending = null;
            throw error;
        });
    }

    return pending;
}

/* "in 47 days", "today", "12 days ago". Reads from the count the
   database calculated, never from a date parsed in the browser, so
   a viewer in another timezone sees the same number. */
export function describeCountdown(days) {
    if (days === null || days === undefined) return "no audit scheduled";
    if (days === 0) return "today";
    if (days < 0) return Math.abs(days) + " days ago";
    return "in " + days + " days";
}
