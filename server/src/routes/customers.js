/* ============================================================
   Sales & Marketing: the customer master, customer onboarding, and
   each customer's document folder.

   Onboarding is the same feature Vendor Onboarding is for suppliers
   (evaluate.js), reshaped for the sell side: a customer has a fixed
   set of onboarding stages that run in order, and a folder of
   documents - each attached either to a stage or to one of the seven
   numbered folders (01_Admin ... 07_Projects) the onboarding
   automation builds. Completing the last stage flips the customer to
   `active`.

   The automation engine (../customer-automation.js) runs on customer
   creation and every step is also a manual button here.
   ============================================================ */

import { Router } from "express";
import multer from "multer";
import { query, withTransaction } from "../db.js";
import { requirePermission } from "../auth.js";
import { saveUploadedFile, readUploadedFile } from "../file-storage.js";
import { log } from "../logger.js";
import {
    runFull, runStep, AUTOMATION_STEPS, FOLDERS
} from "../customer-automation.js";

export const customers = Router();

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }
});

const DOC_EXT = [".pdf", ".xlsx", ".xls", ".docx", ".doc", ".csv", ".png", ".jpg", ".jpeg"];

const FOLDER_KEYS = FOLDERS.map((f) => f.key);

/* Resolve a customer id inside the caller's org, or null. */
async function findCustomer(orgId, id) {
    const r = await query("select id from customers where org_id = $1 and id = $2", [orgId, id]);
    return r.rowCount === 0 ? null : r.rows[0].id;
}

/* The latest automation_logs row per step, for the status panel. */
async function automationSummary(customerId) {
    const r = await query(`
        select distinct on (step)
               step, status, run_source, detail, error, started_at, finished_at, created_at
          from automation_logs
         where customer_id = $1
         order by step, created_at desc
    `, [customerId]);
    const byStep = Object.fromEntries(r.rows.map((row) => [row.step, row]));
    return {
        steps: AUTOMATION_STEPS.map((step) => byStep[step] || { step, status: "pending" }),
        last_run: r.rows.reduce((max, row) =>
            !max || row.created_at > max ? row.created_at : max, null)
    };
}

/* Every customer gets these onboarding stages at creation, in order. */
const DEFAULT_STAGES = [
    { key: "nda_terms",     name: "NDA & terms of business",        detail: "Mutual NDA and agreed commercial terms on file." },
    { key: "requirements",  name: "Requirements & specifications",   detail: "Customer drawings, specs and quality requirements captured." },
    { key: "quotation",     name: "Quotation issued",               detail: "Priced quote sent and acknowledged." },
    { key: "sample_fai",    name: "Sample / first article approval", detail: "Samples submitted and signed off by the customer." },
    { key: "ppap",          name: "PPAP / part approval",           detail: "Full submission approved where the customer requires it." },
    { key: "account_setup", name: "Account & portal setup",         detail: "Payment terms, portal access and shipping accounts set up." }
];

/* ---------- list ---------- */

customers.get("/customers", requirePermission("customer.read"),
    async (request, response, next) => {
        try {
            const result = await query(`
                select c.id, c.name, c.code, c.status,
                       c.primary_contact_name, c.primary_contact_email,
                       count(s.id)::int as stages,
                       count(s.id) filter (where s.status = 'complete')::int as complete
                  from customers c
             left join customer_onboarding_stages s on s.customer_id = c.id
                 where c.org_id = $1
                 group by c.id
                 order by c.name
            `, [request.user.org_id]);
            response.json({ count: result.rowCount, customers: result.rows });
        } catch (error) {
            next(error);
        }
    });

/* ---------- create ---------- */

