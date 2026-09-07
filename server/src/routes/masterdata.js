/* ============================================================
   Master data: vendors, gages, documents, parts, lots, training.

   These have a fixed shape, so they get real columns rather than a
   JSONB payload. The interesting endpoints are the last two: lot
   genealogy and the training matrix, where the schema does work
   that would otherwise be application code.
   ============================================================ */

import { Router } from "express";
import { query, withTransaction } from "../db.js";
import { requirePermission } from "../auth.js";
import { scoredVendors } from "../vendor-scoring.js";
import { saveDocumentFile, readDocumentFile } from "../document-storage.js";
import { saveUploadedFile, readUploadedFile } from "../file-storage.js";
import { upload } from "../uploads.js";

export const masterdata = Router();

/* Field history stores plain strings. Dates arrive from pg as Date
   objects and the incoming edits as "YYYY-MM-DD"; normalise both so a
   no-op edit is not logged as a change. */
function auditText(value) {
    if (value === null || value === undefined) return "";
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value);
}

/* ---------- organization ----------
   Everything the page header needs: who this is, which site, and the
   next certification audit. Days remaining is computed by the database
   from the stored date, so the countdown can never be a stale literal
   sitting in the markup. */
masterdata.get("/organization", async (request, response, next) => {
    try {
        const org = await query(`
            select o.name as organization,
                   s.code as site_code,
                   s.name as site_name
              from organizations o
         left join sites s on s.org_id = o.id
             where o.id = $1
             limit 1
        `, [request.user.org_id]);

        if (org.rowCount === 0) {
            return response.status(404).json({ error: "Organization not found" });
        }

        const certifications = await query(`
            select standard, registrar, certificate_number,
                   issued_on, expires_on, next_audit_on, audit_type, scope,
                   (next_audit_on - current_date)::int as days_to_audit,
                   (expires_on - current_date)::int    as days_to_expiry
              from certifications
             where org_id = $1
             order by next_audit_on
        `, [request.user.org_id]);

        response.json({
            ...org.rows[0],
            certifications: certifications.rows,
            /* The soonest audit is what the header counts down to. */
            next_audit: certifications.rows[0] || null
        });
    } catch (error) {
        next(error);
    }
});

/* ---------- form schema ----------
   GET /api/record-types/ncr/form

   Returns the published form definition plus the option lists any
   link fields need. The front end renders whatever comes back, so
   adding a field in the Form Builder adds it to the form without a
   change to any UI code.

   Link targets come from this fixed table and never from the request,
   so no caller can point a field at an arbitrary table. */
const LINK_SOURCES = {
    parts: `select part_number as value,
                   part_number || '  ' || description as label,
                   false as disabled
              from parts where org_id = $1 order by part_number`,

    gages: `select gage_id as value,
                   gage_id || '  ' || description as label,
                   (next_due < current_date or availability in ('hold', 'retired')) as disabled,
                   case
                       when availability = 'retired' then 'retired'
                       when availability = 'hold' then 'failed calibration'
                       when next_due < current_date then 'calibration expired'
                       else null
                   end as disabled_reason
              from gages where org_id = $1 order by gage_id`,

    lots:  `select lot_number as value,
                   lot_number || '  ' || coalesce(location, '') as label,
                   false as disabled
              from lots where org_id = $1 order by lot_number desc`
};

/* GET /api/record-types
   Every record type and whichever form version is published against
   it. The Form Builder screen reads this, so what it shows is the
   schema the API actually validates against. */
masterdata.get("/record-types", async (request, response, next) => {
    try {
        const result = await query(`
            select rt.key, rt.name, rt.prefix, rt.clause,
                   fv.version, fv.published_at,
                   u.full_name as published_by,
                   jsonb_array_length(coalesce(fv.schema->'fields', '[]'::jsonb)) as field_count,
                   jsonb_array_length(coalesce(fv.schema->'rules',  '[]'::jsonb)) as rule_count,
                   (select count(*)::int from records r
                     where r.record_type_id = rt.id) as record_count
              from record_types rt
         left join lateral (
                   select * from form_versions f
                    where f.record_type_id = rt.id and f.published_at is not null
                    order by f.version desc limit 1
                 ) fv on true
         left join users u on u.id = fv.published_by
             where rt.org_id = $1
             order by rt.clause nulls last, rt.name
        `, [request.user.org_id]);

        response.json({ count: result.rowCount, record_types: result.rows });
    } catch (error) {
        next(error);
    }
});

masterdata.get("/record-types/:key/form", async (request, response, next) => {
    try {
        const found = await query(`
            select rt.key, rt.name, rt.prefix, rt.clause,
                   fv.version, fv.schema
              from record_types rt
         left join form_versions fv
                on fv.record_type_id = rt.id and fv.published_at is not null
             where rt.org_id = $1 and rt.key = $2
             order by fv.version desc
             limit 1
        `, [request.user.org_id, request.params.key]);

        if (found.rowCount === 0) {
            return response.status(404).json({ error: "No such record type" });
        }

        const definition = found.rows[0];

        if (!definition.schema) {
            return response.status(404).json({
                error: "No published form for " + definition.key,
                detail: "This record type has no form version yet."
            });
        }

        /* Load options for every link field the form declares. */
        const fields = definition.schema.fields || [];
        const targets = [...new Set(
            fields.filter((f) => f.type === "link" && LINK_SOURCES[f.target])
                  .map((f) => f.target)
        )];

        const options = {};
        await Promise.all(targets.map(async (target) => {
            const rows = await query(LINK_SOURCES[target], [request.user.org_id]);
            options[target] = rows.rows;
        }));

        /* "user" has been accepted in FIELD_TYPES since this validator
           was written, but nothing ever loaded options for one - a form
           that declared it would have rendered as a plain text box.
           Value is the person's initials, the same identifier records
           already use for owner, so a field like audit's "auditor" is
           a real reference rather than a name typed freely. */
        if (fields.some((f) => f.type === "user")) {
            const rows = await query(`
                select initials as value,
                       full_name || case when discipline is not null
                                         then ' (' || discipline || ')' else '' end as label,
                       false as disabled
                  from users where org_id = $1 and active
                  order by full_name
            `, [request.user.org_id]);
            options.users = rows.rows;
        }

        response.json({
            key: definition.key,
            name: definition.name,
            clause: definition.clause,
            version: definition.version,
            fields,
            rules: definition.schema.rules || [],
            options
        });
    } catch (error) {
        next(error);
    }
});

const FIELD_TYPES = new Set([
    "text", "memo", "number", "date", "select", "link", "file", "signature", "user"
]);

