/* ============================================================
   Excel layout - the one-time "which cell does each field go in"
   review for a form that exports onto the customer's own template.

   Opened as a dialog from the Custom Forms detail screen. The server
   fills in a best guess when a template is first attached (on import,
   or via the upload here); this screen is where a person corrects it
   once. Nothing fancy - a cell is just typed in, e.g. "C3".
   ============================================================ */

import { api } from "../api.js";
import { ensureDialog } from "../forms.js";
import { el, toast } from "../dom.js";

const FLAT_TYPES = new Set(["text", "memo", "number", "date", "select", "link", "user", "boolean"]);

export async function openExcelLayout(typeKey, typeName) {
    const node = ensureDialog();
    node.replaceChildren(el("div", { class: "modal-body" },
        el("p", { class: "sm dim", text: "Loading Excel layout..." })));
    node.showModal();

    let state;
    try {
        state = await api.excelMap(typeKey);
    } catch (error) {
        node.replaceChildren(el("div", { class: "modal-body" },
            el("p", { class: "sm", style: "color:var(--crit)", text: error.message })));
        return;
    }

    render(state);

    function render(data) {
        const { map, schema, has_template: hasTemplate } = data;
        const fields = (schema && schema.fields) || [];
        const flat = fields.filter((f) => FLAT_TYPES.has(f.type));
        const tables = fields.filter((f) => f.type === "table" && Array.isArray(f.columns));
        const sheetNames = (map && map.sheets) || [];

        const head = el("div", { class: "modal-head" },
            el("h2", { class: "modal-title", text: "Excel layout · " + (typeName || typeKey) }));

        if (!hasTemplate) {
            const file = el("input", { type: "file", accept: ".xlsx" });
            file.addEventListener("change", () => uploadTemplate(file.files[0]));
            node.replaceChildren(
                head,
                el("div", { class: "modal-body" }, [
                    el("p", { class: "sm", text:
                        "Attach the spreadsheet this form is based on. Its exports will then come "
                        + "out on that exact layout - headers, merges and all - instead of the "
                        + "generic Field / Value grid." }),
                    el("div", { class: "field-group" }, [
                        el("label", { text: "Template spreadsheet (.xlsx)" }),
                        file
                    ])
                ]),
                el("div", { class: "modal-foot" },
                    el("button", { class: "btn", type: "button", text: "Close", onClick: () => node.close() }))
            );
            return;
        }

        /* ---- a sheet picker that tolerates an off-list value ---- */
        const sheetSelect = (current) => {
            const opts = [...new Set([...sheetNames, current].filter(Boolean))];
            return el("select", { class: "xl-sheet" },
                opts.map((s) => el("option", { value: s, text: s, selected: s === current ? "selected" : undefined })));
        };
        const cellInput = (current) => el("input", {
            type: "text", class: "xl-cell", placeholder: "e.g. C3", value: current || "",
            style: "width:80px"
        });

        /* ---- header fields ---- */
        const fieldRows = flat.map((f) => {
            const spot = (map.fields && map.fields[f.key]) || {};
            const row = el("div", { class: "xl-row", dataset: { key: f.key, kind: "field" } });
            row.append(
                el("span", { class: "xl-label", text: f.label || f.key }),
                sheetSelect(spot.sheet || map.primary_sheet),
                cellInput(spot.cell)
            );
            return row;
        });

        /* ---- table grids ---- */
        const tableBlocks = tables.map((f) => {
            const t = (map.tables && map.tables[f.key]) || {};
            const block = el("div", { class: "xl-table", dataset: { key: f.key } });
            const gridSheet = sheetSelect(t.sheet || map.primary_sheet);
            const firstRow = el("input", { type: "number", min: "1", value: t.first_data_row || "", style: "width:70px", class: "xl-firstrow" });
            const rowNumCol = el("input", { type: "text", value: t.row_number_col || "", placeholder: "e.g. A", style: "width:60px", class: "xl-rownum" });
            const capacity = el("input", { type: "number", min: "1", value: t.capacity || "", style: "width:80px", class: "xl-capacity" });

            block.append(
                el("div", { class: "xl-table-head", text: (f.label || f.key) + "  (grid)" }),
                el("div", { class: "xl-table-meta" }, [
                    el("label", {}, ["Sheet ", gridSheet]),
                    el("label", {}, ["First data row ", firstRow]),
                    el("label", {}, ["Row-number col ", rowNumCol]),
                    el("label", {}, ["Rows before overflow ", capacity])
                ])
            );
            for (const col of f.columns) {
                const letter = (t.columns && t.columns[col.key]) || "";
                const cr = el("div", { class: "xl-row", dataset: { col: col.key } });
                cr.append(
                    el("span", { class: "xl-label", text: col.label || col.key }),
                    el("input", { type: "text", class: "xl-colletter", value: letter, placeholder: "col, e.g. D", style: "width:80px" })
                );
                block.append(cr);
            }
            return block;
        });

        const replaceFile = el("input", { type: "file", accept: ".xlsx", style: "display:none" });
        replaceFile.addEventListener("change", () => uploadTemplate(replaceFile.files[0]));

        const save = el("button", { class: "btn btn-primary", type: "button", text: "Save layout" });
        save.addEventListener("click", () => saveMap(map));

        const remove = el("button", { class: "btn", type: "button", text: "Remove layout" });
        remove.addEventListener("click", async () => {
            if (!window.confirm("Remove the Excel layout? Exports go back to the generated grid.")) return;
            try { await api.deleteExcelMap(typeKey); toast("Excel layout removed"); node.close(); }
            catch (error) { toast(error.message, "error"); }
        });

        node.replaceChildren(
            head,
            el("div", { class: "modal-body xl-body" }, [
                el("p", { class: "sm dim" }, [
                    "Template: ",
                    el("strong", { text: map.template_name || "(file)" }),
                    "  ",
                    el("button", {
                        class: "link-btn", type: "button", text: "Replace file",
                        onClick: () => replaceFile.click()
                    }),
                    replaceFile
                ]),
                el("p", { class: "sm dim", text:
                    "Type the cell each field's value goes into. For a grid, give the first "
                    + "data row and the column letter for each field." }),
                flat.length ? el("div", { class: "section-label", text: "Header fields" }) : null,
                ...fieldRows,
                ...tableBlocks
            ]),
            el("div", { class: "modal-foot" }, [
                remove,
                el("span", { style: "flex:1" }),
                el("button", { class: "btn", type: "button", text: "Cancel", onClick: () => node.close() }),
                save
            ])
        );
    }

    async function uploadTemplate(file) {
        if (!file) return;
        const fd = new FormData();
        fd.append("file", file);
        try {
            const res = await api.uploadExcelTemplate(typeKey, fd);
            toast("Template attached - review the cells");
            render({ ...state, has_template: true, map: res.map });
        } catch (error) {
            toast(error.message, "error");
        }
    }

    async function saveMap(base) {
        const body = node.querySelector(".xl-body");
        const map = {
            template_path: base.template_path,
            template_name: base.template_name,
            sheets: base.sheets,
            primary_sheet: base.primary_sheet,
            fields: {},
            tables: {}
        };

        body.querySelectorAll('.xl-row[data-kind="field"]').forEach((row) => {
            const cell = row.querySelector(".xl-cell").value.trim().toUpperCase();
            if (!cell) return;
            map.fields[row.dataset.key] = {
                sheet: row.querySelector(".xl-sheet").value,
                cell
            };
        });

        body.querySelectorAll(".xl-table").forEach((block) => {
            const columns = {};
            block.querySelectorAll(".xl-row[data-col]").forEach((cr) => {
                const letter = cr.querySelector(".xl-colletter").value.trim().toUpperCase().replace(/[^A-Z]/g, "");
                if (letter) columns[cr.dataset.col] = letter;
            });
            const firstRow = Number(block.querySelector(".xl-firstrow").value);
            if (!firstRow || Object.keys(columns).length === 0) return;
            const rnc = block.querySelector(".xl-rownum").value.trim().toUpperCase().replace(/[^A-Z]/g, "");
            const cap = Number(block.querySelector(".xl-capacity").value);
            map.tables[block.dataset.key] = {
                sheet: block.querySelector(".xl-sheet").value,
                first_data_row: firstRow,
                columns,
                ...(rnc ? { row_number_col: rnc } : {}),
                ...(cap > 0 ? { capacity: cap } : {})
            };
        });

        try {
            await api.saveExcelMap(typeKey, map);
            toast("Excel layout saved");
            node.close();
        } catch (error) {
            toast(error.message, "error");
        }
    }
}
