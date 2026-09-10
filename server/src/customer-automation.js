/* ============================================================
   Customer onboarding automation engine.

   Dual-mode: runFull() fires automatically right after a customer is
   created (POST /api/customers), and every step is also reachable as
   a manual button through the routes in routes/customers.js.

   Each step is idempotent - safe to run again - and every attempt
   writes a row to automation_logs (running -> done | skipped |
   failed). runFull continues past a failed step; the customer create
   is never blocked or rolled back by automation.

   The STEPS registry / runStep / runFull shape is deliberately generic
   so the same engine can later drive NCR / CAPA / 8D automation - see
   docs/customer-onboarding-automation.md.

   Reuses:
     query / withTransaction     ./db.js
     saveUploadedFile            ./file-storage.js
     drawLetterhead / drawFooter ./pdf-branding.js
   ============================================================ */

import fs from "node:fs/promises";
import path from "node:path";
import PDFDocument from "pdfkit";

import { query, withTransaction } from "./db.js";
import { saveUploadedFile, STORAGE_ROOT, STORAGE_DRIVER } from "./file-storage.js";
import { drawLetterhead, drawFooter, INK, INK_2 } from "./pdf-branding.js";
import { log } from "./logger.js";

export const FOLDERS = [
    { key: "admin",        name: "01_Admin",       position: 0 },
    { key: "quality",      name: "02_Quality",     position: 1 },
    { key: "engineering",  name: "03_Engineering", position: 2 },
    { key: "production",   name: "04_Production",  position: 3 },
    { key: "supply_chain", name: "05_SupplyChain", position: 4 },
    { key: "orders",       name: "06_Orders",      position: 5 },
    { key: "projects",     name: "07_Projects",    position: 6 }
];

const DEFAULT_QUALITY = {
    inspection_requirements: [
        "First article inspection on every new part number and after any process change.",
        "Dimensional verification against the released drawing at AQL 1.0 unless the customer specifies tighter.",
        "Cosmetic inspection to the customer's visual standard where one is on file."
    ],
    certifications_required: [
        "Certificate of Conformance with every shipment.",
        "Material certs (mill / heat lot) retained and provided on request.",
        "RoHS / REACH declaration on file where applicable."
    ],
    packaging_labeling: [
        "Parts individually bagged unless the customer packaging spec says otherwise.",
        "Label carries: customer part number, revision, quantity, lot / date code, supplier code.",
        "One part number per container; no mixed lots."
    ]
};

const DEFAULT_ENGINEERING = {
    drawing_requirements: [
        "The latest released customer drawing is on file before quoting or production.",
        "Drawing revision is recorded on the router and on the Certificate of Conformance."
    ],
    revision_control: [
        "No production against an unreleased or superseded revision.",
        "Customer ECN acknowledged in writing before any changeover.",
        "Superseded revisions marked obsolete in Document Control."
    ],
    material_specifications: [
        "Material, temper and finish per the drawing or specification callout.",
        "Substitutions only with written customer approval."
    ]
};

const NDA_BODY = [
    "This Mutual Non-Disclosure Agreement governs the exchange of confidential information "
        + "between the parties in connection with a potential or ongoing supply relationship.",
    "Each party agrees to use the other's confidential information solely to evaluate and "
        + "perform that relationship, to protect it with the same care it uses for its own, and "
        + "not to disclose it to any third party without prior written consent.",
    "Confidential information includes drawings, specifications, pricing, tooling data, "
        + "process know-how and any information marked confidential or that a reasonable person "
        + "would understand to be confidential.",
    "This agreement remains in effect for the duration of the relationship and for three years "
        + "afterward. Neither party acquires any licence or ownership in the other's information."
];

const TERMS_BODY = [
    "These Terms & Conditions of Supply apply to every purchase order the customer places "
        + "unless a signed master agreement states otherwise.",
    "Acceptance: an order is accepted on written acknowledgement. Prices are firm for the "
        + "quantities and dates acknowledged.",
    "Quality: goods conform to the released drawing, the applicable specifications, and the "
        + "customer quality profile on file. Nonconforming goods are handled through the "
        + "supplier's documented NCR / CAPA process.",
    "Delivery, payment terms, warranty and change control follow the master agreement or, "
        + "in its absence, the terms stated on the order acknowledgement."
];

const SETUP_BODY = [
    "This Customer Setup Sheet captures the information needed to open and run the account. "
        + "Complete every field and return it to your account contact.",
    "Company: legal name, DUNS / tax ID, primary and remit-to addresses.",
    "Contacts: purchasing, quality, engineering and accounts payable - name, email, phone.",
    "Commercial: payment terms, currency, incoterms, preferred carrier and account number.",
    "Quality & engineering: certifications required, PPAP level, first-article expectations, "
        + "packaging and labeling standard, drawing and revision-control requirements."
];