/* Never trust the client's own validation. The in-app editor already
   checks all of this before it ever sends a request, but the field
   list is exactly the shape every screen in the app renders forms
   from, so a bad one here breaks every future record of this type,
   not just the request that sent it. */
function problemWith(fields) {
    if (!Array.isArray(fields) || fields.length === 0) {
        return "At least one field is required";
    }

    const seenKeys = new Set();

    for (const field of fields) {
        if (!field || typeof field !== "object") return "Every field must be an object";
        if (!field.key || typeof field.key !== "string") return "Every field needs a key";
        if (!field.label || typeof field.label !== "string") return "Every field needs a label";
        if (!FIELD_TYPES.has(field.type)) return "Unknown field type: " + field.type;
        if (field.section !== undefined && typeof field.section !== "string") {
            return "\"" + field.label + "\"'s section must be text";
        }

        if (seenKeys.has(field.key)) return "Two fields share the key \"" + field.key + "\"";
        seenKeys.add(field.key);

        if (field.type === "select" && (!Array.isArray(field.options) || field.options.length === 0)) {
            return "\"" + field.label + "\" needs at least one option";
        }
        if (field.type === "link" && !LINK_SOURCES[field.target]) {
            return "\"" + field.label + "\" needs a valid link target";
        }
    }

    return null;
}

/* PUT /api/record-types/ncr/form   { fields: [...] }

   Publishing a new version, never overwriting the one records were
   captured under - unchanged from how the Form Builder already
   described itself working, now made real. Conditional rules are not
   editable from here yet, so whatever the previous version had is
   carried forward untouched rather than silently dropped. */
masterdata.put("/record-types/:key/form", requirePermission("forms.manage"),
    async (request, response, next) => {
        try {
            const problem = problemWith(request.body?.fields);
            if (problem) return response.status(422).json({ error: problem });

            const fields = request.body.fields;

            const typeRow = await query(
                "select id from record_types where org_id = $1 and key = $2",
                [request.user.org_id, request.params.key]
            );

            if (typeRow.rowCount === 0) {
                return response.status(404).json({ error: "No such record type" });
            }

            const recordTypeId = typeRow.rows[0].id;

            const version = await withTransaction(async (client) => {
                const previous = await client.query(`
                    select version, schema from form_versions
                     where record_type_id = $1
                     order by version desc limit 1
                `, [recordTypeId]);

                const nextVersion = previous.rowCount > 0 ? previous.rows[0].version + 1 : 1;
                const rules = previous.rowCount > 0 ? (previous.rows[0].schema.rules || []) : [];

                await client.query(`
                    insert into form_versions (record_type_id, version, schema, published_at, published_by)
                    values ($1, $2, $3, now(), $4)
                `, [recordTypeId, nextVersion, JSON.stringify({ fields, rules }), request.user.id]);

                await client.query(`
                    insert into audit_log
                        (org_id, entity, entity_id, field, new_value, changed_by)
                    values ($1, 'form_versions', $2, 'published', $3, $4)
                `, [request.user.org_id, recordTypeId, "v" + nextVersion + ", " + fields.length + " fields", request.user.id]);

                return nextVersion;
            });

            response.json({ key: request.params.key, version, field_count: fields.length });
        } catch (error) {
            next(error);
        }
    });

/* ---------- vendors ---------- */
/* ppm and grade are computed here, not read straight off the row -
   see vendor-scoring.js for what "computed" actually means (real
   receiving history where there is enough of it, the entered figure
   otherwise, an open SCAR always capping the grade). */
masterdata.get("/vendors", async (request, response, next) => {
    try {
        const vendors = await scoredVendors(request.user.org_id);

        vendors.sort((a, b) => {
            const rank = (v) => v.status === "scar_open" ? 0 : v.status === "on_watch" ? 1 : 2;
            return rank(a) - rank(b) || a.name.localeCompare(b.name);
        });

        response.json({ count: vendors.length, vendors });
    } catch (error) {
        next(error);
    }
});

/* ---------- vendor evaluations, clause 8.4.1 ----------
   The other half of supplier scoring: a dated, documented review,
   distinct from the rolling PPM/grade in vendor-scoring.js. Nothing
   here is computed - someone conducts the review and records what
   they found. */
masterdata.get("/vendors/:name/evaluations", async (request, response, next) => {
    try {
        const vendor = await query(
            "select id from vendors where org_id = $1 and name = $2",
            [request.user.org_id, request.params.name]
        );
        if (vendor.rowCount === 0) {
            return response.status(404).json({ error: "No such vendor" });
        }

        const result = await query(`
            select e.audit_date, e.performance_score, e.non_conformance_count,
                   e.notes, u.full_name as evaluated_by
              from vendor_evaluations e
         left join users u on u.id = e.evaluated_by
             where e.vendor_id = $1
             order by e.audit_date desc
        `, [vendor.rows[0].id]);

        response.json({ count: result.rowCount, evaluations: result.rows });
    } catch (error) {
        next(error);
    }
});

/* POST /api/vendors/Halstead%20Steel/evaluations
   { "audit_date": "2026-09-01", "performance_score": 92.5,
     "non_conformance_count": 1, "notes": "..." } */
masterdata.post("/vendors/:name/evaluations", requirePermission("vendor.approve"),
    async (request, response, next) => {
        try {
            const { audit_date, performance_score, non_conformance_count, notes } = request.body || {};

            if (!audit_date || Number.isNaN(new Date(audit_date).getTime())) {
                return response.status(400).json({ error: "audit_date is required and must be a valid date" });
            }

            const vendor = await query(
                "select id from vendors where org_id = $1 and name = $2",
                [request.user.org_id, request.params.name]
            );
            if (vendor.rowCount === 0) {
                return response.status(404).json({ error: "No such vendor" });
            }

            const inserted = await query(`
                insert into vendor_evaluations
                    (vendor_id, audit_date, performance_score, non_conformance_count, notes, evaluated_by)
                values ($1, $2, $3, $4, $5, $6)
                returning audit_date, performance_score, non_conformance_count, notes
            `, [vendor.rows[0].id, audit_date,
                performance_score === undefined ? null : Number(performance_score),
                Number(non_conformance_count) || 0, notes || null, request.user.id]);

            response.status(201).json(inserted.rows[0]);
        } catch (error) {
            next(error);
        }
    });

/* ---------- gages ----------
   Status is derived from the due date rather than stored, so it can
   never drift out of sync with reality. */
