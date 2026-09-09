/* ============================================================
   Provision a new company.

     node --env-file=.env scripts/provision-org.js \
         "Acme Manufacturing" "owner@acme.example" "Jordan Lee" [site code] [site name]

   Manual pilot onboarding: you run this once per new company while
   there is no public sign-up page yet. It creates everything a
   company needs to start using the system on its own data, with
   nobody else's:

     - an organization and a site
     - its own copy of the standard role list and permission grants
       (the same starting matrix Ridgeline has - a company edits its
       own copy afterwards through the permission matrix screen,
       which can never again affect any other company's)
     - every built-in record type (src/record-definitions/), each with
       a working workflow and a plain default form
     - one admin account, holding every permission, with a temporary
       password that must be replaced on first sign-in

   This assumes the PERMISSIONS catalog already exists - it is the
   one thing that stays global, seeded once by db/seed.sql when the
   database was first set up. Everything else here is org-scoped and
   created fresh for this company alone.
   ============================================================ */

import { pool, withTransaction } from "../src/db.js";
import { hashPassword, generateTemporaryPassword } from "../src/passwords.js";
import { allDefinitions } from "../src/record-definitions/index.js";

/* ---------- the starting role list and what each one may do ----------
   Exactly the matrix Ridgeline was seeded with. A new company gets
   this as a sensible default and can reshape it from here; nothing
   about these choices is special-cased to Ridgeline itself. */

const ROLES = [
    ["operator",               "Operator",               "Runs production. Raises problems, does not decide their fate.",        1],
    ["quality_inspector",      "Quality Inspector",       "Verifies product against the drawing. Reads widely, writes narrowly.", 2],
    ["quality_tech",           "Quality Tech",            "Investigates, dispositions routine nonconformance, calibrates.",       3],
    ["quality_engineer",       "Quality Engineer",        "Owns quality tooling and MRB. Signs off dispositions.",                4],
    ["design_engineer",        "Design Engineer",         "Creates and edits product drawings. Cannot release them.",             5],
    ["manufacturing_engineer", "Manufacturing Engineer",  "Owns process, tooling and work instructions.",                         6],
    ["document_controller",    "Document Controller",     "Custodian of controlled documents and the revision record.",           7],
    ["purchasing_manager",     "Purchasing Manager",      "Owns the supply base and supplier corrective action.",                 8],
    ["production_manager",     "Production Manager",      "Owns the schedule, the floor, and production holds.",                  9],
    ["engineering_manager",    "Engineering Manager",     "Releases drawings and changes. Signs MRB for design intent.",         10],
    ["quality_manager",        "Quality Manager",         "Final quality authority. Approves use-as-is, closes CAPA.",           11],
    ["general_manager",        "General Manager",         "Accountable for the whole QMS. Holds every authority.",               12],
    ["admin",                  "Administrator",           "Manages users and access. Deliberately holds no quality authority.",  13]
];

