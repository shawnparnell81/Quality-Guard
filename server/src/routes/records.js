/* ============================================================
   Quality events.

   NCR, CAPA, 8D, complaint, SCAR, audit and risk all route through
   this one file, because they are all rows in the records table.
   The record type is a query parameter, not a separate endpoint.
   ============================================================ */

import { Router } from "express";
import PDFDocument from "pdfkit";
import { query, withTransaction } from "../db.js";
import { requirePermission, createPermissionFor, closePermissionFor } from "../auth.js";
import { INK, INK_2, HAIRLINE, drawLetterhead, drawFooter, humanizeKey } from "../pdf-branding.js";

export const records = Router();

/* due_at could not be set through this API at all before - it only
   ever got a value from seed data, which is why every overdue count
   in the app was silently correct for the demo and silently useless
   for anything actually raised through the UI.

   Undefined, null or "" all mean "no due date" and are left alone
   rather than treated as an error, since not every record needs one.
   Anything else has to parse as a real date. */
function parseDueAt(value) {
    if (value === undefined || value === null || value === "") {
        return { ok: true, value: null };
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return { ok: false, value: null };

    return { ok: true, value: parsed.toISOString() };
}

/* Risk priority numbers are derived, never entered - severity times
   occurrence times detection, computed here so a stored rpn can
   never disagree with the very numbers it comes from. Same idea for
   residual_rpn: the re-evaluation after a mitigation is verified,
   using its own severity/occurrence/detection, not the original
   risk's - a control that lowers occurrence does nothing for
   severity, and the two numbers should say so separately. Only
   touches risk records; every other type's top-level data passes
   through untouched. */
function withComputedTopLevelRpn(typeKey, data) {
    if (typeKey !== "risk" || !data || typeof data !== "object") return data;

    const computed = { ...data };
    const score = (value) => {
        const n = Number(value);
        return Number.isFinite(n) && n >= 1 && n <= 10 ? n : null;
    };

    const [s, o, d] = [score(data.severity), score(data.occurrence), score(data.detection)];
    if (s !== null && o !== null && d !== null) computed.rpn = s * o * d;

    const [rs, ro, rd] = [score(data.residual_severity), score(data.residual_occurrence), score(data.residual_detection)];
    if (rs !== null && ro !== null && rd !== null) computed.residual_rpn = rs * ro * rd;

    return computed;
}

/* The same rpn = severity x occurrence x detection rule, applied
   inside every row of every "table"-type field instead of at the
   top level - a DFMEA or PFMEA line's RPN, computed from that same
   line's own three scores, never the hand-typed number the row's
   own inputs happen to show. Detects a scoreable row structurally
   (does it carry all three columns), not by which record type this
   is, so any current or future table field with these three column
   names benefits, not only apqp's. */
/* Generalized for the closed-loop fmea table, which scores twice per
   row: severity/occurrence/detection -> rpn before an action, and
   result_severity/result_occurrence/result_detection -> result_rpn
   after one. Detected by column-name prefix (everything before
   "severity"/"occurrence"/"detection"), not hard-coded to those two
   specific triplets, so a future table with its own differently-
   prefixed S/O/D columns is picked up the same way with no change
   here. */
function withComputedTableRowRpn(data) {
    if (!data || typeof data !== "object") return data;

    const score = (value) => {
        const n = Number(value);
        return Number.isFinite(n) && n >= 1 && n <= 10 ? n : null;
    };

    const computed = { ...data };

    for (const [key, value] of Object.entries(data)) {
        if (!Array.isArray(value)) continue;

        computed[key] = value.map((row) => {
            if (!row || typeof row !== "object") return row;

            let nextRow = row;

            for (const column of Object.keys(row)) {
                if (!column.endsWith("severity")) continue;

                const prefix = column.slice(0, column.length - "severity".length);
                const [s, o, d] = [
                    score(row[prefix + "severity"]),
                    score(row[prefix + "occurrence"]),
                    score(row[prefix + "detection"])
                ];
                if (s === null || o === null || d === null) continue;

                if (nextRow === row) nextRow = { ...row };
                nextRow[prefix + "rpn"] = s * o * d;
            }

            return nextRow;
        });
    }

    return computed;
}

function withComputedRpn(typeKey, data) {
    return withComputedTableRowRpn(withComputedTopLevelRpn(typeKey, data));
}

/* audit_log.old_value/new_value are text columns - every scalar field
   this app has ever had was fine going through a bare String(), but
   a "table" field's value is an array of row objects, and
   String([{...}]) is "[object Object]" for any single-row table
   regardless of what the row actually contains. JSON.stringify keeps
   the row's real content both readable and, just as importantly,
   distinct - two different tables no longer compare equal just
   because they share a shape. */
function auditText(value) {
    if (value === null || value === undefined) return null;
    return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/* Clause 9.2: an auditor must be independent of the area under
   review. "Area" is not an invented category here - it is the same
   discipline column every person record already carries, compared
   against the department an audit now has to declare. runQuery is
   either the module-level query() or a transaction client's query
   bound to it, so this works both before a transaction opens (create)
   and inside one (update, transition). */
async function auditorConflict(runQuery, orgId, data) {
    if (!data || !data.auditor || !data.department) return false;

    const found = await runQuery(
        "select discipline from users where org_id = $1 and initials = $2",
        [orgId, data.auditor]
    );
    if (found.rowCount === 0) return false;

    const discipline = found.rows[0].discipline;
    return Boolean(discipline)
        && discipline.trim().toLowerCase() === String(data.department).trim().toLowerCase();
}

/* Clause 10.2: a CAPA may not close without evidence the corrective
   action was actually validated. */
async function hasAttachment(runQuery, recordId) {
    const found = await runQuery(
        "select 1 from attachments where record_id = $1 limit 1",
        [recordId]
    );
    return found.rowCount > 0;
}

/* Every record_links row (child_of) pointing at this program whose
   target is of the given type - optionally narrowed by a field on
   that record's own data (e.g. discipline = "Design" picks out the
   DFMEA among an APQP program's fmea children, discipline =
   "Process" the PFMEA). Used by the phase gates below instead of a
   flat status field: a linked fmea's own status (governed by its own
   workflow and its own fmea.approve permission) is something nobody
   can just type "Approved" into, unlike a select field on the
   program itself ever was. */
async function linkedRecordsOfType(runQuery, programId, typeKey, dataFilter) {
    const result = await runQuery(`
        select r.status, r.data
          from record_links l
          join records r      on r.id = l.to_record_id
          join record_types rt on rt.id = r.record_type_id
         where l.from_record_id = $1 and l.link_type = 'child_of' and rt.key = $2
    `, [programId, typeKey]);

    if (!dataFilter) return result.rows;
    return result.rows.filter((row) =>
        Object.entries(dataFilter).every(([key, value]) => row.data?.[key] === value));
}

/* IATF 16949 8.3.4: design and development planning must include
   reviews at planned stages, against defined exit criteria, before
   the next stage begins. An APQP program's five states are its five
   phases, so that requirement means a program cannot leave a phase
   until that phase's own deliverables are actually done - not
   "required to create the record" (records.js's one required-field
   check runs once, at creation, against a type's whole form; a
   program months from launch cannot be required to have already
   typed its launch metrics just to be opened at all), but required
   to advance past the phase that deliverable belongs to.

   Keyed by the phase being left, not the one being entered - nothing
   gates draft -> plan_define, since Phase 1's own work has not
   started yet. DFMEA/PFMEA/control plan/PPAP are no longer flat
   status fields on the program - each is checked by looking for a
   real linked record of that type whose own workflow has actually
   reached "approved" (or, for PPAP, "approved"/"interim_approval"),
   the same real gate every other controlled document in this app
   enforces through its own *.approve permission, not a dropdown
   anyone with apqp.manage could set by hand. */
async function apqpPhaseGaps(runQuery, fromState, data, recordId) {
    const gaps = [];

    if (fromState === "plan_define") {
        if (!data?.voc_customer_requirements) gaps.push("Voice of customer");
        if (!["Feasible", "Feasible with conditions"].includes(data?.feasibility_status)) {
            gaps.push("Feasibility review");
        }
        if (!data?.charter_approved_by) gaps.push("Program charter sign-off");

        const risks = await linkedRecordsOfType(runQuery, recordId, "risk");
        if (risks.length === 0) gaps.push("Risk assessment (link at least one risk record)");
    }

    if (fromState === "product_design") {
        const dfmeas = await linkedRecordsOfType(runQuery, recordId, "fmea", { discipline: "Design" });
        if (!dfmeas.some((r) => r.status === "approved")) gaps.push("DFMEA approved");
    }

    if (fromState === "process_design") {
        const pfmeas = await linkedRecordsOfType(runQuery, recordId, "fmea", { discipline: "Process" });
        if (!pfmeas.some((r) => r.status === "approved")) gaps.push("PFMEA approved");

        const controlPlans = await linkedRecordsOfType(runQuery, recordId, "control_plan");
        if (!controlPlans.some((r) => r.status === "approved")) gaps.push("Control plan approved");
    }

    if (fromState === "validation") {
        const ppaps = await linkedRecordsOfType(runQuery, recordId, "ppap");
        if (!ppaps.some((r) => ["approved", "interim_approval"].includes(r.status))) {
            gaps.push("PPAP approved");
        }
        if (data?.run_at_rate_status !== "Passed") gaps.push("Run-at-rate");
    }

    if (fromState === "production") {
        if (!data?.lessons_learned) gaps.push("Lessons learned");
        if (!data?.launch_metrics_summary) gaps.push("Launch metrics");

        const capas = await linkedRecordsOfType(runQuery, recordId, "capa");
        if (capas.some((r) => r.status !== "closed")) gaps.push("All linked corrective actions closed");
    }

    return gaps;
}

/* Which authority an edit needs depends on what is being changed.
   Selecting "Rework" and selecting "Use-as-is" travel through the same
   endpoint but are not the same decision: use-as-is ships a known
   nonconforming part to a customer, and clause 8.7 expects that to be
   a named authority. */
function editPermissionFor(request) {
    const disposition = request.body?.data?.disposition;

    if (disposition === "Use-as-is") return "ncr.use_as_is";
    if (disposition) return "ncr.disposition";

    /* Ordinary field corrections need no special authority. Every one
       of them still lands in audit_log. */
    return null;
}

const SELECT_RECORD = `
    select r.id,
           r.record_type_id,
           r.number,
           r.title,
           r.status,
           r.severity,
           r.data,
           r.form_version,
           r.opened_at,
           r.due_at,
           r.closed_at,
           rt.key   as type,
           rt.name  as type_name,
           rt.clause,
           u.full_name as owner,
           u.initials  as owner_initials
      from records r
      join record_types rt on rt.id = r.record_type_id
 left join users u        on u.id = r.owner_id
     where r.org_id = $1
`;

/* ---------- list ----------
   GET /api/records?type=ncr&status=containment&open=true&limit=50 */
records.get("/", async (request, response, next) => {
    try {
        const conditions = [];
        const params = [request.user.org_id];

        if (request.query.type) {
            params.push(request.query.type);
            conditions.push("rt.key = $" + params.length);
        }

        if (request.query.status) {
            params.push(request.query.status);
            conditions.push("r.status = $" + params.length);
        }

        if (request.query.severity) {
            params.push(request.query.severity);
            conditions.push("r.severity = $" + params.length);
        }

        if (request.query.open === "true") {
            conditions.push("r.closed_at is null");
        }

        const limit = Math.min(Number(request.query.limit) || 100, 500);
        params.push(limit);

        const sql = SELECT_RECORD
            + (conditions.length ? " and " + conditions.join(" and ") : "")
            + " order by r.opened_at desc limit $" + params.length;

        const result = await query(sql, params);
        response.json({ count: result.rowCount, records: result.rows });
    } catch (error) {
        next(error);
    }
});

/* ---------- search, for the command palette ----------
   GET /api/records/search?q=bore

   Registered before /:number on purpose - Express matches routes in
   the order they are declared, and "search" would otherwise be read
   as a record number and 404 against /:number instead of ever
   reaching here.

   Matches against the number and the title only, not the JSONB data
   payload - a query into arbitrary keys per record type is a
   reasonable future step, but number/title already covers "type an
   NCR number, jump to it" and "type a word from the title." */
records.get("/search", async (request, response, next) => {
    try {
        const q = (request.query.q || "").trim();
        if (q.length < 2) return response.json({ records: [] });

        const result = await query(
            SELECT_RECORD + `
               and (r.number ilike $2 or r.title ilike $2)
             order by r.opened_at desc
             limit 8
            `,
            [request.user.org_id, "%" + q + "%"]
        );

        response.json({ records: result.rows });
    } catch (error) {
        next(error);
    }
});

/* ---------- one record, with its graph and history ----------
   GET /api/records/NCR-2026-0142 */
records.get("/:number", async (request, response, next) => {
    try {
        const found = await query(
            SELECT_RECORD + " and r.number = $2",
            [request.user.org_id, request.params.number]
        );

        if (found.rowCount === 0) {
            return response.status(404).json({ error: "Record not found" });
        }

        const record = found.rows[0];

        /* Links run in both directions. A complaint points at its 8D,
           and from the 8D you still want to see the complaint. */
        const links = await query(`
            select l.link_type,
                   'outgoing' as direction,
                   r.number, r.title, r.status, r.severity, rt.key as type
              from record_links l
              join records r      on r.id = l.to_record_id
              join record_types rt on rt.id = r.record_type_id
             where l.from_record_id = $1
             union all
            select l.link_type,
                   'incoming' as direction,
                   r.number, r.title, r.status, r.severity, rt.key as type
              from record_links l
              join records r      on r.id = l.from_record_id
              join record_types rt on rt.id = r.record_type_id
             where l.to_record_id = $1
        `, [record.id]);

        const history = await query(`
            select a.field, a.old_value, a.new_value, a.reason,
                   a.changed_at, u.full_name as changed_by
              from audit_log a
         left join users u on u.id = a.changed_by
             where a.record_id = $1
             order by a.changed_at desc
             limit 50
        `, [record.id]);

        /* Which moves are legal from here, and whether this particular
           person may make them. The UI needs both: an action nobody can
           take should not appear, and one this person cannot take
           should say who can.

           Matched on record_type_id, not rt.key: a type key like
           "eightd" is only unique per organization, not across all of
           them, so filtering on the key alone would return every
           tenant's transitions that happen to share a from_state. */
        const moves = await query(`
            select wt.to_state, wt.required_permission,
                   ws.name as to_name, ws.is_terminal,
                   p.description as permission_description
              from workflow_transitions wt
         left join workflow_states ws
                on ws.record_type_id = wt.record_type_id and ws.key = wt.to_state
         left join permissions p on p.key = wt.required_permission
             where wt.record_type_id = $1 and wt.from_state = $2
             order by ws.position
        `, [record.record_type_id, record.status]);

        const closeKey = closePermissionFor(record.type);

        /* Same two closure gates the transition endpoint itself
           enforces (clause 9.2 and 10.2), checked once here so a
           blocked close button says why before anyone clicks it,
           rather than only after a 409 comes back. */
        const capaMissingAttachment = record.type === "capa" && !await hasAttachment(query, record.id);
        const auditHasConflict = record.type === "audit"
            && await auditorConflict(query, request.user.org_id, record.data);

        /* Every APQP move is a stage gate on the phase being left, not
           only the final close - computed once here so a blocked
           "next phase" button says exactly which deliverables are
           still open before anyone clicks it. */
        const apqpMissing = record.type === "apqp"
            ? await apqpPhaseGaps(query, record.status, record.data, record.id)
            : [];

        const transitions = moves.rows.map((move) => {
            const stepOk = !move.required_permission || request.can(move.required_permission);
            const closeOk = !move.is_terminal || !closeKey || request.can(closeKey);
            const gateBlocked = move.is_terminal
                ? (capaMissingAttachment
                    ? "Needs at least one attachment before closing"
                    : (auditHasConflict
                        ? "The assigned auditor works within the department under review"
                        : null))
                : null;
            const apqpBlocked = apqpMissing.length > 0
                ? "This phase is not complete - missing: " + apqpMissing.join(", ")
                : null;

            return {
                to: move.to_state,
                label: move.to_name || move.to_state,
                is_terminal: move.is_terminal,
                allowed: stepOk && closeOk && !gateBlocked && !apqpBlocked,
                blocked_because: !stepOk
                    ? "Needs permission to " + (move.permission_description || move.required_permission).toLowerCase()
                    : (!closeOk ? "Closing this needs " + closeKey : (gateBlocked || apqpBlocked))
            };
        });

        response.json({
            record,
            links: links.rows,
            history: history.rows,
            transitions
        });
    } catch (error) {
        next(error);
    }
});

/* ---------- PDF export ----------
   GET /api/records/NCR-2026-0142/pdf

   A real, downloadable, branded file - not a browser print-to-PDF.
   Built with pdfkit: pure JS, no native binary, no headless browser,
   so this needed nothing heavier than what the project already
   depends on. Generic across every record type, the same way the
   detail panel is: it lists whatever is actually in data rather than
   knowing NCR has a disposition and CAPA has a root cause. */

function drawRecordHeader(doc, record) {
    doc.fontSize(19).fillColor(INK).font("Helvetica-Bold").text(record.number);
    doc.fontSize(12.5).fillColor(INK_2).font("Helvetica").text(record.title);
    doc.moveDown(0.4);

    doc.fontSize(9).fillColor(INK_2).font("Helvetica").text(
        "Type: " + (record.type_name || record.type)
        + "    Status: " + humanizeKey(record.status)
        + "    Severity: " + String(record.severity).toUpperCase()
    );

    const facts = [];
    if (record.owner) facts.push("Owner: " + record.owner);
    if (record.opened_at) facts.push("Opened: " + new Date(record.opened_at).toLocaleDateString());
    if (record.due_at) facts.push("Due: " + new Date(record.due_at).toLocaleDateString());
    if (record.closed_at) facts.push("Closed: " + new Date(record.closed_at).toLocaleDateString());
    if (facts.length > 0) doc.text(facts.join("    "));

    doc.moveDown(1);
}

/* Fallback for a record type with no form schema to draw from (should
   not happen for anything raised through this app, but a PDF export
   is the wrong place to 500 over it) - the flat, generic dump this
   function used to be the only version of. */
function drawGenericFields(doc, data) {
    const entries = Object.entries(data || {})
        .filter(([, value]) => value !== null && value !== undefined && value !== "");

    if (entries.length === 0) return;

    doc.fontSize(11).fillColor(INK).font("Helvetica-Bold").text("Details");
    doc.moveDown(0.2);

    for (const [key, value] of entries) {
        doc.fontSize(9).font("Helvetica-Bold").fillColor(INK_2)
            .text(humanizeKey(key) + ":  ", { continued: true })
            .font("Helvetica").fillColor(INK)
            .text(String(value));
    }

    doc.moveDown(1);
}

/* A section banner matching the form itself: bold, uppercase, a
   hairline underneath - the same visual language the letterhead's
   own rule already uses, so a section heading here does not look
   like a new idiom invented just for this. */
function drawSectionHeading(doc, title) {
    doc.moveDown(0.3);
    doc.fontSize(10.5).font("Helvetica-Bold").fillColor(INK).text(title.toUpperCase());
    doc.moveTo(doc.page.margins.left, doc.y + 2)
        .lineTo(doc.page.width - doc.page.margins.right, doc.y + 2)
        .lineWidth(0.75).stroke(HAIRLINE);
    doc.moveDown(0.5);
}

/* A date field's value is the plain "YYYY-MM-DD" string forms.js
   stores it as - readable, but not what a person reads on a printed
   form. A "user" field's value is initials, the same short code the
   form's own dropdown carries as its option value; userNames turns
   that back into a name when one is known, without pretending an
   initials code no longer resolves when it does not. */
function formatFieldValue(field, value, userNames) {
    if (field.type === "date") {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleDateString();
    }

    if (field.type === "user" && userNames && userNames.has(value)) {
        return userNames.get(value) + " (" + value + ")";
    }

    return String(value);
}

/* DFMEA, PFMEA, control plan, process flow diagram: a real bordered
   table via pdfkit's own table() - the same rows and columns the web
   form's table field renders, never a shorter summary in one and a
   fuller one in the other. A wide table (more columns than a
   portrait letter page can hold at a readable size) gets its own
   landscape page and hands the document straight back to portrait
   afterward - the same convention a printed FMEA or control plan
   sheet already uses on paper, not a workaround invented for this. */
function drawTableField(doc, field, rows) {
    const columns = field.columns || [];
    if (columns.length === 0 || rows.length === 0) return;

    const wide = columns.length > 6;
    if (wide) doc.addPage({ size: "letter", layout: "landscape", margin: 54 });

    doc.fontSize(10).font("Helvetica-Bold").fillColor(INK).text(field.label);
    doc.moveDown(0.2);

    const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const widths = columns.map((column) => column.width || Math.floor(usable / columns.length));

    doc.table({
        columnStyles: widths,
        defaultStyle: { padding: 4, fontSize: 7.5 },
        data: [
            columns.map((column) => ({ text: column.label, font: "Helvetica-Bold" })),
            ...rows.map((row) => columns.map((column) => {
                const value = row[column.key];
                return (value === undefined || value === null || value === "")
                    ? ""
                    : formatFieldValue(column, value, null);
            }))
        ]
    });

    doc.moveDown(0.6);

    if (wide) doc.addPage({ size: "letter", margin: 54 });
}

/* The whole point of this export: a PDF laid out like the form that
   was actually filled in, not an alphabetised key/value dump. Reads
   the exact form version the record was raised under - schema.fields
   in their declared order, grouped under the same section headings
   forms.js groups them under on screen (public/js/forms.js,
   appendFieldsGrouped) - so a printed NCR reads the way the on-screen
   form reads, sections and all.

   A key present in data but no longer named by that version's schema
   (an older field, since renamed or removed in a later form version)
   is not dropped - it still happened, and this is meant to carry ALL
   of a record's information, not just what the current form asks
   for - it prints last, under "Additional details". */
function drawFormFields(doc, data, schema, userNames) {
    const values = data || {};
    const fields = (schema && Array.isArray(schema.fields)) ? schema.fields : [];

    if (fields.length === 0) {
        drawGenericFields(doc, values);
        return;
    }

    doc.fontSize(11).fillColor(INK).font("Helvetica-Bold").text("Form detail");
    doc.moveDown(0.2);

    const shown = new Set();
    let lastSection;
    let first = true;

    for (const field of fields) {
        const value = values[field.key];
        const empty = value === null || value === undefined || value === ""
            || (Array.isArray(value) && value.length === 0);
        if (empty) continue;

        shown.add(field.key);

        const section = field.section || null;
        if (first || section !== lastSection) {
            if (section) drawSectionHeading(doc, section);
            lastSection = section;
            first = false;
        }

        const label = field.label || humanizeKey(field.key);

        if (field.type === "table") {
            drawTableField(doc, field, value);
        } else if (field.type === "memo") {
            const text = formatFieldValue(field, value, userNames);
            doc.fontSize(9).font("Helvetica-Bold").fillColor(INK_2).text(label + ":");
            doc.fontSize(9).font("Helvetica").fillColor(INK).text(text, {
                width: doc.page.width - doc.page.margins.left - doc.page.margins.right
            });
            doc.moveDown(0.4);
        } else {
            const text = formatFieldValue(field, value, userNames);
            doc.fontSize(9).font("Helvetica-Bold").fillColor(INK_2)
                .text(label + ":  ", { continued: true })
                .font("Helvetica").fillColor(INK).text(text);
        }
    }

    const leftovers = Object.entries(values).filter(([key, value]) => {
        if (shown.has(key)) return false;
        if (value === null || value === undefined || value === "") return false;
        if (Array.isArray(value) && value.length === 0) return false;
        return true;
    });

    if (leftovers.length > 0) {
        drawSectionHeading(doc, "Additional details");
        for (const [key, value] of leftovers) {
            doc.fontSize(9).font("Helvetica-Bold").fillColor(INK_2)
                .text(humanizeKey(key) + ":  ", { continued: true })
                .font("Helvetica").fillColor(INK).text(String(value));
        }
    }

    doc.moveDown(1);
}

/* A table field's audit-log entry is now the row array's real JSON
   (auditText, above) rather than "[object Object]" - correct, but
   printing that whole blob inline in an audit trail line would trade
   one unreadable value for a different one. Row count is what a
   reader of this trail actually wants to know happened ("the DFMEA
   went from 2 rows to 3"), not each row's full contents restated -
   those already appear in full under the DFMEA section itself.
   Anything that is not JSON-array text (every ordinary field this
   has ever logged) parses to nothing here and prints exactly as
   before. */
function summarizeAuditValue(text) {
    if (!text) return text;

    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return parsed.length + " row" + (parsed.length === 1 ? "" : "s");
    } catch {
        /* Not JSON - an ordinary scalar value, shown as it was written. */
    }

    return text;
}

function drawHistory(doc, rows) {
    if (rows.length === 0) return;

    doc.fontSize(11).fillColor(INK).font("Helvetica-Bold").text("Audit trail");
    doc.moveDown(0.2);

    for (const row of rows) {
        const when = new Date(row.changed_at).toLocaleString();
        const who = row.changed_by || "System";
        const what = humanizeKey(row.field)
            + (row.new_value ? " -> " + summarizeAuditValue(row.new_value) : "");

        doc.fontSize(8.5).font("Helvetica").fillColor(INK_2).text(when + "   " + who + "   " + what);
    }
}

records.get("/:number/pdf", async (request, response, next) => {
    try {
        const found = await query(
            SELECT_RECORD + " and r.number = $2",
            [request.user.org_id, request.params.number]
        );

        if (found.rowCount === 0) {
            return response.status(404).json({ error: "Record not found" });
        }

        const record = found.rows[0];

        const [org, history, formVersion, users] = await Promise.all([
            query("select name from organizations where id = $1", [request.user.org_id]),
            query(`
                select a.field, a.new_value, a.changed_at, u.full_name as changed_by
                  from audit_log a
             left join users u on u.id = a.changed_by
                 where a.record_id = $1
                 order by a.changed_at desc
                 limit 15
            `, [record.id]),
            query(
                "select schema from form_versions where record_type_id = $1 and version = $2",
                [record.record_type_id, record.form_version]
            ),
            query("select initials, full_name from users where org_id = $1", [request.user.org_id])
        ]);

        const orgName = org.rows[0]?.name || "";
        const schema = formVersion.rows[0]?.schema || null;
        const userNames = new Map(users.rows.map((row) => [row.initials, row.full_name]));

        response.setHeader("Content-Type", "application/pdf");
        response.setHeader("Content-Disposition", "attachment; filename=\"" + record.number + ".pdf\"");

        /* bufferPages holds every page until doc.end() instead of
           flushing each as it fills, so the footer can be stamped onto
           all of them afterward - a full-detail NCR routinely runs
           past one page now, and a footer drawn only once, on
           whichever page happened to be current when the content
           ended, used to mean the first page had none and a second,
           otherwise empty page had nothing else on it. */
        const doc = new PDFDocument({ size: "letter", margin: 54, bufferPages: true });
        doc.pipe(response);

        drawLetterhead(doc, orgName);
        drawRecordHeader(doc, record);
        drawFormFields(doc, record.data, schema, userNames);
        drawHistory(doc, history.rows);

        const pageRange = doc.bufferedPageRange();
        for (let i = pageRange.start; i < pageRange.start + pageRange.count; i++) {
            doc.switchToPage(i);
            drawFooter(doc, orgName);
        }

        doc.end();
    } catch (error) {
        next(error);
    }
});

/* ---------- create ----------
   POST /api/records
   { "type": "ncr", "title": "...", "owner": "MO", "data": { ... } }

   The payload is validated against the published form schema, so
   changing the form in the Form Builder changes what the API
   accepts without touching this file. */
records.post("/", requirePermission(createPermissionFor), async (request, response, next) => {
    try {
        const { type, title, owner, severity = "ok", due_at, idempotency_key } = request.body || {};
        const data = withComputedRpn(type, request.body?.data || {});

        if (!type || !title) {
            return response.status(400).json({
                error: "type and title are required"
            });
        }

        /* A record queued offline and synced later carries a key it
           generated at creation time, not at sync time. If that key is
           already on a record in this org, the first attempt actually
           landed and only the confirmation was lost - hand back what
           already exists rather than raising a duplicate. */
        if (idempotency_key) {
            const existing = await query(
                "select id, number, status from records where org_id = $1 and idempotency_key = $2",
                [request.user.org_id, idempotency_key]
            );
            if (existing.rowCount > 0) {
                return response.status(200).json(existing.rows[0]);
            }
        }

        const dueAt = parseDueAt(due_at);
        if (!dueAt.ok) {
            return response.status(400).json({ error: "due_at is not a valid date" });
        }

        if (type === "audit" && await auditorConflict(query, request.user.org_id, data)) {
            return response.status(409).json({
                error: "That auditor works within the department under review",
                detail: "Clause 9.2 requires an auditor be independent of the area they audit."
            });
        }

        const typeRow = await query(
            "select id, prefix from record_types where org_id = $1 and key = $2",
            [request.user.org_id, type]
        );

        if (typeRow.rowCount === 0) {
            return response.status(400).json({ error: "Unknown record type: " + type });
        }

        const recordType = typeRow.rows[0];

        /* Validate against the newest published form version. */
        const formRow = await query(`
            select version, schema from form_versions
             where record_type_id = $1 and published_at is not null
             order by version desc limit 1
        `, [recordType.id]);

        let formVersion = 1;

        if (formRow.rowCount > 0) {
            formVersion = formRow.rows[0].version;
            const missing = (formRow.rows[0].schema.fields || [])
                .filter((field) => field.required && data[field.key] === undefined)
                .map((field) => field.key);

            if (missing.length > 0) {
                return response.status(422).json({
                    error: "Required fields missing",
                    fields: missing
                });
            }
        }

        const created = await withTransaction(async (client) => {
            /* Next number for this type and year. A single writer is
               fine at this scale; a busy plant would use a sequence
               per type instead. */
            const year = new Date().getFullYear();
            const pattern = recordType.prefix + "-" + year + "-%";

            const last = await client.query(`
                select number from records
                 where org_id = $1 and record_type_id = $2 and number like $3
                 order by number desc limit 1
            `, [request.user.org_id, recordType.id, pattern]);

            const nextSeq = last.rowCount === 0
                ? 1
                : Number(last.rows[0].number.split("-").pop()) + 1;

            const number = recordType.prefix + "-" + year + "-"
                + String(nextSeq).padStart(4, "0");

            const ownerRow = owner
                ? await client.query(
                    "select id from users where org_id = $1 and initials = $2",
                    [request.user.org_id, owner]
                  )
                : { rowCount: 0, rows: [] };

            const ownerId = ownerRow.rowCount ? ownerRow.rows[0].id : null;

            /* A new record starts at whatever this type's workflow calls
               its first state, not a literal 'draft'. 8D's first state
               is 'd1', for instance - a type with no workflow defined at
               all still falls back to 'draft' so creating one never
               hard-fails, but nothing shipped today should hit that
               fallback. */
            const firstState = await client.query(
                "select key from workflow_states where record_type_id = $1 order by position limit 1",
                [recordType.id]
            );
            const initialStatus = firstState.rowCount > 0 ? firstState.rows[0].key : "draft";

            const inserted = await client.query(`
                insert into records
                    (org_id, record_type_id, number, title, status, severity,
                     owner_id, data, form_version, created_by, due_at, idempotency_key)
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                returning id, number, status
            `, [request.user.org_id, recordType.id, number, title, initialStatus,
                severity, ownerId, data, formVersion, request.user.id, dueAt.value,
                idempotency_key || null]);

            await client.query(`
                insert into audit_log
                    (org_id, record_id, entity, entity_id, field, new_value, changed_by)
                values ($1, $2, 'records', $2, 'created', $3, $4)
            `, [request.user.org_id, inserted.rows[0].id, number, request.user.id]);

            return inserted.rows[0];
        }).catch(async (error) => {
            /* Lost a race to a concurrent identical retry - the unique
               index caught what the check above could not. Hand back
               the winner's record instead of failing the request. */
            if (error.code === "23505" && idempotency_key) {
                const winner = await query(
                    "select id, number, status from records where org_id = $1 and idempotency_key = $2",
                    [request.user.org_id, idempotency_key]
                );
                if (winner.rowCount > 0) return { row: winner.rows[0], alreadyExisted: true };
            }
            throw error;
        });

        if (created.alreadyExisted) {
            return response.status(200).json(created.row);
        }

        response.status(201).json(created);
    } catch (error) {
        next(error);
    }
});

/* ---------- update ----------
   PATCH /api/records/NCR-2026-0142
   { "data": { "disposition": "Scrap" }, "reason": "MRB decision" }

   Every changed field writes an audit_log row in the same
   transaction. There is no code path that changes a record without
   leaving a trace. */
records.patch("/:number", requirePermission(editPermissionFor), async (request, response, next) => {
    try {
        const { data = {}, severity, reason, due_at, title } = request.body || {};

        /* Distinct from due_at being sent as null or "" (which means
           "clear it"): a PATCH that never mentions due_at at all - the
           common case, editing an ordinary data field - must leave the
           existing due date exactly alone rather than wiping it out. */
        const dueAtProvided = Object.prototype.hasOwnProperty.call(request.body || {}, "due_at");

        const dueAt = dueAtProvided ? parseDueAt(due_at) : { ok: true, value: undefined };
        if (!dueAt.ok) {
            return response.status(400).json({ error: "due_at is not a valid date" });
        }

        const titleProvided = Object.prototype.hasOwnProperty.call(request.body || {}, "title");
        if (titleProvided && !String(title || "").trim()) {
            return response.status(400).json({ error: "title cannot be blank" });
        }

        const updated = await withTransaction(async (client) => {
            const current = await client.query(`
                select r.id, r.title, r.data, r.severity, r.due_at, rt.key as type
                  from records r join record_types rt on rt.id = r.record_type_id
                 where r.org_id = $1 and r.number = $2
                   for update of r
            `, [request.user.org_id, request.params.number]);

            if (current.rowCount === 0) return null;

            const record = current.rows[0];

            /* Who made this change is who is signed in, never a value the
               client sends. The audit log is only worth anything if the
               server, not the caller, decides whose name goes on it. */
            const actorId = request.user.id;

            const merged = withComputedRpn(record.type, { ...record.data, ...data });

            if (record.type === "audit"
                && await auditorConflict((text, params) => client.query(text, params), request.user.org_id, merged)) {
                return { conflict: "That auditor works within the department under review" };
            }

            /* A risk's rpn/residual_rpn are derived, not sent by the
               caller, so they never appear in the plain "what did the
               client ask to change" set below - audited against the
               full merged-and-computed result instead, for this type
               only, so a scores edit still leaves its own trail on the
               number it actually changes. */
            const auditAgainst = record.type === "risk" ? merged : data;

            for (const [key, value] of Object.entries(auditAgainst)) {
                const before = record.data[key];
                const beforeText = auditText(before);
                const afterText = auditText(value);

                /* Two different table-field values (arrays of row
                   objects) both used to stringify to the same
                   "[object Object]" via a bare String() - not only
                   unreadable, but meaning a real edit to a DFMEA's
                   rows could leave no audit trail entry at all, since
                   the before/after comparison itself used that same
                   stringification. auditText's JSON.stringify keeps
                   this comparison (and the row below) honest for a
                   table field the same way it always already was for
                   an ordinary one. */
                if (beforeText === afterText) continue;

                await client.query(`
                    insert into audit_log
                        (org_id, record_id, entity, entity_id, field,
                         old_value, new_value, reason, changed_by)
                    values ($1, $2, 'records', $2, $3, $4, $5, $6, $7)
                `, [request.user.org_id, record.id, key, beforeText, afterText, reason || null, actorId]);
            }

            /* Unchanged (undefined) when the caller never mentioned
               due_at at all; otherwise the new value, parsed above,
               which is legitimately null when the intent was to clear
               a date that was set before. */
            const nextDueAt = dueAtProvided ? dueAt.value : record.due_at;

            if (dueAtProvided) {
                const beforeIso = record.due_at ? new Date(record.due_at).toISOString() : null;
                if (beforeIso !== dueAt.value) {
                    await client.query(`
                        insert into audit_log
                            (org_id, record_id, entity, entity_id, field,
                             old_value, new_value, reason, changed_by)
                        values ($1, $2, 'records', $2, 'due_at', $3, $4, $5, $6)
                    `, [request.user.org_id, record.id, beforeIso, dueAt.value, reason || null, actorId]);
                }
            }

            const nextTitle = titleProvided ? title.trim() : record.title;

            if (titleProvided && nextTitle !== record.title) {
                await client.query(`
                    insert into audit_log
                        (org_id, record_id, entity, entity_id, field,
                         old_value, new_value, reason, changed_by)
                    values ($1, $2, 'records', $2, 'title', $3, $4, $5, $6)
                `, [request.user.org_id, record.id, record.title, nextTitle, reason || null, actorId]);
            }

            const result = await client.query(`
                update records
                   set data = $2,
                       severity = coalesce($3, severity),
                       due_at = $4,
                       title = $5
                 where id = $1
                returning id, number, title, status, severity, data, due_at
            `, [record.id, merged, severity || null, nextDueAt, nextTitle]);

            return result.rows[0];
        });

        if (!updated) {
            return response.status(404).json({ error: "Record not found" });
        }

        if (updated.conflict) {
            return response.status(409).json({
                error: updated.conflict,
                detail: "Clause 9.2 requires an auditor be independent of the area they audit."
            });
        }

        response.json(updated);
    } catch (error) {
        next(error);
    }
});

/* ---------- attachments ----------
   GET  /api/records/NCR-2026-0142/attachments
   POST /api/records/NCR-2026-0142/attachments
       { "filename": "capa-0042-verify.pdf", "storage_key": "\\\\qms\\evidence\\capa-0042-verify.pdf" }

   Metadata only - this records what the evidence is and where it
   lives (a network path, a link into wherever the org already keeps
   files), not the file's bytes. Storing and serving the bytes
   themselves is a real storage-backend decision (local disk vs S3 vs
   Azure Blob, retention policy, scanning) that has not been made yet,
   same as the email-provider question sitting open for escalations.
   An attachment row is real either way - closure gates that check for
   one are not checking a stub. */
records.get("/:number/attachments", async (request, response, next) => {
    try {
        if (!request.user) return response.status(401).json({ error: "Not signed in" });

        const record = await query(
            "select id from records where org_id = $1 and number = $2",
            [request.user.org_id, request.params.number]
        );
        if (record.rowCount === 0) {
            return response.status(404).json({ error: "Record not found" });
        }

        const result = await query(`
            select a.id, a.filename, a.mime_type, a.size_bytes, a.storage_key,
                   a.uploaded_at, u.full_name as uploaded_by
              from attachments a
         left join users u on u.id = a.uploaded_by
             where a.record_id = $1
             order by a.uploaded_at desc
        `, [record.rows[0].id]);

        response.json({ count: result.rowCount, attachments: result.rows });
    } catch (error) {
        next(error);
    }
});

records.post("/:number/attachments", async (request, response, next) => {
    try {
        if (!request.user) return response.status(401).json({ error: "Not signed in" });

        const { filename, storage_key, mime_type, size_bytes } = request.body || {};
        if (!filename || !storage_key) {
            return response.status(400).json({ error: "filename and storage_key are required" });
        }

        const record = await query(
            "select id from records where org_id = $1 and number = $2",
            [request.user.org_id, request.params.number]
        );
        if (record.rowCount === 0) {
            return response.status(404).json({ error: "Record not found" });
        }

        const inserted = await query(`
            insert into attachments (record_id, filename, mime_type, size_bytes, storage_key, uploaded_by)
            values ($1, $2, $3, $4, $5, $6)
            returning id, filename, mime_type, size_bytes, storage_key, uploaded_at
        `, [record.rows[0].id, filename, mime_type || null,
            Number.isFinite(Number(size_bytes)) ? Number(size_bytes) : null,
            storage_key, request.user.id]);

        await query(`
            insert into audit_log
                (org_id, record_id, entity, entity_id, field, new_value, changed_by)
            values ($1, $2, 'attachments', $3, 'added', $4, $5)
        `, [request.user.org_id, record.rows[0].id, inserted.rows[0].id, filename, request.user.id]);

        response.status(201).json(inserted.rows[0]);
    } catch (error) {
        next(error);
    }
});

/* ---------- links ----------
   POST /api/records/APQP-2026-0002/links
   { "to": "FMEA-2026-0014", "link_type": "child_of" }

   record_links has existed since migration 004 (a complaint links to
   its 8D) but nothing has ever been able to create one outside seed
   data - every real feature that wants a real link (an APQP program
   to its FMEA/control plan/process flow/PPAP, a new FMEA revision to
   the one it supersedes, an 8D to the documents its D7 checklist
   reviewed) needed this first. Both records must exist in the
   caller's own org - link_type is exactly the set record_links'
   own check constraint already allows, not a client-invented value. */
const LINK_TYPES = new Set(["related", "caused_by", "corrects", "supersedes", "child_of"]);

records.post("/:number/links", async (request, response, next) => {
    try {
        if (!request.user) return response.status(401).json({ error: "Not signed in" });

        const { to, link_type = "related" } = request.body || {};
        if (!to) return response.status(400).json({ error: "to is required" });
        if (!LINK_TYPES.has(link_type)) {
            return response.status(400).json({ error: "Unknown link_type: " + link_type });
        }

        const [fromResult, toResult] = await Promise.all([
            query("select id, number from records where org_id = $1 and number = $2",
                [request.user.org_id, request.params.number]),
            query("select id, number from records where org_id = $1 and number = $2",
                [request.user.org_id, to])
        ]);

        if (fromResult.rowCount === 0) return response.status(404).json({ error: "Record not found" });
        if (toResult.rowCount === 0) return response.status(404).json({ error: "Linked record not found: " + to });

        const fromRecord = fromResult.rows[0];
        const toRecord = toResult.rows[0];

        if (fromRecord.id === toRecord.id) {
            return response.status(400).json({ error: "A record cannot link to itself" });
        }

        await query(`
            insert into record_links (from_record_id, to_record_id, link_type)
            values ($1, $2, $3)
            on conflict (from_record_id, to_record_id, link_type) do nothing
        `, [fromRecord.id, toRecord.id, link_type]);

        response.status(201).json({ from: fromRecord.number, to: toRecord.number, link_type });
    } catch (error) {
        next(error);
    }
});

/* ---------- workflow transition ----------
   POST /api/records/NCR-2026-0142/transition
   { "to": "mrb", "actor": "MO" }

   Refuses any move the workflow does not define. This is the rule
   that stops a record skipping containment and going straight to
   closed. */
records.post("/:number/transition", async (request, response, next) => {
    try {
        const { to, reason } = request.body || {};

        if (!to) {
            return response.status(400).json({ error: "to is required" });
        }

        if (!request.user) {
            return response.status(401).json({ error: "Not signed in" });
        }

        const outcome = await withTransaction(async (client) => {
            const current = await client.query(`
                select r.id, r.number, r.status, r.record_type_id, r.data, rt.key as type
                  from records r
                  join record_types rt on rt.id = r.record_type_id
                 where r.org_id = $1 and r.number = $2
                   for update of r
            `, [request.user.org_id, request.params.number]);

            if (current.rowCount === 0) return { code: 404 };

            const record = current.rows[0];

            const allowed = await client.query(`
                select required_permission from workflow_transitions
                 where record_type_id = $1 and from_state = $2 and to_state = $3
            `, [record.record_type_id, record.status, to]);

            if (allowed.rowCount === 0) {
                return {
                    code: 409,
                    body: {
                        error: "Transition not allowed",
                        from: record.status,
                        to
                    }
                };
            }

            /* One model of authority, not two. The step names a
               permission; whether this person's role carries it is the
               permission grid's business, and seniority falls out of
               that rather than needing a special case. */
            const stepKey = allowed.rows[0].required_permission;

            if (stepKey && !request.can(stepKey)) {
                return {
                    code: 403,
                    body: {
                        error: "Your role does not permit this step",
                        required: stepKey,
                        your_role: request.user.role_name
                    }
                };
            }

            const terminal = await client.query(`
                select is_terminal from workflow_states
                 where record_type_id = $1 and key = $2
            `, [record.record_type_id, to]);

            const isTerminal = terminal.rowCount > 0 && terminal.rows[0].is_terminal;

            /* Closing a record is a separate authority from working it. */
            const closeKey = isTerminal ? closePermissionFor(record.type) : null;

            if (closeKey && !request.can(closeKey)) {
                return {
                    code: 403,
                    body: {
                        error: "Your role does not permit closing this record",
                        required: closeKey,
                        your_role: request.user.role_name
                    }
                };
            }

            /* Verifying an audit closed is the other half of clause 9.2 -
               a conflict that somehow made it into a record's data
               (raised before this check existed, or edited around it)
               is caught again here, at the moment the audit is actually
               signed off, not only at the moment it was scheduled. */
            if (isTerminal && record.type === "audit"
                && await auditorConflict((text, params) => client.query(text, params), request.user.org_id, record.data)) {
                return {
                    code: 409,
                    body: {
                        error: "That auditor works within the department under review",
                        detail: "Clause 9.2 requires an auditor be independent of the area they audit."
                    }
                };
            }

            /* Clause 10.2: closing a CAPA without evidence the
               corrective action was actually validated is exactly the
               gap between "we planned a fix" and "we proved the fix
               worked" that this clause exists to close. */
            if (isTerminal && record.type === "capa"
                && !await hasAttachment((text, params) => client.query(text, params), record.id)) {
                return {
                    code: 409,
                    body: {
                        error: "At least one validation attachment is required before closing this CAPA",
                        detail: "Clause 10.2 requires evidence the corrective action was verified effective."
                    }
                };
            }

            /* Clause 8.3.4: every APQP phase move, not only the final
               close, is a stage gate - the phase being left has to
               have met its own exit criteria first. */
            if (record.type === "apqp") {
                const missing = await apqpPhaseGaps(
                    (text, params) => client.query(text, params),
                    record.status, record.data, record.id
                );
                if (missing.length > 0) {
                    return {
                        code: 409,
                        body: {
                            error: "This phase's deliverables are not complete",
                            detail: "Clause 8.3.4 requires defined exit criteria be met before advancing a design and development stage.",
                            missing
                        }
                    };
                }
            }

            const actorId = request.user.id;

            const moved = await client.query(`
                update records
                   set status = $2,
                       closed_at = case when $3 then now() else closed_at end
                 where id = $1
                returning id, number, status, closed_at
            `, [record.id, to, isTerminal]);

            await client.query(`
                insert into audit_log
                    (org_id, record_id, entity, entity_id, field,
                     old_value, new_value, reason, changed_by)
                values ($1, $2, 'records', $2, 'status', $3, $4, $5, $6)
            `, [request.user.org_id, record.id, record.status, to, reason || null, actorId]);

            /* A new fmea/control_plan/process_flow revision being
               approved is the moment the revision it supersedes stops
               being the live one - not an edit to that older record
               (nothing about what it said when it was approved
               changes), a status the newer record's own approval
               causes. No workflow_transitions row exists for
               approved -> superseded on purpose: this is the only way
               into it, never a move a user picks from a list. */
            if (to === "approved" && ["fmea", "control_plan", "process_flow"].includes(record.type)) {
                const superseded = await client.query(`
                    select r.id, r.status
                      from record_links l
                      join records r on r.id = l.to_record_id
                     where l.from_record_id = $1 and l.link_type = 'supersedes'
                `, [record.id]);

                for (const old of superseded.rows) {
                    if (old.status !== "superseded") {
                        await client.query(
                            "update records set status = 'superseded', closed_at = coalesce(closed_at, now()) where id = $1",
                            [old.id]
                        );
                        await client.query(`
                            insert into audit_log
                                (org_id, record_id, entity, entity_id, field,
                                 old_value, new_value, reason, changed_by)
                            values ($1, $2, 'records', $2, 'status', $3, 'superseded', $4, $5)
                        `, [request.user.org_id, old.id, old.status,
                            "Superseded by " + record.number + "'s approval", actorId]);
                    }

                    /* Whatever the old revision was a child_of (an APQP
                       program, most often) the new one now stands in
                       for - carried forward automatically rather than
                       relying on whoever approves a revision to
                       remember a second link, or a phase gate quietly
                       losing track of "the approved DFMEA" the moment
                       a revision replaces the one it originally found. */
                    const parents = await client.query(
                        "select from_record_id from record_links where to_record_id = $1 and link_type = 'child_of'",
                        [old.id]
                    );
                    for (const parent of parents.rows) {
                        await client.query(`
                            insert into record_links (from_record_id, to_record_id, link_type)
                            values ($1, $2, 'child_of')
                            on conflict (from_record_id, to_record_id, link_type) do nothing
                        `, [parent.from_record_id, record.id]);
                    }
                }
            }

            return { code: 200, body: moved.rows[0] };
        });

        if (outcome.code === 404) {
            return response.status(404).json({ error: "Record not found" });
        }

        response.status(outcome.code).json(outcome.body);
    } catch (error) {
        next(error);
    }
});
