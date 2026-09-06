/* One-time script: attach the org's real APQP/PPAP templates as real
   controlled documents, using the exact same storage function the
   live upload endpoint uses (server/src/document-storage.js) - not a
   parallel path, so a document created here is indistinguishable
   from one someone uploads through the app.

   FRM-0031 ("8D Report Template") already existed in seed data,
   claiming current_revision "B" with no document_revisions row ever
   behind it - completed here with the org's real 8D.xlsx rather than
   left as a released document with nothing to download. Every other
   file here is a brand new document.

   Run once: node --env-file=.env scripts/seed-apqp-documents.js */

import fs from "node:fs/promises";
import { query, withTransaction } from "../src/db.js";
import { saveDocumentFile } from "../src/document-storage.js";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const DESKTOP = "C:\\Users\\shawn\\OneDrive\\Desktop\\";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const NEW_DOCUMENTS = [
    { file: "APQP Summary.xlsx",         doc_number: "FRM-0032", title: "APQP Summary" },
    { file: "Dimensional Report.xlsx",   doc_number: "FRM-0033", title: "Dimensional Report" },
    { file: "fmea.xlsx",                 doc_number: "FRM-0034", title: "FMEA" },
    { file: "Process Flow Diagram.xlsx", doc_number: "FRM-0035", title: "Process Flow Diagram" },
    { file: "Control Plan.xlsx",         doc_number: "FRM-0036", title: "Control Plan" },
    { file: "PSW.xlsx",                  doc_number: "FRM-0037", title: "Part Submission Warrant (PSW)" },
    { file: "Appearance Report.xlsx",    doc_number: "FRM-0038", title: "Appearance Report" }
];

async function findUser(initials) {
    const result = await query("select id from users where initials = $1", [initials]);
    if (result.rowCount === 0) throw new Error("No user with initials " + initials);
    return result.rows[0].id;
}

async function main() {
    const authorId = await findUser("MO");
    const approverId = await findUser("RV");

    for (const doc of NEW_DOCUMENTS) {
        const existing = await query(
            "select 1 from documents where org_id = $1 and doc_number = $2",
            [ORG_ID, doc.doc_number]
        );
        if (existing.rowCount > 0) {
            console.log("skip (already exists):", doc.doc_number);
            continue;
        }

        const buffer = await fs.readFile(DESKTOP + doc.file);
        const storagePath = await saveDocumentFile(doc.file, buffer);

        await withTransaction(async (client) => {
            const inserted = await client.query(`
                insert into documents (org_id, doc_number, title, owner_id, current_revision, status)
                values ($1, $2, $3, $4, 'A', 'released')
                returning id
            `, [ORG_ID, doc.doc_number, doc.title, authorId]);

            await client.query(`
                insert into document_revisions
                    (document_id, revision, change_summary, author_id, approved_by,
                     effective_date, original_filename, mime_type, size_bytes, storage_path)
                values ($1, 'A', 'Initial upload', $2, $3, now(), $4, $5, $6, $7)
            `, [inserted.rows[0].id, authorId, approverId, doc.file, XLSX_MIME, buffer.length, storagePath]);
        });

        console.log("created:", doc.doc_number, "-", doc.title, "(" + buffer.length + " bytes)");
    }

    // FRM-0031: complete the existing seed placeholder with the real file.
    const eightD = await query(
        "select id, current_revision from documents where org_id = $1 and doc_number = 'FRM-0031'",
        [ORG_ID]
    );

    if (eightD.rowCount === 0) {
        console.log("FRM-0031 not found - skipping 8D workbook attach");
    } else {
        const hasRevision = await query(
            "select 1 from document_revisions where document_id = $1 and revision = $2",
            [eightD.rows[0].id, eightD.rows[0].current_revision]
        );

        if (hasRevision.rowCount > 0) {
            console.log("skip (FRM-0031 revision already has a row):", eightD.rows[0].current_revision);
        } else {
            const buffer = await fs.readFile(DESKTOP + "8D.xlsx");
            const storagePath = await saveDocumentFile("8D.xlsx", buffer);

            await query(`
                insert into document_revisions
                    (document_id, revision, change_summary, author_id, approved_by,
                     effective_date, original_filename, mime_type, size_bytes, storage_path)
                values ($1, $2, 'Attached the real 8D workbook', $3, $4, now(), $5, $6, $7, $8)
            `, [eightD.rows[0].id, eightD.rows[0].current_revision, authorId, approverId,
                "8D.xlsx", XLSX_MIME, buffer.length, storagePath]);

            console.log("completed: FRM-0031 revision", eightD.rows[0].current_revision,
                "-", "8D Report Template", "(" + buffer.length + " bytes)");
        }
    }

    process.exit(0);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
