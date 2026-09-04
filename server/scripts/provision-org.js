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
     - all eight record types, each with a working workflow and a
       plain default form
     - one admin account, holding every permission, with a temporary
       password that must be replaced on first sign-in

   This assumes the PERMISSIONS catalog already exists - it is the
   one thing that stays global, seeded once by db/seed.sql when the
   database was first set up. Everything else here is org-scoped and
   created fresh for this company alone.
   ============================================================ */

import { pool, withTransaction } from "../src/db.js";
import { hashPassword, generateTemporaryPassword } from "../src/passwords.js";

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
        "drawing.read", "training.read"],

    quality_inspector: [
        "ncr.read", "ncr.create", "ncr.contain", "capa.read", "complaint.read",
        "document.read", "drawing.read", "production.read", "shipping.read",
        "shipping.release", "gage.read", "training.read", "audit.read"],

    quality_tech: [
        "ncr.read", "ncr.create", "ncr.contain", "ncr.disposition",
        "capa.read", "capa.create", "complaint.read", "complaint.create",
        "document.read", "drawing.read", "production.read", "production.hold",
        "shipping.read", "gage.read", "gage.calibrate", "training.read",
        "training.record", "audit.read", "risk.read", "vendor.read", "scar.issue"],

    quality_engineer: [
        "ncr.read", "ncr.create", "ncr.contain", "ncr.disposition", "mrb.signoff",
        "capa.read", "capa.create", "complaint.read", "complaint.create",
        "document.read", "document.create", "drawing.read",
        "production.read", "production.hold", "shipping.read",
        "gage.read", "gage.calibrate", "training.read", "training.record",
        "audit.read", "audit.schedule", "risk.read", "risk.manage",
        "vendor.read", "scar.issue"],

    design_engineer: [
        "ncr.read", "ncr.create", "capa.read",
        "document.read", "document.create",
        "drawing.read", "drawing.create", "drawing.edit",
        "change.create", "production.read", "training.read"],

    manufacturing_engineer: [
        "ncr.read", "ncr.create", "capa.read", "capa.create",
        "document.read", "document.create", "drawing.read",
        "change.create", "production.read", "production.hold", "production.release",
        "gage.read", "training.read", "training.record"],

    document_controller: [
        "ncr.read", "document.read", "document.create", "document.approve",
        "document.release", "document.obsolete", "drawing.read",
        "training.read", "training.record", "audit.read"],

    purchasing_manager: [
        "ncr.read", "capa.read", "document.read",
        "vendor.read", "vendor.approve", "vendor.suspend", "scar.issue",
        "production.read", "audit.read", "risk.read"],

    production_manager: [
        "ncr.read", "ncr.create", "ncr.contain", "capa.read",
        "document.read", "drawing.read",
        "production.read", "production.hold", "production.release",
        "shipping.read", "training.read", "training.record", "risk.read"],

    engineering_manager: [
        "ncr.read", "ncr.create", "ncr.disposition", "mrb.signoff",
        "capa.read", "capa.create",
        "document.read", "document.create", "document.approve",
        "drawing.read", "drawing.create", "drawing.edit", "drawing.release",
        "change.create", "change.approve",
        "production.read", "production.release", "training.read",
        "audit.read", "risk.read", "risk.manage", "user.read"],

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
        "risk.read", "risk.manage", "user.read", "forms.manage"]

    /* general_manager and admin are not listed here: general_manager
       gets every permission that exists, and admin gets every "read"
       plus the user/roles resources, both computed below from
       whatever the permissions catalog actually contains rather than
       a list that could drift from it. */
};

/* ---------- record types, workflows and default forms ----------
   Every state key and permission used here already exists (states are
   defined right alongside their type; permissions come from the
   catalog seeded once, globally, by db/seed.sql). Nothing invented. */

const RECORD_TYPES = [
    { key: "ncr",       name: "Nonconformance",      prefix: "NCR",  clause: "8.7" },
    { key: "capa",      name: "Corrective Action",   prefix: "CAPA", clause: "10.2" },
    { key: "eightd",    name: "8D Investigation",    prefix: "8D",   clause: "10.2" },
    { key: "complaint", name: "Customer Complaint",  prefix: "COMP", clause: "8.2.1" },
    { key: "scar",      name: "Supplier Corrective", prefix: "SCAR", clause: "8.4" },
    { key: "audit",     name: "Internal Audit",      prefix: "AUD",  clause: "9.2" },
    { key: "ecn",       name: "Engineering Change",  prefix: "ECN",  clause: "8.5.6" },
    { key: "risk",      name: "Risk or Opportunity", prefix: "R",    clause: "6.1" }
];

