/* ============================================================
   ISO 9001 turtle diagrams, one per department process.

   A turtle is a process box and six sides:
     inputs    - what the process receives
     outputs   - what it delivers
     resources - "with what": equipment, tooling, systems
     people    - "with whom": roles and competence
     methods   - "how": the procedures it runs to
     metrics   - "how measured": the KPIs that say it works

   Entries are plain text for now (the schema keeps a document_id
   column for linking them to controlled documents later). A diagram
   row is created lazily on first save; GET always returns something
   to render, real or a skeleton.
   ============================================================ */

import { Router } from "express";
import PDFDocument from "pdfkit";
import { query, withTransaction } from "../db.js";
import { requirePermission } from "../auth.js";
import { INK, INK_2, HAIRLINE, BRAND, drawLetterhead, drawFooter } from "../pdf-branding.js";

export const turtle = Router();

const DEPARTMENTS = ["purchasing", "production", "tooling", "quality", "engineering", "management"];
const DEPT_LABEL = {
    purchasing: "Purchasing", production: "Production", tooling: "Tooling",
    quality: "Quality", engineering: "Engineering", management: "Management"
};

const SIDES = ["inputs", "outputs", "resources", "people", "methods", "metrics"];
const SIDE_LABEL = {
    inputs:    "Inputs",
    outputs:   "Outputs",
    resources: "With what — equipment & resources",
    people:    "With whom — people & competence",
    methods:   "How — procedures & methods",
    metrics:   "How measured — KPIs & metrics"
};

function emptySides() {
    return Object.fromEntries(SIDES.map((s) => [s, []]));
}

function skeleton(department) {
    return {
        department,
        department_label: DEPT_LABEL[department],
        process_name: DEPT_LABEL[department] + " process",
        process_desc: null,
        sides: emptySides(),
        updated_at: null,
        updated_by: null,
        exists: false
    };
}

/* ---------- list ---------- */
turtle.get("/turtle", async (request, response, next) => {
    try {
        const rows = await query(`
            select d.department, d.process_name, d.updated_at,
                   u.full_name as updated_by,
                   count(e.id)::int as entry_count
              from turtle_diagrams d
         left join users u   on u.id = d.updated_by
         left join turtle_entries e on e.diagram_id = d.id
             where d.org_id = $1
             group by d.id, d.department, d.process_name, d.updated_at, u.full_name
        `, [request.user.org_id]);

        const byDept = new Map(rows.rows.map((r) => [r.department, r]));

        response.json({
            diagrams: DEPARTMENTS.map((department) => {
                const row = byDept.get(department);
                return row
                    ? { department, department_label: DEPT_LABEL[department],
                        process_name: row.process_name, entry_count: row.entry_count,
                        updated_at: row.updated_at, updated_by: row.updated_by, exists: true }
                    : { department, department_label: DEPT_LABEL[department],
                        process_name: DEPT_LABEL[department] + " process",
                        entry_count: 0, updated_at: null, updated_by: null, exists: false };
            })
        });
    } catch (error) {
        next(error);
    }
});

async function loadDiagram(orgId, department) {
    const found = await query(
        "select * from turtle_diagrams where org_id = $1 and department = $2",
        [orgId, department]
    );
    if (found.rowCount === 0) return skeleton(department);

    const diagram = found.rows[0];
    const entries = await query(`
        select e.side, e.text, e.position, d.doc_number
          from turtle_entries e
     left join documents d on d.id = e.document_id
         where e.diagram_id = $1
         order by e.side, e.position
    `, [diagram.id]);

    const sides = emptySides();
    for (const row of entries.rows) {
        sides[row.side].push({ text: row.text, doc_number: row.doc_number || null });
    }

    const who = diagram.updated_by
        ? (await query("select full_name from users where id = $1", [diagram.updated_by])).rows[0]?.full_name
        : null;

    return {
        department,
        department_label: DEPT_LABEL[department],
        process_name: diagram.process_name,
        process_desc: diagram.process_desc,
        sides,
        updated_at: diagram.updated_at,
        updated_by: who || null,
        exists: true
    };
}

/* ---------- one department ---------- */
turtle.get("/turtle/:department", async (request, response, next) => {
    try {
        const department = request.params.department;
        if (!DEPARTMENTS.includes(department)) {
            return response.status(400).json({ error: "Unknown department" });
        }
        response.json(await loadDiagram(request.user.org_id, department));
    } catch (error) {
        next(error);
    }
});