masterdata.get("/gages", async (request, response, next) => {
    try {
        const result = await query(`
            select gage_id, description, range_text, interval_months,
                   manufacturer, model, serial_number, location, cal_supplier,
                   last_cal, next_due, availability,
                   case
                       when next_due < current_date then 'past_due'
                       when next_due < current_date + interval '30 days' then 'due_soon'
                       else 'current'
                   end as status,
                   (next_due - current_date) as days_remaining
              from gages
             where org_id = $1
             order by next_due
        `, [request.user.org_id]);

        response.json({ count: result.rowCount, gages: result.rows });
    } catch (error) {
        next(error);
    }
});

/* POST /api/gages
   Add a tool to the register. When a last_cal is given without an
   explicit next_due, the due date is computed from it and the
   interval - the same arithmetic a passing calibration does - so a
   gage entered with its last result already known lands with the
   right due date and no second step. */
masterdata.post("/gages", requirePermission("gage.create"), async (request, response, next) => {
    try {
        const body = request.body || {};
        const gageId = (body.gage_id || "").trim();
        const description = (body.description || "").trim();
        const intervalMonths = Number(body.interval_months);

        if (!gageId || !description) {
            return response.status(400).json({ error: "gage_id and description are required" });
        }
        if (!Number.isInteger(intervalMonths) || intervalMonths < 1) {
            return response.status(400).json({ error: "interval_months must be a whole number of months, at least 1" });
        }

        const lastCal = body.last_cal || null;
        if (lastCal && Number.isNaN(new Date(lastCal).getTime())) {
            return response.status(400).json({ error: "last_cal is not a valid date" });
        }
        const nextDue = body.next_due || null;
        if (nextDue && Number.isNaN(new Date(nextDue).getTime())) {
            return response.status(400).json({ error: "next_due is not a valid date" });
        }

        const clash = await query(
            "select 1 from gages where org_id = $1 and gage_id = $2",
            [request.user.org_id, gageId]
        );
        if (clash.rowCount > 0) {
            return response.status(409).json({ error: "A gage with that ID already exists" });
        }

        const text = (key) => (body[key] || "").trim() || null;

        const created = await withTransaction(async (client) => {
            const inserted = await client.query(`
                insert into gages
                    (org_id, gage_id, description, range_text, interval_months,
                     manufacturer, model, serial_number, location, cal_supplier,
                     last_cal, next_due)
                values ($1, $2, $3, $4, $5::int, $6, $7, $8, $9, $10, $11::date,
                        coalesce($12::date,
                                 case when $11::date is not null
                                      then $11::date + make_interval(months => $5::int)
                                 end))
                returning id, gage_id, description, range_text, interval_months,
                          manufacturer, model, serial_number, location, cal_supplier,
                          last_cal, next_due, availability
            `, [request.user.org_id, gageId, description, text("range_text"), intervalMonths,
                text("manufacturer"), text("model"), text("serial_number"),
                text("location"), text("cal_supplier"), lastCal, nextDue]);

            await client.query(`
                insert into audit_log
                    (org_id, entity, entity_id, field, new_value, changed_by)
                values ($1, 'gages', $2, 'created', $3, $4)
            `, [request.user.org_id, inserted.rows[0].id, gageId, request.user.id]);

            return inserted.rows[0];
        });

        response.status(201).json(created);
    } catch (error) {
        next(error);
    }
});

/* PATCH /api/gages/BG-0221
   Any detail except the ID. If the interval or last-cal date is part
   of the change and no explicit next_due is sent, the due date is
   recomputed from the two, so editing an interval never leaves the
   old date silently in force. */
masterdata.patch("/gages/:gageId", requirePermission("gage.edit"), async (request, response, next) => {
    try {
        const body = request.body || {};
        const TEXT_FIELDS = ["description", "range_text", "manufacturer", "model",
            "serial_number", "location", "cal_supplier"];
        const DATE_FIELDS = ["last_cal", "next_due"];

        const outcome = await withTransaction(async (client) => {
            const found = await client.query(
                "select * from gages where org_id = $1 and gage_id = $2 for update",
                [request.user.org_id, request.params.gageId]
            );
            if (found.rowCount === 0) return null;
            const gage = found.rows[0];

            const next = {};

            for (const key of TEXT_FIELDS) {
                if (!(key in body)) continue;
                if (key === "description" && !(body[key] || "").trim()) {
                    return { badRequest: "description cannot be empty" };
                }
                next[key] = typeof body[key] === "string" ? body[key].trim() || null : body[key];
            }

            if ("interval_months" in body) {
                const value = Number(body.interval_months);
                if (!Number.isInteger(value) || value < 1) {
                    return { badRequest: "interval_months must be a whole number of months, at least 1" };
                }
                next.interval_months = value;
            }

            for (const key of DATE_FIELDS) {
                if (!(key in body)) continue;
                const value = body[key] || null;
                if (value && Number.isNaN(new Date(value).getTime())) {
                    return { badRequest: key + " is not a valid date" };
                }
                next[key] = value;
            }

            if (("interval_months" in next || "last_cal" in next) && !("next_due" in next)) {
                const baseLastCal = "last_cal" in next ? next.last_cal : auditText(gage.last_cal) || null;
                const interval = "interval_months" in next ? next.interval_months : gage.interval_months;
                if (baseLastCal) {
                    const due = new Date(baseLastCal + "T00:00:00Z");
                    due.setUTCMonth(due.getUTCMonth() + interval);
                    next.next_due = due.toISOString().slice(0, 10);
                }
            }

            const keys = Object.keys(next);
            if (keys.length === 0) {
                return { row: {
                    gage_id: gage.gage_id, description: gage.description, range_text: gage.range_text,
                    interval_months: gage.interval_months, manufacturer: gage.manufacturer,
                    model: gage.model, serial_number: gage.serial_number, location: gage.location,
                    cal_supplier: gage.cal_supplier, last_cal: gage.last_cal, next_due: gage.next_due,
                    availability: gage.availability
                } };
            }

            const setSql = keys.map((key, i) => `${key} = $${i + 2}`).join(", ");
            const result = await client.query(
                `update gages set ${setSql} where id = $1
                 returning id, gage_id, description, range_text, interval_months,
                           manufacturer, model, serial_number, location, cal_supplier,
                           last_cal, next_due, availability`,
                [gage.id, ...keys.map((key) => next[key])]
            );

            for (const key of keys) {
                const before = auditText(gage[key]);
                const after = auditText(result.rows[0][key]);
                if (before === after) continue;
                await client.query(`
                    insert into audit_log
                        (org_id, entity, entity_id, field, old_value, new_value, changed_by)
                    values ($1, 'gages', $2, $3, $4, $5, $6)
                `, [request.user.org_id, gage.id, key, before || null, after || null, request.user.id]);
            }

            return { row: result.rows[0] };
        });

        if (outcome === null) return response.status(404).json({ error: "No such gage" });
        if (outcome.badRequest) return response.status(400).json({ error: outcome.badRequest });
        response.json(outcome.row);
    } catch (error) {
        next(error);
    }
});