const WORKFLOWS = {
    ncr: {
        states: [
            ["draft", "Draft", 1, false], ["containment", "Containment", 2, false],
            ["mrb", "MRB review", 3, false], ["disposition", "Disposition executed", 4, false],
            ["verify", "Verification", 5, false], ["closed", "Closed", 6, true]
        ],
        transitions: [
            ["draft", "containment", "ncr.contain"], ["containment", "mrb", "ncr.disposition"],
            ["mrb", "disposition", "ncr.disposition"], ["disposition", "verify", "ncr.contain"],
            ["verify", "closed", "ncr.close"]
        ]
    },
    capa: {
        states: [
            ["draft", "Draft", 1, false], ["investigation", "Investigation", 2, false],
            ["root_cause", "Root cause", 3, false], ["eightd_linked", "Linked to 8D", 4, false],
            ["action_plan", "Action plan", 5, false], ["verify", "Verify implementation", 6, false],
            ["effectiveness", "Effectiveness check", 7, false], ["closed", "Closed", 8, true]
        ],
        transitions: [
            ["draft", "investigation", "capa.create"], ["investigation", "root_cause", "capa.create"],
            ["investigation", "eightd_linked", "capa.create"], ["eightd_linked", "action_plan", "capa.create"],
            ["root_cause", "action_plan", "capa.create"], ["action_plan", "verify", "capa.create"],
            ["verify", "effectiveness", "capa.create"], ["effectiveness", "closed", "capa.close"]
        ]
    },
    eightd: {
        states: [
            ["d1", "D1 Team formed", 1, false], ["d2", "D2 Problem described", 2, false],
            ["d3", "D3 Interim containment", 3, false], ["d4", "D4 Root cause", 4, false],
            ["d5", "D5 Corrective action", 5, false], ["d6", "D6 Implement and validate", 6, false],
            ["d7", "D7 Prevent recurrence", 7, false], ["d8", "D8 Recognise the team", 8, false],
            ["closed", "Closed", 9, true]
        ],
        transitions: [
            ["d1", "d2", "capa.create"], ["d2", "d3", "ncr.contain"], ["d3", "d4", "capa.create"],
            ["d4", "d5", "capa.create"], ["d5", "d6", "capa.create"], ["d6", "d7", "capa.create"],
            ["d7", "d8", "capa.create"], ["d8", "closed", "capa.close"]
        ]
    },
    complaint: {
        states: [
            ["draft", "Draft", 1, false], ["investigating", "Investigating", 2, false],
            ["with_logistics", "With logistics", 3, false], ["response_drafted", "Response drafted", 4, false],
            ["response_received", "Customer response in", 5, false], ["closed", "Closed", 6, true]
        ],
        transitions: [
            ["draft", "investigating", "complaint.create"], ["investigating", "with_logistics", "complaint.create"],
            ["investigating", "response_drafted", "complaint.respond"], ["with_logistics", "response_drafted", "complaint.respond"],
            ["response_drafted", "response_received", "complaint.respond"], ["response_received", "closed", "complaint.respond"]
        ]
    },
    scar: {
        states: [
            ["draft", "Draft", 1, false], ["awaiting_8d", "Awaiting supplier 8D", 2, false],
            ["response_received", "Response received", 3, false], ["closed", "Closed", 4, true]
        ],
        transitions: [
            ["draft", "awaiting_8d", "scar.issue"], ["awaiting_8d", "response_received", "scar.issue"],
            ["response_received", "closed", "scar.issue"]
        ]
    },
    audit: {
        states: [
            ["draft", "Draft", 1, false], ["scheduled", "Scheduled", 2, false],
            ["overdue", "Overdue", 3, false], ["closed", "Closed", 4, true]
        ],
        transitions: [
            ["draft", "scheduled", "audit.schedule"], ["scheduled", "overdue", "audit.schedule"],
            ["scheduled", "closed", "audit.close"], ["overdue", "closed", "audit.close"]
        ]
    },
    ecn: {
        states: [
            ["draft", "Draft", 1, false], ["impact", "Impact assessment", 2, false],
            ["review", "In review", 3, false], ["approved", "Approved", 4, false],
            ["implemented", "Implemented", 5, true]
        ],
        transitions: [
            ["draft", "impact", "change.create"], ["impact", "review", "change.create"],
            ["review", "approved", "change.approve"], ["approved", "implemented", "change.approve"]
        ]
    },
    risk: {
        states: [
            ["draft", "Draft", 1, false], ["unmitigated", "Unmitigated", 2, false],
            ["opportunity", "Opportunity", 3, false], ["in_progress", "In progress", 4, false],
            ["controlled", "Controlled", 5, true]
        ],
        transitions: [
            ["draft", "unmitigated", "risk.manage"], ["draft", "opportunity", "risk.manage"],
            ["unmitigated", "in_progress", "risk.manage"], ["opportunity", "in_progress", "risk.manage"],
            ["in_progress", "controlled", "risk.manage"]
        ]
    }
};

