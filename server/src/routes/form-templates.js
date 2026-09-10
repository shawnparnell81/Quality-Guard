/* ============================================================
   Starter form templates (P4.5).

   GET  /api/form-templates            list the bundled templates,
                                       flagging which are installed
   POST /api/form-templates/:key/install
                                       create a custom record type
                                       from the template

   The templates live as JSON in src/form-templates/. Installing one
   is the same outcome as the Excel importer's "Apply as new type":
   a record type with an open -> closed workflow and form version 1.

   A template that also ships a spreadsheet (src/form-templates/excel/
   <key>.xlsx + <key>.map.json) gets that file stored and its cell map
   stamped onto form v1, so "Fill from Excel" works against the
   customer's own layout from the moment it is installed.
   ============================================================ */

import { Router } from "express";
import { query, withTransaction } from "../db.js";
import { requirePermission } from "../auth.js";
import { log } from "../logger.js";
import { saveUploadedFile } from "../file-storage.js";
import { mapProblem } from "../excel-fill.js";
import { problemWithSchema } from "./masterdata.js";
import { listTemplates, getTemplate, getTemplateExcel } from "../form-templates/index.js";

export const formTemplates = Router();

const XLSX_EXTENSIONS = new Set([".xlsx"]);

/* Reading the catalogue is harmless - any signed-in user can browse
   what forms are available. Only installing one needs forms.manage. */
formTemplates.get("/form-templates",
    async (request, response, next) => {
        try {
            const templates = listTemplates();
            const rows = await query(
                "select key, prefix from record_types where org_id = $1", [request.user.org_id]);
            const keys = new Set(rows.rows.map((r) => r.key));
            const prefixes = new Set(rows.rows.map((r) => r.prefix));

            const installed = {};
            for (const t of templates) {
                if (keys.has(t.key) || prefixes.has(t.prefix)) installed[t.key] = true;
            }
            response.json({ templates, installed });
        } catch (error) {
            next(error);
        }
    });

formTemplates.get("/form-templates/:key",
    async (request, response, next) => {
        try {
            const tpl = getTemplate(request.params.key);
            if (!tpl) return response.status(404).json({ error: "No such template" });
            response.json(tpl);
        } catch (error) {
            next(error);
        }
    });

/* Store the template's bundled spreadsheet and stamp its cell map onto
   the just-created form v1. Best-effort: the record type is already
   committed, and a form with no Excel layout still works (it falls
   back to the generated Field / Value grid), so a failure here is
   logged, not surfaced. Mirrors the "attach on import" path in
   routes/form-import.js. */
async function attachBundledExcel(key, recordTypeId, userId) {
    const bundle = getTemplateExcel(key);
    if (!bundle) return false;
    try {
        const templatePath = await saveUploadedFile(
            "excel-templates", XLSX_EXTENSIONS, key + ".xlsx", bundle.xlsxBuffer);
        const map = {
            template_path: templatePath,
            template_name: key + ".xlsx",
            built_for_version: 1,
            ...bundle.map
        };
        const bad = mapProblem(map);
        if (bad) {
            log.warn("template_excel_map_invalid", { key, err: bad });
            return false;
        }
        await query(
            "update form_versions set excel_map = $1 where record_type_id = $2 and version = 1",
            [JSON.stringify(map), recordTypeId]);
        return true;
    } catch (error) {
        log.warn("template_excel_attach_failed", { key, err: error });
        return false;
    }
}

formTemplates.post("/form-templates/:key/install", requirePermission("forms.manage"),
    async (request, response, next) => {
        try {
            const tpl = getTemplate(request.params.key);
            if (!tpl) return response.status(404).json({ error: "No such template" });

            const bad = problemWithSchema({ fields: tpl.fields, rules: tpl.rules || [] });
            if (bad) return response.status(500).json({ error: "Template is malformed: " + bad });

            const outcome = await withTransaction(async (client) => {
                const clash = await client.query(
                    "select 1 from record_types where org_id = $1 and (key = $2 or prefix = $3)",
                    [request.user.org_id, tpl.key, tpl.prefix]);
                if (clash.rowCount > 0) {
                    return { conflict: "A record type already uses the key \"" + tpl.key
                        + "\" or prefix \"" + tpl.prefix + "\"" };
                }

                const typeRow = await client.query(`
                    insert into record_types (org_id, key, name, prefix, clause)
                    values ($1, $2, $3, $4, $5) returning id
                `, [request.user.org_id, tpl.key, tpl.name, tpl.prefix, tpl.clause || null]);
                const recordTypeId = typeRow.rows[0].id;

                await client.query(`
                    insert into workflow_states (record_type_id, key, name, position, is_terminal)
                    values ($1, 'open', 'Open', 1, false), ($1, 'closed', 'Closed', 2, true)
                `, [recordTypeId]);
                await client.query(`
                    insert into workflow_transitions (record_type_id, from_state, to_state, required_permission)
                    values ($1, 'open', 'closed', 'forms.manage')
                `, [recordTypeId]);
                await client.query(`
                    insert into form_versions (record_type_id, version, schema, published_at, published_by)
                    values ($1, 1, $2, now(), $3)
                `, [recordTypeId, JSON.stringify({ fields: tpl.fields, rules: [] }), request.user.id]);
                await client.query(`
                    insert into audit_log (org_id, entity, entity_id, field, new_value, changed_by)
                    values ($1, 'record_types', $2, 'installed_from_template', $3, $4)
                `, [request.user.org_id, recordTypeId, tpl.key + " (" + tpl.prefix + ")", request.user.id]);

                return { installed_key: tpl.key, name: tpl.name, prefix: tpl.prefix, record_type_id: recordTypeId };
            });

            if (outcome.conflict) return response.status(409).json({ error: outcome.conflict });

            const excelTemplate = await attachBundledExcel(
                tpl.key, outcome.record_type_id, request.user.id);

            response.status(201).json({
                installed_key: outcome.installed_key,
                name: outcome.name,
                prefix: outcome.prefix,
                excel_template: excelTemplate
            });
        } catch (error) {
            next(error);
        }
    });