/* POST /api/gages/BG-0221/retire
   Out of service for good. The gage and its whole calibration history
   stay in place, but it drops out of the pickers on new records the
   same way a hold does. */
masterdata.post("/gages/:gageId/retire", requirePermission("gage.retire"), async (request, response, next) => {
    try {
        const done = await withTransaction(async (client) => {
            const found = await client.query(
                "select id, availability from gages where org_id = $1 and gage_id = $2 for update",
                [request.user.org_id, request.params.gageId]
            );
            if (found.rowCount === 0) return null;
            const gage = found.rows[0];

            if (gage.availability === "retired") {
                return { gage_id: request.params.gageId, availability: "retired" };
            }

            const result = await client.query(
                "update gages set availability = 'retired' where id = $1 returning gage_id, availability",
                [gage.id]
            );
            await client.query(`
                insert into audit_log
                    (org_id, entity, entity_id, field, old_value, new_value, reason, changed_by)
                values ($1, 'gages', $2, 'availability', $3, 'retired', $4, $5)
            `, [request.user.org_id, gage.id, gage.availability,
                (request.body && request.body.reason) || "Retired from service", request.user.id]);

            return result.rows[0];
        });

        if (!done) return response.status(404).json({ error: "No such gage" });
        response.json(done);
    } catch (error) {
        next(error);
    }
});

/* GET /api/gages/BG-0221/calibrations
   History, most recent first - what "historical calibration records"
   actually means, as opposed to the single last_cal/next_due pair on
   the gage itself. */
masterdata.get("/gages/:gageId/calibrations", async (request, response, next) => {
    try {
        const result = await query(`
            select c.id, c.performed_at, c.performed_on, c.result, c.reading, c.notes,
                   c.cal_supplier, c.as_found, c.as_left, c.standard_used,
                   c.certificate_filename,
                   (c.certificate_path is not null) as has_certificate,
                   u.full_name as performed_by
              from gage_calibrations c
              join gages g on g.id = c.gage_id
         left join users u on u.id = c.performed_by
             where g.org_id = $1 and g.gage_id = $2
             order by c.performed_at desc
        `, [request.user.org_id, request.params.gageId]);

        response.json({ count: result.rowCount, calibrations: result.rows });
    } catch (error) {
        next(error);
    }
});

/* GET /api/gages/BG-0221/calibrations/<id>/certificate
   The calibration certificate PDF, streamed back the way a document
   revision is. Being signed in is enough, same as viewing a
   controlled document. */
masterdata.get("/gages/:gageId/calibrations/:calId/certificate", async (request, response, next) => {
    try {
        const found = await query(`
            select c.certificate_path, c.certificate_filename
              from gage_calibrations c
              join gages g on g.id = c.gage_id
             where g.org_id = $1 and g.gage_id = $2 and c.id = $3
        `, [request.user.org_id, request.params.gageId, request.params.calId]);

        if (found.rowCount === 0 || !found.rows[0].certificate_path) {
            return response.status(404).json({ error: "No certificate on that calibration" });
        }

        const { certificate_path, certificate_filename } = found.rows[0];
        const buffer = await readUploadedFile(certificate_path);

        response.setHeader("Content-Type", "application/pdf");
        response.setHeader(
            "Content-Disposition",
            "inline; filename=\"" + (certificate_filename || "certificate.pdf") + "\""
        );
        response.send(buffer);
    } catch (error) {
        next(error);
    }
});

/* POST /api/gages/BG-0221/calibrations
   multipart or JSON: result (req), performed_on, cal_supplier,
   standard_used, as_found, as_left, reading, notes, certificate (PDF)

   A pass sets last_cal to the calibration date (today if none given)
   and extends next_due by the gage's own interval from that date. A
   fail leaves next_due alone - there is no "next due" for a gage that
   is not fit to use, only a hold that a later pass lifts - and sets
   the gage on hold in the same transaction that records the failure,
   not as a separate step something could skip. The certificate, if
   one is attached, is written to file storage first so a storage
   failure never leaves a half-recorded result. */
masterdata.post("/gages/:gageId/calibrations", requirePermission("gage.calibrate"),
    upload.single("certificate"), async (request, response, next) => {
    try {
        const body = request.body || {};
        const { result, reading, notes } = body;

        if (result !== "pass" && result !== "fail") {
            return response.status(400).json({ error: "result must be 'pass' or 'fail'" });
        }

        const performedOn = body.performed_on || null;
        if (performedOn && Number.isNaN(new Date(performedOn).getTime())) {
            return response.status(400).json({ error: "performed_on is not a valid date" });
        }

        const text = (key) => (body[key] || "").trim() || null;

        let certificatePath = null;
        let certificateFilename = null;
        if (request.file) {
            certificateFilename = request.file.originalname;
            certificatePath = await saveUploadedFile(
                "calibrations", [".pdf"], request.file.originalname, request.file.buffer
            );
        }

        const updated = await withTransaction(async (client) => {
            const found = await client.query(
                "select id, interval_months, availability from gages where org_id = $1 and gage_id = $2 for update",
                [request.user.org_id, request.params.gageId]
            );

            if (found.rowCount === 0) return null;
            const gage = found.rows[0];

            const nextAvailability = result === "fail" ? "hold" : "available";

            await client.query(`
                insert into gage_calibrations
                    (org_id, gage_id, performed_by, result, reading, notes,
                     performed_on, cal_supplier, as_found, as_left, standard_used,
                     certificate_path, certificate_filename)
                values ($1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10, $11, $12, $13)
            `, [request.user.org_id, gage.id, request.user.id, result, reading || null, notes || null,
                performedOn, text("cal_supplier"), text("as_found"), text("as_left"),
                text("standard_used"), certificatePath, certificateFilename]);

            const record = await client.query(`
                update gages
                   set last_cal = coalesce($3::date, current_date),
                       next_due = case
                           when $4 = 'pass'
                           then coalesce($3::date, current_date) + make_interval(months => interval_months)
                           else next_due
                       end,
                       availability = $2
                 where id = $1
                returning gage_id, last_cal, next_due, availability
            `, [gage.id, nextAvailability, performedOn, result]);

            if (gage.availability !== nextAvailability) {
                await client.query(`
                    insert into audit_log
                        (org_id, entity, entity_id, field, old_value, new_value, reason, changed_by)
                    values ($1, 'gages', $2, 'availability', $3, $4, $5, $6)
                `, [request.user.org_id, gage.id, gage.availability, nextAvailability,
                    result === "fail" ? "Failed calibration" : "Passed calibration", request.user.id]);
            }

            return { ...record.rows[0], certificate: certificateFilename };
        });

        if (!updated) return response.status(404).json({ error: "No such gage" });
        response.status(201).json(updated);
    } catch (error) {
        next(error);
    }
});

