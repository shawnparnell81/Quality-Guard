/* ============================================================
   One multipart upload handler, shared by every route that takes a
   file - controlled documents, calibration certificates, training
   evidence, onboarding-stage documents.

   In-memory: the bytes are handed straight to file storage and never
   kept. 25 MB ceiling. The extension allowlist is the caller's job
   (file-storage.js / document-storage.js), not multer's.
   ============================================================ */

import multer from "multer";

export const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }
});