const QUALITY_BODY = [
    "This Customer Quality Profile records the quality requirements this account is run to. "
        + "It is seeded with the supplier defaults below; edit it to match the customer's own "
        + "specification and quality agreement.",
    "Inspection: first article on every new part number and after a process change; "
        + "dimensional verification to the released drawing; cosmetic inspection to the "
        + "customer visual standard.",
    "Certifications: Certificate of Conformance with every shipment; material certs retained "
        + "and available on request; regulatory declarations on file where applicable.",
    "Packaging & labeling: parts individually protected; label carries part number, revision, "
        + "quantity, lot / date code and supplier code; one part number per container."
];

const STARTER_DOCS = [
    { file: "NDA.pdf",                      folder: "admin",   title: "Mutual Non-Disclosure Agreement", body: NDA_BODY },
    { file: "Terms-and-Conditions.pdf",     folder: "admin",   title: "Terms & Conditions of Supply",    body: TERMS_BODY },
    { file: "Customer-Setup-Sheet.pdf",     folder: "admin",   title: "Customer Setup Sheet",            body: SETUP_BODY },
    { file: "Quality-Profile-Template.pdf", folder: "quality", title: "Customer Quality Profile",        body: QUALITY_BODY }
];

/* ---------- helpers ---------- */

function slug(text) {
    return String(text || "").trim()
        .replace(/[^A-Za-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "customer";
}

async function orgName(orgId) {
    const r = await query("select name from organizations where id = $1", [orgId]);
    return r.rows[0]?.name || "QMS Guardian";
}

async function customerRow(orgId, customerId) {
    const r = await query(`
        select id, name, code, address, primary_contact_name, primary_contact_email, phone
          from customers where org_id = $1 and id = $2
    `, [orgId, customerId]);
    return r.rows[0] || null;
}

function folderRoot(cust) {
    return (cust.code ? cust.code + "-" : "") + slug(cust.name);
}

/* ---------- steps ---------- */

async function seedFolders({ orgId, customerId }) {
    const cust = await customerRow(orgId, customerId);
    if (!cust) throw new Error("No such customer");
    const root = folderRoot(cust);

    let touched = 0;
    for (const f of FOLDERS) {
        let storagePath = null;
        if (STORAGE_DRIVER === "local") {
            const dir = path.join(STORAGE_ROOT, "customer-folders", customerId, f.name);
            await fs.mkdir(dir, { recursive: true });
            storagePath = path.posix.join("customer-folders", customerId, f.name);
        }
        await query(`
            insert into customer_folders (customer_id, folder_key, name, position, path, storage_path, status)
            values ($1, $2, $3, $4, $5, $6, 'created')
            on conflict (customer_id, folder_key) do update set
                path = excluded.path,
                storage_path = coalesce(excluded.storage_path, customer_folders.storage_path),
                status = 'created'
        `, [customerId, f.key, f.name, f.position, root + "/" + f.name, storagePath]);
        touched += 1;
    }
    return { detail: touched + " folder(s) ensured under " + root + "/" };
}

async function syncMetadata({ orgId, customerId }) {
    const cust = await customerRow(orgId, customerId);
    if (!cust) throw new Error("No such customer");

    const hasContact = cust.primary_contact_name || cust.primary_contact_email || cust.phone;
    const contacts = hasContact ? [{
        role: "Primary",
        name: cust.primary_contact_name || null,
        email: cust.primary_contact_email || null,
        phone: cust.phone || null
    }] : [];

    await query(`
        insert into customer_metadata
            (customer_id, billing_address, shipping_address, contacts, folder_root, synced_at)
        values ($1, $2, $2, $3::jsonb, $4, now())
        on conflict (customer_id) do update set
            billing_address  = coalesce(customer_metadata.billing_address, excluded.billing_address),
            shipping_address = coalesce(customer_metadata.shipping_address, excluded.shipping_address),
            contacts    = case when customer_metadata.contacts = '[]'::jsonb
                               then excluded.contacts else customer_metadata.contacts end,
            folder_root = excluded.folder_root,
            synced_at   = now(),
            updated_at  = now()
    `, [customerId, cust.address || null, JSON.stringify(contacts), folderRoot(cust)]);

    return { detail: "Metadata snapshot synced from the customer record" };
}

/* column is one of two hard-coded jsonb columns - never user input. */
async function seedProfile(column, value, { customerId, force }) {
    await query(
        "insert into customer_metadata (customer_id) values ($1) on conflict (customer_id) do nothing",
        [customerId]
    );
    const cur = await query(
        "select " + column + " as v from customer_metadata where customer_id = $1", [customerId]);
    const existing = cur.rows[0]?.v || {};
    const isEmpty = Object.keys(existing).length === 0;

    if (!isEmpty && !force) {
        return { skipped: true, detail: "Profile already set - left as edited" };
    }
    await query(
        "update customer_metadata set " + column + " = $2::jsonb, updated_at = now() where customer_id = $1",
        [customerId, JSON.stringify(value)]);
    return { detail: isEmpty ? "Default profile created" : "Profile reset to default (force)" };
}

const seedQualityProfile = (ctx) => seedProfile("quality_requirements", DEFAULT_QUALITY, ctx);
const seedEngProfile = (ctx) => seedProfile("engineering_requirements", DEFAULT_ENGINEERING, ctx);

function renderPdf(orgTitle, cust, spec) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: "LETTER", margin: 48 });
        const chunks = [];
        doc.on("data", (c) => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        drawLetterhead(doc, orgTitle, spec.title);
        doc.moveDown(1);
        doc.fontSize(10).fillColor(INK_2)
            .text("Customer: " + cust.name + (cust.code ? "  (" + cust.code + ")" : ""))
            .text("Prepared: " + new Date().toISOString().slice(0, 10));
        doc.moveDown(1);
        doc.fontSize(10.5).fillColor(INK);
        for (const para of spec.body) {
            doc.text(para, { align: "left" });
            doc.moveDown(0.6);
        }
        doc.moveDown(1.5);
        doc.fontSize(9).fillColor(INK_2).text(
            "Generated as a starter template by QMS Guardian onboarding automation. "
            + "Replace it with your executed or customer-specific version.");
        drawFooter(doc, orgTitle);
        doc.end();
    });
}