/* ---------- documents ----------
   ?record=APQP-2026-0002 narrows to the documents attached to one
   record - the same query this endpoint always ran, with one more
   condition, so a program or an 8D's own detail view can show just
   its own documents through this one endpoint rather than a second,
   parallel one. */
masterdata.get("/documents", async (request, response, next) => {
    try {
        const params = [request.user.org_id];
        let recordFilter = "";

        if (request.query.record) {
            params.push(request.query.record);
            recordFilter = `and d.record_id = (
                select id from records where org_id = $1 and number = $${params.length}
            )`;
        }

        const result = await query(`
            select d.doc_number, d.title, d.current_revision, d.status,
                   u.full_name as owner,
                   (select count(*) from document_revisions dr
                     where dr.document_id = d.id) as revision_count
              from documents d
         left join users u on u.id = d.owner_id
             where d.org_id = $1 ${recordFilter}
             order by d.doc_number
        `, params);

        response.json({ count: result.rowCount, documents: result.rows });
    } catch (error) {
        next(error);
    }
});

masterdata.get("/documents/:docNumber/revisions", async (request, response, next) => {
    try {
        const result = await query(`
            select dr.revision, dr.change_summary, dr.effective_date, dr.created_at,
                   dr.original_filename, dr.mime_type, (dr.storage_path is not null) as has_file,
                   author.full_name   as author,
                   approver.full_name as approved_by
              from document_revisions dr
              join documents d          on d.id = dr.document_id
         left join users author         on author.id = dr.author_id
         left join users approver       on approver.id = dr.approved_by
             where d.org_id = $1 and d.doc_number = $2
             order by dr.created_at desc
        `, [request.user.org_id, request.params.docNumber]);

        response.json({ count: result.rowCount, revisions: result.rows });
    } catch (error) {
        next(error);
    }
});

/* ---------- documents: real files ----------
   A document has always had a revision history (schema.sql); none of
   it could ever be created, revised, or downloaded until now. Uses
   the shared `upload` handler defined at the top of this file. */

/* Next after whatever the most recently created revision was, by
   creation order rather than alphabetical - a revision letter is
   assigned once and never resorted, so the newest one really is
   "created_at desc limit 1", the same row the revisions list above
   already treats as most recent. */
function nextRevisionLetter(previous) {
    if (!previous) return "A";
    const code = previous.toUpperCase().charCodeAt(previous.length - 1);
    return previous.slice(0, -1) + String.fromCharCode(code + 1);
}

/* POST /api/documents   multipart: doc_number, title, change_summary, file, record? */
masterdata.post("/documents", requirePermission("document.create"), upload.single("file"),
    async (request, response, next) => {
        try {
            const { doc_number, title, change_summary, record } = request.body || {};

            if (!doc_number || !title || !request.file) {
                return response.status(400).json({ error: "doc_number, title, and file are required" });
            }

            const existing = await query(
                "select 1 from documents where org_id = $1 and doc_number = $2",
                [request.user.org_id, doc_number]
            );
            if (existing.rowCount > 0) {
                return response.status(409).json({ error: "A document already exists with that number: " + doc_number });
            }

            let recordId = null;
            if (record) {
                const found = await query(
                    "select id from records where org_id = $1 and number = $2",
                    [request.user.org_id, record]
                );
                if (found.rowCount === 0) {
                    return response.status(404).json({ error: "Record not found: " + record });
                }
                recordId = found.rows[0].id;
            }

            const storagePath = await saveDocumentFile(request.file.originalname, request.file.buffer);

            const created = await withTransaction(async (client) => {
                const doc = await client.query(`
                    insert into documents (org_id, doc_number, title, owner_id, record_id)
                    values ($1, $2, $3, $4, $5)
                    returning id, doc_number, title, status, current_revision
                `, [request.user.org_id, doc_number, title, request.user.id, recordId]);

                const revision = await client.query(`
                    insert into document_revisions
                        (document_id, revision, change_summary, author_id,
                         original_filename, mime_type, size_bytes, storage_path)
                    values ($1, 'A', $2, $3, $4, $5, $6, $7)
                    returning revision, change_summary, created_at
                `, [doc.rows[0].id, change_summary || "Initial upload", request.user.id,
                    request.file.originalname, request.file.mimetype, request.file.size, storagePath]);

                return { document: doc.rows[0], revision: revision.rows[0] };
            });

            response.status(201).json(created);
        } catch (error) {
            /* assertAllowedFilename (document-storage.js) throws with
               a real status - the app's own generic error handler
               always answers 500 regardless of one, the same as every
               other route in this file already works around by
               answering directly rather than relying on it. */
            if (error.status) return response.status(error.status).json({ error: error.message });
            next(error);
        }
    }
);

