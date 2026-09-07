/* ============================================================
   Where uploaded files live, for anything that is not a controlled
   document.

   document-storage.js came first and is deliberately left exactly as
   it was - its stored paths are bare "<uuid>.<ext>" names rooted at
   storage/documents, and a working upload path is not worth
   refactoring for the sake of sharing code. This module is the
   general version for everything since: a calibration certificate
   today, whatever else needs a real file tomorrow.

   The one rule both share: never trust the caller's filename for
   anything but its extension, and write under a generated id so
   nothing a client sends can collide with another file or climb out
   of the directory.

   Local disk, same posture as the rest of the app. A blob store
   later means changing only the two functions here - every caller
   deals in an opaque storage_path string.
   ============================================================ */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* server/src/ -> server/storage */
export const STORAGE_ROOT = path.join(__dirname, "..", "storage");

/* An extension allowlist, not a MIME check the client controls. The
   caller passes the set that makes sense for its own kind of file. */
export function assertAllowedExtension(filename, allowedExtensions) {
    const allowed = allowedExtensions instanceof Set
        ? allowedExtensions
        : new Set(allowedExtensions);
    const ext = path.extname(filename || "").toLowerCase();

    if (!allowed.has(ext)) {
        throw Object.assign(
            new Error(
                "Unsupported file type \"" + (ext || "(none)") + "\". Allowed: "
                + [...allowed].join(", ")
            ),
            { status: 422 }
        );
    }

    return ext;
}

/* Writes bytes under storage/<subdir>/ and returns the storage_path
   to persist: "<subdir>/<uuid><ext>". Both segments are generated
   here, never taken from the request. */
export async function saveUploadedFile(subdir, allowedExtensions, originalFilename, buffer) {
    const ext = assertAllowedExtension(originalFilename, allowedExtensions);
    const storedName = crypto.randomUUID() + ext;
    const directory = path.join(STORAGE_ROOT, subdir);

    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, storedName), buffer);

    return path.posix.join(subdir, storedName);
}

/* Resolves a storage_path back to bytes for a download. storage_path
   is always exactly what saveUploadedFile returned, but this guards
   against a climbed path anyway rather than trust that at read time. */
export async function readUploadedFile(storagePath) {
    const full = path.resolve(STORAGE_ROOT, storagePath);

    if (full !== STORAGE_ROOT && !full.startsWith(STORAGE_ROOT + path.sep)) {
        throw Object.assign(new Error("Invalid storage path"), { status: 400 });
    }

    return fs.readFile(full);
}
