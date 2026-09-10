/* ============================================================
   Raise one records row of a given type, in its first workflow
   state, optionally linked to another record.

   Three call sites grew their own copy of this: di.js (audit -> DI),
   operations.js (rejected receipt -> NCR), and the audit automation
   (finding -> DI / fail -> NCR). This is the one implementation they
   share. records.js keeps its own create path - that one also runs
   form validation and takes user-supplied fields.

   Runs inside the caller's transaction (takes a client, not a pool).
   ============================================================ */

import { log } from "./logger.js";
import { nextRecordNumber } from "./record-numbering.js";

/**
 * @param {import("pg").PoolClient} client  an open transaction
 * @param {object} opts
 * @param {string} opts.orgId
 * @param {string} opts.typeKey            record_types.key, e.g. "di" | "ncr"
 * @param {string} opts.title
 * @param {object} [opts.data]             the record's form payload
 * @param {"ok"|"warn"|"crit"} [opts.severity]
 * @param {string|null} [opts.linkFromRecordId]  raise a record_links row from this record
 * @param {"related"|"caused_by"|"corrects"|"supersedes"|"child_of"} [opts.linkType]
 * @param {string} opts.userId
 * @returns {Promise<{id: string, number: string} | null>}  null when the org has no such type
 */
export async function raiseLinkedRecord(client, {
    orgId, typeKey, title, data = {}, severity = "warn",
    linkFromRecordId = null, linkType = "child_of", userId
}) {
    const typeRow = await client.query(
        "select id, prefix from record_types where org_id = $1 and key = $2",
        [orgId, typeKey]
    );
    if (typeRow.rowCount === 0) {
        log.warn("raise_linked_record_no_type", { orgId, typeKey });
        return null;
    }
    const recordType = typeRow.rows[0];

    const firstState = await client.query(
        "select key from workflow_states where record_type_id = $1 order by position limit 1",
        [recordType.id]
    );
    if (firstState.rowCount === 0) {
        throw new Error("Record type " + typeKey + " has no workflow states");
    }

    /* Pin the record to the current form version so its detail view
       renders every field the manual form has. Published versions
       only, the same as the manual create path: an automation must
       not pin a record to a draft schema nobody has released. */
    const formVersion = await client.query(`
        select coalesce(max(version), 1) as version from form_versions
         where record_type_id = $1 and published_at is not null
    `, [recordType.id]);

    const number = await nextRecordNumber(client, orgId, recordType);

    const inserted = await client.query(`
        insert into records
            (org_id, record_type_id, number, title, status, severity, data, form_version, created_by)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        returning id, number
    `, [orgId, recordType.id, number, title, firstState.rows[0].key,
        severity, data, formVersion.rows[0].version, userId || null]);
    const newId = inserted.rows[0].id;

    if (linkFromRecordId) {
        await client.query(`
            insert into record_links (from_record_id, to_record_id, link_type)
            values ($1, $2, $3)
            on conflict (from_record_id, to_record_id, link_type) do nothing
        `, [linkFromRecordId, newId, linkType]);

        await client.query(`
            insert into audit_log (org_id, record_id, entity, entity_id, field, new_value, changed_by)
            values ($1, $2, 'records', $2, 'created', $3, $4),
                   ($1, $5, 'record_links', $2, $6, $3, $4)
        `, [orgId, newId, number, userId || null, linkFromRecordId, "linked:" + linkType]);
    } else {
        await client.query(`
            insert into audit_log (org_id, record_id, entity, entity_id, field, new_value, changed_by)
            values ($1, $2, 'records', $2, 'created', $3, $4)
        `, [orgId, newId, number, userId || null]);
    }

    return inserted.rows[0];
}