/* POST /api/documents/FMEA-2026-0014/revisions   multipart: file, change_summary, revision? */
masterdata.post("/documents/:docNumber/revisions", requirePermission("document.create"), upload.single("file"),
    async (request, response, next) => {
        try {
            if (!request.file) {
                return response.status(400).json({ error: "file is required" });
            }

            const doc = await query(
                "select id from documents where org_id = $1 and doc_number = $2",
                [request.user.org_id, request.params.docNumber]
            );
            if (doc.rowCount === 0) {
                return response.status(404).json({ error: "Document not found" });
            }
            const documentId = doc.rows[0].id;

            const latest = await query(
                "select revision from document_revisions where document_id = $1 order by created_at desc limit 1",
                [documentId]
            );

            const revision = request.body?.revision || nextRevisionLetter(latest.rows[0]?.revision);

            const clash = await query(
                "select 1 from document_revisions where document_id = $1 and revision = $2",
                [documentId, revision]
            );
            if (clash.rowCount > 0) {
                return response.status(409).json({ error: "Revision " + revision + " already exists for this document" });
            }

            const storagePath = await saveDocumentFile(request.file.originalname, request.file.buffer);

            /* Uploading a revision is not the same act as making it
               official - see WI-0412 in this org's own seed data, a
               drafted revision sitting unapproved while an earlier one
               stays current. documents.status moves to in_approval so
               the register reflects that something is now pending,
               but current_revision - the one a plain download without
               a revision number returns - does not change until
               /release says so. */
            const created = await withTransaction(async (client) => {
                const inserted = await client.query(`
                    insert into document_revisions
                        (document_id, revision, change_summary, author_id,
                         original_filename, mime_type, size_bytes, storage_path)
                    values ($1, $2, $3, $4, $5, $6, $7, $8)
                    returning revision, change_summary, created_at
                `, [documentId, revision, request.body?.change_summary || "Revision uploaded", request.user.id,
                    request.file.originalname, request.file.mimetype, request.file.size, storagePath]);

                await client.query(
                    "update documents set status = 'in_approval' where id = $1 and status <> 'obsolete'",
                    [documentId]
                );

                return inserted.rows[0];
            });

            response.status(201).json(created);
        } catch (error) {
            if (error.status) return response.status(error.status).json({ error: error.message });
            next(error);
        }
    }
);

/* POST /api/documents/FMEA-2026-0014/revisions/B/release
   The one place a revision becomes the official one. Either
   permission in the catalog that names this act satisfies it -
   document.approve ("Approve a document revision") and
   document.release ("Release a revision to the shop floor") describe
   the same real authority from two angles, not two separate gates to
   clear. */
masterdata.post("/documents/:docNumber/revisions/:revision/release", async (request, response, next) => {
    try {
        if (!request.can("document.release") && !request.can("document.approve")) {
            return response.status(403).json({
                error: "Your role does not permit this",
                required: "document.release or document.approve"
            });
        }

        const doc = await query(
            "select id from documents where org_id = $1 and doc_number = $2",
            [request.user.org_id, request.params.docNumber]
        );
        if (doc.rowCount === 0) {
            return response.status(404).json({ error: "Document not found" });
        }
        const documentId = doc.rows[0].id;

        const revision = await query(
            "select id from document_revisions where document_id = $1 and revision = $2",
            [documentId, request.params.revision]
        );
        if (revision.rowCount === 0) {
            return response.status(404).json({ error: "Revision not found" });
        }

        await withTransaction(async (client) => {
            await client.query(
                "update document_revisions set approved_by = $1, effective_date = now() where id = $2",
                [request.user.id, revision.rows[0].id]
            );
            await client.query(
                "update documents set current_revision = $1, status = 'released' where id = $2",
                [request.params.revision, documentId]
            );
        });

        response.json({ doc_number: request.params.docNumber, current_revision: request.params.revision });
    } catch (error) {
        next(error);
    }
});

/* A browser can only ever display a handful of formats on its own -
   nothing renders an actual spreadsheet, but a PDF, an image, or
   plain text/CSV all show natively. Everything else - Excel, Word -
   is exactly as viewable as it ever was: opened in the real
   application that made it, just downloaded through a real, tracked
   window instead of a bare link. */
function canRenderInline(mimeType) {
    if (!mimeType) return false;
    return mimeType === "application/pdf"
        || mimeType.startsWith("image/")
        || mimeType === "text/plain"
        || mimeType === "text/csv";
}

/* GET /api/documents/FMEA-2026-0014/revisions/B/download
   GET /api/documents/FMEA-2026-0014/revisions/current/download
   Streams the real file back. Content-Disposition depends on what
   the browser can actually do with it: inline for the formats above,
   so a document window's own <iframe> can show a PDF/image right on
   the page - attachment for everything else, which is exactly what
   makes clicking "Open" actually save-and-launch Excel/Word rather
   than the browser trying and failing to display it. No extra
   permission beyond being signed in, the same as the two read-only
   routes above already allow: viewing a controlled document is not
   gated the way authoring one is. */
masterdata.get("/documents/:docNumber/revisions/:revision/download", async (request, response, next) => {
    try {
        const revisionKey = request.params.revision;

        const result = await query(`
            select dr.original_filename, dr.mime_type, dr.storage_path
              from document_revisions dr
              join documents d on d.id = dr.document_id
             where d.org_id = $1 and d.doc_number = $2
               and dr.revision = case when $3 = 'current' then d.current_revision else $3 end
        `, [request.user.org_id, request.params.docNumber, revisionKey]);

        if (result.rowCount === 0 || !result.rows[0].storage_path) {
            return response.status(404).json({ error: "No file on that revision" });
        }

        const { original_filename, mime_type, storage_path } = result.rows[0];
        const buffer = await readDocumentFile(storage_path);
        const disposition = canRenderInline(mime_type) ? "inline" : "attachment";

        response.setHeader("Content-Type", mime_type || "application/octet-stream");
        response.setHeader("Content-Disposition", disposition + "; filename=\"" + original_filename + "\"");
        response.send(buffer);
    } catch (error) {
        next(error);
    }
});

/* ---------- parts ---------- */
masterdata.get("/parts", async (request, response, next) => {
    try {
        const result = await query(`
            select part_number, description, revision, customer
              from parts where org_id = $1 order by part_number
        `, [request.user.org_id]);

        response.json({ count: result.rowCount, parts: result.rows });
    } catch (error) {
        next(error);
    }
});

/* ---------- lot genealogy ----------
   GET /api/lots/L-88213/genealogy

   A recursive CTE walks the parent chain up to the raw material and
   back down through every child lot. This is the query that answers
   "which customers got parts from this heat number", which is the
   question a recall turns on. */
masterdata.get("/lots/:lotNumber/genealogy", async (request, response, next) => {
    try {
        const result = await query(`
            with recursive
            target as (
                select id from lots where org_id = $1 and lot_number = $2
            ),
            ancestors as (
                select l.*, 0 as depth
                  from lots l join target t on t.id = l.id
                 union all
                select parent.*, a.depth - 1
                  from lots parent
                  join ancestors a on a.parent_lot_id = parent.id
            ),
            root as (
                select id from ancestors order by depth limit 1
            ),
            descendants as (
                select l.*, 0 as depth
                  from lots l join root r on r.id = l.id
                 union all
                select child.*, d.depth + 1
                  from lots child
                  join descendants d on child.parent_lot_id = d.id
            )
            select d.lot_number, d.heat_number, d.qty, d.location,
                   d.status, d.depth,
                   p.part_number, p.description as part_description,
                   (select count(*)::int from records r
                     where r.data->>'lot_number' = d.lot_number) as linked_records
              from descendants d
         left join parts p on p.id = d.part_id
             order by d.depth, d.lot_number
        `, [request.user.org_id, request.params.lotNumber]);

        if (result.rowCount === 0) {
            return response.status(404).json({ error: "Lot not found" });
        }

        response.json({ lot: request.params.lotNumber, tree: result.rows });
    } catch (error) {
        next(error);
    }
});

