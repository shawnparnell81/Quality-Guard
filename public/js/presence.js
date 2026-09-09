/* ============================================================
   Client side of concurrent-edit presence.

   beginEditing(number, onEditors, getDirty) tells the server "I have
   this record open", keeps a heartbeat going, listens for presence
   frames on the SSE stream, and calls onEditors with the OTHER people
   editing it - [{ name, dirty }] - whenever that set changes.
   getDirty(), if given, is polled each heartbeat so this editor's own
   unsaved-changes state reaches the others. Call the returned stop()
   when the editor closes.
   ============================================================ */

import { api } from "./api.js";
import { currentUser } from "./session.js";
import { onStreamEvent } from "./stream.js";

const HEARTBEAT_MS = 8000;

export function beginEditing(number, onEditors, getDirty) {
    let stopped = false;
    const me = currentUser();
    const myId = me && me.id;

    const shape = (editors, dropMe) => (editors || [])
        .filter((e) => !dropMe || e.id !== myId)
        .map((e) => ({ name: e.name, dirty: !!e.dirty }));

    const report = (editors) => { if (!stopped) onEditors(shape(editors, true)); };

    const beat = async () => {
        if (stopped) return;
        try {
            const { editors } = await api.editingHeartbeat(number, getDirty ? getDirty() : false);
            /* the heartbeat's own reply already excludes me */
            if (!stopped) onEditors(shape(editors, false));
        } catch { /* record gone or offline - the SSE frame will correct us */ }
    };

    const offStream = onStreamEvent("presence", (event) => {
        if (event.id === number) report(event.editors);
    });

    beat();
    const timer = setInterval(beat, HEARTBEAT_MS);

    return function stop() {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        offStream();
        api.stopEditing(number).catch(() => { /* best effort; TTL covers it */ });
    };
}
