/* ============================================================
   Where uploaded files live, for anything that is not a controlled
   document.

   document-storage.js came first and is deliberately left exactly as
   it was - its stored paths are bare "<uuid>.<ext>" names rooted at
   storage/documents, and a working upload path is not worth
   refactoring for the sake of sharing code. This module is the
   general version for everything since: a calibration certificate
   today, whatever else needs a real file tomorrow.

   The one rule every driver shares: never trust the caller's filename
   for anything but its extension, and write under a generated id so
   nothing a client sends can collide with another file or climb out
   of the store.

   ---- drivers ----

   Callers deal only in an opaque storage_path string; where the bytes
   actually sit is a driver, chosen once at load time by STORAGE_DRIVER
   (default "local"). The public functions - saveUploadedFile,
   readUploadedFile, assertAllowedExtension - keep the same signatures
   whichever driver is active.

     local  - disk under server/storage/<subdir>/. The dev and
              single-box default. Files vanish on a container redeploy
              and are invisible to a second instance; that is the
              reason the s3 driver has a slot here.

     s3     - contract only, not implemented in this build (kept
              dependency-free on purpose). To finish it: read the
              bucket from STORAGE_S3_BUCKET, use the storage_path as
              the object key verbatim, put on save and get on read.
              Migrating an existing deployment is then a one-off
              script that walks server/storage and re-saves each file
              through this driver - the storage_path values do not
              change, the key is identical.
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

/* Magic-byte signatures per extension. A renamed .exe is caught here
   even though its extension passed the allowlist. Extensions with no
   reliable signature (.txt, .csv) are not listed and are let through
   on the allowlist alone. */
const SIGNATURES = {
    ".pdf":  [[0x25, 0x50, 0x44, 0x46]],                              // %PDF
    ".png":  [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    ".jpg":  [[0xff, 0xd8, 0xff]],
    ".jpeg": [[0xff, 0xd8, 0xff]],
    ".gif":  [[0x47, 0x49, 0x46, 0x38]],                              // GIF8
    ".bmp":  [[0x42, 0x4d]],
    ".tif":  [[0x49, 0x49, 0x2a, 0x00], [0x4d, 0x4d, 0x00, 0x2a]],
    ".tiff": [[0x49, 0x49, 0x2a, 0x00], [0x4d, 0x4d, 0x00, 0x2a]],
    ".webp": [],                                                       // RIFF/WEBP check below
    ".heic": [],                                                       // ftyp brand check below
    ".heif": [],
    ".rtf":  [[0x7b, 0x5c, 0x72, 0x74, 0x66]],                        // {\rtf
    ".zip":  [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06], [0x50, 0x4b, 0x07, 0x08]],
    /* OOXML is a zip; legacy Office and .msg are OLE compound files */
    ".docx": [[0x50, 0x4b, 0x03, 0x04]],
    ".xlsx": [[0x50, 0x4b, 0x03, 0x04]],
    ".pptx": [[0x50, 0x4b, 0x03, 0x04]],
    ".doc":  [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
    ".xls":  [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
    ".ppt":  [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
    ".msg":  [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]]
};

const startsWith = (buffer, bytes) =>
    buffer.length >= bytes.length && bytes.every((b, i) => buffer[i] === b);

/* Throws 422 when the bytes plainly are not the kind of file the name
   claims. A no-op for an extension with no signature, or an empty
   buffer (multer already rejects those). */
export function assertContentMatchesExtension(ext, buffer) {
    if (!buffer || buffer.length < 4) return;
    const sigs = SIGNATURES[ext];
    if (sigs === undefined) return;              // nothing reliable to check

    if (ext === ".webp") {
        const ok = startsWith(buffer, [0x52, 0x49, 0x46, 0x46])
            && buffer.length >= 12
            && [0x57, 0x45, 0x42, 0x50].every((b, i) => buffer[8 + i] === b);
        if (!ok) throw badContent(ext);
        return;
    }
    if (ext === ".heic" || ext === ".heif") {
        /* ....ftyp<brand> where brand is one of the HEIF family */
        const brand = buffer.slice(8, 12).toString("latin1");
        const isFtyp = buffer.slice(4, 8).toString("latin1") === "ftyp";
        if (!(isFtyp && /^(heic|heix|hevc|mif1|msf1)$/.test(brand))) throw badContent(ext);
        return;
    }

    if (sigs.length && !sigs.some((sig) => startsWith(buffer, sig))) {
        throw badContent(ext);
    }
}

function badContent(ext) {
    return Object.assign(
        new Error("That file's contents are not a valid \"" + ext + "\" file - "
            + "it may have been renamed. Upload the file in its real format."),
        { status: 422 }
    );
}

/* ---------- local disk driver ---------- */

/* storage_path is always exactly what saveUploadedFile built, but a
   climbed path is checked for here anyway rather than trusted at read
   time. */
function resolveLocal(storagePath) {
    const full = path.resolve(STORAGE_ROOT, storagePath);
    if (full !== STORAGE_ROOT && !full.startsWith(STORAGE_ROOT + path.sep)) {
        throw Object.assign(new Error("Invalid storage path"), { status: 400 });
    }
    return full;
}

const localDriver = {
    name: "local",
    async save(storagePath, buffer) {
        const full = resolveLocal(storagePath);
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, buffer);
    },
    async read(storagePath) {
        return fs.readFile(resolveLocal(storagePath));
    }
};

/* ---------- s3 driver (contract only) ---------- */

function s3NotImplemented() {
    return Object.assign(
        new Error("STORAGE_DRIVER=s3 is set but this build has no s3 driver. "
            + "Use STORAGE_DRIVER=local, or implement the driver (see file-storage.js)."),
        { status: 500 }
    );
}

const s3Driver = {
    name: "s3",
    async save() { throw s3NotImplemented(); },
    async read() { throw s3NotImplemented(); }
};

/* ---------- driver selection ---------- */

const DRIVERS = { local: localDriver, s3: s3Driver };
const driver = DRIVERS[process.env.STORAGE_DRIVER || "local"];

if (!driver) {
    throw new Error("Unknown STORAGE_DRIVER \"" + process.env.STORAGE_DRIVER
        + "\". Expected one of: " + Object.keys(DRIVERS).join(", "));
}

/* The active driver's name, for a health check or a boot log line. */
export const STORAGE_DRIVER = driver.name;

/* ---------- public API (driver-independent) ---------- */

/* Writes bytes under <subdir>/ and returns the storage_path to
   persist: "<subdir>/<uuid><ext>". Both segments are generated here,
   never taken from the request. */
export async function saveUploadedFile(subdir, allowedExtensions, originalFilename, buffer) {
    const ext = assertAllowedExtension(originalFilename, allowedExtensions);
    assertContentMatchesExtension(ext, buffer);
    const storagePath = path.posix.join(subdir, crypto.randomUUID() + ext);
    await driver.save(storagePath, buffer);
    return storagePath;
}

/* Resolves a storage_path back to bytes for a download. */
export async function readUploadedFile(storagePath) {
    return driver.read(storagePath);
}