masterdata.get("/lots", async (request, response, next) => {
    try {
        const onHold = request.query.on_hold === "true";

        const result = await query(`
            select l.lot_number, l.heat_number, l.qty, l.location, l.status,
                   p.part_number
              from lots l
         left join parts p on p.id = l.part_id
             where l.org_id = $1
               ${onHold ? "and l.status in ('on_hold','quarantine')" : ""}
             order by l.lot_number desc
        `, [request.user.org_id]);

        response.json({ count: result.rowCount, lots: result.rows });
    } catch (error) {
        next(error);
    }
});

/* ---------- training matrix and gaps ----------
   A gap is not a stored flag. It is the absence of a training row at
   the document's CURRENT revision, computed at read time. Release a
   new revision and the gaps appear by themselves. */
masterdata.get("/training/gaps", async (request, response, next) => {
    try {
        const result = await query(`
            select u.full_name as operator,
                   u.role,
                   d.doc_number,
                   d.title as document_title,
                   d.current_revision,
                   tr.revision_trained,
                   tr.id as training_record_id,
                   case
                       when tr.id is null then 'never_trained'
                       else 'superseded_revision'
                   end as gap_type
              from users u
              join document_requirements req
                on req.role = u.role and req.org_id = u.org_id
              join documents d
                on d.id = req.document_id
         left join training_records tr
                on tr.user_id = u.id and tr.document_id = d.id
             where u.org_id = $1
               and u.active
               and (
                     tr.id is null
                     or tr.revision_trained is distinct from d.current_revision
                   )
             order by u.full_name, d.doc_number
        `, [request.user.org_id]);

        response.json({ count: result.rowCount, gaps: result.rows });
    } catch (error) {
        next(error);
    }
});

masterdata.get("/training/matrix", async (request, response, next) => {
    try {
        /* Built from document_requirements outward, the same shape as
           /training/gaps, so an operator required to hold a document but
           never trained on it still gets a row and a cell for it, rather
           than being absent from the matrix altogether. */
        const result = await query(`
            select u.full_name as operator, u.initials as operator_initials, u.role,
                   json_object_agg(
                       d.doc_number,
                       json_build_object(
                           'trained_revision', tr.revision_trained,
                           'current_revision', d.current_revision,
                           'training_record_id', tr.id,
                           'ok', tr.revision_trained is not null
                                 and tr.revision_trained = d.current_revision
                       )
                   ) as documents
              from users u
              join document_requirements req
                on req.role = u.role and req.org_id = u.org_id
              join documents d on d.id = req.document_id
         left join training_records tr
                on tr.user_id = u.id and tr.document_id = d.id
             where u.org_id = $1 and u.active
             group by u.id, u.full_name, u.initials, u.role
             order by u.full_name
        `, [request.user.org_id]);

        response.json({ count: result.rowCount, matrix: result.rows });
    } catch (error) {
        next(error);
    }
});

/* ---------- training records: the write side ----------
   The matrix and gaps above are computed; these are the rows behind
   them. One POST covers a whole training session (one document, one
   date, one sign-off sheet, many people) as well as a single entry -
   `users` is just a one-element list in that case. */

const TRAINING_EVIDENCE_EXT = [".pdf", ".xlsx", ".xls", ".docx", ".doc", ".csv"];

masterdata.get("/training", async (request, response, next) => {
    try {
        const result = await query(`
            select tr.id,
                   u.initials  as user_initials,
                   u.full_name as user_name,
                   d.doc_number,
                   d.title     as doc_title,
                   tr.revision_trained,
                   d.current_revision,
                   tr.trained_on,
                   tr.next_review,
                   tb.full_name as trained_by_name,
                   (tr.evidence_path is not null) as has_evidence,
                   (tr.revision_trained = d.current_revision) as is_current
              from training_records tr
              join users u     on u.id = tr.user_id
              join documents d on d.id = tr.document_id
         left join users tb    on tb.id = tr.trained_by
             where tr.org_id = $1
             order by tr.trained_on desc, u.full_name
        `, [request.user.org_id]);

        response.json({ count: result.rowCount, records: result.rows });
    } catch (error) {
        next(error);
    }
});

masterdata.get("/training/:id/evidence", async (request, response, next) => {
    try {
        const found = await query(
            "select evidence_path, evidence_filename from training_records where org_id = $1 and id = $2",
            [request.user.org_id, request.params.id]
        );
        if (found.rowCount === 0 || !found.rows[0].evidence_path) {
            return response.status(404).json({ error: "No evidence on that training record" });
        }

        const { evidence_path, evidence_filename } = found.rows[0];
        const buffer = await readUploadedFile(evidence_path);
        const isPdf = (evidence_filename || "").toLowerCase().endsWith(".pdf");

        response.setHeader("Content-Type", isPdf ? "application/pdf" : "application/octet-stream");
        response.setHeader(
            "Content-Disposition",
            (isPdf ? "inline" : "attachment") + "; filename=\"" + (evidence_filename || "evidence") + "\""
        );
        response.send(buffer);
    } catch (error) {
        next(error);
    }
});

masterdata.get("/training/:id", async (request, response, next) => {
    try {
        const result = await query(`
            select tr.id,
                   u.initials  as user_initials,
                   u.full_name as user_name,
                   d.doc_number,
                   d.title     as doc_title,
                   tr.revision_trained,
                   d.current_revision,
                   tr.trained_on,
                   tr.next_review,
                   tr.notes,
                   tb.initials  as trained_by_initials,
                   tb.full_name as trained_by_name,
                   tr.evidence_filename,
                   (tr.evidence_path is not null) as has_evidence
              from training_records tr
              join users u     on u.id = tr.user_id
              join documents d on d.id = tr.document_id
         left join users tb    on tb.id = tr.trained_by
             where tr.org_id = $1 and tr.id = $2
        `, [request.user.org_id, request.params.id]);

        if (result.rowCount === 0) return response.status(404).json({ error: "No such training record" });
        response.json(result.rows[0]);
    } catch (error) {
        next(error);
    }
});

