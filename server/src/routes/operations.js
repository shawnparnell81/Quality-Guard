/* ============================================================
   Receiving inspection and shipping.

   Clause 8.4.2 on the way in, clause 8.6 on the way out. Both are
   the same shape: a header, a set of checks, and a decision that
   somebody with the right authority signs.
   ============================================================ */

import { Router } from "express";
import { query, withTransaction } from "../db.js";
import { requirePermission } from "../auth.js";
import { upload } from "../uploads.js";
import { saveUploadedFile, readUploadedFile } from "../file-storage.js";
import { scoredVendors, samplePlanForGrade, receivingSamplePlan } from "../vendor-scoring.js";

export const operations = Router();

/* ============================================================
   Receiving
   ============================================================ */

/* The rich part of an incoming inspection lives in receipts.data,
   the same shape records.data uses. These are the keys the form
   writes; anything not listed is dropped on the way in so a client
   cannot stuff the column with arbitrary fields. Split by the six
   sections of the form. */
const RECEIPT_DATA_KEYS = new Set([
    // 1. shipment identification
    "supplier_name", "packing_slip_number", "carrier", "received_date",
    "po_number", "part_number", "part_description",
    // 2. material details
    "lot_number", "manufacturer", "country_of_origin", "qty_received",
    "unit_of_measure", "expiration_date_present", "expiration_date",
    // 3. visual / packaging
    "packaging_condition", "labelling_correct", "quantity_matches_packing_slip",
    "material_matches_po", "visual_defects", "visual_notes",
    // 4. dimensional / physical
    "dimension_check_required", "dimensions", "weight_check_required",
    "weight_expected", "weight_actual", "physical_notes",
    // 5. documentation
    "cert_of_conformance_received", "material_cert_received", "rohs_reach_received",
    "test_report_received", "documentation_notes",
    // 6. disposition (written by the disposition route, listed so a
    //    draft can carry a proposed result)
    "inspection_result", "rejection_reason", "requires_ncr", "requires_quarantine"
]);

/* Photos of the shipment - damage, labelling, the packing slip.
   Not controlled documents, so they ride in file-storage under
   storage/receipts. */
const RECEIPT_PHOTO_EXTENSIONS = new Set([
    ".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp", ".heic"
]);
const INLINE_PHOTO_MIME = new Set([
    "application/pdf", "image/png", "image/jpeg", "image/tiff", "image/webp"
]);

/* Keep only the keys the form owns, and only when they carry a
   value. undefined/"" clears nothing (the merge below is additive);
   an explicit null is how the client removes a key. */
function cleanReceiptData(input) {
    const out = {};
    if (!input || typeof input !== "object") return out;
    for (const [key, value] of Object.entries(input)) {
        if (!RECEIPT_DATA_KEYS.has(key)) continue;
        if (value === undefined) continue;
        out[key] = value;
    }
    return out;
}

/* sample_plan and vendor_grade are overridden below with the live
   computed grade (vendor-scoring.js), not read straight off the row -
   the schema comment on receipts.sample_plan always said the plan
   should follow the vendor's real grade; this is that rule, made
   real instead of a static string set once at seed time. */
operations.get("/receipts", async (request, response, next) => {
    try {
        const [result, vendors] = await Promise.all([
            query(`
                select r.receipt_number, r.po_number, r.part_number, r.qty_received,
                       r.received_at, r.status, r.notes, r.data, r.quarantined, r.ncr_number,
                       v.name as vendor,
                       u.full_name as inspected_by, r.inspected_at,
                       (select count(*)::int from receipt_measurements m
                         where m.receipt_id = r.id) as measurements,
                       (select count(*)::int from receipt_measurements m
                         where m.receipt_id = r.id and m.result = 'fail') as failures
                  from receipts r
             left join vendors v on v.id = r.vendor_id
             left join users u   on u.id = r.inspected_by
                 where r.org_id = $1
                 order by case r.status when 'pending' then 0 when 'reject' then 1 else 2 end,
                          r.received_at desc
            `, [request.user.org_id]),
            scoredVendors(request.user.org_id)
        ]);

        const vendorByName = new Map(vendors.map((v) => [v.name, v]));

        const receipts = result.rows.map((row) => {
            const grade = vendorByName.get(row.vendor)?.grade || null;
            const data = row.data || {};
            const { photos, ...safeData } = data;
            return {
                ...row,
                data: safeData,
                /* A free-text supplier (not on the AVL) still shows in the register. */
                vendor: row.vendor || data.supplier_name || null,
                photo_count: Array.isArray(photos) ? photos.length : 0,
                vendor_grade: grade,
                ...receivingSamplePlan(grade, row.qty_received)
            };
        });

        response.json({ count: receipts.length, receipts });
    } catch (error) {
        next(error);
    }
});

