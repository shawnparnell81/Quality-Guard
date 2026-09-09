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
import { el, toast, pill, humanize, statusKind } from "./dom.js";
import { beginEditing } from "./presence.js";
import { buildUploader } from "./attach-upload.js";
import { openFileWindow } from "./doc-windows.js";
import { checkRules } from "./rules.js";
import { ensureDialog, paintThreshold } from "./field-kit.js";
import { createTableEditor } from "./table-editor.js";

/* Re-exported so the many modules that import ensureDialog from here
   keep working - the implementation lives in field-kit.js now, next
   to the other field helpers the table editor also needs. */
export { ensureDialog };

/* ---------- field rendering ---------- */

/* currentValue is undefined when raising a new record, and whatever
   is already stored under field.key when editing one - the only
   difference between the two forms is which values arrive filled in.
   context carries the record number when editing an existing record,
   so a table with rowAttachments can offer a per-row file button. */
export function buildField(field, options, currentValue, context = {}) {
    /* idPrefix keeps input ids / label `for` unique when more than one
       editor is mounted at once (concurrent panes, M3). */
    const id = (context.idPrefix || "") + "field-" + field.key;
    const wrapper = el("div", { class: "field-group" });

    wrapper.append(el("label", { for: id }, [
        field.label,
        field.required ? el("span", { class: "req", text: " *" }) : null
    ]));

    let input;

    switch (field.type) {
        case "memo":
            input = el("textarea", { id, name: field.key, rows: 3, text: currentValue ?? "" });
            break;

        case "number":
            input = el("input", {
                type: "number", id, name: field.key, step: "any",
                value: currentValue ?? ""
            });
            if (field.min !== undefined) input.min = field.min;
            if (field.thresholds) {
                const repaint = () => paintThreshold(input, field, input.value);
                input.addEventListener("input", repaint);
                repaint();
            }
            break;

        case "date":
            input = el("input", {
                type: "date", id, name: field.key,
                value: currentValue ? String(currentValue).slice(0, 10) : ""
            });
            break;

        case "select":
            input = el("select", { id, name: field.key }, [
                el("option", { value: "", text: "Choose..." }),
                ...(field.options || []).map((value) => el("option", {
                    value, text: value,
                    selected: currentValue === value ? "selected" : undefined
                }))
            ]);
            break;

        case "boolean": {
            input = el("input", { type: "checkbox", id, name: field.key });
            input.checked = currentValue === true || currentValue === "true";
            wrapper.append(input);
            return { wrapper, input, field };
        }

        case "link": {
            /* target:"record" links to another record; when it is
               narrowed to a type the options come keyed "record:<type>" */
            const optKey = field.target === "record" && field.record_type
                ? "record:" + field.record_type : field.target;
            const list = options[optKey] || [];
            input = el("select", { id, name: field.key }, [
                el("option", { value: "", text: "Choose..." }),
                ...list.map((item) => {
                    const option = el("option", {
                        value: item.value, text: item.label,
                        selected: currentValue === item.value ? "selected" : undefined
                    });
                    /* A gage past its calibration date, or on hold after
                       failing one, cannot be used to judge a part. The
                       form rule says block; this is where that becomes
                       visible, and why is whatever the server actually
                       says it is - a hold from a failed calibration is
                       not the same fact as one that just expired. */
                    if (item.disabled) {
                        option.disabled = true;
                        option.textContent = item.label + "  (" + (item.disabled_reason || "unavailable") + ")";
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
            /* A signature is sealed by the server - who, when, which
               form version, and a hash of the rest of the form. Once
               set it is never re-signed by an edit; until then, the
               person completing the record ticks to sign as themself. */
            const me = currentUser();
            const sealed = currentValue && typeof currentValue === "object" && currentValue.signer
                ? currentValue
                : (currentValue ? { signer: String(currentValue), legacy: true } : null);

            if (sealed) {
                input = el("input", {
                    type: "text", id, name: field.key, readonly: "readonly", class: "readonly",
                    value: sealed.signer
                        + (sealed.role ? " (" + sealed.role + ")" : "")
                        + (sealed.at ? " - " + new Date(sealed.at).toLocaleString() : "")
                });
                wrapper.append(input);
                wrapper.append(el("span", { class: "field-hint",
                    text: sealed.legacy
                        ? "Signed (legacy record)."
                        : "Signed. Any change to the record after this is flagged on its detail view." }));
                return { wrapper, input, field };
            }

            input = el("input", { type: "checkbox", id, name: field.key });
            wrapper.append(el("label", { class: "check-inline" }, [
                input,
                el("span", { text: me ? "Sign as " + me.name + (me.role_name ? " (" + me.role_name + ")" : "") : "Sign" })
            ]));
            wrapper.append(el("span", { class: "field-hint",
                text: "The server records who and when, and seals it against later edits." }));
            return { wrapper, input, field };
        }

        case "file": {
            /* A field-scoped file slot: its uploads are ordinary record
               attachments tagged row_ref = "<fieldKey>:_", so they show
               grouped under this field on the detail view. */
            input = el("input", { type: "hidden", id, name: field.key });
            if (context.recordNumber) {
                const btn = el("button", {
                    class: "btn sm", type: "button", text: "📎 Files for “" + field.label + "”",
                    onClick: () => openRowAttachments(
                        context.recordNumber, field.key + ":_", field.label)
                });
                wrapper.append(btn);
            } else {
                wrapper.append(el("input", { type: "text", disabled: "disabled", class: "readonly" }));
                wrapper.append(el("span", { class: "field-hint",
                    text: "Save the record, then attach files here." }));
            }
            return { wrapper, input, field };
        }

        case "table": {
            /* The repeating grid is its own module (table-editor.js,
               audit H3): an explicit JS row model with a render step,
               not per-row state stashed on DOM nodes. */
            const editor = createTableEditor({
                field, options,
                value: Array.isArray(currentValue) ? currentValue : [],
                recordNumber: context.recordNumber,
                onRowAttach: (rowRef, title) =>
                    openRowAttachments(context.recordNumber, rowRef, title)
            });
            wrapper.append(editor.el);
            return {
                wrapper, input: null, field,
                readTable: () => editor.getRows(),
                writeTable: (rows) => editor.setRows(rows)
            };
        }


        default:
            input = el("input", { type: "text", id, name: field.key, value: currentValue ?? "" });
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

/* Files pinned to one row of a table field. The file itself is an
   ordinary record attachment tagged row_ref = "<fieldKey>:<rowId>";
   this dialog just filters the record's attachments to that one row
   and points buildUploader at the same endpoint with the tag. */
async function openRowAttachments(recordNumber, rowRef, title) {
    const node = ensureDialog();
    const listBox = el("div", { class: "chip-list" });

    const load = async () => {
        listBox.replaceChildren(el("span", { class: "sm dim", text: "Loading..." }));
        try {
            const { attachments } = await api.attachments(recordNumber);
            const mine = (attachments || []).filter((a) => a.row_ref === rowRef);
            if (mine.length === 0) {
                listBox.replaceChildren(el("p", { class: "sm dim", text: "No files on this row yet." }));
                return;
            }
            listBox.replaceChildren(...mine.map((a) => a.has_file
                ? el("button", {
                    class: "chip chip-link", type: "button", title: "Open " + a.filename,
                    onClick: () => openFileWindow(
                        api.attachmentFileUrl(recordNumber, a.id), a.filename, a.mime_type)
                }, a.filename)
                : el("span", { class: "chip", text: a.filename + "  (link)" })));
        } catch (error) {
            listBox.replaceChildren(el("p", { class: "sm", style: "color:var(--crit)", text: error.message }));
        }
    };

    node.replaceChildren(
        el("div", { class: "modal-head" },
            el("h2", { class: "modal-title", text: "Files · " + title })),
        el("div", { class: "modal-body" }, [
            listBox,
            buildUploader({
                url: api.recordAttachmentsUrl(recordNumber),
                fields: { row_ref: rowRef },
                onComplete: load
            })
        ]),
        el("div", { class: "modal-foot" },
            el("button", { class: "btn btn-primary", type: "button", text: "Done",
                onClick: () => node.close() }))
    );
    node.showModal();
    load();
}

export function readValue(entry) {
    if (entry.field.type === "table") {
        const rows = entry.readTable ? entry.readTable() : [];
        return rows.length ? rows : undefined;
    }

    /* A checkbox: ticked stores true, unticked is left unset (the same
       "nothing to record" as an empty text box). */
    if (entry.field.type === "boolean") {
        return entry.input.checked ? true : undefined;
    }

    /* A signature: an unsigned field is a checkbox - ticked means
       "sign me", which the server turns into a sealed record. An
       already-signed field renders read-only and is never sent back
       (the server keeps the stored signature regardless). */
    if (entry.field.type === "signature") {
        return entry.input.type === "checkbox" && entry.input.checked ? true : undefined;
    }

    const raw = entry.input.value;

    if (raw === "" || raw === null) return undefined;
    if (entry.field.type === "number") return Number(raw);

    return raw;
}

/* One field's problem, or null. The building block both the plain
   list (validate, below) and the record editor's clickable summary
   are made from. */
export function fieldProblem(entry) {
    const { field, input } = entry;
    const value = readValue(entry);

    /* an already-signed signature field reads back undefined (it is
       never re-sent) but is not "missing" */
    const alreadySigned = field.type === "signature" && input && input.type !== "checkbox";

    if (field.required && value === undefined && field.type !== "file" && !alreadySigned) {
        return field.type === "table"
            ? field.label + " needs at least one row"
            : field.label + " is required";
    }

    if (value === undefined || field.type === "table") return null;

    if (field.pattern && !new RegExp(field.pattern).test(String(value))) {
        return field.label + " must be " + describePattern(field.pattern);
    }
    if (field.min !== undefined && Number(value) < field.min) {
        return field.label + " must be at least " + field.min;
    }
    if (input && input.disabled && field.required) {
        return field.label + " cannot be set yet";
    }
    return null;
}

export function validate(entries) {
    const problems = [];
    for (const entry of entries) {
        const message = fieldProblem(entry);
        if (message) problems.push(message);
    }
    return problems;
}

/* ---------- full page: create or edit a record ----------

   Every type shares one screen (index.html's #view-record-editor)
   rather than one dialog per type, because the fields are schema-
   driven either way - the only thing that differs between "New NCR"
   and "Edit NCR-2026-0142" is whether values arrive already filled
   in and whether the save button calls create or update. */

const SEVERITY_OPTIONS = [["ok", "OK"], ["warn", "Warning"], ["crit", "Critical"]];

/* Where "Cancel" and "Back" return to, and where a successful save
   lands. Set on every open rather than read once, since the same
   screen is reached from a different register each time. */
let returnView = null;

/* An open editor registers a teardown (drop the beforeunload guard,
   stop the autosave timers) and a dirtiness probe, so navigating away
   by the shared Back button can also warn and clean up. */
let editorTeardown = null;
let editorIsDirty = () => false;

/* The record the editor currently has open, so the shared Print / PDF
   buttons in its header can act on it. Null while creating a new one.
   (Pane editors track their own record via the onEditor handle.) */
let editorRecordNumber = null;

export function wireRecordEditor() {
    const back = document.getElementById("record-editor-back");
    if (back) {
        back.addEventListener("click", () => {
            if (editorIsDirty()
                && !window.confirm("Leave without saving? Your draft is kept and offered when you come back.")) {
                return;
            }
            if (editorTeardown) editorTeardown();
            if (returnView) {
                document.dispatchEvent(new CustomEvent("navigate", { detail: { view: returnView } }));
            }
        });
    }

    const printBtn = document.getElementById("record-editor-print");
    if (printBtn) {
        printBtn.addEventListener("click", () => {
            if (editorRecordNumber) {
                window.open("/api/records/" + encodeURIComponent(editorRecordNumber) + "/pdf?inline=1", "_blank");
            }
        });
    }
    const pdfBtn = document.getElementById("record-editor-pdf");
    if (pdfBtn) {
        pdfBtn.addEventListener("click", () => {
            if (!editorRecordNumber) return;
            api.downloadRecordPdf(editorRecordNumber, { onWait: () => toast("Preparing the PDF…") })
                .catch((error) => toast(error.message, "error"));
        });
    }
}

/* Fields are rendered in the order the form defines, and an optional
   field.section starts a new labelled group whenever it changes -
   the same section-label look already used for "Linked records" and
   "Permission matrix" elsewhere in the app, not a new visual idiom. */
function appendFieldsGrouped(container, entries) {
    let lastSection;
    let first = true;

    for (const entry of entries) {
        const section = entry.field.section || null;

        if (first || section !== lastSection) {
            if (section) container.append(el("div", { class: "section-label", text: section }));
            lastSection = section;
            first = false;
        }

        container.append(entry.wrapper);
    }
}

/* host / headerless / onDone: render the editor into an arbitrary
   container (a pane body) instead of #record-editor-body, skip the
   shared page header, and hand control back to the caller on save or
   cancel rather than navigating. onEditor(handle) hands the caller a
   { isDirty, destroy, number } so several pane editors can run at
   once (M3), each torn down independently. Used by the multi-pane
   workspace so panes can be edited in place. */
export async function openRecordEditor(typeKey, {
    number, onSaved, returnView: fromView, stayOnSave = false, custom = false,
    host = null, headerless = false, onDone = null, onEditor = null
} = {}) {
    if (fromView) returnView = fromView;

    const body = host || document.getElementById("record-editor-body");
    const titleEl = headerless ? null : document.getElementById("record-editor-title");
    const subEl = headerless ? null : document.getElementById("record-editor-sub");
    const statusEl = headerless ? null : document.getElementById("record-editor-status");
    const actionsEl = headerless ? null : document.getElementById("record-editor-actions");
    if (!body) return;

    if (!headerless) editorRecordNumber = number || null;
    if (actionsEl) {
        actionsEl.hidden = !number;
        /* Print / PDF are static + wired once; drop any per-open extras
           (Duplicate / Excel for a custom type) from the last record. */
        actionsEl.querySelectorAll(".editor-extra").forEach((n) => n.remove());
        if (number && custom) {
            const dup = el("button", { class: "btn no-print editor-extra", type: "button", text: "Duplicate" });
            dup.addEventListener("click", async () => {
                dup.disabled = true;
                try {
                    const r = await api.cloneRecord(number);
                    toast(r.number + " created from " + number);
                    openRecordEditor(typeKey, { number: r.number, returnView, stayOnSave, custom, host, headerless, onDone, onEditor });
                } catch (error) { toast(error.message, "error"); dup.disabled = false; }
            });
            const excel = el("button", {
                class: "btn no-print editor-extra", type: "button", text: "Excel",
                onClick: () => api.downloadRecordExcel(number, { onWait: () => toast("Preparing the workbook…") })
                    .catch((error) => toast(error.message, "error"))
            });
            actionsEl.append(dup, excel);
        }
    }
    if (statusEl) statusEl.replaceChildren();

    body.replaceChildren(el("p", { class: "sm dim", text: "Loading..." }));

    let definition;
    let existing = null;

    let existingVersion = null;
    try {
        definition = await api.recordForm(typeKey);
        if (number) {
            const result = await api.record(number);
            existing = result.record;
            existingVersion = result.version || null;
        }
    } catch (error) {
        body.replaceChildren(el("p", { class: "sm", style: "color:var(--crit)", text: error.message }));
        return;
    }

    if (titleEl) titleEl.textContent = existing ? existing.number : "New " + definition.name;
    if (subEl) {
        subEl.textContent = "Clause " + (definition.clause || "-")
            + (existing ? " - form v" + existing.form_version : " - form v" + definition.version);
    }
    if (statusEl && existing) {
        statusEl.replaceChildren(pill(humanize(existing.status), statusKind(existing.status)));
    }

    const errorBox = el("div", { class: "signin-error", hidden: "hidden" });

    /* Filled by the presence heartbeat (P3.3) when someone else has
       this same record open - and now whether they have unsaved
       changes (P3 / M15). */
    const presenceBanner = el("div", { class: "presence-banner", hidden: "hidden" });
    function paintPresence(editors) {
        if (!editors || editors.length === 0) { presenceBanner.hidden = true; return; }
        const names = editors.map((e) => e.name);
        const who = names.length === 1 ? names[0]
            : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
        const anyDirty = editors.some((e) => e.dirty);
        presenceBanner.textContent = who
            + (names.length === 1 ? " also has" : " also have")
            + " this record open"
            + (anyDirty ? ", with unsaved changes. Compare before you save." : ". Whoever saves last wins.");
        presenceBanner.hidden = false;
    }

    /* idPrefix (M3): unique input ids so several editors can be mounted
       at once (concurrent panes). "" for the normal single editor. */
    const idPrefix = headerless && number ? number + "__" : "";

    const entries = definition.fields.map((field) =>
        buildField(field, definition.options, existing ? existing.data[field.key] : undefined,
            { recordNumber: existing ? existing.number : null, idPrefix })
    );

    const titleInput = el("input", {
        type: "text", id: idPrefix + "field-title", name: "title", required: true,
        placeholder: "What is wrong, in one line",
        value: existing ? existing.title : ""
    });

    const titleGroup = el("div", { class: "field-group" }, [
        el("label", { for: idPrefix + "field-title" }, ["Summary", el("span", { class: "req", text: " *" })]),
        titleInput,
        el("span", { class: "field-hint", text: "This is what appears in the register." })
    ]);

    const severitySelect = el("select", { id: idPrefix + "field-severity", name: "severity" },
        SEVERITY_OPTIONS.map(([value, label]) => el("option", {
            value, text: label,
            selected: (existing ? existing.severity : "warn") === value ? "selected" : undefined
        }))
    );

    const severityGroup = el("div", { class: "field-group" }, [
        el("label", { for: idPrefix + "field-severity", text: "Severity" }),
        severitySelect
    ]);

    /* Due date lives on the record itself (records.due_at), not in the
       type-specific data payload, so it is asked for here once rather
       than as a per-type field every form has to remember to declare -
       every register's overdue colouring reads this same column. */
    const dueInput = el("input", {
        type: "date", id: idPrefix + "field-due-at", name: "due_at",
        value: existing && existing.due_at ? existing.due_at.slice(0, 10) : ""
    });

    const dueGroup = el("div", { class: "field-group" }, [
        el("label", { for: idPrefix + "field-due-at", text: "Due date" }),
        dueInput,
        el("span", { class: "field-hint", text: "Optional. Drives the overdue colouring in the register." })
    ]);

    const saveLabel = existing ? "Save changes" : "Raise " + definition.name;
    const save = el("button", { class: "btn btn-primary", type: "submit" }, saveLabel);
    const autosaveHint = el("span", { class: "autosave-hint" });
    const cancel = el("button", { class: "btn", type: "button" }, "Cancel");

    const form = el("form", {}, [errorBox, presenceBanner, titleGroup, severityGroup, dueGroup]);
    appendFieldsGrouped(form, entries);
    form.append(el("div", { class: "row", style: "margin-top:18px" }, [save, cancel, autosaveHint]));

    body.replaceChildren(form);

    /* ---------- the rest of the record (S3) ----------
       For an existing record the editable form is only half the page;
       its workflow, links, attachments and history render below it, so
       the whole record is one surface. A workflow transition re-opens
       the editor so the status pill and any now-locked fields update. */
    if (existing) {
        import("./views/record-context.js")
            .then(({ buildRecordContext }) => {
                /* Skip if a newer editor replaced this form in the host
                   (concurrent panes, or a re-open, took over). */
                if (!body.contains(form)) return;
                body.append(buildRecordContext(typeKey, existing.number, {
                    onWorkflow: () => openRecordEditor(typeKey, {
                        number: existing.number, onSaved, returnView, stayOnSave,
                        custom, host, headerless, onDone, onEditor
                    })
                }));
            })
            .catch(() => { /* context is additive; the form still works without it */ });
    }

    /* ---------- inline validation (P0.3) ---------- */

    function paintFieldError(entry) {
        const message = fieldProblem(entry);
        let node = entry.wrapper.querySelector(":scope > .field-error");
        if (!message) { if (node) node.remove(); return Boolean(message); }
        if (!node) { node = el("div", { class: "field-error" }); entry.wrapper.append(node); }
        node.textContent = message;
        return true;
    }

    function paintTitleError() {
        const bad = !titleInput.value.trim();
        let node = titleGroup.querySelector(":scope > .field-error");
        if (!bad) { if (node) node.remove(); return false; }
        if (!node) { node = el("div", { class: "field-error" }); titleGroup.append(node); }
        node.textContent = "Summary is required";
        return true;
    }

    function focusProblem(target) {
        if (!target) return;
        const focusable = target.matches && target.matches("input,select,textarea,button")
            ? target
            : (target.querySelector && target.querySelector("input:not([type=hidden]),select,textarea,button"));
        (focusable || target).scrollIntoView({ block: "center", behavior: "smooth" });
        if (focusable && typeof focusable.focus === "function") focusable.focus();
    }

    for (const entry of entries) {
        if (entry.field.type === "table" || !entry.wrapper) continue;
        entry.wrapper.addEventListener("focusout", () => paintFieldError(entry));
        entry.wrapper.addEventListener("input", () => {
            if (entry.wrapper.querySelector(":scope > .field-error")) paintFieldError(entry);
        });
    }
    titleInput.addEventListener("blur", paintTitleError);
    titleInput.addEventListener("input", () => {
        if (titleGroup.querySelector(":scope > .field-error")) paintTitleError();
    });

    /* ---------- autosave + unsaved-changes guard (P0.2, M15) ----------
       localStorage is the instant, offline-safe tier; the server draft
       (P3 / M15) is the copy that survives a device change. Both hold
       the same { at, snap } shape. */

    const draftKey = "qmsg:draft:v1:" + typeKey + ":" + (number || "new");
    const serverKey = typeKey + ":" + (number || "new");
    let serverPushTimer = null;
    const store = {
        read() { try { return JSON.parse(localStorage.getItem(draftKey) || "null"); } catch { return null; } },
        write(value) {
            try { localStorage.setItem(draftKey, JSON.stringify(value)); } catch { /* full or blocked */ }
            if (serverPushTimer) clearTimeout(serverPushTimer);
            serverPushTimer = setTimeout(() => {
                api.saveDraft(serverKey, value).catch(() => { /* offline - localStorage still has it */ });
            }, 2000);
        },
        clear() {
            try { localStorage.removeItem(draftKey); } catch { /* blocked */ }
            if (serverPushTimer) clearTimeout(serverPushTimer);
            api.clearDraft(serverKey).catch(() => { /* best effort */ });
        }
    };

    function snapshot() {
        const data = {};
        for (const entry of entries) {
            const value = readValue(entry);
            if (value !== undefined) data[entry.field.key] = value;
        }
        return {
            title: titleInput.value,
            severity: severitySelect.value,
            due_at: dueInput.value || null,
            data
        };
    }
    const cleanJSON = JSON.stringify(snapshot());
    const isDirty = () => JSON.stringify(snapshot()) !== cleanJSON;
    /* Only the one shared-screen editor registers as "the" editor;
       pane editors (M3) may run several at once and are tracked by
       their caller through onEditor instead. */
    if (!headerless) editorIsDirty = isDirty;

    /* Announce that this record is open for editing, and show a banner
       if anyone else already has it. Only for an existing record - a
       new one has no number to key on yet. */
    const stopPresence = existing ? beginEditing(existing.number, paintPresence, isDirty) : null;

    function applyDraft(snap) {
        titleInput.value = snap.title || "";
        severitySelect.value = snap.severity || "warn";
        dueInput.value = snap.due_at || "";
        for (const entry of entries) {
            const value = (snap.data || {})[entry.field.key];
            if (entry.field.type === "table") {
                if (entry.writeTable) entry.writeTable(Array.isArray(value) ? value : []);
            } else if (entry.field.type === "boolean") {
                entry.input.checked = value === true || value === "true";
            } else if (entry.input) {
                const raw = value == null ? "" : String(value);
                entry.input.value = entry.field.type === "date" ? raw.slice(0, 10) : raw;
            }
        }
    }

    let savedAt = 0;
    let saveTimer = null;

    function paintHint() {
        if (!savedAt) { autosaveHint.textContent = ""; return; }
        const mins = Math.round((Date.now() - savedAt) / 60000);
        autosaveHint.textContent = "Draft saved " + (mins < 1 ? "just now" : mins + " min ago");
    }
    function autosave() {
        if (isDirty()) {
            savedAt = Date.now();
            store.write({ at: savedAt, snap: snapshot() });
        } else {
            savedAt = 0;
            store.clear();
        }
        paintHint();
    }
    const queueSave = () => {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(autosave, 700);
    };
    form.addEventListener("input", queueSave);
    form.addEventListener("change", queueSave);
    const hintTicker = setInterval(paintHint, 30000);

    const onBeforeUnload = (event) => {
        if (isDirty()) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", onBeforeUnload);

    let torn = false;
    function teardown() {
        if (torn) return;
        torn = true;
        if (saveTimer) clearTimeout(saveTimer);
        clearInterval(hintTicker);
        window.removeEventListener("beforeunload", onBeforeUnload);
        if (stopPresence) stopPresence();
        if (editorTeardown === teardown) editorTeardown = null;
        if (editorIsDirty === isDirty) editorIsDirty = () => false;
    }
    if (!headerless) {
        if (editorTeardown) editorTeardown();   // a previous shared-screen editor left mounted
        editorTeardown = teardown;
    }
    /* Hand a handle to a pane host so it can check dirtiness and tear
       this instance down without touching sibling pane editors (M3). */
    if (onEditor) onEditor({ isDirty, destroy: teardown, number: number || null });

    function leave() {
        teardown();
        if (onDone) { onDone(null); return; }
        if (returnView) document.dispatchEvent(new CustomEvent("navigate", { detail: { view: returnView } }));
    }
    cancel.addEventListener("click", () => {
        if (isDirty()
            && !window.confirm("Leave without saving? Your draft is kept and offered when you come back.")) {
            return;
        }
        leave();
    });

    /* Offer an unsent draft from a previous visit - this browser's
       localStorage first, else the server copy (a draft started on
       another device). */
    function offerDraft(draft, source) {
        if (!draft || !draft.snap || JSON.stringify(draft.snap) === cleanJSON) return;
        const mins = Math.max(0, Math.round((Date.now() - (draft.at || Date.now())) / 60000));
        const banner = el("div", { class: "draft-banner" }, [
            el("span", {}, "Unsaved draft from " + (mins < 1 ? "moments ago" : mins + " min ago")
                + (source === "server" ? " (another device)." : ".")),
            el("button", {
                type: "button", class: "btn sm",
                onClick: () => { applyDraft(draft.snap); banner.remove(); autosave(); }
            }, "Restore"),
            el("button", {
                type: "button", class: "btn sm",
                onClick: () => { store.clear(); savedAt = 0; paintHint(); banner.remove(); }
            }, "Discard")
        ]);
        form.prepend(banner);
    }

    const localDraft = store.read();
    if (localDraft) {
        offerDraft(localDraft, "local");
    } else {
        /* the server stores the same { at, snap } value store.write sends */
        api.getDraft(serverKey)
            .then((d) => offerDraft(d.snapshot, "server"))
            .catch(() => { /* 404 - no server draft, nothing to offer */ });
    }

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        errorBox.hidden = true;

        const problems = [];
        if (paintTitleError()) problems.push({ message: "Summary is required", focus: titleInput });
        for (const entry of entries) {
            if (paintFieldError(entry)) {
                problems.push({ message: fieldProblem(entry), focus: entry.input || entry.wrapper });
            }
        }

        if (problems.length > 0) {
            errorBox.replaceChildren(
                el("div", {
                    class: "sm", style: "font-weight:600;margin-bottom:4px",
                    text: problems.length === 1 ? "One thing to fix" : problems.length + " things to fix"
                }),
                ...problems.map((problem) => el("button", {
                    type: "button", class: "err-jump", onClick: () => focusProblem(problem.focus)
                }, problem.message))
            );
            errorBox.hidden = false;
            errorBox.scrollIntoView({ behavior: "smooth", block: "center" });
            return;
        }

        const data = {};
        for (const entry of entries) {
            const value = readValue(entry);
            if (value !== undefined) data[entry.field.key] = value;
        }

        /* Conditional form rules - instant feedback before the round
           trip; the server enforces the same rules authoritatively. */
        const rules = checkRules(definition, data);
        if (rules.blocked.length) {
            errorBox.replaceChildren(
                el("div", { class: "sm", style: "font-weight:600;margin-bottom:4px", text: "This form's rules block the save" }),
                ...rules.blocked.map((m) => el("div", { text: m }))
            );
            errorBox.hidden = false;
            errorBox.scrollIntoView({ behavior: "smooth", block: "center" });
            return;
        }

        save.disabled = true;
        save.textContent = "Saving...";

        try {
            let result;

            if (existing) {
                result = await api.updateRecord(existing.number, {
                    title: titleInput.value.trim(),
                    severity: severitySelect.value,
                    due_at: dueInput.value || null,
                    data,
                    /* optimistic concurrency: if someone else saved
                       since this editor opened, the server 409s rather
                       than letting one edit quietly bury the other */
                    ...(existingVersion ? { expected_version: existingVersion } : {})
                });
                existingVersion = result.version || existingVersion;
                toast(result.number + " updated");
            } else {
                const me = currentUser();
                result = await api.createRecord({
                    type: definition.key,
                    title: titleInput.value.trim(),
                    owner: me ? me.initials : undefined,
                    severity: severitySelect.value,
                    due_at: dueInput.value || undefined,
                    data
                });
                toast(result.number + " created");
            }

            store.clear();
            teardown();

            if (onSaved) await onSaved(result);

            /* A pane editor (M2): hand control back so the pane can go
               read-only with the saved values. No navigation. */
            if (onDone) { onDone(result); return; }

            /* stayOnSave (the merged record surface): a saved edit keeps
               you on the record - re-open it so the form rebinds to the
               new version and the context panel refreshes - instead of
               bouncing back to the register. A brand-new record still
               navigates, since there is nothing to stay on. */
            if (stayOnSave && existing) {
                await openRecordEditor(typeKey, {
                    number: result.number, onSaved, returnView, stayOnSave
                });
            } else if (returnView) {
                document.dispatchEvent(new CustomEvent("navigate", { detail: { view: returnView } }));
            }
        } catch (error) {
            /* The server validates everything again. When it disagrees,
               it is right, and it names the fields. */
            const fields = error.payload?.fields;
            const stale = error.payload?.code === "stale";
            const ruleHits = error.payload?.rule_violations;
            errorBox.replaceChildren(
                el("div", { text: stale
                    ? "Someone else saved this record while you were editing. Reopen it to see their change, then re-apply yours."
                    : error.message }),
                fields ? el("div", { class: "sm", text: "Missing: " + fields.join(", ") }) : null,
                ...(Array.isArray(ruleHits) ? ruleHits.map((m) => el("div", { class: "sm", text: m })) : [])
            );
            errorBox.hidden = false;
            errorBox.scrollIntoView({ behavior: "smooth", block: "center" });
        } finally {
            save.disabled = false;
            save.textContent = saveLabel;
        }
    });

    paintHint();
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
