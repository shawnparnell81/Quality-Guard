/* ============================================================
   One multipart upload handler, shared by every route that takes a
   file - controlled documents, calibration certificates, training
   evidence, onboarding-stage documents.

   In-memory: the bytes are handed straight to file storage and never
   kept. 25 MB ceiling, one file per request. The extension allowlist
   AND a magic-byte check are the caller's job, in file-storage.js /
   document-storage.js.

   xlsxUpload is the tighter variant for the spreadsheet importers: a
   real form template is well under 10 MB, and a smaller ceiling plus
   assertSaneWorkbook() blunt a decompression-bomb .xlsx.
   ============================================================ */

import multer from "multer";

export const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024, files: 1 }
});

export const xlsxUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 }
});

/* A modest guard against a zip/xlsx that unpacks to millions of
   cells: a genuine QMS template is thousands, not tens of millions.
   Throws 413 so the route's catch can surface it. */
export function assertSaneWorkbook(workbook) {
    let cells = 0;
    for (const ws of workbook.worksheets) {
        const rows = ws.actualRowCount || ws.rowCount || 0;
        const cols = Math.max(1, ws.actualColumnCount || ws.columnCount || 1);
        cells += rows * cols;
        if (cells > 2_000_000) {
            throw Object.assign(
                new Error("That workbook is far larger than a form template should be."),
                { status: 413 }
            );
        }
    }
}
