/* ============================================================
   One place that turns a stored field value into display text.

   The record detail screen, the printed PDF and the Excel export
   used to each carry their own copy of "a checkbox reads Yes / No, a
   date reads 01 Sep 2026, a user field resolves to a name" - three
   copies that had already drifted (one accepted the number 1 as
   true, one localised the date to the server's region, one left it
   untouched). This module is the single copy they all import.

   Pure: no DOM, no Node. Lives in shared/ so the browser and server
   import the same file.
   ============================================================ */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* Spreadsheet / stale-data spellings of a ticked box. Mirrors the
   BOOL_TRUE set the Excel importer coerces with (routes/records.js);
   kept in sync by intent, not by import, to keep this module free of
   server dependencies. */
const TRUEISH = new Set(["true", "yes", "y", "1", "x", "on", "checked"]);

/* Empty enough not to render: null, undefined, "", or an empty
   table array. Zero and false are NOT empty. */
export function isEmpty(value) {
    return value === null || value === undefined || value === ""
        || (Array.isArray(value) && value.length === 0);
}

/* "2026-09-01" -> "01 Sep 2026", with no timezone or locale in the
   path (Date + toLocaleDateString can shift a bare ISO date across a
   day boundary depending on where the server runs). Anything that is
   not a leading ISO date falls back to a Date parse, then to the raw
   string. */
export function formatDateValue(value) {
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
    if (iso) {
        const month = MONTHS[Number(iso[2]) - 1];
        return month ? iso[3] + " " + month + " " + iso[1] : String(value);
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return String(value);
    return parsed.getUTCDate().toString().padStart(2, "0") + " "
        + MONTHS[parsed.getUTCMonth()] + " " + parsed.getUTCFullYear();
}

/* field  - the schema field or table column ({ type, ... }); may be
            null for an untyped / legacy value.
   value  - the stored value.
   opts.users       - Map or plain object of initials -> full name.
   opts.empty       - text for an empty value (default "").
   opts.spreadsheet - keep numbers and dates as native values so
                      exceljs types the cell; still maps booleans to
                      Yes / No and objects to JSON.

   Always returns a string, except in spreadsheet mode where a
   number or date value passes straight through. */
export function formatValue(field, value, opts = {}) {
    const empty = opts.empty === undefined ? "" : opts.empty;
    if (isEmpty(value)) return empty;

    const type = field && field.type;

    if (type === "boolean") {
        const token = typeof value === "string" ? value.trim().toLowerCase() : value;
        if (token === true || token === 1) return "Yes";
        if (token === false || token === 0) return "No";
        return TRUEISH.has(token) ? "Yes" : "No";
    }

    if (type === "date") {
        return opts.spreadsheet ? value : formatDateValue(value);
    }

    if (type === "user") {
        const name = opts.users instanceof Map ? opts.users.get(value)
            : opts.users ? opts.users[value]
            : null;
        return name ? name + " (" + value + ")" : String(value);
    }

    if (type === "signature") {
        /* a sealed signature ({signer, at, ...}); legacy ones are a
           plain "Name - Role" string */
        if (value && typeof value === "object" && value.signer) {
            return value.signer
                + (value.role ? " (" + value.role + ")" : "")
                + (value.at ? " - " + formatDateValue(value.at) : "");
        }
        return String(value);
    }

    if (value && typeof value === "object") return JSON.stringify(value);

    /* spreadsheet mode keeps a numeric value native so exceljs types
       the cell as a number, whatever the field is declared as */
    if (opts.spreadsheet && typeof value === "number") return value;

    return String(value);
}