customers.post("/customers", requirePermission("customer.manage"),
    async (request, response, next) => {
        try {
            const name = String(request.body?.name || "").trim();
            if (!name) return response.status(400).json({ error: "A customer name is required" });

            const code = String(request.body?.code || "").trim() || null;
            const created = await withTransaction(async (client) => {
                const dup = await client.query(
                    "select 1 from customers where org_id = $1 and lower(name) = lower($2)",
                    [request.user.org_id, name]
                );
                if (dup.rowCount > 0) return { conflict: "A customer called \"" + name + "\" already exists" };

                const row = await client.query(`
                    insert into customers
                        (org_id, name, code, primary_contact_name, primary_contact_email,
                         phone, address, notes, created_by)
                    values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    returning id
                `, [
                    request.user.org_id, name, code,
                    String(request.body?.primary_contact_name || "").trim() || null,
                    String(request.body?.primary_contact_email || "").trim() || null,
                    String(request.body?.phone || "").trim() || null,
                    String(request.body?.address || "").trim() || null,
                    String(request.body?.notes || "").trim() || null,
                    request.user.id
                ]);
                const customerId = row.rows[0].id;

                for (let i = 0; i < DEFAULT_STAGES.length; i++) {
                    const stage = DEFAULT_STAGES[i];
                    await client.query(`
                        insert into customer_onboarding_stages
                            (customer_id, stage_key, name, detail, position)
                        values ($1, $2, $3, $4, $5)
                    `, [customerId, stage.key, stage.name, stage.detail, i]);
                }

                await client.query(`
                    insert into audit_log (org_id, entity, entity_id, field, new_value, changed_by)
                    values ($1, 'customers', $2, 'created', $3, $4)
                `, [request.user.org_id, customerId, name, request.user.id]);

                return { id: customerId };
            });

            if (created.conflict) return response.status(409).json({ error: created.conflict });

            /* Fire the onboarding automation. Continue-on-failure and
               fully detached from the create: a thrown step is already
               logged to automation_logs, and the customer stands
               regardless. The user re-runs a failed step from its
               button on the folder page. */
            let automation = null;
            try {
                automation = await runFull(
                    request.user.org_id, created.id, request.user.id, { source: "auto" }
                );
            } catch (autoError) {
                log.error("customer_automation_run_failed",
                    { customerId: created.id, error: autoError.message });
            }

            response.status(201).json({ id: created.id, name, automation });
        } catch (error) {
            next(error);
        }
    });

/* ---------- the folder: profile + stages + document library ---------- */

customers.get("/customers/:id", requirePermission("customer.read"),
    async (request, response, next) => {
        try {
            const customer = await query(`
                select id, name, code, status, primary_contact_name,
                       primary_contact_email, phone, address, notes, created_at
                  from customers where org_id = $1 and id = $2
            `, [request.user.org_id, request.params.id]);
            if (customer.rowCount === 0) return response.status(404).json({ error: "No such customer" });

            const stages = await query(`
                select s.id, s.stage_key, s.name, s.detail, s.status, s.position,
                       s.completed_at, u.full_name as completed_by
                  from customer_onboarding_stages s
             left join users u on u.id = s.completed_by
                 where s.customer_id = $1
                 order by s.position
            `, [request.params.id]);

            const folderRows = await query(`
                select id, folder_key, name, position, status, path
                  from customer_folders
                 where customer_id = $1
                 order by position
            `, [request.params.id]);

            const docs = await query(`
                select cd.id, cd.stage_id, cd.folder_id, cd.kind, cd.note, cd.uploaded_at,
                       cd.original_filename, cd.mime_type, cd.size_bytes,
                       up.full_name as uploaded_by,
                       d.doc_number, d.title as doc_title, d.current_revision
                  from customer_documents cd
             left join users up    on up.id = cd.uploaded_by
             left join documents d on d.id = cd.document_id
                 where cd.customer_id = $1
                 order by cd.uploaded_at
            `, [request.params.id]);

            const byStage = new Map();
            const byFolder = new Map();
            for (const row of docs.rows) {
                const doc = {
                    id: row.id, kind: row.kind, note: row.note,
                    uploaded_by: row.uploaded_by, uploaded_at: row.uploaded_at,
                    original_filename: row.original_filename, mime_type: row.mime_type,
                    size_bytes: row.size_bytes, doc_number: row.doc_number,
                    doc_title: row.doc_title, current_revision: row.current_revision
                };
                if (row.stage_id) {
                    if (!byStage.has(row.stage_id)) byStage.set(row.stage_id, []);
                    byStage.get(row.stage_id).push(doc);
                } else if (row.folder_id) {
                    if (!byFolder.has(row.folder_id)) byFolder.set(row.folder_id, []);
                    byFolder.get(row.folder_id).push(doc);
                }
            }

            const metadata = await query(`
                select billing_address, shipping_address, contacts,
                       quality_requirements, engineering_requirements, folder_root, synced_at
                  from customer_metadata where customer_id = $1
            `, [request.params.id]);

            response.json({
                customer: customer.rows[0],
                can_manage: request.can("customer.manage"),
                can_onboard: request.can("customer.onboard"),
                stages: stages.rows.map((stage) => ({
                    ...stage,
                    documents: byStage.get(stage.id) || []
                })),
                folders: folderRows.rows.map((folder) => ({
                    ...folder,
                    documents: byFolder.get(folder.id) || []
                })),
                metadata: metadata.rows[0] || null,
                automation: await automationSummary(request.params.id)
            });
        } catch (error) {
            next(error);
        }
    });

