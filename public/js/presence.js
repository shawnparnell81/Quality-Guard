/* ============================================================
   Client side of concurrent-edit presence.

   beginEditing(number, onEditors) tells the server "I have this
   record open", keeps a heartbeat going, listens for presence frames
   on the SSE stream, and calls onEditors(names[]) with the OTHER
   people editing it whenever that set changes. Call the returned
   stop() when the editor closes.
   ============================================================ */

import { api } from "./api.js";
import { currentUser } from "./session.js";
import { onStreamEvent } from "./stream.js";

const HEARTBEAT_MS = 8000;

export function beginEditing(number, onEditors) {
    let stopped = false;
    const me = currentUser();
    const myId = me && me.id;

    const report = (editors) => {
        if (stopped) return;
        onEditors((editors || [])
            .filter((e) => e.id !== myId)
            .map((e) => e.name));
    };

    const beat = async () => {
        if (stopped) return;
        try {
            const { editors } = await api.editingHeartbeat(number);
            /* the heartbeat's own reply already excludes me */
            if (!stopped) onEditors((editors || []).map((e) => e.name));
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