/* POST /api/receipts
   { "po_number": "PO-4471", "vendor": "Halstead Steel",
     "part_number": "RP-4471-A", "qty_received": 340,
     "data": { ...section 1-5 of the inspection form... } }

   Logging that a shipment arrived, distinct from dispositioning it -
   this is the gate the clause actually names: before anything is
   accepted or rejected, the inspection itself has to be set up, sized
   against the vendor's real grade and the quantity actually on the
   dock, not entered from seed data the way every prior receipt in
   this app was.

   `vendor` names a supplier on the AVL - that links the receipt to
   the vendor row and sizes the sample against its live grade. A
   supplier not on the AVL is still a real receipt: pass its name in
   data.supplier_name instead, and the sample falls back to the
   ungraded plan. The rest of the inspection form (packaging, visual,
   documentation) rides in `data`; po_number / part_number /
   qty_received are mirrored to their own columns because the
   register and the sample plan read them directly. */
operations.post("/receipts", requirePermission("receiving.log"), async (request, response, next) => {
    try {
        const body = request.body || {};
        const data = cleanReceiptData(body.data);

        const vendor = (body.vendor || "").trim();
        const supplierName = vendor || (data.supplier_name || "").trim();
        const poNumber = (body.po_number ?? data.po_number ?? "").toString().trim();
        const partNumber = (body.part_number ?? data.part_number ?? "").toString().trim();
        const qty = Number(body.qty_received ?? data.qty_received);
        const notes = body.notes || null;

        if (!supplierName) {
            return response.status(400).json({ error: "A supplier is required (vendor or data.supplier_name)" });
        }
        if (!Number.isFinite(qty) || qty <= 0) {
            return response.status(400).json({ error: "A positive qty_received is required" });
        }

        let vendorRow = null;
        if (vendor) {
            const vendors = await scoredVendors(request.user.org_id);
            vendorRow = vendors.find((v) => v.name === vendor) || null;
            if (!vendorRow) {
                return response.status(400).json({ error: "Unknown vendor: " + vendor });
            }
        }

        const gate = receivingSamplePlan(vendorRow?.grade || null, qty);

        /* Store the resolved facts back into data so the form always
           has the fields it renders, whichever way they arrived. */
        const storedData = {
            ...data,
            supplier_name: supplierName,
            po_number: poNumber || undefined,
            part_number: partNumber || undefined,
            qty_received: qty
        };

        const created = await withTransaction(async (client) => {
            const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
            const pattern = "RCV-" + datePart + "-%";

            /* Sort on the numeric suffix, not the text - "RCV-...-10"
               sorts before "RCV-...-9" as a string, which handed out a
               duplicate number on the tenth receipt of a day. */
            const last = await client.query(`
                select coalesce(
                    max(split_part(receipt_number, '-', 3)::int), 0
                ) as seq
                  from receipts
                 where org_id = $1 and receipt_number like $2
            `, [request.user.org_id, pattern]);

            const nextSeq = last.rows[0].seq + 1;

            const receiptNumber = "RCV-" + datePart + "-" + nextSeq;

            const inserted = await client.query(`
                insert into receipts
                    (org_id, receipt_number, po_number, vendor_id, part_number,
                     qty_received, sample_plan, notes, data)
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                returning id, receipt_number, status, received_at, notes, data,
                          quarantined, ncr_number
            `, [request.user.org_id, receiptNumber, poNumber || null, vendorRow?.id || null,
                partNumber || null, qty, gate.sample_plan, notes, storedData]);

            await client.query(`
                insert into audit_log (org_id, entity, entity_id, field, new_value, changed_by)
                values ($1, 'receipts', $2, 'created', $3, $4)
            `, [request.user.org_id, inserted.rows[0].id, receiptNumber, request.user.id]);

            return inserted.rows[0];
        });

        response.status(201).json({
            ...created,
            vendor: supplierName,
            vendor_grade: vendorRow?.grade || null,
            qty_received: qty,
            ...gate
        });
    } catch (error) {
        next(error);
    }
});