/* ---------- edit profile / status ---------- */

customers.patch("/customers/:id", requirePermission("customer.manage"),
    async (request, response, next) => {
        try {
            const fields = ["name", "code", "status", "primary_contact_name",
                "primary_contact_email", "phone", "address", "notes"];
            const sets = [];
            const values = [request.user.org_id, request.params.id];
            for (const field of fields) {
                if (!Object.prototype.hasOwnProperty.call(request.body || {}, field)) continue;
                let value = request.body[field];
                if (typeof value === "string") value = value.trim() || null;
                if (field === "status" && value && !["prospect", "active", "inactive"].includes(value)) {
                    return response.status(400).json({ error: "Unknown status " + value });
                }
                values.push(value);
                sets.push(field + " = $" + values.length);
            }
            if (sets.length === 0) return response.status(400).json({ error: "Nothing to update" });

            const updated = await query(`
                update customers set ${sets.join(", ")}, updated_at = now()
                 where org_id = $1 and id = $2
                returning id
            `, values);
            if (updated.rowCount === 0) return response.status(404).json({ error: "No such customer" });
            response.json({ id: updated.rows[0].id });
        } catch (error) {
            next(error);
        }
    });

/* ---------- complete an onboarding stage ---------- */

customers.post("/customers/:id/stages/:stageKey/complete",
    requirePermission("customer.onboard"),
    async (request, response, next) => {
        try {
            const result = await withTransaction(async (client) => {
                const found = await client.query(`
                    select s.id, s.status, s.name, s.position, c.id as customer_id
                      from customer_onboarding_stages s
                      join customers c on c.id = s.customer_id
                     where c.org_id = $1 and c.id = $2 and s.stage_key = $3
                       for update of s
                `, [request.user.org_id, request.params.id, request.params.stageKey]);

                if (found.rowCount === 0) return null;
                const stage = found.rows[0];
                if (stage.status === "complete") return { conflict: "That stage is already complete" };

                const earlier = await client.query(`
                    select name from customer_onboarding_stages
                     where customer_id = $1 and status <> 'complete' and position < $2
                     order by position limit 1
                `, [stage.customer_id, stage.position]);
                if (earlier.rowCount > 0) {
                    return { conflict: "Complete " + earlier.rows[0].name + " first" };
                }

                await client.query(`
                    update customer_onboarding_stages
                       set status = 'complete', completed_by = $2, completed_at = now()
                     where id = $1
                `, [stage.id, request.user.id]);

                const remaining = await client.query(`
                    select count(*)::int as n from customer_onboarding_stages
                     where customer_id = $1 and status <> 'complete'
                `, [stage.customer_id]);

                let activated = false;
                if (remaining.rows[0].n === 0) {
                    await client.query(
                        "update customers set status = 'active', updated_at = now() where id = $1",
                        [stage.customer_id]
                    );
                    activated = true;
                }

                await client.query(`
                    insert into audit_log
                        (org_id, entity, entity_id, field, old_value, new_value, reason, changed_by)
                    values ($1, 'customer_onboarding', $2, $3, $4, 'complete', $5, $6)
                `, [request.user.org_id, stage.customer_id, request.params.stageKey,
                    stage.status, request.body?.reason || null, request.user.id]);

                return { stage: request.params.stageKey, activated };
            });

            if (!result) return response.status(404).json({ error: "No such customer or stage" });
            if (result.conflict) return response.status(409).json({ error: result.conflict });
            response.json(result);
        } catch (error) {
            next(error);
        }
    });