masterdata.post("/training", requirePermission("training.record"),
    upload.single("evidence"), async (request, response, next) => {
    try {
        const body = request.body || {};
        const docNumber = (body.document || "").trim();
        const revisionTrained = (body.revision_trained || "").trim();
        const trainedOn = body.trained_on || null;
        const nextReview = body.next_review || null;

        let people;
        try { people = JSON.parse(body.users || "[]"); } catch { people = []; }
        people = (Array.isArray(people) ? people : [])
            .map((initials) => String(initials).trim().toUpperCase())
            .filter(Boolean);

        if (!docNumber || !revisionTrained) {
            return response.status(400).json({ error: "document and revision_trained are required" });
        }
        if (!trainedOn || Number.isNaN(new Date(trainedOn).getTime())) {
            return response.status(400).json({ error: "trained_on is required and must be a valid date" });
        }
        if (nextReview && Number.isNaN(new Date(nextReview).getTime())) {
            return response.status(400).json({ error: "next_review is not a valid date" });
        }
        if (people.length === 0) {
            return response.status(400).json({ error: "Name at least one person who was trained" });
        }

        const doc = await query(
            "select id from documents where org_id = $1 and doc_number = $2",
            [request.user.org_id, docNumber]
        );
        if (doc.rowCount === 0) return response.status(404).json({ error: "No such document: " + docNumber });

        let trainerId = request.user.id;
        if (body.trained_by) {
            const trainer = await query(
                "select id from users where org_id = $1 and upper(initials) = $2",
                [request.user.org_id, String(body.trained_by).trim().toUpperCase()]
            );
            if (trainer.rowCount === 0) return response.status(404).json({ error: "No user with initials " + body.trained_by });
            trainerId = trainer.rows[0].id;
        }

        const found = await query(
            "select id, upper(initials) as initials from users where org_id = $1 and upper(initials) = any($2::text[])",
            [request.user.org_id, people]
        );
        const byInitials = new Map(found.rows.map((r) => [r.initials, r.id]));
        const missing = people.filter((p) => !byInitials.has(p));
        if (missing.length > 0) {
            return response.status(404).json({ error: "Unknown initials: " + missing.join(", ") });
        }

        let evidencePath = null;
        let evidenceFilename = null;
        if (request.file) {
            evidenceFilename = request.file.originalname;
            evidencePath = await saveUploadedFile(
                "training", TRAINING_EVIDENCE_EXT, request.file.originalname, request.file.buffer
            );
        }

        const count = await withTransaction(async (client) => {
            for (const initials of people) {
                const userId = byInitials.get(initials);
                const inserted = await client.query(`
                    insert into training_records
                        (org_id, user_id, document_id, revision_trained, trained_on,
                         next_review, trained_by, evidence_path, evidence_filename, notes)
                    values ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $9, $10)
                    on conflict (user_id, document_id) do update set
                        revision_trained  = excluded.revision_trained,
                        trained_on        = excluded.trained_on,
                        next_review       = excluded.next_review,
                        trained_by        = excluded.trained_by,
                        evidence_path     = excluded.evidence_path,
                        evidence_filename = excluded.evidence_filename,
                        notes             = excluded.notes
                    returning id
                `, [request.user.org_id, userId, doc.rows[0].id, revisionTrained, trainedOn,
                    nextReview, trainerId, evidencePath, evidenceFilename,
                    (body.notes || "").trim() || null]);

                await client.query(`
                    insert into audit_log
                        (org_id, entity, entity_id, field, new_value, changed_by)
                    values ($1, 'training_records', $2, 'recorded', $3, $4)
                `, [request.user.org_id, inserted.rows[0].id,
                    docNumber + " rev " + revisionTrained, request.user.id]);
            }
            return people.length;
        });

        response.status(201).json({ count, document: docNumber, revision: revisionTrained });
    } catch (error) {
        next(error);
    }
});

masterdata.patch("/training/:id", requirePermission("training.record"),
    upload.single("evidence"), async (request, response, next) => {
    try {
        const body = request.body || {};

        const outcome = await withTransaction(async (client) => {
            const found = await client.query(
                "select * from training_records where org_id = $1 and id = $2 for update",
                [request.user.org_id, request.params.id]
            );
            if (found.rowCount === 0) return null;
            const record = found.rows[0];

            const next = {};

            if ("revision_trained" in body) {
                const value = (body.revision_trained || "").trim();
                if (!value) return { badRequest: "revision_trained cannot be empty" };
                next.revision_trained = value;
            }
            for (const key of ["trained_on", "next_review"]) {
                if (!(key in body)) continue;
                const value = body[key] || null;
                if (value && Number.isNaN(new Date(value).getTime())) {
                    return { badRequest: key + " is not a valid date" };
                }
                next[key] = value;
            }
            if ("notes" in body) next.notes = (body.notes || "").trim() || null;
            if ("trained_by" in body) {
                if (!body.trained_by) {
                    next.trained_by = null;
                } else {
                    const trainer = await client.query(
                        "select id from users where org_id = $1 and upper(initials) = $2",
                        [request.user.org_id, String(body.trained_by).trim().toUpperCase()]
                    );
                    if (trainer.rowCount === 0) return { badRequest: "No user with initials " + body.trained_by };
                    next.trained_by = trainer.rows[0].id;
                }
            }
            if (request.file) {
                next.evidence_filename = request.file.originalname;
                next.evidence_path = await saveUploadedFile(
                    "training", TRAINING_EVIDENCE_EXT, request.file.originalname, request.file.buffer
                );
            }

            const keys = Object.keys(next);
            if (keys.length === 0) return { row: { id: record.id, unchanged: true } };

            const setSql = keys.map((key, i) => `${key} = $${i + 2}`).join(", ");
            const result = await client.query(
                `update training_records set ${setSql} where id = $1
                 returning id, revision_trained, trained_on, next_review, notes, evidence_filename`,
                [record.id, ...keys.map((key) => next[key])]
            );

            for (const key of keys) {
                if (key === "evidence_path") continue;
                const before = auditText(record[key]);
                const after = auditText(result.rows[0][key] ?? next[key]);
                if (before === after) continue;
                await client.query(`
                    insert into audit_log
                        (org_id, entity, entity_id, field, old_value, new_value, changed_by)
                    values ($1, 'training_records', $2, $3, $4, $5, $6)
                `, [request.user.org_id, record.id, key, before || null, after || null, request.user.id]);
            }

            return { row: result.rows[0] };
        });

        if (outcome === null) return response.status(404).json({ error: "No such training record" });
        if (outcome.badRequest) return response.status(400).json({ error: outcome.badRequest });
        response.json(outcome.row);
    } catch (error) {
        next(error);
    }
});