/* PATCH /api/receipts/RCV-20260904-1
   { "data": { ...changed fields... }, "notes": "...", "part_number": "..." }

   Working through the inspection form section by section, saved as
   the inspector goes. Only while the receipt is still pending - once
   it is accepted or rejected the record is closed. data merges
   (an explicit null on a key removes it); the mirrored columns
   follow whatever data carries. One audit row lists the keys that
   changed. */
operations.patch("/receipts/:number", requirePermission("receiving.log"),
    async (request, response, next) => {
        try {
            const body = request.body || {};
            const patch = cleanReceiptData(body.data);

            const result = await withTransaction(async (client) => {
                const found = await client.query(
                    "select id, status, data from receipts where org_id = $1 and receipt_number = $2 for update",
                    [request.user.org_id, request.params.number]
                );
                if (found.rowCount === 0) return null;
                if (found.rows[0].status !== "pending") {
                    return { conflict: "That receipt has been dispositioned and can no longer be edited" };
                }

                const before = found.rows[0].data || {};
                const merged = { ...before };
                for (const [key, value] of Object.entries(patch)) {
                    if (value === null) delete merged[key];
                    else merged[key] = value;
                }

                const poNumber = merged.po_number ?? null;
                const partNumber = merged.part_number ?? null;
                const qty = Number(merged.qty_received);

                const updated = await client.query(`
                    update receipts
                       set data = $2,
                           po_number = $3,
                           part_number = $4,
                           qty_received = case when $5::numeric > 0 then $5::numeric else qty_received end,
                           notes = coalesce($6, notes)
                     where id = $1
                    returning receipt_number, status, data, quarantined, ncr_number,
                              po_number, part_number, qty_received, notes
                `, [found.rows[0].id, merged, poNumber, partNumber,
                    Number.isFinite(qty) ? qty : 0, body.notes || null]);

                const changed = Object.keys(patch);
                if (changed.length > 0) {
                    await client.query(`
                        insert into audit_log
                            (org_id, entity, entity_id, field, new_value, changed_by)
                        values ($1, 'receipts', $2, 'inspection', $3, $4)
                    `, [request.user.org_id, found.rows[0].id,
                        changed.join(", "), request.user.id]);
                }

                return { receipt: updated.rows[0] };
            });

            if (!result) return response.status(404).json({ error: "No such receipt" });
            if (result.conflict) return response.status(409).json({ error: result.conflict });

            response.json(result.receipt);
        } catch (error) {
            next(error);
        }
    });

operations.get("/receipts/:number", async (request, response, next) => {
    try {
        const [found, vendors] = await Promise.all([
            query(`
                select r.id, r.receipt_number, r.po_number, r.part_number,
                       r.qty_received, r.received_at, r.status, r.notes,
                       r.data, r.quarantined, r.ncr_number,
                       v.name as vendor,
                       u.full_name as inspected_by, r.inspected_at
                  from receipts r
             left join vendors v on v.id = r.vendor_id
             left join users u   on u.id = r.inspected_by
                 where r.org_id = $1 and r.receipt_number = $2
            `, [request.user.org_id, request.params.number]),
            scoredVendors(request.user.org_id)
        ]);

        if (found.rowCount === 0) {
            return response.status(404).json({ error: "No such receipt" });
        }

        const row = found.rows[0];
        const data = row.data || {};
        const vendor = vendors.find((v) => v.name === row.vendor) || null;

        const measurements = await query(`
            select characteristic, specification, actual, result, gage_id
              from receipt_measurements
             where receipt_id = $1 order by position
        `, [row.id]);

        /* Photos come back without their storage_path - the client
           fetches each by index through the route below. The stored
           paths never leave the server. */
        const photos = Array.isArray(data.photos)
            ? data.photos.map((p, index) => ({
                index,
                filename: p.filename,
                mime_type: p.mime_type,
                size: p.size,
                uploaded_by: p.uploaded_by,
                uploaded_at: p.uploaded_at
            }))
            : [];
        const { photos: _stored, ...safeData } = data;

        response.json({
            receipt: {
                ...row,
                data: safeData,
                vendor: row.vendor || data.supplier_name || null,
                on_avl: Boolean(row.vendor),
                vendor_grade: vendor?.grade || null,
                vendor_ppm: vendor?.ppm ?? null,
                ...receivingSamplePlan(vendor?.grade, row.qty_received)
            },
            photos,
            measurements: measurements.rows,
            can_disposition: request.can("ncr.disposition"),
            can_log_measurement: request.can("receiving.log"),
            can_edit: request.can("receiving.log") && row.status === "pending"
        });
    } catch (error) {
        next(error);
    }
});

