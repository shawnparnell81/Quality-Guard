/* ============================================================
   Permission matrix.

   The screen an auditor is shown when they ask who is authorised to
   do what. Printed, it is the clause 5.3 record, so it is built from
   the same tables the server enforces against. A matrix that could
   drift from the real rules would be worse than no matrix at all.
   ============================================================ */

import { api } from "../api.js";
import { currentUser, can, applyPermissions } from "../session.js";
import { el, pill, fillTable, loadingRow, errorRow, humanize, toast } from "../dom.js";
import { ensureDialog, confirmStep } from "../forms.js";

export async function renderRoles() {
    const matrix = document.getElementById("roles-matrix");
    const rolesBody = document.getElementById("roles-table");

    if (rolesBody) loadingRow(rolesBody, 3);

    try {
        const { roles, permissions } = await api.roles();
        const me = currentUser();
        const editable = can("roles.manage");

        /* ---- the grid ----
           Forty-eight permissions across thirteen roles is too much to
           scan as one undifferentiated list, so rows are grouped by the
           thing they act on and each group gets a banner. */
        if (matrix) {
            const head = el("tr", {}, [
                el("th", { text: "Permission" }),
                el("th", { text: "Clause" }),
                ...roles.map((role) => el("th", {
                    text: shortName(role.name),
                    title: role.name + ". " + (role.description || ""),
                    class: me && me.role === role.key ? "col-you" : null
                }))
            ]);

            const body = [];
            let lastResource = null;

            for (const permission of permissions) {
                if (permission.resource !== lastResource) {
                    lastResource = permission.resource;
                    body.push(el("tr", { class: "group-row" }, [
                        el("td", {
                            colspan: roles.length + 2,
                            text: resourceLabel(permission.resource)
                        })
                    ]));
                }

                body.push(el("tr", {}, [
                    el("td", { class: "sm", title: permission.key }, permission.description),
                    el("td", { class: "mono sm dim" }, permission.clause || "-"),

                    ...roles.map((role) => {
                        const granted = permission.roles.includes(role.key);
                        const isYou = me && me.role === role.key;

                        return el("td", {
                            class: "mark " + (granted ? "mark-y" : "mark-n")
                                    + (isYou ? " col-you" : "")
                                    + (editable ? " mark-editable" : ""),
                            dataset: editable
                                ? { role: role.key, permission: permission.key,
                                    granted: String(granted) }
                                : undefined,
                            title: editable
                                ? "Click to " + (granted ? "revoke from " : "grant to ") + role.name
                                : role.name + (granted ? " may " : " may not ")
                                  + permission.description.toLowerCase()
                        }, granted ? "Y" : ".");
                    })
                ]));
            }

            matrix.replaceChildren(
                el("thead", {}, head),
                el("tbody", {}, body)
            );
        }

        setMatrixHint(editable);

        const note = document.getElementById("matrix-note");
        if (note) {
            note.textContent = permissions.length + " permissions across "
                + roles.length + " roles, clause 5.3";
        }

        /* ---- the roles themselves ---- */
        const counts = {};
        for (const permission of permissions) {
            for (const role of permission.roles) {
                counts[role] = (counts[role] || 0) + 1;
            }
        }

        fillTable(rolesBody, roles, [
            { render: (row) => {
                const you = me && me.role === row.key;
                return you
                    ? [row.name, el("span", { class: "chip", style: "margin-left:8px", text: "you" })]
                    : row.name;
            } },
            { className: "sm dim", render: (row) => row.description || "-" },
            { className: "num", render: (row) => counts[row.key] || 0 }
        ]);

    } catch (error) {
        errorRow(rolesBody, 3, error);
        if (matrix) matrix.replaceChildren();
    }
}

/* Column headers have to fit thirteen roles across, so shorten to the
   distinctive word rather than truncating every one with an ellipsis.
   The full name stays in the title attribute. */
const SHORT_NAMES = {
    "Operator":               "Operator",
    "Quality Inspector":      "Q Insp",
    "Quality Tech":           "Q Tech",
    "Quality Engineer":       "Q Eng",
    "Design Engineer":        "Design",
    "Manufacturing Engineer": "Mfg Eng",
    "Document Controller":    "Doc Ctl",
    "Purchasing Manager":     "Purch",
    "Production Manager":     "Prod Mgr",
    "Engineering Manager":    "Eng Mgr",
    "Quality Manager":        "Qual Mgr",
    "General Manager":        "GM",
    "Administrator":          "Admin"
};

