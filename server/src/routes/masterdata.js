/* ============================================================
   Master data: vendors, gages, documents, parts, lots, training.

   These have a fixed shape, so they get real columns rather than a
   JSONB payload. The interesting endpoints are the last two: lot
   genealogy and the training matrix, where the schema does work
   that would otherwise be application code.
   ============================================================ */

import { Router } from "express";
import { query } from "../db.js";

export const masterdata = Router();

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
                   (next_due < current_date) as disabled
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

/* ---------- vendors ---------- */
masterdata.get("/vendors", async (request, response, next) => {
    try {
        const result = await query(`
            select name, scope, cert_type, cert_expires,
                   otd_pct, ppm, grade, status
              from vendors
             where org_id = $1
             order by case status when 'scar_open' then 0
                                  when 'on_watch'  then 1
                                  else 2 end,
                      name
        `, [request.user.org_id]);

        response.json({ count: result.rowCount, vendors: result.rows });
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
                   last_cal, next_due,
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

/* ---------- documents ---------- */
masterdata.get("/documents", async (request, response, next) => {
    try {
        const result = await query(`
            select d.doc_number, d.title, d.current_revision, d.status,
                   u.full_name as owner,
                   (select count(*) from document_revisions dr
                     where dr.document_id = d.id) as revision_count
              from documents d
         left join users u on u.id = d.owner_id
             where d.org_id = $1
             order by d.doc_number
        `, [request.user.org_id]);

        response.json({ count: result.rowCount, documents: result.rows });
    } catch (error) {
        next(error);
    }
});

masterdata.get("/documents/:docNumber/revisions", async (request, response, next) => {
    try {
        const result = await query(`
            select dr.revision, dr.change_summary, dr.effective_date,
                   author.full_name   as author,
                   approver.full_name as approved_by
              from document_revisions dr
              join documents d          on d.id = dr.document_id
         left join users author         on author.id = dr.author_id
         left join users approver       on approver.id = dr.approved_by
             where d.org_id = $1 and d.doc_number = $2
             order by dr.revision desc
        `, [request.user.org_id, request.params.docNumber]);

        response.json({ count: result.rowCount, revisions: result.rows });
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
            select u.full_name as operator, u.role,
                   json_object_agg(
                       d.doc_number,
                       json_build_object(
                           'trained_revision', tr.revision_trained,
                           'current_revision', d.current_revision,
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
             group by u.id, u.full_name, u.role
             order by u.full_name
        `, [request.user.org_id]);

        response.json({ count: result.rowCount, matrix: result.rows });
    } catch (error) {
        next(error);
    }
});
