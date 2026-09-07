/* ============================================================
   APQP programs are driven by three controlled documents.

   An APQP program is a `records` row of type apqp with a five-phase
   workflow. What carries the process is the Process Flow Diagram, the
   FMEA and the Control Plan - each a controlled document linked to
   the program (documents.record_id). This router names which document
   fills each slot, lets one be uploaded or linked, and reports
   whether Phase 3 is ready (all three attached).

   The phase move itself still goes through
   POST /api/records/:number/transition; the client only enables the
   advance button once this endpoint says the gate is met.
   ============================================================ */

import { Router } from "express";
import multer from "multer";
import { query, withTransaction } from "../db.js";
import { requirePermission } from "../auth.js";
import { saveDocumentFile } from "../document-storage.js";

export const apqp = Router();

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }
});

const SLOTS = [
    { slot: "process_flow", label: "Process Flow Diagram", prefix: "PFD" },
    { slot: "fmea",         label: "FMEA",                  prefix: "FMEA" },
    { slot: "control_plan", label: "Control Plan",          prefix: "CP" }
];
const SLOT_KEYS = new Set(SLOTS.map((s) => s.slot));

async function apqpRecord(orgId, number) {
    const found = await query(`
        select r.id, r.status
          from records r
          join record_types rt on rt.id = r.record_type_id
         where r.org_id = $1 and r.number = $2 and rt.key = 'apqp'
    `, [orgId, number]);
    return found.rowCount > 0 ? found.rows[0] : null;
}

async function packet(orgId, number, record) {
    const rows = await query(`
        select ad.slot, d.doc_number, d.title, d.current_revision, d.status
          from apqp_deliverables ad
          join documents d on d.id = ad.document_id
         where ad.record_id = $1
    `, [record.id]);
    const bySlot = new Map(rows.rows.map((r) => [r.slot, r]));

    const deliverables = SLOTS.map((s) => {
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

    const missing = deliverables.filter((d) => !d.document).map((d) => d.label);
    return {
        number,
        phase: record.status,
        deliverables,
        gate: { phase3_ready: missing.length === 0, missing }
    };
}

apqp.get("/apqp/:number/deliverables", async (request, response, next) => {
    try {
        const record = await apqpRecord(request.user.org_id, request.params.number);
        if (!record) return response.status(404).json({ error: "No such APQP program" });
        response.json(await packet(request.user.org_id, request.params.number, record));
    } catch (error) {
        next(error);
    }
});

apqp.post("/apqp/:number/deliverables/:slot", requirePermission("apqp.manage"),
    upload.single("file"), async (request, response, next) => {
    try {
        const { number, slot } = request.params;
        if (!SLOT_KEYS.has(slot)) {
            return response.status(400).json({ error: "Unknown deliverable slot" });
        }

        const record = await apqpRecord(request.user.org_id, number);
        if (!record) return response.status(404).json({ error: "No such APQP program" });

        const slotDef = SLOTS.find((s) => s.slot === slot);
        const linkDocNumber = (request.body?.document || "").trim();

        if (!request.file && !linkDocNumber) {
            return response.status(400).json({ error: "Attach a file or name a controlled document" });
        }

        const result = await withTransaction(async (client) => {
            let documentId;

            if (request.file) {
                /* A new controlled document, linked to this program, in
                   the same shape POST /api/documents makes. */
                const base = "APQP-" + number + "-" + slotDef.prefix;
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
                `, [documentId, "APQP deliverable upload", request.user.id,
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
                insert into apqp_deliverables (org_id, record_id, slot, document_id, added_by, added_at)
                values ($1, $2, $3, $4, $5, now())
                on conflict (record_id, slot) do update set
                    document_id = excluded.document_id,
                    added_by    = excluded.added_by,
                    added_at    = now()
            `, [request.user.org_id, record.id, slot, documentId, request.user.id]);

            await client.query(`
                insert into audit_log (org_id, record_id, entity, entity_id, field, new_value, changed_by)
                values ($1, $2, 'apqp_deliverables', $2, $3, $4, $5)
            `, [request.user.org_id, record.id, "attached:" + slot,
                request.file ? request.file.originalname : linkDocNumber, request.user.id]);

            return { ok: true };
        });

        if (result && result.notFound) {
            return response.status(404).json({ error: result.notFound });
        }

        response.status(201).json(await packet(request.user.org_id, number, record));
    } catch (error) {
        next(error);
    }
});

apqp.delete("/apqp/:number/deliverables/:slot", requirePermission("apqp.manage"),
    async (request, response, next) => {
    try {
        const { number, slot } = request.params;
        if (!SLOT_KEYS.has(slot)) {
            return response.status(400).json({ error: "Unknown deliverable slot" });
        }

        const record = await apqpRecord(request.user.org_id, number);
        if (!record) return response.status(404).json({ error: "No such APQP program" });

        const removed = await query(
            "delete from apqp_deliverables where record_id = $1 and slot = $2 returning id",
            [record.id, slot]
        );
        if (removed.rowCount === 0) {
            return response.status(404).json({ error: "Nothing attached to that slot" });
        }

        await query(`
            insert into audit_log (org_id, record_id, entity, entity_id, field, new_value, changed_by)
            values ($1, $2, 'apqp_deliverables', $2, $3, 'removed', $4)
        `, [request.user.org_id, record.id, "removed:" + slot, request.user.id]);

        response.json(await packet(request.user.org_id, number, record));
    } catch (error) {
        next(error);
    }
});
