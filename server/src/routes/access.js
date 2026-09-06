/* ============================================================
   Who am I, and who may do what.

   The matrix endpoint is not only for the app. Printed, it is the
   clause 5.3 record of assigned authorities, which is a thing an
   auditor asks for by name.
   ============================================================ */

import { Router } from "express";
import { query, withTransaction } from "../db.js";
import { requirePermission } from "../auth.js";
import { hashPassword, generateTemporaryPassword } from "../passwords.js";

export const access = Router();

/* GET /api/me
   Everything the front end needs to decide what to show.

   Exported as a bare handler because it is mounted before the forced
   password change gate: the change-password screen still needs to
   know who it is talking to, and this exposes nothing but the
   caller's own identity. */
export function meHandler(request, response) {
    if (!request.user) {
        return response.status(401).json({ error: "Not signed in" });
    }

    response.json({
        id: request.user.id,
        org_id: request.user.org_id,
        name: request.user.full_name,
        initials: request.user.initials,
        role: request.user.role,
        role_name: request.user.role_name,
        must_change_password: request.user.must_change_password,
        permissions: [...request.permissions].sort()
    });
}

/* PUT /api/roles/:roleKey/permissions/:permissionKey   { granted }

   Changing the matrix changes who may sign off what, so it is itself
   an audited act under clause 5.3. Every grant and revoke records who
   made it, when, and against which role. */
access.put("/roles/:roleKey/permissions/:permissionKey",
    requirePermission("roles.manage"),
    async (request, response, next) => {
        try {
            const { roleKey, permissionKey } = request.params;
            const granted = request.body?.granted === true;

            const [role, permission] = await Promise.all([
                query("select key, name from roles where org_id = $1 and key = $2",
                    [request.user.org_id, roleKey]),
                query("select key, description from permissions where key = $1", [permissionKey])
            ]);

            if (role.rowCount === 0) {
                return response.status(404).json({ error: "No such role: " + roleKey });
            }
            if (permission.rowCount === 0) {
                return response.status(404).json({ error: "No such permission: " + permissionKey });
            }

            /* Lockout guard.
               Removing roles.manage from your own role would leave
               nobody able to put it back except by editing the
               database by hand. */
            if (!granted
                && permissionKey === "roles.manage"
                && roleKey === request.user.role) {
                return response.status(409).json({
                    error: "You cannot remove access control from your own role",
                    detail: "Grant it to another role first, or ask that role to make this change."
                });
            }

            /* Somebody has to be able to administer access. Scoped to
               this org: another company running low on roles.manage
               holders is not this company's problem, and is not this
               company's business to see. */
            if (!granted && permissionKey === "roles.manage") {
                const holders = await query(
                    "select count(*)::int as n from role_permissions where org_id = $1 and permission_key = 'roles.manage'",
                    [request.user.org_id]
                );
                if (holders.rows[0].n <= 1) {
                    return response.status(409).json({
                        error: "At least one role must keep access control"
                    });
                }
            }

            const changed = await withTransaction(async (client) => {
                const before = await client.query(
                    "select 1 from role_permissions where org_id = $1 and role_key = $2 and permission_key = $3",
                    [request.user.org_id, roleKey, permissionKey]
                );

                const had = before.rowCount > 0;
                if (had === granted) return { role: roleKey, permission: permissionKey, granted, unchanged: true };

                if (granted) {
                    await client.query(
                        "insert into role_permissions (org_id, role_key, permission_key) values ($1, $2, $3)",
                        [request.user.org_id, roleKey, permissionKey]
                    );
                } else {
                    await client.query(
                        "delete from role_permissions where org_id = $1 and role_key = $2 and permission_key = $3",
                        [request.user.org_id, roleKey, permissionKey]
                    );
                }

                await client.query(`
                    insert into audit_log
                        (org_id, entity, field, old_value, new_value, reason, changed_by)
                    values ($1, 'role_permissions', $2, $3, $4, $5, $6)
                `, [request.user.org_id,
                    roleKey + " / " + permissionKey,
                    had ? "granted" : "not granted",
                    granted ? "granted" : "not granted",
                    request.body?.reason || null,
                    request.user.id]);

                return { role: roleKey, permission: permissionKey, granted, unchanged: false };
            });

            response.json(changed);
        } catch (error) {
            next(error);
        }
    });

/* GET /api/roles/history
   What has been changed about who may do what, most recent first. */