function shortName(name) {
    return SHORT_NAMES[name] || name;
}

const RESOURCE_LABELS = {
    ncr:        "Nonconformance",
    mrb:        "Material review board",
    capa:       "Corrective action",
    complaint:  "Customer complaints",
    document:   "Document control",
    drawing:    "Engineering drawings",
    change:     "Change control",
    vendor:     "Supply base",
    scar:       "Supplier corrective action",
    production: "Production",
    shipping:   "Shipping",
    gage:       "Calibration",
    training:   "Training",
    audit:      "Internal audit",
    risk:       "Risk register",
    user:       "People",
    roles:      "Access control"
};

function resourceLabel(resource) {
    return RESOURCE_LABELS[resource] || humanize(resource);
}

function setMatrixHint(editable) {
    const hint = document.getElementById("matrix-hint");
    if (!hint) return;

    hint.textContent = editable
        ? "Click any cell to grant or revoke. Every change is recorded against your name."
        : "Read only. Changing who may do what requires the roles.manage permission.";
}

/* One delegated listener for the whole grid.

   The cell is updated straight away and rolled back if the server
   refuses, which keeps the grid feeling immediate without ever
   showing a state the server did not accept. */
export function wireMatrixEditing() {
    const matrix = document.getElementById("roles-matrix");
    if (!matrix) return;

    matrix.addEventListener("click", async (event) => {
        const cell = event.target.closest("td.mark-editable[data-role]");
        if (!cell || cell.dataset.busy === "true") return;

        const wasGranted = cell.dataset.granted === "true";
        const nowGranted = !wasGranted;

        paintCell(cell, nowGranted);
        cell.dataset.busy = "true";

        try {
            await api.setRolePermission(
                cell.dataset.role,
                cell.dataset.permission,
                nowGranted
            );
            flashMatrixMessage(null);
        } catch (error) {
            paintCell(cell, wasGranted);
            flashMatrixMessage(error.message);
        } finally {
            cell.dataset.busy = "false";
        }
    });
}

function paintCell(cell, granted) {
    cell.dataset.granted = String(granted);
    cell.textContent = granted ? "Y" : ".";
    cell.classList.toggle("mark-y", granted);
    cell.classList.toggle("mark-n", !granted);
}

function flashMatrixMessage(message) {
    const box = document.getElementById("matrix-message");
    if (!box) return;

    box.textContent = message || "";
    box.hidden = !message;
}

/* ============================================================
   People and access

   The directory used to be read-only: the server has always been
   able to add a person, change their role, reset a forgotten
   password or withdraw access, but nothing in the screen offered a
   way to reach those endpoints. Every action below calls a route
   that already existed and was already enforced - this only gives
   an honest person a button instead of a terminal.
   ============================================================ */

let peopleCache = [];

export async function renderPeople() {
    const tbody = document.getElementById("people-table");
    if (!tbody) return;

    loadingRow(tbody, 7);

    /* Reading the directory is itself a permission, so someone without
       it gets an explanation rather than an empty table. */
    if (!can("user.read")) {
        tbody.replaceChildren(
            el("tr", {}, el("td", {
                colspan: 7,
                class: "sm dim",
                style: "text-align:center;padding:28px"
            }, [
                el("div", { text: "You do not have permission to view the people directory." }),
                el("div", {
                    class: "sm",
                    style: "margin-top:6px",
                    text: "Requires user.read. Switch to an Administrator, Engineering Manager,"
                          + " Quality Manager or General Manager to see it."
                })
            ]))
        );
        setPeopleNote("restricted");
        return;
    }

    try {
        const { users, count } = await api.users();
        peopleCache = users;

        fillTable(tbody, users, [
            { render: (row) => {
                const me = currentUser();
                const you = me && me.initials === row.initials;
                return you
                    ? [row.full_name, el("span", { class: "chip", style: "margin-left:8px", text: "you" })]
                    : row.full_name;
            } },
            { className: "sm dim", render: (row) => row.job_title || "-" },
            { className: "sm", render: (row) => row.discipline || "-" },
            { render: (row) => pill(row.role_name, row.active ? "info" : "hold") },
            { className: "num", render: (row) => row.permission_count },
            { render: (row) => row.active
                ? pill("Active", "done")
                : pill("Access removed", "hold") },
            { render: (row) => renderPeopleActions(row) }
        ], "No one recorded yet");

        applyPermissions(tbody);

        /* Self-protection mirrors the server's own rule (POST
           /users/:initials/deactivate refuses this too): applied after
           applyPermissions so holding user.deactivate yourself cannot
           re-enable the one row it must never allow. */
        const me = currentUser();
        if (me) {
            const selfDeactivate = tbody.querySelector(
                'button[data-action="deactivate"][data-initials="' + me.initials + '"]'
            );
            if (selfDeactivate) {
                selfDeactivate.disabled = true;
                selfDeactivate.classList.add("not-permitted");
                selfDeactivate.title = "You cannot remove your own access";
            }
        }

        setPeopleNote(count + " people, " + users.filter((u) => u.active).length + " active");
    } catch (error) {
        errorRow(tbody, 7, error);
    }
}

