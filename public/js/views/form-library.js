/* ============================================================
   Form Library.

   The front door for forms: a gallery of ready-made form types
   (AIAG / AS9102 core tools). One click adds a form to the
   workspace as a record type; once it's in, "New record" opens the
   full-screen editor. No spreadsheet needed for a standard form -
   that path is still there on Import Form for a company's own
   custom forms.
   ============================================================ */

import { api } from "../api.js";
import { can } from "../session.js";
import { openRecordEditor } from "../forms.js";
import { el, pill, toast } from "../dom.js";

export async function renderFormLibrary() {
    const host = document.getElementById("form-library-body");
    if (!host) return;
    host.replaceChildren(el("p", { class: "sm dim", text: "Loading form library..." }));

    let data;
    try {
        data = await api.formTemplates();
    } catch (error) {
        host.replaceChildren(el("div", { class: "table-empty" }, [
            el("div", { class: "empty-title", text: "Couldn't load the form library" }),
            el("div", { class: "empty-hint", text: error.message || "Try reloading the page." })
        ]));
        return;
    }

    const templates = (data && data.templates) || [];
    const installed = (data && data.installed) || {};
    const manage = can("forms.manage");

    if (templates.length === 0) {
        host.replaceChildren(el("div", { class: "table-empty" }, [
            el("div", { class: "empty-title", text: "No form templates found" }),
            el("div", { class: "empty-hint", text: "The server returned an empty list - restart the API if you just updated it." })
        ]));
        return;
    }

    /* group by category, categories in first-seen order */
    const groups = new Map();
    for (const t of templates) {
        if (!groups.has(t.category)) groups.set(t.category, []);
        groups.get(t.category).push(t);
    }

    const sections = [];
    for (const [category, items] of groups) {
        sections.push(el("h2", { class: "lib-cat", text: category }));
        sections.push(el("div", { class: "form-gallery" }, items.map((t) => card(t))));
    }
    host.replaceChildren(...sections);

    function card(t) {
        const isIn = Boolean(installed[t.key]);

        const action = isIn
            ? el("button", { class: "btn btn-primary btn-xs", type: "button", text: "New record  →" })
            : manage
                ? el("button", { class: "btn btn-xs", type: "button", text: "Add to workspace" })
                : el("span", { class: "sm dim", text: "Not added" });

        if (isIn) {
            action.addEventListener("click", () => {
                document.dispatchEvent(new CustomEvent("navigate", { detail: { view: "record-editor" } }));
                openRecordEditor(t.key, { returnView: "form-library" });
            });
        } else if (manage) {
            action.addEventListener("click", async () => {
                action.disabled = true;
                action.textContent = "Adding...";
                try {
                    await api.installFormTemplate(t.key);
                    toast(t.name + " added");
                    renderFormLibrary();
                } catch (error) {
                    toast(error.message, "error");
                    action.disabled = false;
                    action.textContent = "Add to workspace";
                }
            });
        }

        return el("div", { class: "form-card" + (isIn ? " is-installed" : "") }, [
            el("div", { class: "form-card-head" }, [
                el("span", { class: "form-card-name", text: t.name }),
                t.standard ? el("span", { class: "form-card-std", text: t.standard }) : null
            ]),
            t.has_excel_template
                ? el("p", { class: "form-card-xl sm", title:
                    "Ships with its own spreadsheet - download the Excel template, fill it in, "
                    + "and \"Fill from Excel\" reads it straight back onto a record." },
                "📄  Fills from your own Excel layout")
                : null,
            el("p", { class: "form-card-desc", text: t.description || "" }),
            el("div", { class: "form-card-foot" }, [
                el("span", { class: "form-card-meta sm dim", text:
                    (t.clause ? "Clause " + t.clause + "  ·  " : "")
                    + t.field_count + " fields"
                    + (t.table_count ? "  ·  " + t.table_count + " table" + (t.table_count === 1 ? "" : "s") : "") }),
                isIn ? pill("Added", "done") : el("span", {}),
                action
            ])
        ]);
    }
}
