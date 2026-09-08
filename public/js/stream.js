/* ============================================================
   Client side of the live change feed.

   One EventSource per tab, opened once after sign-in. View modules
   register interest with onStreamEvent("records", handler) and get
   called with { entity, id, action, at } whenever the server says a
   record (or document, ...) changed in this org.

   EventSource reconnects on its own using the server's `retry:` hint,
   so there is no backoff logic here - only a guard against opening a
   second stream, and a clean teardown for sign-out.
   ============================================================ */

const handlers = new Map();   // entity -> Set<fn>
let source = null;

/* Subscribe to one entity bucket ("records", "documents"). Returns an
   unsubscribe function. */
export function onStreamEvent(entity, handler) {
    if (!handlers.has(entity)) handlers.set(entity, new Set());
    handlers.get(entity).add(handler);
    return () => offStreamEvent(entity, handler);
}

export function offStreamEvent(entity, handler) {
    const set = handlers.get(entity);
    if (set) set.delete(handler);
}

function dispatch(event) {
    const set = handlers.get(event.entity);
    if (!set) return;
    for (const handler of set) {
        try { handler(event); } catch (error) { console.error("stream handler failed", error); }
    }
}

/* Opens the stream. Safe to call more than once - the second call is
   a no-op while a stream is already open. */
export function startStream() {
    if (source || typeof EventSource === "undefined") return;

    source = new EventSource("/api/stream", { withCredentials: true });

    source.addEventListener("change", (message) => {
        let event;
        try { event = JSON.parse(message.data); } catch { return; }
        if (event && event.entity) dispatch(event);
    });

    /* EventSource fires "error" on every transient drop and then
       reconnects itself; only worth a line when it actually gives up
       (readyState CLOSED), which happens on a 401 after the session
       ends - the next API call will redirect to sign-in anyway. */
    source.addEventListener("error", () => {
        if (source && source.readyState === EventSource.CLOSED) {
            console.info("Live updates disconnected.");
        }
    });
}

export function stopStream() {
    if (source) {
        source.close();
        source = null;
    }
}
