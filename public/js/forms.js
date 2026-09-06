/* ============================================================
   Record forms, built from the schema the server publishes.

   Nothing here knows what an NCR contains. It reads the field list
   from /api/record-types/<key>/form and renders whatever it finds,
   so adding a field in the Form Builder adds it to this form without
   a line of UI code changing. That is the whole promise of the
   configurable layer, made real.

   Uses the native <dialog>, which brings focus trapping, Escape to
   close and the backdrop with it.
   ============================================================ */

import { api } from "./api.js";
import { currentUser } from "./session.js";
import { el, toast } from "./dom.js";

/* ---------- one dialog, reused ---------- */

let dialog = null;

export function ensureDialog() {
    if (dialog) return dialog;

    dialog = el("dialog", { class: "modal" });
    document.body.append(dialog);

    /* Clicking the backdrop closes. The dialog element reports clicks
       on the backdrop as clicks on itself, so compare the target. */
    dialog.addEventListener("click", (event) => {
        if (event.target === dialog) dialog.close();
    });

    return dialog;
}

/* ---------- field rendering ---------- */

function buildField(field, options) {
    const id = "field-" + field.key;
    const wrapper = el("div", { class: "field-group" });

    wrapper.append(el("label", { for: id }, [
        field.label,
        field.required ? el("span", { class: "req", text: " *" }) : null
    ]));

    let input;

    switch (field.type) {
        case "memo":
            input = el("textarea", { id, name: field.key, rows: 3 });
            break;

        case "number":
            input = el("input", { type: "number", id, name: field.key, step: "any" });
            if (field.min !== undefined) input.min = field.min;
            break;

        case "date":
            input = el("input", { type: "date", id, name: field.key });
            break;

        case "select":
            input = el("select", { id, name: field.key }, [
                el("option", { value: "", text: "Choose..." }),
                ...(field.options || []).map((value) => el("option", { value, text: value }))
            ]);
            break;

        case "link": {
            const list = options[field.target] || [];
            input = el("select", { id, name: field.key }, [
                el("option", { value: "", text: "Choose..." }),
                ...list.map((item) => {
                    const option = el("option", { value: item.value, text: item.label });
                    /* A gage past its calibration date cannot be used to
                       judge a part. The form rule says block; this is
                       where that becomes visible. */
                    if (item.disabled) {
                        option.disabled = true;
                        option.textContent = item.label + "  (calibration expired)";
                    }
                    return option;
                })
            ]);
            break;
        }

        case "user": {
            const list = options.users || [];
            input = el("select", { id, name: field.key }, [
                el("option", { value: "", text: "Choose..." }),
                ...list.map((item) => el("option", { value: item.value, text: item.label }))
            ]);
            break;
        }

        case "signature": {
            const me = currentUser();
            input = el("input", {
                type: "text", id, name: field.key,
                value: me ? me.name + " - " + me.role_name : "",
                readonly: "readonly", class: "readonly"
            });
            wrapper.append(input);
            wrapper.append(el("span", {
                class: "field-hint",
                text: "Signed as you, with the time, when you save."
            }));
            return { wrapper, input, field };
        }

        case "file":
            input = el("input", { type: "text", id, name: field.key, disabled: "disabled" });
            wrapper.append(input);
            wrapper.append(el("span", {
                class: "field-hint",
                text: "Attachments are not built yet."
            }));
            return { wrapper, input, field };

        default:
            input = el("input", { type: "text", id, name: field.key });
            if (field.pattern) input.pattern = field.pattern;
    }

    if (field.required) input.required = true;

    wrapper.append(input);

    if (field.pattern) {
        wrapper.append(el("span", {
            class: "field-hint",
            text: "Format: " + describePattern(field.pattern)
        }));
    }

    return { wrapper, input, field };
}

/* Turns the handful of patterns actually in use into something a
   person can act on. An unrecognised one is shown as written rather
   than guessed at. */