/* ---------- add a document (to a stage or a library category) ---------- */

customers.post("/customers/:id/documents", requirePermission("customer.manage"),
    upload.single("file"), async (request, response, next) => {
        try {
            const note = String(request.body?.note || "").trim() || null;
            const docNumber = String(request.body?.document || "").trim();
            const stageKey = String(request.body?.stage_key || "").trim();
            const folderKey = String(request.body?.folder_key || "").trim();

            if (!!stageKey === !!folderKey) {
                return response.status(400).json({ error: "Give exactly one of stage_key or folder_key" });
            }
            if (folderKey && !FOLDER_KEYS.includes(folderKey)) {
                return response.status(400).json({ error: "Unknown folder " + folderKey });
            }
            if (!request.file && !docNumber) {
                return response.status(400).json({ error: "Attach a file or name a controlled document" });
            }

            const customerId = await findCustomer(request.user.org_id, request.params.id);
            if (!customerId) return response.status(404).json({ error: "No such customer" });

            let stageId = null;
            if (stageKey) {
                const stage = await query(
                    "select id from customer_onboarding_stages where customer_id = $1 and stage_key = $2",
                    [request.params.id, stageKey]
                );
                if (stage.rowCount === 0) return response.status(404).json({ error: "No such stage" });
                stageId = stage.rows[0].id;
            }

            let folderId = null;
            if (folderKey) {
                const folder = await query(
                    "select id from customer_folders where customer_id = $1 and folder_key = $2",
                    [request.params.id, folderKey]
                );
                if (folder.rowCount === 0) {
                    return response.status(404).json({
                        error: "That folder does not exist yet - run Create folders first"
                    });
                }
                folderId = folder.rows[0].id;
            }

            let linkedDocId = null;
            if (!request.file) {
                const doc = await query(
                    "select id from documents where org_id = $1 and doc_number = $2",
                    [request.user.org_id, docNumber]
                );
                if (doc.rowCount === 0) {
                    return response.status(404).json({ error: "No controlled document " + docNumber });
                }
                linkedDocId = doc.rows[0].id;
            }

            let storagePath = null, filename = null, mime = null, size = null;
            if (request.file) {
                filename = request.file.originalname;
                mime = request.file.mimetype;
                size = request.file.size;
                storagePath = await saveUploadedFile(
                    "customer-docs", DOC_EXT, request.file.originalname, request.file.buffer
                );
            }

            const inserted = await withTransaction(async (client) => {
                const row = await client.query(`
                    insert into customer_documents
                        (org_id, customer_id, stage_id, folder_id, kind, original_filename,
                         mime_type, size_bytes, storage_path, document_id, note, uploaded_by)
                    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                    returning id, kind
                `, [request.user.org_id, request.params.id, stageId, folderId,
                    request.file ? "upload" : "link",
                    filename, mime, size, storagePath, linkedDocId, note, request.user.id]);

                await client.query(`
                    insert into audit_log (org_id, entity, entity_id, field, new_value, changed_by)
                    values ($1, 'customer_documents', $2, 'attached', $3, $4)
                `, [request.user.org_id, row.rows[0].id,
                    request.file ? filename : ("link:" + docNumber), request.user.id]);

                return row.rows[0];
            });

            response.status(201).json(inserted);
        } catch (error) {
            next(error);
        }
    });

customers.delete("/customers/:id/documents/:docId", requirePermission("customer.manage"),
    async (request, response, next) => {
        try {
            const removed = await query(`
                delete from customer_documents cd using customers c
                 where cd.customer_id = c.id and c.org_id = $1 and c.id = $2 and cd.id = $3
                returning cd.id
            `, [request.user.org_id, request.params.id, request.params.docId]);
            if (removed.rowCount === 0) return response.status(404).json({ error: "No such document" });

            await query(`
                insert into audit_log (org_id, entity, entity_id, field, new_value, changed_by)
                values ($1, 'customer_documents', $2, 'removed', 'removed', $3)
            `, [request.user.org_id, request.params.docId, request.user.id]);

            response.json({ removed: request.params.docId });
        } catch (error) {
            next(error);
        }
    });