function renderPeopleActions(row) {
    /* Access is withdrawn, never deleted - there is no reactivate
       route, and a deactivated login is refused outright, so nothing
       here would do anything for them anyway. */
    if (!row.active) {
        return el("span", { class: "sm dim", text: "-" });
    }

    return el("div", { class: "row-actions" }, [
        el("button", {
            class: "btn btn-xs", type: "button", text: "Edit",
            dataset: { requires: "user.edit", action: "edit", initials: row.initials }
        }),
        el("button", {
            class: "btn btn-xs", type: "button", text: "Reset password",
            dataset: { requires: "user.reset_password", action: "reset", initials: row.initials }
        }),
        el("button", {
            class: "btn btn-xs btn-danger", type: "button", text: "Deactivate",
            dataset: { requires: "user.deactivate", action: "deactivate", initials: row.initials }
        })
    ]);
}

function setPeopleNote(text) {
    const note = document.getElementById("people-note");
    if (note) note.textContent = text;
}

/* ---------- wiring ---------- */

export function wirePeopleActions() {
    const addButton = document.getElementById("add-person-btn");
    if (addButton) {
        addButton.addEventListener("click", () => {
            if (addButton.disabled) return;
            openCreateUserDialog(() => renderPeople());
        });
    }

    const table = document.getElementById("people-table");
    if (!table) return;

    table.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-action]");
        if (!button || button.disabled) return;

        const user = peopleCache.find((row) => row.initials === button.dataset.initials);
        if (!user) return;

        if (button.dataset.action === "edit") {
            openEditUserDialog(user, () => renderPeople());
        } else if (button.dataset.action === "reset") {
            openResetPasswordDialog(user, () => renderPeople());
        } else if (button.dataset.action === "deactivate") {
            confirmDeactivate(user, () => renderPeople());
        }
    });
}

async function loadRoleOptions() {
    const { roles } = await api.roles();
    return roles;
}

function field(id, labelText, input, required, hint) {
    return el("div", { class: "field-group" }, [
        el("label", { for: id }, [labelText, required ? el("span", { class: "req", text: " *" }) : null]),
        input,
        hint ? el("span", { class: "field-hint", text: hint }) : null
    ]);
}

function showLoadFailure(node, error) {
    node.replaceChildren(
        el("div", { class: "modal-head" }, el("h2", { text: "Could not open the form" })),
        el("div", { class: "modal-body" },
            el("p", { class: "sm", style: "color:var(--crit)", text: error.message })),
        el("div", { class: "modal-foot" },
            el("button", { class: "btn", type: "button", onClick: () => node.close() }, "Close"))
    );
}

/* ---------- add a person ---------- */

function openCreateUserDialog(onDone) {
    const node = ensureDialog();
    node.replaceChildren(el("p", { class: "sm dim", text: "Loading roles..." }));
    node.showModal();

    loadRoleOptions()
        .then((roles) => buildCreateForm(node, roles, onDone))
        .catch((error) => showLoadFailure(node, error));
}