/* POST /api/receipts/RCV-20260904-1/measurements
   { "characteristic": "Heat number on cert", "specification": "Present and legible",
     "actual": "Present", "result": "pass", "gage_id": null }

   One line of the sample this receipt's gate called for. Positions
   append in the order they're logged - the inspector working through
   the sample one unit or one characteristic at a time, not a form
   filled out in one shot. */
operations.post("/receipts/:number/measurements",
    requirePermission("receiving.log"),
    async (request, response, next) => {
        try {
            const { characteristic, specification, actual, result, gage_id } = request.body || {};

            if (!characteristic || !["pass", "fail"].includes(result)) {
                return response.status(400).json({
                    error: "characteristic and a result of pass or fail are required"
                });
            }

            const found = await query(
                "select id from receipts where org_id = $1 and receipt_number = $2",
                [request.user.org_id, request.params.number]
            );
            if (found.rowCount === 0) {
                return response.status(404).json({ error: "No such receipt" });
            }

            const inserted = await query(`
                insert into receipt_measurements
                    (receipt_id, characteristic, specification, actual, result, gage_id, position)
                select $1, $2, $3, $4, $5, $6,
                       coalesce((select max(position) + 1 from receipt_measurements where receipt_id = $1), 1)
                returning characteristic, specification, actual, result, gage_id, position
            `, [found.rows[0].id, characteristic, specification || null,
                actual || null, result, gage_id || null]);

            response.status(201).json(inserted.rows[0]);
        } catch (error) {
            next(error);
        }
    });

/* The three ways an incoming inspection can end. accepted_with_notes
   is still an acceptance - the material goes to stock - but it
   leaves a written observation for the supplier scorecard. */
const DISPOSITION_RESULTS = new Set(["accepted", "accepted_with_notes", "rejected"]);

/* Raise an NCR for a rejected receipt, inline, the same way di.js
   raises a DI - a records row of type ncr in its first workflow
   state, its data prefilled from the receipt. Returns the new NCR
   number, or null if the org has no ncr record type. */
async function raiseReceiptNcr(client, orgId, user, receipt, rejectionReason) {
    const { id: userId } = user;
    const typeRow = await client.query(
        "select id, prefix from record_types where org_id = $1 and key = 'ncr'",
        [orgId]
    );
    if (typeRow.rowCount === 0) return null;
    const recordType = typeRow.rows[0];

    const firstState = await client.query(
        "select key from workflow_states where record_type_id = $1 order by position limit 1",
        [recordType.id]
    );

    /* Pin the record to the current NCR form so its detail view
       renders every field the manual form has. */
    const formVersion = await client.query(
        "select coalesce(max(version), 1) as version from form_versions where record_type_id = $1",
        [recordType.id]
    );

    const year = new Date().getFullYear();
    const last = await client.query(`
        select number from records
         where org_id = $1 and record_type_id = $2 and number like $3
         order by number desc limit 1
    `, [orgId, recordType.id, recordType.prefix + "-" + year + "-%"]);
    const nextSeq = last.rowCount === 0
        ? 1
        : Number(last.rows[0].number.split("-").pop()) + 1;
    const number = recordType.prefix + "-" + year + "-" + String(nextSeq).padStart(4, "0");

    const rd = receipt.data || {};
    const data = {
        source: receipt.receipt_number,
        part_number: receipt.part_number || rd.part_number || undefined,
        lot_number: rd.lot_number || undefined,
        customer_or_supplier: receipt.vendor || rd.supplier_name || undefined,
        po_or_job_number: receipt.po_number || rd.po_number || undefined,
        qty_affected: receipt.qty_received || rd.qty_received || undefined,
        detection_point: "receiving",
        department: "Receiving",
        raised_by: user.initials || undefined,
        description: rejectionReason
            || "Rejected at incoming inspection - see receipt " + receipt.receipt_number
    };

    const inserted = await client.query(`
        insert into records
            (org_id, record_type_id, number, title, status, severity, data, form_version, created_by)
        values ($1, $2, $3, $4, $5, 'crit', $6, $7, $8)
        returning id, number
    `, [orgId, recordType.id, number,
        "Incoming rejection - " + receipt.receipt_number,
        firstState.rows[0].key, data, formVersion.rows[0].version, userId]);

    await client.query(`
        insert into audit_log (org_id, record_id, entity, entity_id, field, new_value, changed_by)
        values ($1, $2, 'records', $2, 'created', $3, $4)
    `, [orgId, inserted.rows[0].id, number, userId]);

    return inserted.rows[0].number;
}