/* ---------- save (replace-all) ---------- */
turtle.put("/turtle/:department", requirePermission("turtle.manage"),
    async (request, response, next) => {
    try {
        const department = request.params.department;
        if (!DEPARTMENTS.includes(department)) {
            return response.status(400).json({ error: "Unknown department" });
        }

        const body = request.body || {};
        const processName = (body.process_name || "").trim();
        if (!processName) {
            return response.status(400).json({ error: "process_name is required" });
        }

        const incoming = body.sides || {};
        const cleaned = Object.fromEntries(SIDES.map((side) => [
            side,
            (Array.isArray(incoming[side]) ? incoming[side] : [])
                .map((entry) => (typeof entry === "string" ? entry : entry?.text || "").trim())
                .filter(Boolean)
        ]));

        await withTransaction(async (client) => {
            const upserted = await client.query(`
                insert into turtle_diagrams (org_id, department, process_name, process_desc, updated_by, updated_at)
                values ($1, $2, $3, $4, $5, now())
                on conflict (org_id, department) do update set
                    process_name = excluded.process_name,
                    process_desc = excluded.process_desc,
                    updated_by   = excluded.updated_by,
                    updated_at   = now()
                returning id
            `, [request.user.org_id, department, processName,
                (body.process_desc || "").trim() || null, request.user.id]);

            const diagramId = upserted.rows[0].id;
            await client.query("delete from turtle_entries where diagram_id = $1", [diagramId]);

            for (const side of SIDES) {
                for (let i = 0; i < cleaned[side].length; i += 1) {
                    await client.query(
                        "insert into turtle_entries (diagram_id, side, text, position) values ($1, $2, $3, $4)",
                        [diagramId, side, cleaned[side][i], i]
                    );
                }
            }

            await client.query(`
                insert into audit_log (org_id, entity, entity_id, field, new_value, changed_by)
                values ($1, 'turtle_diagrams', $2, 'updated', $3, $4)
            `, [request.user.org_id, diagramId, department, request.user.id]);
        });

        response.json(await loadDiagram(request.user.org_id, department));
    } catch (error) {
        next(error);
    }
});

/* ---------- branded one-page PDF ---------- */
turtle.get("/turtle/:department/pdf", async (request, response, next) => {
    try {
        const department = request.params.department;
        if (!DEPARTMENTS.includes(department)) {
            return response.status(400).json({ error: "Unknown department" });
        }

        const [org, diagram] = await Promise.all([
            query("select name from organizations where id = $1", [request.user.org_id]),
            loadDiagram(request.user.org_id, department)
        ]);
        const orgName = org.rows[0]?.name || "";

        response.setHeader("Content-Type", "application/pdf");
        response.setHeader("Content-Disposition",
            "attachment; filename=\"turtle-" + department + ".pdf\"");

        const doc = new PDFDocument({ size: "letter", margin: 54, bufferPages: true });
        doc.pipe(response);

        drawLetterhead(doc, orgName);

        doc.fillColor(INK).font("Helvetica-Bold").fontSize(16)
            .text("Turtle diagram — " + DEPT_LABEL[department] + " process", { continued: false });
        doc.moveDown(0.3);
        doc.font("Helvetica-Bold").fontSize(12).fillColor(BRAND).text(diagram.process_name);
        if (diagram.process_desc) {
            doc.moveDown(0.2);
            doc.font("Helvetica").fontSize(10).fillColor(INK_2).text(diagram.process_desc);
        }
        doc.moveDown(0.8);

        const left = doc.page.margins.left;
        const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
        const colGap = 18;
        const colWidth = (width - colGap) / 2;

        let y = doc.y;
        SIDES.forEach((side, index) => {
            const col = index % 2;
            const x = left + col * (colWidth + colGap);
            if (col === 0 && index > 0) y = doc.y + 10;

            doc.font("Helvetica-Bold").fontSize(9).fillColor(BRAND)
                .text(SIDE_LABEL[side].toUpperCase(), x, y, { width: colWidth });
            const lines = diagram.sides[side];
            doc.font("Helvetica").fontSize(10).fillColor(INK);
            if (lines.length === 0) {
                doc.fillColor("#9AA7A4").text("—", x, doc.y + 2, { width: colWidth });
            } else {
                for (const entry of lines) {
                    doc.fillColor(INK).text("•  " + entry.text
                        + (entry.doc_number ? "  (" + entry.doc_number + ")" : ""),
                        x, doc.y + 2, { width: colWidth });
                }
            }

            if (col === 1) {
                doc.strokeColor(HAIRLINE).moveTo(left, doc.y + 8)
                    .lineTo(left + width, doc.y + 8).stroke();
                doc.moveDown(0.6);
            }
        });

        doc.moveDown(1);
        doc.font("Helvetica").fontSize(8).fillColor(INK_2).text(
            "Reviewed against ISO 9001:2015 clause 4.4 — processes and their interactions."
            + (diagram.updated_by ? "  Last updated by " + diagram.updated_by + "." : "")
        );

        const range = doc.bufferedPageRange();
        for (let i = range.start; i < range.start + range.count; i += 1) {
            doc.switchToPage(i);
            drawFooter(doc, orgName);
        }

        doc.end();
    } catch (error) {
        next(error);
    }
});
