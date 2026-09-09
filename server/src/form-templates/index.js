/* ============================================================
   Starter form templates (P4.5).

   The AIAG core-tool forms, shipped as JSON in this folder. An admin
   installs one from Settings and it becomes a custom record type
   (open -> closed workflow, form v1) - the same result as importing a
   spreadsheet, minus the spreadsheet.

   Each file is { key, name, prefix, clause, description, fields: [...] }
   where `fields` is the app's own form shape (see problemWith in
   routes/masterdata.js).

   A template MAY also bundle the real spreadsheet it was derived from,
   as a pair in ./excel/ :

       excel/<key>.xlsx        the customer's own layout
       excel/<key>.map.json    the field -> cell map (buildDefaultMap shape)

   When both are present, installing the template also stamps that map
   onto form version 1 (routes/form-templates.js), so "Fill from Excel"
   reads a filled copy of the customer's own file straight back into a
   record - no generic Field / Value grid.
   ============================================================ */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const excelDir = join(here, "excel");

const templates = new Map();
for (const file of readdirSync(here)) {
    if (!file.endsWith(".json")) continue;
    const tpl = JSON.parse(readFileSync(join(here, file), "utf8"));
    templates.set(tpl.key, tpl);
}

/* key -> { xlsxPath, mapPath } for every template that ships its own
   spreadsheet. Resolved once at load; the files are read on demand. */
const excelBundles = new Map();
for (const key of templates.keys()) {
    const xlsxPath = join(excelDir, key + ".xlsx");
    const mapPath = join(excelDir, key + ".map.json");
    if (existsSync(xlsxPath) && existsSync(mapPath)) {
        excelBundles.set(key, { xlsxPath, mapPath });
    }
}

/* Metadata only - the full field list is fetched per template. */
export function listTemplates() {
    return [...templates.values()]
        .map((t) => ({
            key: t.key, name: t.name, prefix: t.prefix,
            clause: t.clause, description: t.description,
            category: t.category || "Other",
            standard: t.standard || null,
            field_count: t.fields.length,
            table_count: (t.fields || []).filter((f) => f.type === "table").length,
            has_excel_template: excelBundles.has(t.key)
        }))
        .sort((a, b) => (a.category + a.name).localeCompare(b.category + b.name));
}

export function getTemplate(key) {
    return templates.get(key) || null;
}

/* The bundled spreadsheet + cell map for a template, or null. `map` is
   the raw buildDefaultMap-shaped object from disk (no template_path /
   template_name - the install step assigns those). */
export function getTemplateExcel(key) {
    const bundle = excelBundles.get(key);
    if (!bundle) return null;
    try {
        return {
            xlsxBuffer: readFileSync(bundle.xlsxPath),
            map: JSON.parse(readFileSync(bundle.mapPath, "utf8"))
        };
    } catch {
        return null;
    }
}
