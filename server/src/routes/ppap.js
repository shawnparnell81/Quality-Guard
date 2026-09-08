/* ============================================================
   PPAP submission package, clause 8.3.4.4.

   A PPAP record carries the 18 AIAG elements as slots (ppap_elements).
   Each slot points at the record or controlled document that
   satisfies it - a free-text reference the screen makes clickable -
   or is marked not applicable with a note. Which elements a package
   must have on file before it can be submitted is set by its level;
   the gate is enforced in the record's transition to "submitted"
   (routes/records.js).
   ============================================================ */

import { Router } from "express";
import { query } from "../db.js";
import { requirePermission } from "../auth.js";

export const ppap = Router();

/* The 18 elements, in AIAG order. */
export const PPAP_ELEMENTS = [
    [1,  "Design records"],
    [2,  "Authorised engineering change documents"],
    [3,  "Customer engineering approval"],
    [4,  "Design FMEA (DFMEA)"],
    [5,  "Process flow diagram"],
    [6,  "Process FMEA (PFMEA)"],
    [7,  "Control plan"],
    [8,  "Measurement system analysis (MSA)"],
    [9,  "Dimensional results"],
    [10, "Records of material / performance tests"],
    [11, "Initial process studies (capability)"],
    [12, "Qualified laboratory documentation"],
    [13, "Appearance approval report (AAR)"],
    [14, "Sample production parts"],
    [15, "Master sample"],
    [16, "Checking aids"],
    [17, "Customer-specific requirements"],
    [18, "Part submission warrant (PSW)"]
];

const ELEMENT_NAME = new Map(PPAP_ELEMENTS);

/* What each submission level must have on file before "submitted".
   Levels 1 and 4 send the PSW plus whatever the customer separately
   defines; 2 is samples + limited data; 3 and 5 are the full pack. */
export const REQUIRED_BY_LEVEL = {
    1: [18],
    2: [3, 9, 13, 14, 18],
    3: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 18],
    4: [18],
    5: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 18]
};

export function levelOf(data) {
    const match = /([1-5])/.exec(String((data && data.submission_level) || ""));
    return match ? Number(match[1]) : 3;
}

const isFilled = (row) =>
    row.not_applicable || (row.reference != null && String(row.reference).trim() !== "");

/* The required element numbers a package still has nothing on file
   for. runQuery is query() or a transaction client's, so this works
   both standalone and inside the transition transaction. */
export async function ppapMissing(runQuery, recordId, data) {
    const required = REQUIRED_BY_LEVEL[levelOf(data)] || [18];
    const rows = await runQuery(
        "select element, reference, not_applicable from ppap_elements where record_id = $1",
        [recordId]
    );
    const filled = new Set(rows.rows.filter(isFilled).map((r) => r.element));
    return required.filter((n) => !filled.has(n)).map((n) => ({ element: n, name: ELEMENT_NAME.get(n) }));
}

async function findPpap(orgId, number) {
    const found = await query(`
        select r.id, r.number, r.status, r.data
          from records r join record_types rt on rt.id = r.record_type_id
         where r.org_id = $1 and r.number = $2 and rt.key = 'ppap'
    `, [orgId, number]);
    return found.rows[0] || null;
}

/* GET /api/ppap/PPAP-2026-0003
   The whole package: the record's level, all 18 slots with their
   fill state, and the submit gate. */
ppap.get("/ppap/:number", async (request, response, next) => {
    try {
        const record = await findPpap(request.user.org_id, request.params.number);
        if (!record) return response.status(404).json({ error: "No such PPAP" });

        const slots = await query(`
            select e.element, e.reference, e.note, e.not_applicable, e.updated_at,
                   u.full_name as updated_by,
                   lr.status as linked_status, lr.title as linked_title
              from ppap_elements e
         left join users u on u.id = e.updated_by
         left join records lr on lr.org_id = $2 and lr.number = e.reference
             where e.record_id = $1
        `, [record.id, request.user.org_id]);

        const byElement = new Map(slots.rows.map((r) => [r.element, r]));
        const level = levelOf(record.data);
        const required = new Set(REQUIRED_BY_LEVEL[level] || [18]);

        const elements = PPAP_ELEMENTS.map(([n, name]) => {
            const slot = byElement.get(n) || null;
            return {
                element: n,
                name,
                required: required.has(n),
                reference: slot ? slot.reference : null,
                note: slot ? slot.note : null,
                not_applicable: slot ? slot.not_applicable : false,
                filled: slot ? isFilled(slot) : false,
                linked_status: slot ? slot.linked_status : null,
                linked_title: slot ? slot.linked_title : null,
                updated_by: slot ? slot.updated_by : null,
                updated_at: slot ? slot.updated_at : null
            };
        });

        const missing = elements.filter((e) => e.required && !e.filled).map((e) => e.name);

        response.json({
            number: record.number,
            status: record.status,
            level,
            elements,
            gate: {
                required: [...required],
                missing,
                ready_to_submit: missing.length === 0
            }
        });
    } catch (error) {
        next(error);
    }
});

/* PUT /api/ppap/PPAP-2026-0003/elements/7
   { reference?, note?, not_applicable? } - fill or update a slot. */
ppap.put("/ppap/:number/elements/:element", requirePermission("ppap.manage"),
    async (request, response, next) => {
        try {
            const record = await findPpap(request.user.org_id, request.params.number);
            if (!record) return response.status(404).json({ error: "No such PPAP" });

            const n = Number(request.params.element);
            if (!Number.isInteger(n) || n < 1 || n > 18) {
                return response.status(400).json({ error: "element must be 1-18" });
            }

            const { reference, note, not_applicable } = request.body || {};
            const na = not_applicable === true;
            if (!na && (!reference || !String(reference).trim())) {
                return response.status(400).json({
                    error: "a reference is required unless the element is marked not applicable"
                });
            }

            const saved = await query(`
                insert into ppap_elements (org_id, record_id, element, reference, note, not_applicable, updated_by)
                values ($1, $2, $3, $4, $5, $6, $7)
                on conflict (record_id, element) do update set
                    reference = excluded.reference,
                    note = excluded.note,
                    not_applicable = excluded.not_applicable,
                    updated_by = excluded.updated_by,
                    updated_at = now()
                returning element, reference, note, not_applicable
            `, [request.user.org_id, record.id, n,
                na ? null : String(reference).trim(),
                (note || "").trim() || null, na, request.user.id]);

            response.json(saved.rows[0]);
        } catch (error) {
            next(error);
        }
    });

ppap.delete("/ppap/:number/elements/:element", requirePermission("ppap.manage"),
    async (request, response, next) => {
        try {
            const record = await findPpap(request.user.org_id, request.params.number);
            if (!record) return response.status(404).json({ error: "No such PPAP" });
            await query("delete from ppap_elements where record_id = $1 and element = $2",
                [record.id, Number(request.params.element)]);
            response.json({ cleared: true });
        } catch (error) {
            next(error);
        }
    });
