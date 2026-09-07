/* ============================================================
   Discrepancy Investigation - the bridge from an audit finding to
   the corrective forms.

   A DI is a `records` row of type di with a four-state workflow
   (open -> investigating -> awaiting form closure -> closed). It is
   raised from an internal audit that turned up a discrepancy, and it
   carries the three completed forms the finding requires - the NCR
   form, the 8D report, the CAPA form - each a controlled document in
   a named slot (di_deliverables), the same shape APQP carries its
   Process Flow / FMEA / Control Plan.

   The forms are the ones already in Document Control: filled out,
   uploaded here, or linked by document number. This router raises the
   DI (and links it to its audit), fills and clears the slots, and
   reports whether all three are attached. The two closure gates - a
   DI needs all three forms before it can close, an audit needs its DI
   closed before it can close - live in POST /api/records/:number/transition.
   ============================================================ */

import { Router } from "express";
import multer from "multer";
import { query, withTransaction } from "../db.js";
import { requirePermission } from "../auth.js";
import { saveDocumentFile } from "../document-storage.js";

export const di = Router();

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }
});

const SLOTS = [
    { slot: "ncr",    label: "NCR form",   prefix: "NCR" },
    { slot: "eightd", label: "8D report",  prefix: "8D" },
    { slot: "capa",   label: "CAPA form",  prefix: "CAPA" }
];
const SLOT_KEYS = new Set(SLOTS.map((s) => s.slot));

async function diRecord(orgId, number) {
    const found = await query(`
        select r.id, r.status, r.record_type_id
          from records r
          join record_types rt on rt.id = r.record_type_id
         where r.org_id = $1 and r.number = $2 and rt.key = 'di'
    `, [orgId, number]);
    return found.rowCount > 0 ? found.rows[0] : null;
}

async function auditRecord(orgId, number) {
    const found = await query(`
        select r.id, r.status
          from records r
          join record_types rt on rt.id = r.record_type_id
         where r.org_id = $1 and r.number = $2 and rt.key = 'audit'
    `, [orgId, number]);
    return found.rowCount > 0 ? found.rows[0] : null;
}

/* The three slots plus the gate. */
async function packet(number, record) {
    const rows = await query(`
        select dd.slot, d.doc_number, d.title, d.current_revision, d.status
          from di_deliverables dd
          join documents d on d.id = dd.document_id
         where dd.record_id = $1
    `, [record.id]);
    const bySlot = new Map(rows.rows.map((r) => [r.slot, r]));

    const forms = SLOTS.map((s) => {
        const row = bySlot.get(s.slot);
        return {
            slot: s.slot,
            label: s.label,
            document: row
                ? {
                    doc_number: row.doc_number,
                    title: row.title,
                    current_revision: row.current_revision,
                    status: row.status,
                    has_released: Boolean(row.current_revision)
                }
                : null
        };
    });

    const missing = forms.filter((f) => !f.document).map((f) => f.label);
    return {
        number,
        di_status: record.status,
        forms,
        gate: { all_attached: missing.length === 0, missing }
    };
}

/* ---------- raise a DI from an audit ---------- */

di.post("/di", requirePermission("di.manage"), async (request, response, next) => {
    try {
        const auditNumber = (request.body?.audit_number || "").trim();
        if (!auditNumber) {
            return response.status(400).json({ error: "audit_number is required" });
        }

        const audit = await auditRecord(request.user.org_id, auditNumber);
        if (!audit) return response.status(404).json({ error: "No such audit " + auditNumber });

        const department = (request.body?.department || "").trim();
        const finding = (request.body?.finding || "").trim();
        if (!department || !finding) {
            return response.status(422).json({
                error: "Required fields missing",
                fields: [!department && "department", !finding && "finding"].filter(Boolean)
            });
        }

        const result = await withTransaction(async (client) => {
            /* One DI per audit. */
            const existing = await client.query(`
                select r.number
                  from record_links l
                  join records r        on r.id = l.to_record_id
                  join record_types rt  on rt.id = r.record_type_id
                 where l.from_record_id = $1 and l.link_type = 'child_of' and rt.key = 'di'
            `, [audit.id]);
            if (existing.rowCount > 0) {
                return { conflict: "That audit already has a DI: " + existing.rows[0].number };
            }

            const typeRow = await client.query(
                "select id, prefix from record_types where org_id = $1 and key = 'di'",
                [request.user.org_id]
            );
            const recordType = typeRow.rows[0];

            const year = new Date().getFullYear();
            const last = await client.query(`
                select number from records
                 where org_id = $1 and record_type_id = $2 and number like $3
                 order by number desc limit 1
            `, [request.user.org_id, recordType.id, recordType.prefix + "-" + year + "-%"]);
            const nextSeq = last.rowCount === 0
                ? 1
                : Number(last.rows[0].number.split("-").pop()) + 1;
            const number = recordType.prefix + "-" + year + "-" + String(nextSeq).padStart(4, "0");

            const firstState = await client.query(
                "select key from workflow_states where record_type_id = $1 order by position limit 1",
                [recordType.id]
            );

            const data = {
                department,
                finding,
                investigator: (request.body?.investigator || "").trim() || undefined,
                root_cause: (request.body?.root_cause || "").trim() || undefined,
                containment: (request.body?.containment || "").trim() || undefined,
                corrective_plan: (request.body?.corrective_plan || "").trim() || undefined
            };

            const inserted = await client.query(`
                insert into records
                    (org_id, record_type_id, number, title, status, severity, data, form_version, created_by)
                values ($1, $2, $3, $4, $5, 'warn', $6, 1, $7)
                returning id, number, status
            `, [request.user.org_id, recordType.id, number,
                "Discrepancy from " + auditNumber, firstState.rows[0].key, data, request.user.id]);
            const diId = inserted.rows[0].id;

            await client.query(`
                insert into record_links (from_record_id, to_record_id, link_type)
                values ($1, $2, 'child_of')
            `, [audit.id, diId]);

            await client.query(`
                insert into audit_log (org_id, record_id, entity, entity_id, field, new_value, changed_by)
                values ($1, $2, 'records', $2, 'created', $3, $4),
                       ($1, $5, 'record_links', $2, 'di_raised', $3, $4)
            `, [request.user.org_id, diId, number, request.user.id, audit.id]);

            return { row: inserted.rows[0] };
        });

        if (result.conflict) return response.status(409).json({ error: result.conflict });
        response.status(201).json(result.row);
    } catch (error) {
        next(error);
    }
});

