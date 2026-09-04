/* ============================================================
   Permission matrix.

   The screen an auditor is shown when they ask who is authorised to
   do what. Printed, it is the clause 5.3 record, so it is built from
   the same tables the server enforces against. A matrix that could
   drift from the real rules would be worse than no matrix at all.
   ============================================================ */

import { api } from "../api.js";
import { currentUser, can } from "../session.js";
import { el, pill, fillTable, loadingRow, errorRow, humanize } from "../dom.js";

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
   ============================================================ */

export async function renderPeople() {
    const tbody = document.getElementById("people-table");
    if (!tbody) return;

    loadingRow(tbody, 6);

    /* Reading the directory is itself a permission, so someone without
       it gets an explanation rather than an empty table. */
    if (!can("user.read")) {
        tbody.replaceChildren(
            el("tr", {}, el("td", {
                colspan: 6,
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
                : pill("Access removed", "hold") }
        ]);

        setPeopleNote(count + " people, " + users.filter((u) => u.active).length + " active");
    } catch (error) {
        errorRow(tbody, 6, error);
    }
}

function setPeopleNote(text) {
    const note = document.getElementById("people-note");
    if (note) note.textContent = text;
}