/* POST /api/receipts/RCV-20260904-1/disposition
   { "result": "rejected", "rejection_reason": "...", "notes": "...",
     "requires_ncr": true, "requires_quarantine": true }

   Also accepts the older { accept: true|false, notes } shape.

   accepted / accepted_with_notes -> status accept; rejected -> status
   reject. A rejected receipt with requires_ncr raises a linked NCR
   (records type ncr, first state) and stores its number on the
   receipt. requires_quarantine sets the quarantined flag the
   register filters on. One disposition only - 409 after that. */
operations.post("/receipts/:number/disposition",
    requirePermission("ncr.disposition"),
    async (request, response, next) => {
        try {
            const body = request.body || {};

            /* New shape when result is present, else the old accept flag. */
            let result;
            if (typeof body.result === "string") {
                if (!DISPOSITION_RESULTS.has(body.result)) {
                    return response.status(400).json({
                        error: "result must be one of " + [...DISPOSITION_RESULTS].join(", ")
                    });
                }
                result = body.result;
            } else {
                result = body.accept === true ? "accepted" : "rejected";
            }

            const rejected = result === "rejected";
            const rejectionReason = (body.rejection_reason || "").trim();

            if (rejected && !rejectionReason) {
                return response.status(422).json({ error: "A rejection_reason is required to reject a receipt" });
            }

            const requiresNcr = rejected && body.requires_ncr === true;
            const requiresQuarantine = body.requires_quarantine === true;

            const outcome = await withTransaction(async (client) => {
                const found = await client.query(`
                    select r.id, r.status, r.receipt_number, r.po_number, r.part_number,
                           r.qty_received, r.data, v.name as vendor
                      from receipts r
                 left join vendors v on v.id = r.vendor_id
                     where r.org_id = $1 and r.receipt_number = $2
                       for update of r
                `, [request.user.org_id, request.params.number]);

                if (found.rowCount === 0) return null;
                if (found.rows[0].status !== "pending") {
                    return { conflict: "That receipt has already been dispositioned" };
                }
                const receipt = found.rows[0];

                let ncrNumber = null;
                if (requiresNcr) {
                    ncrNumber = await raiseReceiptNcr(
                        client, request.user.org_id, request.user, receipt, rejectionReason
                    );
                }

                const mergedData = {
                    ...(receipt.data || {}),
                    inspection_result: result,
                    rejection_reason: rejected ? rejectionReason : undefined,
                    requires_ncr: requiresNcr || undefined,
                    requires_quarantine: requiresQuarantine || undefined
                };

                const updated = await client.query(`
                    update receipts
                       set status = $2, inspected_by = $3, inspected_at = now(),
                           notes = coalesce($4, notes),
                           data = $5,
                           quarantined = $6,
                           ncr_number = coalesce($7, ncr_number)
                     where id = $1
                    returning receipt_number, status, quarantined, ncr_number
                `, [receipt.id, rejected ? "reject" : "accept",
                    request.user.id, body.notes || null, mergedData,
                    requiresQuarantine, ncrNumber]);

                await client.query(`
                    insert into audit_log
                        (org_id, entity, entity_id, field, old_value, new_value, reason, changed_by)
                    values ($1, 'receipts', $2, 'status', 'pending', $3, $4, $5)
                `, [request.user.org_id, receipt.id, result,
                    rejected ? rejectionReason : (body.notes || null), request.user.id]);

                return { receipt: updated.rows[0], ncr_number: ncrNumber };
            });

            if (!outcome) return response.status(404).json({ error: "No such receipt" });
            if (outcome.conflict) return response.status(409).json({ error: outcome.conflict });

            response.json({
                ...outcome.receipt,
                ncr_created: Boolean(outcome.ncr_number),
                ncr_number: outcome.ncr_number || outcome.receipt.ncr_number || null
            });
        } catch (error) {
            next(error);
        }
    });