function buildCreateForm(node, roles, onDone) {
    const errorBox = el("div", { class: "signin-error", hidden: "hidden" });

    const nameInput = el("input", { type: "text", id: "np-name", required: true });
    const emailInput = el("input", { type: "email", id: "np-email", required: true });
    const initialsInput = el("input", {
        type: "text", id: "np-initials", required: true, maxlength: 4,
        style: "text-transform:uppercase"
    });
    const roleSelect = el("select", { id: "np-role", required: true }, [
        el("option", { value: "", text: "Choose..." }),
        ...roles.map((role) => el("option", { value: role.key, text: role.name }))
    ]);
    const disciplineInput = el("input", { type: "text", id: "np-discipline" });
    const jobTitleInput = el("input", { type: "text", id: "np-job-title" });

    const save = el("button", { class: "btn btn-primary", type: "submit" }, "Add person");

    const form = el("form", { method: "dialog" }, [
        errorBox,
        field("np-name", "Full name", nameInput, true),
        field("np-email", "Email", emailInput, true),
        field("np-initials", "Initials", initialsInput, true,
            "Used to sign records - keep it short, for example AM"),
        field("np-role", "Role", roleSelect, true),
        field("np-discipline", "Discipline", disciplineInput, false),
        field("np-job-title", "Job title", jobTitleInput, false)
    ]);

    node.replaceChildren(
        el("div", { class: "modal-head" }, el("h2", { class: "modal-title", text: "Add person" })),
        el("div", { class: "modal-body" }, form),
        el("div", { class: "modal-foot" }, [
            el("button", { class: "btn", type: "button", onClick: () => node.close() }, "Cancel"),
            save
        ])
    );

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        errorBox.hidden = true;

        const problems = [];
        if (!nameInput.value.trim()) problems.push("Full name is required");
        if (!emailInput.value.trim()) problems.push("Email is required");
        if (!initialsInput.value.trim()) problems.push("Initials are required");
        if (!roleSelect.value) problems.push("Role is required");

        if (problems.length > 0) {
            errorBox.replaceChildren(...problems.map((text) => el("div", { text })));
            errorBox.hidden = false;
            return;
        }

        save.disabled = true;
        save.textContent = "Adding...";

        try {
            const created = await api.createUser({
                full_name: nameInput.value.trim(),
                email: emailInput.value.trim(),
                initials: initialsInput.value.trim(),
                role: roleSelect.value,
                discipline: disciplineInput.value.trim() || undefined,
                job_title: jobTitleInput.value.trim() || undefined
            });

            node.close();
            showCredentialsDialog({
                heading: created.full_name + " was added",
                initials: created.initials,
                temporaryPassword: created.temporary_password,
                note: created.note
            });
            if (onDone) onDone();
        } catch (error) {
            const fields = error.payload?.fields;
            errorBox.replaceChildren(
                el("div", { text: error.message }),
                fields ? el("div", { class: "sm", text: "Missing: " + fields.join(", ") }) : null
            );
            errorBox.hidden = false;
        } finally {
            save.disabled = false;
            save.textContent = "Add person";
        }
    });

    nameInput.focus();
}

/* ---------- editing role, discipline, job title ---------- */

function openEditUserDialog(user, onDone) {
    const node = ensureDialog();
    node.replaceChildren(el("p", { class: "sm dim", text: "Loading roles..." }));
    node.showModal();

    loadRoleOptions()
        .then((roles) => buildEditForm(node, user, roles, onDone))
        .catch((error) => showLoadFailure(node, error));
}