const GRANTS = {
    operator: [
        "ncr.read", "ncr.create", "production.read", "document.read",
        "drawing.read", "training.read", "lpa.read"],

    quality_inspector: [
        "ncr.read", "ncr.create", "ncr.contain", "capa.read", "complaint.read",
        "document.read", "drawing.read", "production.read", "shipping.read",
        "shipping.release", "gage.read", "training.read", "audit.read", "di.read",
        "receiving.log", "fair.read", "fair.manage", "lpa.read", "lpa.audit"],

    quality_tech: [
        "ncr.read", "ncr.create", "ncr.contain", "ncr.disposition",
        "capa.read", "capa.create", "complaint.read", "complaint.create",
        "document.read", "drawing.read", "production.read", "production.hold",
        "shipping.read", "gage.read", "gage.calibrate", "training.read",
        "training.record", "audit.read", "di.read", "risk.read", "vendor.read",
        "scar.issue", "receiving.log", "fair.read", "fair.manage", "lpa.read", "lpa.audit"],

    quality_engineer: [
        "ncr.read", "ncr.create", "ncr.contain", "ncr.disposition", "mrb.signoff",
        "capa.read", "capa.create", "complaint.read", "complaint.create",
        "document.read", "document.create", "drawing.read",
        "production.read", "production.hold", "shipping.read",
        "gage.read", "gage.calibrate", "training.read", "training.record",
        "audit.read", "audit.schedule", "di.read", "di.manage", "risk.read", "risk.manage",
        "vendor.read", "scar.issue", "apqp.manage", "receiving.log", "fair.read", "fair.manage",
        "review.manage", "ppap.manage", "lpa.read", "lpa.audit", "lpa.manage"],

    design_engineer: [
        "ncr.read", "ncr.create", "capa.read",
        "document.read", "document.create",
        "drawing.read", "drawing.create", "drawing.edit",
        "change.create", "production.read", "training.read"],

    manufacturing_engineer: [
        "ncr.read", "ncr.create", "capa.read", "capa.create",
        "document.read", "document.create", "drawing.read",
        "change.create", "production.read", "production.hold", "production.release",
        "gage.read", "training.read", "training.record", "di.read", "di.manage", "apqp.manage",
        "wo.log", "ppap.manage", "lpa.read", "lpa.audit"],

    document_controller: [
        "ncr.read", "document.read", "document.create", "document.approve",
        "document.release", "document.obsolete", "drawing.read",
        "training.read", "training.record", "audit.read", "di.read"],

    purchasing_manager: [
        "ncr.read", "capa.read", "document.read",
        "vendor.read", "vendor.approve", "vendor.suspend", "scar.issue",
        "production.read", "audit.read", "risk.read", "purchasing.log", "review.manage"],

    production_manager: [
        "ncr.read", "ncr.create", "ncr.contain", "capa.read",
        "document.read", "drawing.read",
        "production.read", "production.hold", "production.release",
        "shipping.read", "training.read", "training.record", "risk.read",
        "purchasing.log", "wo.log", "review.manage", "lpa.read", "lpa.audit"],

    engineering_manager: [
        "ncr.read", "ncr.create", "ncr.disposition", "mrb.signoff",
        "capa.read", "capa.create",
        "document.read", "document.create", "document.approve",
        "drawing.read", "drawing.create", "drawing.edit", "drawing.release",
        "change.create", "change.approve",
        "production.read", "production.release", "training.read",
        "audit.read", "di.read", "di.manage", "risk.read", "risk.manage", "user.read",
        "apqp.manage", "review.manage", "ppap.manage", "lpa.read", "lpa.audit", "lpa.manage"],

    quality_manager: [
        "ncr.read", "ncr.create", "ncr.contain", "ncr.disposition", "ncr.use_as_is",
        "ncr.close", "mrb.signoff",
        "capa.read", "capa.create", "capa.close",
        "complaint.read", "complaint.create", "complaint.respond",
        "document.read", "document.create", "document.approve", "document.release",
        "document.obsolete", "drawing.read", "change.create", "change.approve",
        "vendor.read", "vendor.approve", "vendor.suspend", "scar.issue",
        "production.read", "production.hold", "production.release",
        "shipping.read", "shipping.release",
        "gage.read", "gage.calibrate", "gage.retire",
        "training.read", "training.record",
        "audit.read", "audit.schedule", "audit.close",
        "di.read", "di.manage", "di.close",
        "risk.read", "risk.manage", "user.read", "forms.manage", "apqp.manage", "receiving.log",
        "purchasing.log", "wo.log", "layout.manage", "fair.read", "fair.manage", "review.manage",
        "ppap.manage", "lpa.read", "lpa.audit", "lpa.manage"]

    /* general_manager and admin are not listed here: general_manager
       gets every permission that exists, and admin gets every "read"
       plus the user/roles resources, both computed below from
       whatever the permissions catalog actually contains rather than
       a list that could drift from it. */
};

/* Record types, their workflows and their default forms are defined
   once in src/record-definitions/ - see allDefinitions(). This
   provisioner and the db seed both build from that single source. */

function deriveInitials(fullName) {
    const parts = fullName.trim().split(/\s+/).filter(Boolean);
    const first = parts[0]?.[0] || "X";
    const last = parts.length > 1 ? parts[parts.length - 1][0] : "X";
    return (first + last).toUpperCase();
}