/* POST /api/receipts/RCV-20260904-1/photos   multipart: file

   A photo or scan attached to the inspection - packaging damage, a
   label, the packing slip. Appended to data.photos with who and
   when; the bytes go to storage/receipts under a generated name. */
operations.post("/receipts/:number/photos",
    requirePermission("receiving.log"),
    upload.single("file"),
    async (request, response, next) => {
        try {
            if (!request.file) {
                return response.status(400).json({ error: "A file is required" });
            }

            const found = await query(
                "select id, status, data from receipts where org_id = $1 and receipt_number = $2",
                [request.user.org_id, request.params.number]
            );
            if (found.rowCount === 0) {
                return response.status(404).json({ error: "No such receipt" });
            }

            const storagePath = await saveUploadedFile(
                "receipts", RECEIPT_PHOTO_EXTENSIONS,
                request.file.originalname, request.file.buffer
            );

            const entry = {
                filename: request.file.originalname,
                storage_path: storagePath,
                mime_type: request.file.mimetype,
                size: request.file.size,
                uploaded_by: request.user.initials || null,
                uploaded_at: new Date().toISOString()
            };

            const updated = await query(`
                update receipts
                   set data = jsonb_set(
                           data,
                           '{photos}',
                           coalesce(data->'photos', '[]'::jsonb) || $2::jsonb
                       )
                 where id = $1
                returning data->'photos' as photos
            `, [found.rows[0].id, JSON.stringify(entry)]);

            await query(`
                insert into audit_log (org_id, entity, entity_id, field, new_value, changed_by)
                values ($1, 'receipts', $2, 'photo_added', $3, $4)
            `, [request.user.org_id, found.rows[0].id, request.file.originalname, request.user.id]);

            const photos = (updated.rows[0].photos || []).map((p, index) => ({
                index,
                filename: p.filename,
                mime_type: p.mime_type,
                size: p.size,
                uploaded_by: p.uploaded_by,
                uploaded_at: p.uploaded_at
            }));

            response.status(201).json({ photos });
        } catch (error) {
            if (error.status) return response.status(error.status).json({ error: error.message });
            next(error);
        }
    });

/* GET /api/receipts/RCV-20260904-1/photos/0
   Streams one photo back by its index in data.photos. */
operations.get("/receipts/:number/photos/:index", async (request, response, next) => {
    try {
        const found = await query(
            "select data from receipts where org_id = $1 and receipt_number = $2",
            [request.user.org_id, request.params.number]
        );
        if (found.rowCount === 0) {
            return response.status(404).json({ error: "No such receipt" });
        }

        const photos = found.rows[0].data?.photos;
        const index = Number(request.params.index);
        if (!Array.isArray(photos) || !Number.isInteger(index) || !photos[index]) {
            return response.status(404).json({ error: "No such photo" });
        }
        const photo = photos[index];

        const buffer = await readUploadedFile(photo.storage_path);
        const disposition = INLINE_PHOTO_MIME.has(photo.mime_type) ? "inline" : "attachment";

        response.setHeader("Content-Type", photo.mime_type || "application/octet-stream");
        response.setHeader("Content-Disposition",
            disposition + "; filename=\"" + (photo.filename || "photo") + "\"");
        response.send(buffer);
    } catch (error) {
        if (error.status) return response.status(error.status).json({ error: error.message });
        next(error);
    }
});

/* ============================================================
   Shipping
   ============================================================ */

