/* ============================================================
   Server-Sent Events: one long-lived GET per browser tab, so a
   register or a dashboard can refresh the row that changed without
   polling.

   The fan-out is cross-instance (audit H8). publish() does a Postgres
   NOTIFY; every app instance holds one dedicated LISTEN connection
   and pushes each notification to its own open SSE streams. Postgres
   is already required, so this adds no infrastructure - the change
   from the old in-process EventEmitter is one NOTIFY and one LISTEN.

   Wire format (EventSource): an event named "change" whose data is
       { orgId, entity, id, action, at, ...extra }
   entity  - coarse bucket the client keys on: "records", "documents"
   id      - what the client needs to refetch (a record number, a doc id)
   action  - "created" | "updated" | "transitioned" | "deleted"
   ============================================================ */

import pg from "pg";
import { pool } from "./db.js";
import { log } from "./logger.js";

const CHANNEL = "qms_change";

/* NOTIFY has an 8 KB payload ceiling. Our frames are tiny except a
   presence frame with a big editor list; past this size we send the
   frame without its `editors` detail and the client refetches. */
const MAX_PAYLOAD = 7000;

/* Every SSE connection this instance is holding: { orgId, send }. */
const localStreams = new Set();

/* ---------- publish ---------- */

export function publish(orgId, event) {
    if (!orgId || !event || !event.entity) return;

    const frame = {
        ...event,
        orgId: String(orgId),
        entity: event.entity,
        id: event.id ?? null,
        action: event.action || "updated",
        at: Date.now()
    };

    let json = JSON.stringify(frame);
    if (json.length > MAX_PAYLOAD && "editors" in frame) {
        delete frame.editors;
        json = JSON.stringify(frame);
    }
    if (json.length > MAX_PAYLOAD) {
        log.warn("stream_frame_dropped", { entity: frame.entity, size: json.length });
        return;
    }

    /* Fire and forget - a change feed must never fail a write. */
    pool.query("select pg_notify($1, $2)", [CHANNEL, json])
        .catch((error) => log.warn("stream_notify_failed", { err: error }));
}

/* ---------- the LISTEN side ---------- */

let listener = null;
let stopped = false;

function fanOut(json) {
    let frame;
    try { frame = JSON.parse(json); } catch { return; }
    for (const stream of localStreams) {
        if (stream.orgId === frame.orgId) stream.send(frame);
    }
}

async function connectListener() {
    if (stopped) return;

    const client = new pg.Client({
        host: process.env.PGHOST,
        port: Number(process.env.PGPORT || 5432),
        database: process.env.PGDATABASE,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD
    });

    client.on("notification", (msg) => {
        if (msg.channel === CHANNEL && msg.payload) fanOut(msg.payload);
    });
    client.on("error", (error) => {
        log.warn("stream_listener_error", { err: error });
        /* the 'end' handler does the reconnect */
    });
    client.on("end", () => {
        listener = null;
        if (!stopped) { const t = setTimeout(connectListener, 2000); if (typeof t.unref === "function") t.unref(); }
    });

    try {
        await client.connect();
        await client.query("LISTEN " + CHANNEL);
        listener = client;
        log.info("stream_listener_ready", { channel: CHANNEL });
    } catch (error) {
        log.warn("stream_listener_connect_failed", { err: error });
        try { await client.end(); } catch { /* already down */ }
        if (!stopped) { const t = setTimeout(connectListener, 2000); if (typeof t.unref === "function") t.unref(); }
    }
}

export function startChangeBus() {
    stopped = false;
    connectListener();
}

export async function stopChangeBus() {
    stopped = true;
    const client = listener;
    listener = null;
    if (client) { try { await client.end(); } catch { /* already down */ } }
}

/* ---------- the SSE endpoint ---------- */

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

    const entry = {
        orgId,
        send(frame) {
            response.write("event: change\n");
            response.write("data: " + JSON.stringify(frame) + "\n\n");
        }
    };
    localStreams.add(entry);

    /* A comment every 25s so proxies and load balancers don't reap the
       connection as idle. */
    const heartbeat = setInterval(() => {
        response.write(": ping\n\n");
    }, 25000);
    if (typeof heartbeat.unref === "function") heartbeat.unref();

    const stop = () => {
        clearInterval(heartbeat);
        localStreams.delete(entry);
    };
    request.on("close", stop);
    request.on("error", stop);
}

/* For tests: how many streams this instance is holding. */
export function openStreamCount() {
    return localStreams.size;
}