/* Plain, generic default forms - free-text where Ridgeline's own forms
   link to master data (parts, gages, lots) that a brand new company
   has not entered yet. A company can move a field to a link once it
   has something for that field to link to. */
const FORMS = {
    ncr: [
        { key: "part_number",   label: "Part number",       type: "text" },
        { key: "lot_number",    label: "Lot or serial",     type: "text" },
        { key: "qty_affected",  label: "Quantity affected", type: "number", min: 0 },
        { key: "characteristic", label: "Characteristic",   type: "text" },
        { key: "measured",      label: "Measured value",    type: "text" },
        { key: "gage_id",       label: "Gage used",         type: "text" },
        { key: "disposition",   label: "Disposition",       type: "select", required: true,
          options: ["Rework", "Scrap", "Use-as-is", "Return to supplier", "Regrade"] },
        { key: "containment",   label: "Containment",       type: "memo" }
    ],
    capa: [
        { key: "source",                  label: "Source",                     type: "text" },
        { key: "problem_statement",       label: "Problem statement",          type: "memo", required: true },
        { key: "root_cause",              label: "Root cause",                 type: "memo" },
        { key: "corrective_action",       label: "Corrective action",          type: "memo" },
        { key: "effectiveness_criterion", label: "How effectiveness is judged", type: "memo" }
    ],
    eightd: [
        { key: "customer", label: "Customer", type: "text" },
        { key: "summary",  label: "Summary",  type: "memo" }
    ],
    complaint: [
        { key: "customer",    label: "Customer",       type: "text", required: true },
        { key: "contact",     label: "Contact",        type: "text" },
        { key: "part_number", label: "Part number",    type: "text" },
        { key: "qty",         label: "Quantity",       type: "number", min: 0 },
        { key: "description", label: "Description",    type: "memo", required: true }
    ],
    scar: [
        { key: "vendor",  label: "Vendor",  type: "text", required: true },
        { key: "process", label: "Process", type: "text" },
        { key: "issue",   label: "Issue",   type: "memo", required: true }
    ],
    audit: [
        { key: "scope",   label: "Scope",   type: "text", required: true },
        { key: "auditor", label: "Auditor", type: "text" },
        { key: "planned", label: "Planned date", type: "date" }
    ],
    ecn: [
        { key: "part_number", label: "Part number", type: "text", required: true },
        { key: "from_rev",    label: "From revision", type: "text" },
        { key: "to_rev",      label: "To revision",   type: "text" },
        { key: "reason",      label: "Reason for change", type: "memo", required: true }
    ],
    risk: [
        { key: "process",    label: "Process",    type: "text" },
        { key: "severity",   label: "Severity (1-10)",   type: "number", min: 1 },
        { key: "occurrence", label: "Occurrence (1-10)", type: "number", min: 1 },
        { key: "detection",  label: "Detection (1-10)",  type: "number", min: 1 },
        { key: "action",     label: "Planned action",    type: "memo" }
    ]
};

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
             where action = 'read' or resource in ('user', 'roles', 'forms')
        `, [orgId]);

        for (const type of RECORD_TYPES) {
            const inserted = await client.query(
                "insert into record_types (org_id, key, name, prefix, clause) values ($1, $2, $3, $4, $5) returning id",
                [orgId, type.key, type.name, type.prefix, type.clause]
            );
            const recordTypeId = inserted.rows[0].id;

            const workflow = WORKFLOWS[type.key];
            for (const [key, name, position, isTerminal] of workflow.states) {
                await client.query(
                    "insert into workflow_states (record_type_id, key, name, position, is_terminal) values ($1, $2, $3, $4, $5)",
                    [recordTypeId, key, name, position, isTerminal]
                );
            }
            for (const [fromState, toState, permission] of workflow.transitions) {
                await client.query(
                    "insert into workflow_transitions (record_type_id, from_state, to_state, required_permission) values ($1, $2, $3, $4)",
                    [recordTypeId, fromState, toState, permission]
                );
            }

            await client.query(
                `insert into form_versions (record_type_id, version, schema, published_at)
                 values ($1, 1, $2, now())`,
                [recordTypeId, JSON.stringify({ fields: FORMS[type.key], rules: [] })]
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
