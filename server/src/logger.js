/* ============================================================
   Structured logging.

   One JSON object per line on stdout: { ts, level, msg, ... }. That
   is what a log shipper (or `jq`, or `grep`) wants; a human tailing
   it in dev still gets one readable line per event.

     import { log } from "./logger.js";
     log.info("request", { method, path, status, ms });
     log.error("unhandled", { err, request_id });

   An `err` field is expanded to { message, stack, status?, code? }.
   LOG_LEVEL (debug|info|warn|error, default info) gates output.
   ============================================================ */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

function serialiseError(error) {
    if (!(error instanceof Error)) return error;
    return {
        message: error.message,
        stack: error.stack,
        ...(error.status ? { status: error.status } : {}),
        ...(error.statusCode ? { status: error.statusCode } : {}),
        ...(error.code ? { code: error.code } : {})
    };
}

function emit(level, msg, fields = {}) {
    if (LEVELS[level] < threshold) return;

    const line = { ts: new Date().toISOString(), level, msg };
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        line[key] = key === "err" ? serialiseError(value) : value;
    }

    const text = JSON.stringify(line);
    if (level === "error") process.stderr.write(text + "\n");
    else process.stdout.write(text + "\n");
}

export const log = {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields)
};