function describePattern(pattern) {
    if (pattern === "^L-[0-9]{5}$") return "L- followed by five digits, for example L-88213";
    return pattern;
}

function readValue(entry) {
    const raw = entry.input.value;

    if (raw === "" || raw === null) return undefined;
    if (entry.field.type === "number") return Number(raw);

    return raw;
}

function validate(entries) {
    const problems = [];

    for (const entry of entries) {
        const { field, input } = entry;
        const value = readValue(entry);

        if (field.required && value === undefined && field.type !== "file") {
            problems.push(field.label + " is required");
            continue;
        }

        if (value === undefined) continue;

        if (field.pattern && !new RegExp(field.pattern).test(String(value))) {
            problems.push(field.label + " must be " + describePattern(field.pattern));
        }

        if (field.min !== undefined && Number(value) < field.min) {
            problems.push(field.label + " must be at least " + field.min);
        }

        if (input.disabled && field.required) {
            problems.push(field.label + " cannot be set yet");
        }
    }

    return problems;
}

/* ---------- the dialog itself ---------- */

export async function openRecordForm(typeKey, { onSaved } = {}) {
    const node = ensureDialog();
    node.replaceChildren(el("p", { class: "sm dim", text: "Loading form..." }));
    node.showModal();

    let definition;

    try {
        definition = await api.recordForm(typeKey);
    } catch (error) {
        node.replaceChildren(
            el("div", { class: "modal-head" }, el("h2", { text: "Could not open the form" })),
            el("div", { class: "modal-body" },
                el("p", { class: "sm", style: "color:var(--crit)", text: error.message })),
            el("div", { class: "modal-foot" },
                el("button", { class: "btn", type: "button", onClick: () => node.close() }, "Close"))
        );
        return;
    }

    const errorBox = el("div", { class: "signin-error", hidden: "hidden" });
    const entries = definition.fields.map((field) => buildField(field, definition.options));

    const titleInput = el("input", {
        type: "text", id: "field-title", name: "title", required: true,
        placeholder: "What is wrong, in one line"
    });

    const titleGroup = el("div", { class: "field-group" }, [
        el("label", { for: "field-title" }, ["Summary", el("span", { class: "req", text: " *" })]),
        titleInput,
        el("span", { class: "field-hint", text: "This is what appears in the register." })
    ]);

    /* Due date lives on the record itself (records.due_at), not in the
       type-specific data payload, so it is asked for here once rather
       than as a per-type field every form has to remember to declare -
       every register's overdue colouring reads this same column. */
    const dueInput = el("input", { type: "date", id: "field-due-at", name: "due_at" });

    const dueGroup = el("div", { class: "field-group" }, [
        el("label", { for: "field-due-at", text: "Due date" }),
        dueInput,
        el("span", { class: "field-hint", text: "Optional. Drives the overdue colouring in the register." })
    ]);

    const save = el("button", { class: "btn btn-primary", type: "submit" }, "Raise " + definition.name);

    const form = el("form", { method: "dialog" }, [
        errorBox,
        titleGroup,
        dueGroup,
        ...entries.map((entry) => entry.wrapper)
    ]);

    node.replaceChildren(
        el("div", { class: "modal-head" }, [
            el("h2", { class: "modal-title", text: "New " + definition.name }),
            el("span", { class: "panel-note",
                text: "clause " + (definition.clause || "-") + " / form v" + definition.version })
        ]),
        el("div", { class: "modal-body" }, form),
        el("div", { class: "modal-foot" }, [
            el("button", { class: "btn", type: "button", onClick: () => node.close() }, "Cancel"),
            save
        ])
    );

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        errorBox.hidden = true;

        const problems = validate(entries);

        if (!titleInput.value.trim()) problems.unshift("Summary is required");

        if (problems.length > 0) {
            errorBox.replaceChildren(...problems.map((text) => el("div", { text })));
            errorBox.hidden = false;
            return;
        }

        const data = {};
        for (const entry of entries) {
            const value = readValue(entry);
            if (value !== undefined) data[entry.field.key] = value;
        }

        save.disabled = true;
        save.textContent = "Saving...";

        try {
            const me = currentUser();
            const created = await api.createRecord({
                type: definition.key,
                title: titleInput.value.trim(),
                owner: me ? me.initials : undefined,
                severity: "warn",
                due_at: dueInput.value || undefined,
                data
            });

            node.close();
            toast(created.number + " created");
            if (onSaved) onSaved(created);
        } catch (error) {
            /* The server validates everything again. When it disagrees,
               it is right, and it names the fields. */
            const fields = error.payload?.fields;
            errorBox.replaceChildren(
                el("div", { text: error.message }),
                fields ? el("div", { class: "sm", text: "Missing: " + fields.join(", ") }) : null
            );
            errorBox.hidden = false;
        } finally {
            save.disabled = false;
            save.textContent = "Raise " + definition.name;
        }
    });

    titleInput.focus();
}