/* ---------- form slots ---------- */

di.get("/di/:number/forms", async (request, response, next) => {
    try {
        const record = await diRecord(request.user.org_id, request.params.number);
        if (!record) return response.status(404).json({ error: "No such DI" });
        response.json(await packet(request.params.number, record));
    } catch (error) {
        next(error);
    }
});

di.post("/di/:number/forms/:slot", requirePermission("di.manage"),
    upload.single("file"), async (request, response, next) => {
    try {
        const { number, slot } = request.params;
        if (!SLOT_KEYS.has(slot)) {
            return response.status(400).json({ error: "Unknown form slot" });
        }

        const record = await diRecord(request.user.org_id, number);
        if (!record) return response.status(404).json({ error: "No such DI" });

        const slotDef = SLOTS.find((s) => s.slot === slot);
        const linkDocNumber = (request.body?.document || "").trim();

        if (!request.file && !linkDocNumber) {
            return response.status(400).json({ error: "Attach a file or name a controlled document" });
        }

        const result = await withTransaction(async (client) => {
            let documentId;

            if (request.file) {
                /* The completed form becomes a controlled document
                   linked to this DI, in the same shape POST /api/documents
                   makes. */
                const base = "DI-" + number + "-" + slotDef.prefix;
                const taken = await client.query(
                    "select doc_number from documents where org_id = $1 and doc_number like $2",
                    [request.user.org_id, base + "%"]
                );
                const docNumber = taken.rowCount === 0 ? base : base + "-r" + (taken.rowCount + 1);
                const storagePath = await saveDocumentFile(request.file.originalname, request.file.buffer);

                const doc = await client.query(`
                    insert into documents (org_id, doc_number, title, owner_id, record_id)
                    values ($1, $2, $3, $4, $5)
                    returning id
                `, [request.user.org_id, docNumber, slotDef.label + " - " + number,
                    request.user.id, record.id]);
                documentId = doc.rows[0].id;

                await client.query(`
                    insert into document_revisions
                        (document_id, revision, change_summary, author_id,
                         original_filename, mime_type, size_bytes, storage_path)
                    values ($1, 'A', $2, $3, $4, $5, $6, $7)
                `, [documentId, "DI form upload", request.user.id,
                    request.file.originalname, request.file.mimetype, request.file.size, storagePath]);
            } else {
                const doc = await client.query(
                    "select id from documents where org_id = $1 and doc_number = $2",
                    [request.user.org_id, linkDocNumber]
                );
                if (doc.rowCount === 0) {
                    return { notFound: "No controlled document " + linkDocNumber };
                }
                documentId = doc.rows[0].id;
                await client.query(
                    "update documents set record_id = $2 where id = $1",
                    [documentId, record.id]
                );
            }

            await client.query(`
                insert into di_deliverables (org_id, record_id, slot, document_id, added_by, added_at)
                values ($1, $2, $3, $4, $5, now())
                on conflict (record_id, slot) do update set
                    document_id = excluded.document_id,
                    added_by    = excluded.added_by,
                    added_at    = now()
            `, [request.user.org_id, record.id, slot, documentId, request.user.id]);

            await client.query(`
                insert into audit_log (org_id, record_id, entity, entity_id, field, new_value, changed_by)
                values ($1, $2, 'di_deliverables', $2, $3, $4, $5)
            `, [request.user.org_id, record.id, "attached:" + slot,
                request.file ? request.file.originalname : linkDocNumber, request.user.id]);

            return { ok: true };
        });

        if (result && result.notFound) {
            return response.status(404).json({ error: result.notFound });
        }

        response.status(201).json(await packet(number, record));
    } catch (error) {
        next(error);
    }
});

di.delete("/di/:number/forms/:slot", requirePermission("di.manage"),
    async (request, response, next) => {
    try {
        const { number, slot } = request.params;
        if (!SLOT_KEYS.has(slot)) {
            return response.status(400).json({ error: "Unknown form slot" });
        }

        const record = await diRecord(request.user.org_id, number);
        if (!record) return response.status(404).json({ error: "No such DI" });

        const removed = await query(
            "delete from di_deliverables where record_id = $1 and slot = $2 returning id",
            [record.id, slot]
        );
        if (removed.rowCount === 0) {
            return response.status(404).json({ error: "Nothing attached to that slot" });
        }

        await query(`
            insert into audit_log (org_id, record_id, entity, entity_id, field, new_value, changed_by)
            values ($1, $2, 'di_deliverables', $2, $3, 'removed', $4)
        `, [request.user.org_id, record.id, "removed:" + slot, request.user.id]);

        response.json(await packet(number, record));
    } catch (error) {
        next(error);
    }
});
