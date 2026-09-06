/* ============================================================
   Offline queue for shop-floor data entry.

   Native IndexedDB, no library - a queue this small (a handful of
   reports at a time, on one device) does not need one, and every
   dependency added here is one more thing to keep patched on a
   product aimed at shops with no IT department to do that.

   Isolated per organization: the database name is keyed by org_id,
   so a shared floor tablet used by more than one company over its
   life never mixes one tenant's queued reports into another's, and
   nothing written here ever needs its own tenant check - the browser
   itself is the boundary.
   ============================================================ */

import { api } from "./api.js";

const DB_VERSION = 1;

function dbName(orgId) {
    return "qualityguard-offline-" + orgId;
}

function openDb(orgId) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName(orgId), DB_VERSION);

        request.onupgradeneeded = () => {
            const db = request.result;

            if (!db.objectStoreNames.contains("pending")) {
                const store = db.createObjectStore("pending", { keyPath: "localId", autoIncrement: true });
                store.createIndex("status", "status");
            }

            /* A record type's form (its fields, and the option lists for
               any link field) is fetched live normally, but a device
               that has never been online since this feature shipped has
               nothing to render offline. Caching the last-seen
               definition means the form still opens - option lists just
               will not reflect anything added since the last sync. */
            if (!db.objectStoreNames.contains("forms")) {
                db.createObjectStore("forms", { keyPath: "typeKey" });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function idbRequest(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/* ---------- the queue itself ---------- */

export async function enqueueRecord(orgId, payload) {
    const db = await openDb(orgId);
    const idempotencyKey = crypto.randomUUID();

    const entry = {
        idempotencyKey,
        payload,
        status: "pending",
        attempts: 0,
        lastError: null,
        createdAt: new Date().toISOString()
    };

    const localId = await idbRequest(
        db.transaction("pending", "readwrite").objectStore("pending").add(entry)
    );

    db.close();
    return { localId, idempotencyKey };
}

export async function listQueue(orgId) {
    const db = await openDb(orgId);
    const all = await idbRequest(
        db.transaction("pending", "readonly").objectStore("pending").getAll()
    );
    db.close();
    return all;
}

export async function removeFromQueue(orgId, localId) {
    const db = await openDb(orgId);
    await idbRequest(
        db.transaction("pending", "readwrite").objectStore("pending").delete(localId)
    );
    db.close();
}

async function updateQueueEntry(orgId, localId, patch) {
    const db = await openDb(orgId);
    const store = db.transaction("pending", "readwrite").objectStore("pending");
    const existing = await idbRequest(store.get(localId));

    if (existing) {
        await idbRequest(store.put({ ...existing, ...patch }));
    }

    db.close();
}

/* ---------- cached form definitions, for opening the screen offline ---------- */

export async function cacheForm(orgId, typeKey, definition) {
    const db = await openDb(orgId);
    await idbRequest(
        db.transaction("forms", "readwrite").objectStore("forms")
            .put({ typeKey, definition, cachedAt: new Date().toISOString() })
    );
    db.close();
}

export async function getCachedForm(orgId, typeKey) {
    const db = await openDb(orgId);
    const row = await idbRequest(
        db.transaction("forms", "readonly").objectStore("forms").get(typeKey)
    );
    db.close();
    return row ? row.definition : null;
}

/* ---------- syncing ----------

   A network failure (the request never completed - api.js's own
   wording for that case) means "try again later," not "this one
   failed": the record stays queued. Anything else the server said no
   to - a validation error, most likely - will say no again forever,
   so it is marked failed and surfaced rather than retried silently
   on a loop. */

function isNetworkFailure(error) {
    return typeof error.message === "string" && error.message.includes("Cannot reach the server");
}

export async function trySyncQueue(orgId) {
    if (!navigator.onLine) return { synced: 0, failed: 0, remaining: (await listQueue(orgId)).length };

    const attempting = (await listQueue(orgId)).filter((entry) => entry.status !== "failed");

    let synced = 0;
    let failed = 0;

    for (const entry of attempting) {
        try {
            await api.createRecord({ ...entry.payload, idempotency_key: entry.idempotencyKey });
            await removeFromQueue(orgId, entry.localId);
            synced++;
        } catch (error) {
            if (isNetworkFailure(error)) {
                /* Still offline in practice, whatever navigator.onLine
                   claims - stop for now rather than fail every
                   remaining entry against a connection that is not
                   really there. */
                await updateQueueEntry(orgId, entry.localId, {
                    attempts: (entry.attempts || 0) + 1,
                    lastError: error.message
                });
                break;
            }

            await updateQueueEntry(orgId, entry.localId, {
                status: "failed",
                attempts: (entry.attempts || 0) + 1,
                lastError: error.message
            });
            failed++;
        }
    }

    const remaining = (await listQueue(orgId)).length;
    return { synced, failed, remaining };
}

/* Runs a sync attempt whenever the browser regains connectivity, once
   at startup if already online, and on a slow interval besides - some
   OS/network-driver combinations never fire the 'online' event
   reliably, and checking a local IndexedDB store costs nothing when
   there is nothing queued. */
export function wireAutoSync(orgId, onSyncComplete) {
    let running = false;

    const run = async () => {
        if (running) return;
        running = true;

        try {
            const result = await trySyncQueue(orgId);
            if (onSyncComplete) onSyncComplete(result);
        } finally {
            running = false;
        }
    };

    window.addEventListener("online", run);
    if (navigator.onLine) run();

    setInterval(run, 30000);

    return run;
}