/* ---------- a small confirm, for workflow moves ---------- */

export function confirmStep({ title, body, confirmLabel, onConfirm }) {
    const node = ensureDialog();
    const errorBox = el("div", { class: "signin-error", hidden: "hidden" });

    const reason = el("textarea", { id: "step-reason", rows: 2,
        placeholder: "Optional. Recorded against this change." });

    const go = el("button", { class: "btn btn-primary", type: "button" }, confirmLabel);

    node.replaceChildren(
        el("div", { class: "modal-head" }, el("h2", { class: "modal-title", text: title })),
        el("div", { class: "modal-body" }, [
            errorBox,
            el("p", { class: "sm", style: "margin:0 0 14px", text: body }),
            el("div", { class: "field-group" }, [
                el("label", { for: "step-reason", text: "Reason" }),
                reason
            ])
        ]),
        el("div", { class: "modal-foot" }, [
            el("button", { class: "btn", type: "button", onClick: () => node.close() }, "Cancel"),
            go
        ])
    );

    go.addEventListener("click", async () => {
        go.disabled = true;
        go.textContent = "Working...";

        try {
            await onConfirm(reason.value.trim() || null);
            node.close();
            toast(title);
        } catch (error) {
            errorBox.textContent = error.message;
            errorBox.hidden = false;
        } finally {
            go.disabled = false;
            go.textContent = confirmLabel;
        }
    });

    node.showModal();
}

/* ---------- setting or changing a due date ---------- */

export function editDueDate({ title, currentValue, onSave }) {
    const node = ensureDialog();
    const errorBox = el("div", { class: "signin-error", hidden: "hidden" });

    const dateInput = el("input", {
        type: "date",
        value: currentValue ? currentValue.slice(0, 10) : ""
    });

    const go = el("button", { class: "btn btn-primary", type: "button" }, "Save");

    node.replaceChildren(
        el("div", { class: "modal-head" }, el("h2", { class: "modal-title", text: title })),
        el("div", { class: "modal-body" }, [
            errorBox,
            el("div", { class: "field-group" }, [
                el("label", { for: "due-date-input", text: "Due date" }),
                dateInput,
                el("span", { class: "field-hint", text: "Leave blank to clear it." })
            ])
        ]),
        el("div", { class: "modal-foot" }, [
            el("button", { class: "btn", type: "button", onClick: () => node.close() }, "Cancel"),
            go
        ])
    );

    go.addEventListener("click", async () => {
        go.disabled = true;
        go.textContent = "Saving...";

        try {
            await onSave(dateInput.value || null);
            node.close();
            toast(dateInput.value ? "Due date set" : "Due date cleared");
        } catch (error) {
            errorBox.textContent = error.message;
            errorBox.hidden = false;
        } finally {
            go.disabled = false;
            go.textContent = "Save";
        }
    });

    node.showModal();
}
