/* ============================================================
   Engineering drawings, clause 8.3.

   A drawing is a controlled document with a revision history and an
   access level. Production sees the released revision and nothing
   else, which is the control the clause is asking for.
   ============================================================ */

import { Router } from "express";
import { query, withTransaction } from "../db.js";
import { requirePermission } from "../auth.js";
import { upload } from "../uploads.js";
import { saveUploadedFile, readUploadedFile } from "../file-storage.js";

export const engineering = Router();

/* The app has no CAD tool, so a drawing carries the file it was drawn
   in. These are the formats worth accepting - the neutral exchange
   ones and the common vendor natives - not an open door. */
const DRAWING_EXTENSIONS = new Set([
    ".pdf", ".dxf", ".dwg", ".step", ".stp", ".igs", ".iges",
    ".png", ".jpg", ".jpeg", ".tif", ".tiff"
]);

const INLINE_MIME = new Set([
    "application/pdf", "image/png", "image/jpeg", "image/tiff"
]);

/* A -> B -> C ... one letter at a time; AA follows Z on the rare
   drawing that gets that far. */
function nextRevisionLetter(current) {
    if (!current) return "A";
    const last = current[current.length - 1];
    if (last === "Z") return current + "A";
    return current.slice(0, -1) + String.fromCharCode(last.charCodeAt(0) + 1);
}

engineering.get("/drawings", requirePermission("drawing.read"),
    async (request, response, next) => {
        try {
            const result = await query(`
                select d.drawing_number, d.title, d.customer, d.current_revision,
                       d.status, d.access_level,
                       u.full_name as owner,
                       p.description as part_description,
                       (select count(*)::int from drawing_revisions r
                         where r.drawing_id = d.id) as revision_count,
                       (select r.ecn_number from drawing_revisions r
                         where r.drawing_id = d.id and r.status in ('draft','in_review')
                         limit 1) as open_ecn
                  from drawings d
             left join users u on u.id = d.owner_id
             left join parts p on p.id = d.part_id
                 where d.org_id = $1
                 order by d.drawing_number
            `, [request.user.org_id]);

            response.json({ count: result.rowCount, drawings: result.rows });
        } catch (error) {
            next(error);
        }
    });

engineering.get("/drawings/:number", requirePermission("drawing.read"),
    async (request, response, next) => {
        try {
            const found = await query(`
                select d.id, d.drawing_number, d.title, d.customer,
                       d.current_revision, d.status, d.access_level,
                       u.full_name as owner, p.part_number, p.description as part_description
                  from drawings d
             left join users u on u.id = d.owner_id
             left join parts p on p.id = d.part_id
                 where d.org_id = $1 and d.drawing_number = $2
            `, [request.user.org_id, request.params.number]);

            if (found.rowCount === 0) {
                return response.status(404).json({ error: "No such drawing" });
            }

            const drawing = found.rows[0];

            const revisions = await query(`
                select r.revision, r.change_summary, r.ecn_number, r.status,
                       r.released_at, u.full_name as released_by,
                       r.original_filename, r.mime_type,
                       (r.storage_path is not null) as has_file
                  from drawing_revisions r
             left join users u on u.id = r.released_by
                 where r.drawing_id = $1
                 order by r.revision desc
            `, [drawing.id]);

            response.json({
                drawing,
                revisions: revisions.rows,
                can_release: request.can("drawing.release")
            });
        } catch (error) {
            next(error);
        }
    });

/* POST /api/drawings   multipart: drawing_number, title, customer?,
   change_summary?, access_level?, file

   A new drawing with its first revision (A), status draft. The app has
   no CAD program, so the file the drawing was drawn in rides along and
   is what View opens. current_revision stays null until a release. */