async function generateStarterDocs({ orgId, customerId, userId }) {
    const cust = await customerRow(orgId, customerId);
    if (!cust) throw new Error("No such customer");
    const orgTitle = await orgName(orgId);

    await seedFolders({ orgId, customerId });
    const folders = await query(
        "select id, folder_key from customer_folders where customer_id = $1", [customerId]);
    const folderIdByKey = Object.fromEntries(folders.rows.map((r) => [r.folder_key, r.id]));

    let made = 0, existed = 0;
    for (const spec of STARTER_DOCS) {
        const folderId = folderIdByKey[spec.folder];
        const dup = await query(
            "select 1 from customer_documents where customer_id = $1 and folder_id = $2 and original_filename = $3",
            [customerId, folderId, spec.file]);
        if (dup.rowCount > 0) { existed += 1; continue; }

        const buffer = await renderPdf(orgTitle, cust, spec);
        const storagePath = await saveUploadedFile("customer-folders", [".pdf"], spec.file, buffer);

        await withTransaction(async (client) => {
            const row = await client.query(`
                insert into customer_documents
                    (org_id, customer_id, folder_id, kind, original_filename, mime_type,
                     size_bytes, storage_path, note, uploaded_by)
                values ($1, $2, $3, 'upload', $4, 'application/pdf', $5, $6,
                        'Generated by onboarding automation', $7)
                returning id
            `, [orgId, customerId, folderId, spec.file, buffer.length, storagePath, userId || null]);
            await client.query(`
                insert into audit_log (org_id, entity, entity_id, field, new_value, changed_by)
                values ($1, 'customer_documents', $2, 'generated', $3, $4)
            `, [orgId, row.rows[0].id, spec.file, userId || null]);
        });
        made += 1;
    }
    return { detail: made + " document(s) generated, " + existed + " already present" };
}

/* ---------- registry + runners ---------- */

const STEPS = {
    folders: seedFolders,
    metadata: syncMetadata,
    quality: seedQualityProfile,
    engineering: seedEngProfile,
    starter_docs: generateStarterDocs
};

export const AUTOMATION_STEPS = ["folders", "metadata", "quality", "engineering", "starter_docs"];

/* Run one step. Always writes an automation_logs row; never throws -
   a failure comes back as { status: "failed", error }. */
export async function runStep(orgId, customerId, userId, step, opts = {}) {
    const { force = false, source = "manual" } = opts;
    const fn = STEPS[step];
    if (!fn) throw new Error("Unknown automation step: " + step);

    const logRow = await query(`
        insert into automation_logs (org_id, customer_id, step, status, run_source, started_at)
        values ($1, $2, $3, 'running', $4, now())
        returning id
    `, [orgId, customerId, step, source]);
    const logId = logRow.rows[0].id;

    try {
        const out = await fn({ orgId, customerId, userId, force });
        const status = out && out.skipped ? "skipped" : "done";
        await query(
            "update automation_logs set status = $2, detail = $3, finished_at = now() where id = $1",
            [logId, status, out?.detail || null]);
        return { step, status, detail: out?.detail || null };
    } catch (error) {
        log.warn("automation_step_failed", { step, customerId, error: error.message });
        await query(
            "update automation_logs set status = 'failed', error = $2, finished_at = now() where id = $1",
            [logId, String(error.message).slice(0, 500)]);
        return { step, status: "failed", error: error.message };
    }
}

/* Run every step in order, continuing past a failure. */
export async function runFull(orgId, customerId, userId, opts = {}) {
    const { force = false, source = "auto" } = opts;
    const steps = [];
    for (const step of AUTOMATION_STEPS) {
        steps.push(await runStep(orgId, customerId, userId, step, { force, source }));
    }
    return { steps };
}