access.get("/roles/history", requirePermission("roles.manage"), async (request, response, next) => {
    try {
        const result = await query(`
            select a.field as change, a.old_value, a.new_value, a.reason,
                   a.changed_at, u.full_name as changed_by
              from audit_log a
         left join users u on u.id = a.changed_by
             where a.org_id = $1 and a.entity = 'role_permissions'
             order by a.changed_at desc
             limit 40
        `, [request.user.org_id]);

        response.json({ count: result.rowCount, history: result.rows });
    } catch (error) {
        next(error);
    }
});

/* GET /api/users
   The people directory. Reading who holds which authority is itself a
   permission, because the org chart is not public information. */
access.get("/users", requirePermission("user.read"), async (request, response, next) => {
    try {
        const result = await query(`
            select u.initials, u.full_name, u.email, u.role, u.discipline,
                   u.job_title, u.active, u.created_at,
                   r.name as role_name, r.position as role_position,
                   (select count(*)::int from role_permissions rp
                     where rp.org_id = u.org_id and rp.role_key = u.role) as permission_count
              from users u
              join roles r on r.key = u.role and r.org_id = u.org_id
             where u.org_id = $1
             order by r.position desc, u.full_name
        `, [request.user.org_id]);

        response.json({ count: result.rowCount, users: result.rows });
    } catch (error) {
        next(error);
    }
});

/* POST /api/users
   Adding a person is an authority in its own right, clause 5.3. Who
   did it and when is written to the audit log, because "who gave them
   access" is a question that gets asked after something goes wrong. */
access.post("/users", requirePermission("user.create"), async (request, response, next) => {
    try {
        const { full_name, email, initials, role, discipline, job_title } = request.body || {};

        if (!full_name || !email || !initials || !role) {
            return response.status(400).json({
                error: "full_name, email, initials and role are all required"
            });
        }

        const roleRow = await query(
            "select key from roles where org_id = $1 and key = $2",
            [request.user.org_id, role]
        );
        if (roleRow.rowCount === 0) {
            return response.status(400).json({ error: "Unknown role: " + role });
        }

        const clash = await query(
            "select initials from users where org_id = $1 and (email = $2 or initials = $3)",
            [request.user.org_id, email, initials.toUpperCase()]
        );
        if (clash.rowCount > 0) {
            return response.status(409).json({
                error: "Someone already has that email or those initials"
            });
        }

        /* A new account gets a temporary password that must be replaced
           on first sign-in. It is returned exactly once, here, and never
           stored in readable form, so the only way to recover it is a
           reset. */
        const temporary = generateTemporaryPassword();
        const { hash, salt } = await hashPassword(temporary);

        const created = await withTransaction(async (client) => {
            const inserted = await client.query(`
                insert into users
                    (org_id, email, full_name, initials, role, discipline, job_title,
                     password_hash, password_salt, must_change_password, created_by)
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10)
                returning id, initials, full_name, role
            `, [request.user.org_id, email, full_name, initials.toUpperCase(), role,
                discipline || null, job_title || null, hash, salt, request.user.id]);

            await client.query(`
                insert into audit_log
                    (org_id, entity, entity_id, field, new_value, reason, changed_by)
                values ($1, 'users', $2, 'created', $3, $4, $5)
            `, [request.user.org_id, inserted.rows[0].id,
                full_name + " as " + role, "New user added", request.user.id]);

            return inserted.rows[0];
        });

        response.status(201).json({
            ...created,
            temporary_password: temporary,
            note: "Give this to them directly. It is shown once and cannot be retrieved."
        });
    } catch (error) {
        next(error);
    }
});

/* PATCH /api/users/:initials
   Changing someone's role changes what they may sign off, so the old
   and new values both go in the audit log. */
access.patch("/users/:initials", requirePermission("user.edit"), async (request, response, next) => {
    try {
        const { role, discipline, job_title, reason } = request.body || {};

        if (role) {
            const roleRow = await query(
            "select key from roles where org_id = $1 and key = $2",
            [request.user.org_id, role]
        );
            if (roleRow.rowCount === 0) {
                return response.status(400).json({ error: "Unknown role: " + role });
            }
        }

        const updated = await withTransaction(async (client) => {
            const existing = await client.query(
                "select id, role, discipline, job_title from users where org_id = $1 and initials = $2 for update",
                [request.user.org_id, request.params.initials.toUpperCase()]
            );

            if (existing.rowCount === 0) return null;
            const before = existing.rows[0];

            if (role && role !== before.role) {
                await client.query(`
                    insert into audit_log
                        (org_id, entity, entity_id, field, old_value, new_value, reason, changed_by)
                    values ($1, 'users', $2, 'role', $3, $4, $5, $6)
                `, [request.user.org_id, before.id, before.role, role,
                    reason || null, request.user.id]);
            }

            const result = await client.query(`
                update users
                   set role       = coalesce($2, role),
                       discipline = coalesce($3, discipline),
                       job_title  = coalesce($4, job_title)
                 where id = $1
                returning initials, full_name, role, discipline, job_title
            `, [before.id, role || null, discipline || null, job_title || null]);

            return result.rows[0];
        });

        if (!updated) return response.status(404).json({ error: "No such user" });
        response.json(updated);
    } catch (error) {
        next(error);
    }
});