engineering.post("/drawings", requirePermission("drawing.create"), upload.single("file"),
    async (request, response, next) => {
        try {
            const drawingNumber = (request.body?.drawing_number || "").trim();
            const title = (request.body?.title || "").trim();
            if (!drawingNumber || !title) {
                return response.status(422).json({ error: "drawing_number and title are required" });
            }
            if (!request.file) {
                return response.status(400).json({ error: "A drawing file is required" });
            }

            const accessLevel = ["all_plant", "eng_qa", "eng_only"].includes(request.body?.access_level)
                ? request.body.access_level : "eng_qa";

            const clash = await query(
                "select 1 from drawings where org_id = $1 and drawing_number = $2",
                [request.user.org_id, drawingNumber]
            );
            if (clash.rowCount > 0) {
                return response.status(409).json({ error: "A drawing already has that number: " + drawingNumber });
            }

            const storagePath = await saveUploadedFile(
                "drawings", DRAWING_EXTENSIONS, request.file.originalname, request.file.buffer);

            const created = await withTransaction(async (client) => {
                const drawing = await client.query(`
                    insert into drawings (org_id, drawing_number, title, customer, status, access_level, owner_id)
                    values ($1, $2, $3, $4, 'draft', $5, $6)
                    returning id
                `, [request.user.org_id, drawingNumber, title,
                    (request.body?.customer || "").trim() || null, accessLevel, request.user.id]);

                await client.query(`
                    insert into drawing_revisions
                        (drawing_id, revision, change_summary, status,
                         original_filename, mime_type, size_bytes, storage_path)
                    values ($1, 'A', $2, 'draft', $3, $4, $5, $6)
                `, [drawing.rows[0].id, (request.body?.change_summary || "").trim() || "Initial upload",
                    request.file.originalname, request.file.mimetype, request.file.size, storagePath]);

                await client.query(`
                    insert into audit_log (org_id, entity, entity_id, field, new_value, changed_by)
                    values ($1, 'drawings', $2, 'created', $3, $4)
                `, [request.user.org_id, drawing.rows[0].id, drawingNumber, request.user.id]);

                return drawing.rows[0].id;
            });

            response.status(201).json({ drawing_number: drawingNumber, revision: "A", id: created });
        } catch (error) {
            if (error.status) return response.status(error.status).json({ error: error.message });
            next(error);
        }
    });

/* POST /api/drawings/RP-2210-C/revisions   multipart: change_summary,
   revision?, ecn_number?, file

   A new draft revision with its file. Still needs a separate release
   before production sees it. */
engineering.post("/drawings/:number/revisions", requirePermission("drawing.create"), upload.single("file"),
    async (request, response, next) => {
        try {
            if (!request.file) {
                return response.status(400).json({ error: "A drawing file is required" });
            }
            const changeSummary = (request.body?.change_summary || "").trim();
            if (!changeSummary) {
                return response.status(422).json({ error: "change_summary is required" });
            }

            const found = await query(
                "select id from drawings where org_id = $1 and drawing_number = $2",
                [request.user.org_id, request.params.number]
            );
            if (found.rowCount === 0) return response.status(404).json({ error: "No such drawing" });
            const drawingId = found.rows[0].id;

            const latest = await query(
                "select revision from drawing_revisions where drawing_id = $1 order by length(revision) desc, revision desc limit 1",
                [drawingId]
            );
            const revision = (request.body?.revision || "").trim()
                || nextRevisionLetter(latest.rows[0]?.revision);

            const taken = await query(
                "select 1 from drawing_revisions where drawing_id = $1 and revision = $2",
                [drawingId, revision]
            );
            if (taken.rowCount > 0) {
                return response.status(409).json({ error: "Revision " + revision + " already exists" });
            }

            const storagePath = await saveUploadedFile(
                "drawings", DRAWING_EXTENSIONS, request.file.originalname, request.file.buffer);

            await withTransaction(async (client) => {
                await client.query(`
                    insert into drawing_revisions
                        (drawing_id, revision, change_summary, ecn_number, status,
                         original_filename, mime_type, size_bytes, storage_path)
                    values ($1, $2, $3, $4, 'draft', $5, $6, $7, $8)
                `, [drawingId, revision, changeSummary,
                    (request.body?.ecn_number || "").trim() || null,
                    request.file.originalname, request.file.mimetype, request.file.size, storagePath]);

                await client.query(`
                    insert into audit_log (org_id, entity, entity_id, field, new_value, changed_by)
                    values ($1, 'drawings', $2, 'revision_uploaded', $3, $4)
                `, [request.user.org_id, drawingId, revision, request.user.id]);
            });

            response.status(201).json({ drawing_number: request.params.number, revision });
        } catch (error) {
            if (error.status) return response.status(error.status).json({ error: error.message });
            next(error);
        }
    });

