/* ============================================================
   A modal create/edit form for the typed master-data tables.

   The records table has openRecordEditor (forms.js), driven by a
   schema the server publishes. Gages, vendors, parts and the rest
   have fixed columns and no such schema - but the field rendering,
   validation and value-reading are the same job, so this reuses
   buildField / validate / readValue from forms.js and only adds what
   they do not do: a real file input, and packaging the result for a
   caller who owns the actual request.

   openEntityForm({ title, fields, values, submitLabel, options,
                    onSubmit, successMessage })

     fields  - [{ key, label, type, required?, options?, min?,
                  pattern?, accept?, hint? }]. type "file" renders an
                <input type=file>; type "checklist" renders a box of
                checkboxes from options ([{value,label}] or [string]),
                and readValue returns the array of ticked values
                (required = at least one). Every other type is whatever
                buildField already understands.
     values  - current values, keyed by field.key (empty for a new one).
     options - passed straight to buildField (e.g. { users } for a
                "user" field).
     onSubmit({ values, files }) - returns a promise. `files` is
                { key: File } for any file field with a chosen file;
                file fields never appear in `values`. Throw to keep
                the dialog open with the thrown message shown; an
                error carrying `.payload.fields` also lists them.
     onSaved(result) - optional, awaited after a successful submit and
                after the dialog closes (refresh the list here).
   ============================================================ */

import { ensureDialog, buildField, readValue, validate } from "./forms.js";
import { el, toast } from "./dom.js";

export function openEntityForm({
    title,
    fields,
    values = {},
    submitLabel = "Save",
    options = {},
    onSubmit,
    onSaved,
    successMessage
}) {
    const node = ensureDialog();
    const errorBox = el("div", { class: "signin-error", hidden: "hidden" });

    const entries = [];       // { field, input } for buildField-backed fields
    const fileInputs = {};    // key -> <input type="file">
    const checklists = {};    // key -> the .checklist container
    const groups = [];

    for (const field of fields) {
        if (field.type === "file") {
            const id = "field-" + field.key;
            const input = el("input", { type: "file", id, name: field.key });
            if (field.accept) input.accept = field.accept;

            fileInputs[field.key] = input;
            groups.push(el("div", { class: "field-group" }, [
                el("label", { for: id }, [
                    field.label,
                    field.required ? el("span", { class: "req", text: " *" }) : null
                ]),
                input,
                field.hint ? el("span", { class: "field-hint", text: field.hint }) : null
            ]));
            continue;
        }

        if (field.type === "checklist") {
            const chosen = new Set(values[field.key] || []);
            const box = el("div", { class: "checklist" },
                (field.options || []).map((option) => {
                    const value = typeof option === "string" ? option : option.value;
                    const label = typeof option === "string" ? option : option.label;
                    return el("label", { class: "checklist-row" }, [
                        el("input", {
                            type: "checkbox", value,
                            checked: chosen.has(value) ? "checked" : undefined
                        }),
                        el("span", { text: label })
                    ]);
                })
            );

            checklists[field.key] = box;
            groups.push(el("div", { class: "field-group" }, [
                el("label", {}, [
                    field.label,
                    field.required ? el("span", { class: "req", text: " *" }) : null
                ]),
                box,
                field.hint ? el("span", { class: "field-hint", text: field.hint }) : null
            ]));
            continue;
        }

        const built = buildField(field, options, values[field.key]);
        entries.push({ field, input: built.input });

        if (field.hint && !built.wrapper.querySelector(".field-hint")) {
            built.wrapper.append(el("span", { class: "field-hint", text: field.hint }));
        }
        groups.push(built.wrapper);
    }

    const save = el("button", { class: "btn btn-primary", type: "button", text: submitLabel });

    node.replaceChildren(
        el("div", { class: "modal-head" }, el("h2", { class: "modal-title", text: title })),
        el("div", { class: "modal-body" }, [errorBox, ...groups]),
        el("div", { class: "modal-foot" }, [
            el("button", { class: "btn", type: "button", text: "Cancel", onClick: () => node.close() }),
            save
        ])
    );

    function showError(message, missing) {
        errorBox.replaceChildren(
            el("div", { text: message }),
            missing && missing.length
                ? el("div", { class: "sm", text: "Missing: " + missing.join(", ") })
                : null
        );
        errorBox.hidden = false;
        errorBox.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    save.addEventListener("click", async () => {
        errorBox.hidden = true;

        const problems = validate(entries);
        for (const field of fields) {
            if (field.type === "file" && field.required && !fileInputs[field.key].files[0]) {
                problems.push(field.label + " is required");
            }
            if (field.type === "checklist" && field.required
                && checklists[field.key].querySelectorAll("input:checked").length === 0) {
                problems.push("Pick at least one for " + field.label);
            }
        }
        if (problems.length > 0) {
            showError(problems[0]);
            return;
        }

        const outValues = {};
        for (const entry of entries) {
            const value = readValue(entry);
            if (value !== undefined) outValues[entry.field.key] = value;
        }
        for (const [key, box] of Object.entries(checklists)) {
            const picked = [...box.querySelectorAll("input:checked")].map((i) => i.value);
            if (picked.length > 0) outValues[key] = picked;
        }

        const files = {};
        for (const [key, input] of Object.entries(fileInputs)) {
            if (input.files[0]) files[key] = input.files[0];
        }

        save.disabled = true;
        save.textContent = "Saving...";

        try {
            const result = await onSubmit({ values: outValues, files });
            node.close();
            if (successMessage) {
                toast(typeof successMessage === "function" ? successMessage(result) : successMessage);
            }
            if (onSaved) await onSaved(result);
            return result;
        } catch (error) {
            /* The server validates again and, when it disagrees, is
               right - and it names the fields. */
            showError(error.message || "Something went wrong", error.payload?.fields);
        } finally {
            save.disabled = false;
            save.textContent = submitLabel;
        }
    });

    node.showModal();

    const first = node.querySelector(
        ".modal-body input:not([type=file]):not([type=checkbox]), .modal-body select, .modal-body textarea"
    );
    if (first) first.focus();
}
