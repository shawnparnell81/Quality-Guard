/* ============================================================
   The canonical definition of every built-in record type.

   One module per type in this folder, each a plain object:

     { key, name, prefix, clause,
       states:      [ [key, name, position, isTerminal], ... ],
       transitions: [ [fromState, toState, requiredPermission], ... ],
       form:        { fields: [...], rules: [...] } }

   `form.fields` is the app's own form shape - the same thing the Form
   Builder edits and problemWith() (routes/masterdata.js) validates.
   `transitions` gate on a permission key; the runtime reads only
   workflow_transitions.required_permission.

   This is the single source of truth for what a newly provisioned
   company gets. scripts/provision-org.js builds every tenant from it,
   and it is what the record-definitions parity test checks the
   database against. Ridgeline's richer demo forms (parts/gages links,
   conditional rules) are a separate seed-time overlay, not defined
   here.
   ============================================================ */

import ncr from "./ncr.js";
import capa from "./capa.js";
import eightd from "./eightd.js";
import complaint from "./complaint.js";
import scar from "./scar.js";
import audit from "./audit.js";
import ecn from "./ecn.js";
import risk from "./risk.js";
import apqp from "./apqp.js";
import di from "./di.js";
import fair from "./fair.js";
import ppap from "./ppap.js";

/* Order matters: this is the order a fresh org's record types are
   created in, and the order screens list them in. */
export const RECORD_DEFINITIONS = [
    ncr, capa, eightd, complaint, scar, audit, ecn, risk, apqp, di, fair, ppap
];

const byKey = new Map(RECORD_DEFINITIONS.map((def) => [def.key, def]));

export function allDefinitions() {
    return RECORD_DEFINITIONS;
}

export function definitionFor(key) {
    return byKey.get(key);
}