/* GET /api/drawings/RP-2210-C/revisions/B/file
   Streams the drawing back. Same reason drawings need to be uploaded -
   there is nothing else to open. An eng_only drawing does not leave
   engineering: pulling its file needs drawing.edit. */
engineering.get("/drawings/:number/revisions/:revision/file", requirePermission("drawing.read"),
    async (request, response, next) => {
        try {
            const found = await query(`
                select r.original_filename, r.mime_type, r.storage_path, d.access_level
                  from drawing_revisions r
                  join drawings d on d.id = r.drawing_id
                 where d.org_id = $1 and d.drawing_number = $2 and r.revision = $3
            `, [request.user.org_id, request.params.number, request.params.revision]);

            if (found.rowCount === 0 || !found.rows[0].storage_path) {
                return response.status(404).json({ error: "No file on that drawing revision" });
            }
            const rev = found.rows[0];

            if (rev.access_level === "eng_only" && !request.can("drawing.edit")) {
                return response.status(403).json({ error: "This drawing is engineering-only while in work" });
            }

            const buffer = await readUploadedFile(rev.storage_path);
            const disposition = INLINE_MIME.has(rev.mime_type) ? "inline" : "attachment";

            response.setHeader("Content-Type", rev.mime_type || "application/octet-stream");
            response.setHeader("Content-Disposition",
                disposition + "; filename=\"" + (rev.original_filename || "drawing") + "\"");
            response.send(buffer);
        } catch (error) {
            if (error.status) return response.status(error.status).json({ error: error.message });
            next(error);
        }
    });

/* POST /api/drawings/RP-2210-C/revisions/G/release

   The authority a design engineer is deliberately missing. Clause 8.3
   expects design output to be verified by somebody other than whoever
   drew it. */
engineering.post("/drawings/:number/revisions/:revision/release",
    requirePermission("drawing.release"),
    async (request, response, next) => {
        try {
            const result = await withTransaction(async (client) => {
                const found = await client.query(`
                    select r.id, r.status, r.revision, d.id as drawing_id
                      from drawing_revisions r
                      join drawings d on d.id = r.drawing_id
                     where d.org_id = $1 and d.drawing_number = $2 and r.revision = $3
                       for update of r
                `, [request.user.org_id, request.params.number, request.params.revision]);

                if (found.rowCount === 0) return null;
                const revision = found.rows[0];

                if (revision.status === "released") {
                    return { conflict: "That revision is already released" };
                }

                /* Releasing supersedes whatever was current. Two live
                   revisions of one drawing is the failure mode this
                   whole module exists to prevent. */
                await client.query(`
                    update drawing_revisions set status = 'superseded'
                     where drawing_id = $1 and status = 'released'
                `, [revision.drawing_id]);

                await client.query(`
                    update drawing_revisions
                       set status = 'released', released_by = $2, released_at = now()
                     where id = $1
                `, [revision.id, request.user.id]);

                await client.query(`
                    update drawings
                       set current_revision = $2, status = 'released'
                     where id = $1
                `, [revision.drawing_id, revision.revision]);

                await client.query(`
                    insert into audit_log
                        (org_id, entity, entity_id, field, old_value, new_value, reason, changed_by)
                    values ($1, 'drawings', $2, 'released_revision', $3, $4, $5, $6)
                `, [request.user.org_id, revision.drawing_id, revision.status, revision.revision,
                    request.body?.reason || null, request.user.id]);

                return { released: revision.revision };
            });

            if (!result) return response.status(404).json({ error: "No such drawing revision" });
            if (result.conflict) return response.status(409).json({ error: result.conflict });

            response.json(result);
        } catch (error) {
            next(error);
        }
    });
