/* ============================================================
   Server-Sent Events: one long-lived GET per browser tab, so a
   register or a dashboard can refresh the row that changed without
   polling.

   The bus is in-process. That is the right size for a single-node
   deployment - which is what a small shop runs - and the publish()
   call is a no-op cost when nobody is listening. Moving to multiple
   nodes later means putting Redis (or Postgres LISTEN/NOTIFY) behind
   publish() and nothing else changes.

   Wire format (EventSource): an event named "change" whose data is
       { orgId, entity, id, action, at }
   entity  - coarse bucket the client keys on: "records", "documents"
   id      - what the client needs to refetch (a record number, a doc id)
   action  - "created" | "updated" | "transitioned" | "deleted"
   ============================================================ */

import { EventEmitter } from "node:events";

const bus = new EventEmitter();
/* One listener per open connection; a busy shop could have dozens of
   tabs open. Node warns past 10 by default - lift the cap rather than
   leak the warning. */
bus.setMaxListeners(0);

/* Fan a change out to every open stream belonging to that org. Safe
   to call from anywhere, including inside a request handler after the
   response has been sent. */
export function publish(orgId, event) {
    if (!orgId || !event || !event.entity) return;
    bus.emit("change", {
        ...event,                       // carry through any extra payload (e.g. presence's `editors`)
        orgId: String(orgId),
        entity: event.entity,
        id: event.id ?? null,
        action: event.action || "updated",
        at: Date.now()
    });
}

/* GET /api/stream - mounted behind requireAuth, so request.user is
   set. Held open until the client navigates away or the socket drops. */
export function streamHandler(request, response) {
    const orgId = String(request.user.org_id);

    response.status(200).set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        /* nginx and friends buffer proxied responses by default, which
           would hold every event until the connection closed. */
        "X-Accel-Buffering": "no"
    });
    if (typeof response.flushHeaders === "function") response.flushHeaders();

    /* retry: tells EventSource how long to wait before reconnecting.
       The comment line is a valid no-op frame that opens the stream. */
    response.write("retry: 3000\n\n");
    response.write(": connected\n\n");

    const onChange = (event) => {
        if (event.orgId !== orgId) return;
        response.write("event: change\n");
        response.write("data: " + JSON.stringify(event) + "\n\n");
    };
    bus.on("change", onChange);

    /* A comment every 25s so proxies and load balancers don't reap the
       connection as idle. */
    const heartbeat = setInterval(() => {
        response.write(": ping\n\n");
    }, 25000);
    if (typeof heartbeat.unref === "function") heartbeat.unref();

    const stop = () => {
        clearInterval(heartbeat);
        bus.off("change", onChange);
    };
    request.on("close", stop);
    request.on("error", stop);
}

/* For tests: how many streams are currently open. */
export function openStreamCount() {
    return bus.listenerCount("change");
}