function buildEditForm(node, user, roles, onDone) {
    const errorBox = el("div", { class: "signin-error", hidden: "hidden" });

    const roleSelect = el("select", { id: "eu-role" },
        roles.map((role) => el("option", {
            value: role.key, text: role.name,
            selected: role.key === user.role ? "selected" : undefined
        }))
    );
    const disciplineInput = el("input", { type: "text", id: "eu-discipline", value: user.discipline || "" });
    const jobTitleInput = el("input", { type: "text", id: "eu-job-title", value: user.job_title || "" });
    const reasonInput = el("textarea", {
        id: "eu-reason", rows: 2, placeholder: "Optional. Recorded against this change."
    });

    const save = el("button", { class: "btn btn-primary", type: "submit" }, "Save");

    const form = el("form", { method: "dialog" }, [
        errorBox,
        field("eu-role", "Role", roleSelect, false),
        field("eu-discipline", "Discipline", disciplineInput, false),
        field("eu-job-title", "Job title", jobTitleInput, false),
        field("eu-reason", "Reason", reasonInput, false)
    ]);

    node.replaceChildren(
        el("div", { class: "modal-head" }, el("h2", { class: "modal-title", text: "Edit " + user.full_name })),
        el("div", { class: "modal-body" }, form),
        el("div", { class: "modal-foot" }, [
            el("button", { class: "btn", type: "button", onClick: () => node.close() }, "Cancel"),
            save
        ])
    );

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        errorBox.hidden = true;
        save.disabled = true;
        save.textContent = "Saving...";

        try {
            await api.updateUser(user.initials, {
                role: roleSelect.value || undefined,
                discipline: disciplineInput.value.trim() || undefined,
                job_title: jobTitleInput.value.trim() || undefined,
                reason: reasonInput.value.trim() || undefined
            });

            node.close();
            toast(user.full_name + " updated");
            if (onDone) onDone();
        } catch (error) {
            errorBox.textContent = error.message;
            errorBox.hidden = false;
        } finally {
            save.disabled = false;
            save.textContent = "Save";
        }
    });
}

/* ---------- resetting a forgotten password ---------- */

function openResetPasswordDialog(user, onDone) {
    const node = ensureDialog();
    const errorBox = el("div", { class: "signin-error", hidden: "hidden" });
    const reasonInput = el("textarea", {
        rows: 2, placeholder: "Optional. Recorded against this change."
    });

    const go = el("button", { class: "btn btn-primary", type: "button" }, "Reset password");

    node.replaceChildren(
        el("div", { class: "modal-head" },
            el("h2", { class: "modal-title", text: "Reset password for " + user.full_name })),
        el("div", { class: "modal-body" }, [
            errorBox,
            el("p", { class: "sm", style: "margin:0 0 14px",
                text: "Issues a new temporary password and ends every session they currently hold." }),
            el("div", { class: "field-group" }, [
                el("label", { text: "Reason" }),
                reasonInput
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
            const result = await api.resetPassword(user.initials, {
                reason: reasonInput.value.trim() || undefined
            });

            node.close();
            showCredentialsDialog({
                heading: "Password reset for " + result.full_name,
                initials: result.initials,
                temporaryPassword: result.temporary_password,
                note: result.note
            });
            if (onDone) onDone();
        } catch (error) {
            errorBox.textContent = error.message;
            errorBox.hidden = false;
        } finally {
            go.disabled = false;
            go.textContent = "Reset password";
        }
    });

    node.showModal();
}

/* ---------- showing a one-time temporary password ---------- */

function showCredentialsDialog({ heading, initials, temporaryPassword, note }) {
    const node = ensureDialog();

    const passwordInput = el("input", {
        type: "text", readonly: "readonly", value: temporaryPassword,
        class: "mono", style: "font-size: 15px; letter-spacing: 0.5px; flex: 1"
    });

    const copyButton = el("button", { class: "btn", type: "button", text: "Copy" });
    copyButton.addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(temporaryPassword);
            copyButton.textContent = "Copied";
            setTimeout(() => { copyButton.textContent = "Copy"; }, 1500);
        } catch {
            /* Clipboard access can be blocked (permissions, non-secure
               context). Selecting the text is the fallback that always
               works, since the field is right there either way. */
            passwordInput.select();
        }
    });

    const done = el("button", { class: "btn btn-primary", type: "button", text: "Done" });
    done.addEventListener("click", () => node.close());

    node.replaceChildren(
        el("div", { class: "modal-head" }, el("h2", { class: "modal-title", text: heading })),
        el("div", { class: "modal-body" }, [
            el("p", { class: "sm", style: "margin:0 0 10px", text: "Temporary password for " + initials + ":" }),
            el("div", { class: "row", style: "gap:8px" }, [passwordInput, copyButton]),
            el("p", { class: "sm dim", style: "margin-top:12px",
                text: note || "Give this to them directly. It is shown once and cannot be retrieved." })
        ]),
        el("div", { class: "modal-foot" }, done)
    );

    node.showModal();
    passwordInput.focus();
    passwordInput.select();
}