/* POST /api/users/:initials/reset-password

   For the person who has forgotten theirs. Issues a fresh temporary
   password, forces a change on next sign-in, and ends every session
   they currently hold: if the reason for the reset is that somebody
   else got in, leaving those alive defeats the point. */
access.post("/users/:initials/reset-password",
    requirePermission("user.reset_password"),
    async (request, response, next) => {
        try {
            const target = request.params.initials.toUpperCase();
            const temporary = generateTemporaryPassword();
            const { hash, salt } = await hashPassword(temporary);

            const result = await withTransaction(async (client) => {
                const found = await client.query(
                    "select id, full_name from users where org_id = $1 and initials = $2 for update",
                    [request.user.org_id, target]
                );

                if (found.rowCount === 0) return null;
                const user = found.rows[0];

                await client.query(`
                    update users
                       set password_hash = $2, password_salt = $3,
                           must_change_password = true,
                           failed_attempts = 0, locked_until = null
                     where id = $1
                `, [user.id, hash, salt]);

                await client.query(`
                    update sessions set revoked_at = now()
                     where user_id = $1 and revoked_at is null
                `, [user.id]);

                await client.query(`
                    insert into audit_log
                        (org_id, entity, entity_id, field, new_value, reason, changed_by)
                    values ($1, 'users', $2, 'password_reset', 'temporary issued', $3, $4)
                `, [request.user.org_id, user.id, request.body?.reason || null, request.user.id]);

                return user;
            });

            if (!result) return response.status(404).json({ error: "No such user" });

            response.json({
                initials: target,
                full_name: result.full_name,
                temporary_password: temporary,
                sessions_ended: true,
                note: "Give this to them directly. It is shown once and cannot be retrieved."
            });
        } catch (error) {
            next(error);
        }
    });

/* POST /api/users/:initials/deactivate
   Access is withdrawn, never deleted. The person stays on every record
   they touched, which is what makes the history readable years later. */
access.post("/users/:initials/deactivate",
    requirePermission("user.deactivate"),
    async (request, response, next) => {
        try {
            const target = request.params.initials.toUpperCase();

            if (request.user.initials === target) {
                return response.status(409).json({
                    error: "You cannot remove your own access"
                });
            }

            const result = await withTransaction(async (client) => {
                const found = await client.query(
                    "select id, active from users where org_id = $1 and initials = $2 for update",
                    [request.user.org_id, target]
                );

                if (found.rowCount === 0) return null;

                await client.query(`
                    update users set active = false, deactivated_at = now()
                     where id = $1
                `, [found.rows[0].id]);

                await client.query(`
                    insert into audit_log
                        (org_id, entity, entity_id, field, old_value, new_value, reason, changed_by)
                    values ($1, 'users', $2, 'active', 'true', 'false', $3, $4)
                `, [request.user.org_id, found.rows[0].id,
                    request.body?.reason || null, request.user.id]);

                return { initials: target, active: false };
            });

            if (!result) return response.status(404).json({ error: "No such user" });
            response.json(result);
        } catch (error) {
            next(error);
        }
    });

/* GET /api/roles
   The full permission matrix: every role, every permission, and which
   cells are granted. */
access.get("/roles", async (request, response, next) => {
    try {
        const [roles, permissions, grants] = await Promise.all([
            query("select key, name, description, position from roles where org_id = $1 order by position",
                [request.user.org_id]),
            query(`select key, resource, action, description, clause
                     from permissions order by clause nulls last, key`),
            query("select role_key, permission_key from role_permissions where org_id = $1",
                [request.user.org_id])
        ]);

        /* Set lookup so the client can render a grid without an N by M
           search through an array of grants. */
        const granted = {};
        for (const row of grants.rows) {
            (granted[row.permission_key] ||= []).push(row.role_key);
        }

        response.json({
            roles: roles.rows,
            permissions: permissions.rows.map((permission) => ({
                ...permission,
                roles: granted[permission.key] || []
            }))
        });
    } catch (error) {
        next(error);
    }
});