export async function provisionOrganization({ companyName, adminEmail, adminName, siteCode = "MAIN", siteName = "Main site" }) {
    const temporary = generateTemporaryPassword();
    const { hash, salt } = await hashPassword(temporary);
    const adminInitials = deriveInitials(adminName);

    const result = await withTransaction(async (client) => {
        const org = await client.query(
            "insert into organizations (name) values ($1) returning id",
            [companyName]
        );
        const orgId = org.rows[0].id;

        await client.query(
            "insert into sites (org_id, code, name) values ($1, $2, $3)",
            [orgId, siteCode, siteName]
        );

        for (const [key, name, description, position] of ROLES) {
            await client.query(
                "insert into roles (org_id, key, name, description, position) values ($1, $2, $3, $4, $5)",
                [orgId, key, name, description, position]
            );
        }

        for (const [roleKey, permissionKeys] of Object.entries(GRANTS)) {
            for (const permissionKey of permissionKeys) {
                await client.query(
                    "insert into role_permissions (org_id, role_key, permission_key) values ($1, $2, $3)",
                    [orgId, roleKey, permissionKey]
                );
            }
        }

        /* general_manager: everything the catalog defines. admin:
           every read, plus the two resources access control itself
           lives under. Computed from the catalog so a permission
           added later is covered without editing this file. */
        await client.query(`
            insert into role_permissions (org_id, role_key, permission_key)
            select $1, 'general_manager', key from permissions
        `, [orgId]);

        await client.query(`
            insert into role_permissions (org_id, role_key, permission_key)
            select $1, 'admin', key from permissions
             where action = 'read' or resource in ('user', 'roles', 'forms', 'layout')
        `, [orgId]);

        for (const def of allDefinitions()) {
            const inserted = await client.query(
                "insert into record_types (org_id, key, name, prefix, clause) values ($1, $2, $3, $4, $5) returning id",
                [orgId, def.key, def.name, def.prefix, def.clause]
            );
            const recordTypeId = inserted.rows[0].id;

            for (const [key, name, position, isTerminal] of def.states) {
                await client.query(
                    "insert into workflow_states (record_type_id, key, name, position, is_terminal) values ($1, $2, $3, $4, $5)",
                    [recordTypeId, key, name, position, isTerminal]
                );
            }
            for (const [fromState, toState, permission] of def.transitions) {
                await client.query(
                    "insert into workflow_transitions (record_type_id, from_state, to_state, required_permission) values ($1, $2, $3, $4)",
                    [recordTypeId, fromState, toState, permission]
                );
            }

            await client.query(
                `insert into form_versions (record_type_id, version, schema, published_at)
                 values ($1, 1, $2, now())`,
                [recordTypeId, JSON.stringify({ fields: def.form.fields, rules: def.form.rules })]
            );
        }

        const admin = await client.query(`
            insert into users
                (org_id, email, full_name, initials, role,
                 password_hash, password_salt, must_change_password)
            values ($1, $2, $3, $4, 'general_manager', $5, $6, true)
            returning id, initials, full_name, email
        `, [orgId, adminEmail, adminName, adminInitials, hash, salt]);

        return { orgId, admin: admin.rows[0] };
    });

    return { ...result, temporaryPassword: temporary };
}

/* Run directly rather than imported. */
if (process.argv[1] && process.argv[1].endsWith("provision-org.js")) {
    const [companyName, adminEmail, adminName, siteCode, siteName] = process.argv.slice(2);

    if (!companyName || !adminEmail || !adminName) {
        console.error("Usage: node scripts/provision-org.js \"<company name>\" <admin email> \"<admin full name>\" [site code] [site name]");
        process.exitCode = 1;
    } else {
        try {
            const { orgId, admin, temporaryPassword } = await provisionOrganization({
                companyName, adminEmail, adminName,
                ...(siteCode ? { siteCode } : {}),
                ...(siteName ? { siteName } : {})
            });

            console.log("Provisioned " + companyName);
            console.log("  org id:   " + orgId);
            console.log("  sign in:  " + admin.email);
            console.log("  password: " + temporaryPassword);
            console.log("");
            console.log("This is shown once. Give it to " + admin.full_name + " directly;");
            console.log("they will be asked to set their own password on first sign-in.");
        } catch (error) {
            console.error("Provisioning failed: " + error.message);
            process.exitCode = 1;
        } finally {
            await pool.end();
        }
    }
}
