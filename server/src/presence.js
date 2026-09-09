/* ============================================================
   "Who else has this record open for editing right now."

   A browser that opens the record editor sends a heartbeat every few
   seconds; the entry expires ~20s after the last one, so a closed tab
   or a dropped connection clears itself without needing a reliable
   "goodbye". Every change to a record's editor set is pushed to that
   org's SSE streams as a { entity: "presence" } frame, so other open
   editors update live.

   In-process, like the SSE bus it rides on - right for one node,
   swap a shared store behind these four functions to scale out.
   ============================================================ */

import { publish } from "./stream.js";

const TTL_MS = 20000;

/* key "<orgId>|<recordNumber>" -> Map<userId, { id, name, at }>.
   A pipe is a safe separator: org ids are UUIDs and record numbers
   are PREFIX-YYYY-NNNN, neither of which contains one. */
const rooms = new Map();

const keyFor = (orgId, number) => String(orgId) + "|" + number;
const splitKey = (key) => {
    const at = key.indexOf("|");
    return [key.slice(0, at), key.slice(at + 1)];
};

function liveEditors(room) {
    const now = Date.now();
    const out = [];
    for (const entry of room.values()) {
        if (now - entry.at < TTL_MS) out.push({ id: entry.id, name: entry.name, dirty: !!entry.dirty });
    }
    return out;
}

function broadcast(orgId, number, room) {
    publish(orgId, {
        entity: "presence",
        id: number,
        action: "editing",
        editors: liveEditors(room)
    });
}

/* Called on open and then on a timer. Returns the current editor list
   (including the caller - the client filters itself out by id). */
export function heartbeat(orgId, number, user, dirty = false) {
    const key = keyFor(orgId, number);
    let room = rooms.get(key);
    if (!room) { room = new Map(); rooms.set(key, room); }

    const prev = room.get(user.id);
    room.set(user.id, {
        id: user.id, name: user.full_name || user.initials || "Someone",
        at: Date.now(), dirty: !!dirty
    });

    /* Tell everyone else when the set changed OR when this editor's
       unsaved-changes state flipped - both are news to the others. */
    if (!prev || !!prev.dirty !== !!dirty) broadcast(orgId, number, room);
    return liveEditors(room);
}

/* Called when the editor closes. */
export function leaveEditing(orgId, number, userId) {
    const key = keyFor(orgId, number);
    const room = rooms.get(key);
    if (!room || !room.delete(userId)) return;
    if (room.size === 0) rooms.delete(key);
    else broadcast(orgId, number, room);
}

/* Prune entries whose last heartbeat aged out; announce the rooms
   that shrank. Runs on a timer from app startup. */
export function sweepPresence() {
    const now = Date.now();
    for (const [key, room] of rooms) {
        let changed = false;
        for (const [userId, entry] of room) {
            if (now - entry.at >= TTL_MS) { room.delete(userId); changed = true; }
        }
        if (!changed) continue;

        const [orgId, number] = splitKey(key);
        if (room.size === 0) {
            rooms.delete(key);
            publish(orgId, { entity: "presence", id: number, action: "editing", editors: [] });
        } else {
            broadcast(orgId, number, room);
        }
    }
}

/* For tests. */
export function editorsFor(orgId, number) {
    const room = rooms.get(keyFor(orgId, number));
    return room ? liveEditors(room) : [];
}

const timer = setInterval(sweepPresence, 10000);
if (typeof timer.unref === "function") timer.unref();
