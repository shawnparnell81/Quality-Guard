/* ============================================================
   Starter form templates (P4.5).

   The AIAG core-tool forms, shipped as JSON in this folder. An admin
   installs one from Settings and it becomes a custom record type
   (open -> closed workflow, form v1) - the same result as importing a
   spreadsheet, minus the spreadsheet.

   Each file is { key, name, prefix, clause, description, fields: [...] }
   where `fields` is the app's own form shape (see problemWith in
   routes/masterdata.js).
   ============================================================ */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const templates = new Map();
for (const file of readdirSync(here)) {
    if (!file.endsWith(".json")) continue;
    const tpl = JSON.parse(readFileSync(join(here, file), "utf8"));
    templates.set(tpl.key, tpl);
}

/* Metadata only - the full field list is fetched per template. */
export function listTemplates() {
    return [...templates.values()]
        .map((t) => ({
            key: t.key, name: t.name, prefix: t.prefix,
            clause: t.clause, description: t.description,
            field_count: t.fields.length
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

export function getTemplate(key) {
    return templates.get(key) || null;
}