customers.get("/customers/:id/documents/:docId/download", requirePermission("customer.read"),
    async (request, response, next) => {
        try {
            const found = await query(`
                select cd.kind, cd.storage_path, cd.original_filename, cd.mime_type,
                       d.doc_number, d.current_revision
                  from customer_documents cd
                  join customers c on c.id = cd.customer_id
             left join documents d on d.id = cd.document_id
                 where c.org_id = $1 and c.id = $2 and cd.id = $3
            `, [request.user.org_id, request.params.id, request.params.docId]);

            if (found.rowCount === 0) return response.status(404).json({ error: "No such document" });
            const doc = found.rows[0];

            if (doc.kind === "link") {
                if (!doc.doc_number) return response.status(404).json({ error: "The linked document is gone" });
                return response.redirect(
                    "/api/documents/" + encodeURIComponent(doc.doc_number) + "/revisions/current/download"
                );
            }
            if (!doc.storage_path) return response.status(404).json({ error: "No file on that document" });

            const buffer = await readUploadedFile(doc.storage_path);
            const inline = (doc.mime_type || "").startsWith("application/pdf")
                || (doc.mime_type || "").startsWith("image/");
            response.setHeader("Content-Type", doc.mime_type || "application/octet-stream");
            response.setHeader("Content-Disposition",
                (inline ? "inline" : "attachment") + "; filename=\"" + (doc.original_filename || "document") + "\"");
            response.send(buffer);
        } catch (error) {
            next(error);
        }
    });

/* ---------- onboarding automation: manual (re-)runs ---------- */

/* Run the whole sequence again. Idempotent; ?force / { force:true }
   also rewrites the two profiles. */
customers.post("/customers/:id/run-full-automation", requirePermission("customer.manage"),
    async (request, response, next) => {
        try {
            const customerId = await findCustomer(request.user.org_id, request.params.id);
            if (!customerId) return response.status(404).json({ error: "No such customer" });

            const force = request.body?.force === true || request.query.force === "true";
            const result = await runFull(
                request.user.org_id, customerId, request.user.id, { source: "manual", force }
            );
            response.json(result);
        } catch (error) {
            next(error);
        }
    });

/* One step at a time. sync-metadata bundles the three data steps so a
   single button refreshes the snapshot and both profiles. */
function stepRoute(pathSuffix, steps) {
    customers.post("/customers/:id/" + pathSuffix, requirePermission("customer.manage"),
        async (request, response, next) => {
            try {
                const customerId = await findCustomer(request.user.org_id, request.params.id);
                if (!customerId) return response.status(404).json({ error: "No such customer" });

                const force = request.body?.force === true || request.query.force === "true";
                const out = [];
                for (const step of steps) {
                    out.push(await runStep(
                        request.user.org_id, customerId, request.user.id,
                        step, { source: "manual", force }
                    ));
                }
                response.json({ steps: out });
            } catch (error) {
                next(error);
            }
        });
}

stepRoute("create-folders", ["folders"]);
stepRoute("sync-metadata", ["metadata", "quality", "engineering"]);
stepRoute("generate-starter-docs", ["starter_docs"]);

/* The full append-only trail for the status panel. */
customers.get("/customers/:id/automation-logs", requirePermission("customer.read"),
    async (request, response, next) => {
        try {
            const customerId = await findCustomer(request.user.org_id, request.params.id);
            if (!customerId) return response.status(404).json({ error: "No such customer" });

            const logs = await query(`
                select step, status, run_source, detail, error,
                       started_at, finished_at, created_at
                  from automation_logs
                 where customer_id = $1
                 order by created_at desc
                 limit 200
            `, [customerId]);
            response.json({ count: logs.rowCount, logs: logs.rows });
        } catch (error) {
            next(error);
        }
    });
