/* ============================================================
   Where a controlled document's actual bytes live.

   documents/document_revisions (schema.sql) have always described a
   real revision history; nothing has ever stored the file behind
   one. This is the other half: local disk, one file per revision,
   named by a generated id rather than whatever the uploader called
   it, so nothing a client sends can collide with another file or
   escape this directory. The real filename is kept in the database
   (document_revisions.original_filename) - a different job from what
   the file is called on disk.

   Local disk, not a blob store: this app runs self-hosted, the same
   posture its own dev setup already assumes. Swapping this for S3 or
   similar later only means changing the three functions below - every
   caller already only deals with a storage_path string.
   ============================================================ */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* server/src/ -> server/storage/documents */
export const STORAGE_ROOT = path.join(__dirname, "..", "storage", "documents");

/* A conservative extension allowlist, not a MIME-type check the
   client controls - the browser's own guess at a file's type is not
   something to trust for what gets written to disk. Kept to the
   formats this app's own controlled documents actually are: Excel
   workbooks (the org's real FMEA/Control Plan/Process Flow/8D
   templates), PDFs, and Word documents for prose procedures. */
const ALLOWED_EXTENSIONS = new Set([
    ".xlsx", ".xls", ".xlsm", ".csv",
    ".pdf",
    ".doc", ".docx"
]);

export function assertAllowedFilename(filename) {
    const ext = path.extname(filename || "").toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
        const allowed = [...ALLOWED_EXTENSIONS].join(", ");
        throw Object.assign(
            new Error("Unsupported file type \"" + (ext || "(none)") + "\". Allowed: " + allowed),
            { status: 422 }
        );
    }
    return ext;
}

/* Writes one revision's bytes to disk and returns the storage_path to
   save on its document_revisions row. Never trusts the caller's own
   filename for anything but its extension. */
export async function saveDocumentFile(originalFilename, buffer) {
    const ext = assertAllowedFilename(originalFilename);
    const storedName = crypto.randomUUID() + ext;

    await fs.mkdir(STORAGE_ROOT, { recursive: true });
    await fs.writeFile(path.join(STORAGE_ROOT, storedName), buffer);

    return storedName;
}

/* Resolves a stored name back to bytes for a download. storage_path
   is always exactly what saveDocumentFile returned - a bare
   crypto.randomUUID() + extension, never a path a client supplied -
   so joining it onto STORAGE_ROOT can never climb out of it. */
export async function readDocumentFile(storagePath) {
    return fs.readFile(path.join(STORAGE_ROOT, storagePath));
}