operations.get("/shipments", async (request, response, next) => {
    try {
        const result = await query(`
            select s.shipment_number, s.customer, s.part_number, s.qty,
                   s.ship_date, s.carrier, s.status, s.released_at,
                   l.lot_number, u.full_name as released_by,
                   (select count(*)::int from shipment_checks c
                     where c.shipment_id = s.id) as checks_total,
                   (select count(*)::int from shipment_checks c
                     where c.shipment_id = s.id and c.status = 'pass') as checks_passed,
                   (select count(*)::int from shipment_checks c
                     where c.shipment_id = s.id and c.status = 'fail') as checks_failed
              from shipments s
         left join lots  l on l.id = s.lot_id
         left join users u on u.id = s.released_by
             where s.org_id = $1
             order by case s.status
                        when 'blocked' then 0
                        when 'awaiting_release' then 1
                        when 'preparing' then 2
                        else 3 end,
                      s.ship_date desc
        `, [request.user.org_id]);

        response.json({ count: result.rowCount, shipments: result.rows });
    } catch (error) {
        next(error);
    }
});

operations.get("/shipments/:number", async (request, response, next) => {
    try {
        const found = await query(`
            select s.id, s.shipment_number, s.customer, s.part_number, s.qty,
                   s.ship_date, s.carrier, s.status, s.released_at,
                   l.lot_number, l.heat_number, u.full_name as released_by
              from shipments s
         left join lots  l on l.id = s.lot_id
         left join users u on u.id = s.released_by
             where s.org_id = $1 and s.shipment_number = $2
        `, [request.user.org_id, request.params.number]);

        if (found.rowCount === 0) {
            return response.status(404).json({ error: "No such shipment" });
        }

        const shipment = found.rows[0];

        const checks = await query(`
            select description, evidence, status, position
              from shipment_checks where shipment_id = $1 order by position
        `, [shipment.id]);

        const outstanding = checks.rows.filter((c) => c.status !== "pass");

        response.json({
            shipment,
            checks: checks.rows,
            outstanding: outstanding.length,
            can_release: request.can("shipping.release") && outstanding.length === 0
        });
    } catch (error) {
        next(error);
    }
});

/* POST /api/shipments/SHIP-20260903-02/release

   Refuses while any check is outstanding. That refusal is the whole
   of clause 8.6: planned verification complete before release. */
operations.post("/shipments/:number/release",
    requirePermission("shipping.release"),
    async (request, response, next) => {
        try {
            const result = await withTransaction(async (client) => {
                const found = await client.query(
                    "select id, status from shipments where org_id = $1 and shipment_number = $2 for update",
                    [request.user.org_id, request.params.number]
                );

                if (found.rowCount === 0) return null;
                const shipment = found.rows[0];

                if (shipment.status === "shipped") {
                    return { conflict: "That shipment has already been released" };
                }

                const outstanding = await client.query(`
                    select description from shipment_checks
                     where shipment_id = $1 and status <> 'pass'
                     order by position
                `, [shipment.id]);

                if (outstanding.rowCount > 0) {
                    return {
                        conflict: "Release checks are not complete",
                        blocking: outstanding.rows.map((row) => row.description)
                    };
                }

                const updated = await client.query(`
                    update shipments
                       set status = 'shipped', released_by = $2, released_at = now()
                     where id = $1
                    returning shipment_number, status
                `, [shipment.id, request.user.id]);

                await client.query(`
                    insert into audit_log
                        (org_id, entity, entity_id, field, old_value, new_value, reason, changed_by)
                    values ($1, 'shipments', $2, 'status', $3, 'shipped', $4, $5)
                `, [request.user.org_id, shipment.id, shipment.status,
                    request.body?.reason || null, request.user.id]);

                return { shipment: updated.rows[0] };
            });

            if (!result) return response.status(404).json({ error: "No such shipment" });

            if (result.conflict) {
                return response.status(409).json({
                    error: result.conflict,
                    blocking: result.blocking
                });
            }

            response.json(result.shipment);
        } catch (error) {
            next(error);
        }
    });

/* Marks one release check complete. */
operations.post("/shipments/:number/checks/:position/pass",
    requirePermission("shipping.release"),
    async (request, response, next) => {
        try {
            const result = await query(`
                update shipment_checks c
                   set status = 'pass',
                       evidence = coalesce($3, c.evidence)
                  from shipments s
                 where s.id = c.shipment_id
                   and s.org_id = $1 and s.shipment_number = $2
                   and c.position = $4
                returning c.description, c.status
            `, [request.user.org_id, request.params.number,
                request.body?.evidence || null, Number(request.params.position)]);

            if (result.rowCount === 0) {
                return response.status(404).json({ error: "No such check" });
            }

            response.json(result.rows[0]);
        } catch (error) {
            next(error);
        }
    });
