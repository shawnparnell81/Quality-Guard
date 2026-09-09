/* ============================================================
   PPAP submission package detail, clause 8.3.4.4.

   A PPAP record carries the 18 AIAG elements as slots. Each slot
   points at the record or controlled document satisfying it (a
   free-text reference), or is marked not applicable with a note.
   Which elements the level requires is shown against each, and the
   package cannot move to "submitted" until every required element is
   filled - the gate is enforced server-side (routes/ppap.js +
   routes/records.js); this screen shows why before you click.
   ============================================================ */

import { api } from "../api.js";
import { confirmStep } from "../forms.js";
import { openEntityForm } from "../entity-form.js";
import { can, applyPermissions } from "../session.js";
import { el, pill, humanize, statusKind, formatDate } from "../dom.js";

const STATE_LABEL = {
    draft: "Draft", assembling: "Assembling package", submitted: "Submitted",
    interim: "Interim approval", approved: "Approved", rejected: "Rejected"
};
const STATE_KIND = {
    draft: "hold", assembling: "prog", submitted: "prog",
    interim: "prog", approved: "done", rejected: "open"
};

const HEADER_FIELDS = [
    ["Part number", "part_number"], ["Part name", "part_name"], ["Revision", "revision"],
    ["Customer", "customer"], ["Customer part no.", "customer_part_number"], ["Drawing / spec", "drawing"],
    ["Submission level", "submission_level"], ["Reason", "reason"],
    ["Part weight", "part_weight"], ["PSW number", "psw_number"],
    ["Submitted on", "submitted_on"], ["Submitted by", "submitted_by"],
    ["Customer disposition", "customer_disposition"], ["Customer sign-off", "customer_signoff"]
];

function openLinkForm(number, element, slot) {
    openEntityForm({
        title: "Element " + element.element + " - " + element.name,
        fields: [
            { key: "reference", label: "Record or document number", type: "text", required: true,
              hint: "e.g. a Control Plan record, a FAIR number, a PSW document number." },
            { key: "note", label: "Note", type: "text" }
        ],
        values: { reference: element.reference || "", note: element.note || "" },
        submitLabel: "Link",
        successMessage: () => "Element " + element.element + " linked",
        onSubmit: ({ values }) => api.setPpapElement(number, element.element, values),
        onSaved: () => renderPpapDetail(number, { slot })
    });
}

function openNaForm(number, element, slot) {
    openEntityForm({
        title: "Mark element " + element.element + " not applicable",
        fields: [
            { key: "note", label: "Why it does not apply", type: "memo", required: true,
              hint: "e.g. \"No appearance requirement on this part.\"" }
        ],
        values: { note: element.note || "" },
        submitLabel: "Mark N/A",
        successMessage: () => "Element " + element.element + " marked not applicable",
        onSubmit: ({ values }) => api.setPpapElement(number, element.element,
            { not_applicable: true, note: values.note }),
        onSaved: () => renderPpapDetail(number, { slot })
    });
}

function elementRow(number, element, canManage) {
    const fill = element.not_applicable
        ? el("span", { class: "sm", text: "N/A" + (element.note ? " - " + element.note : "") })
        : element.reference
            ? el("span", { class: "sm" }, [
                el("span", { class: "mono", text: element.reference }),
                element.linked_status
                    ? pill(humanize(element.linked_status), statusKind(element.linked_status))
                    : null,
                element.note ? el("span", { class: "dim", text: "  " + element.note }) : null
            ])
            : el("span", { class: "sm dim", text: "nothing on file" });

    const controls = canManage
        ? el("div", { class: "row-actions no-print" }, [
            el("button", { class: "btn btn-xs", type: "button",
                dataset: { ppapLink: element.element }, text: element.reference ? "Change" : "Link" }),
            element.not_applicable
                ? null
                : el("button", { class: "btn btn-xs", type: "button",
                    dataset: { ppapNa: element.element }, text: "N/A" }),
            (element.reference || element.not_applicable)
                ? el("button", { class: "btn btn-xs", type: "button",
                    dataset: { ppapClear: element.element }, text: "Clear" })
                : null
        ])
        : null;

    return el("li", { class: "ppap-el" + (element.filled ? " is-filled" : (element.required ? " is-missing" : "")) }, [
        el("div", {}, [
            el("div", { class: "sm", style: "font-weight:600" }, [
                el("span", { class: "mono dim", text: element.element + ". " }),
                document.createTextNode(element.name),
                element.required
                    ? el("span", { class: "chip", style: "margin-left:8px", text: "required" })
                    : null
            ]),
            fill
        ]),
        controls
    ]);
}

function transitionsRow(number, record, transitions, slot) {
    if (!transitions || transitions.length === 0) {
        return el("p", { class: "sm dim no-print",
            text: "This PPAP is " + (STATE_LABEL[record.status] || record.status).toLowerCase() + "." });
    }

    const buttons = transitions.map((step) => {
        const button = el("button", {
            class: "btn" + (step.allowed ? " btn-primary" : " not-permitted"),
            type: "button", title: step.blocked_because || "Move to " + step.label
        }, step.label);

        if (!step.allowed) { button.disabled = true; return button; }

        button.addEventListener("click", () => confirmStep({
            title: "Move " + number + " to " + step.label,
            body: step.to === "submitted"
                ? "Marks the package submitted to the customer."
                : step.is_terminal
                    ? "This closes the PPAP as " + step.label.toLowerCase() + "."
                    : "The PPAP moves to " + step.label + ".",
            confirmLabel: "Move to " + step.label,
            onConfirm: async (reason) => {
                await api.transition(number, { to: step.to, reason });
                await renderPpapDetail(number, { slot });
            }
        }));
        return button;
    });

    const blocked = transitions.find((s) => !s.allowed && s.blocked_because);

    return el("div", { class: "no-print" }, [
        el("div", { class: "section-label", text: "Move this forward" }),
        el("div", { class: "row" }, buttons),
        blocked ? el("p", { class: "sm dim", style: "margin:8px 0 0", text: blocked.blocked_because }) : null
    ]);
}

/* The last package fetched, so the click handlers can seed a form
   with what is already on a slot without another round trip. */
let lastPackage = null;

/* `slot` is the id prefix the detail is written into - "ppap" for the
   register side panel (unchanged), "record-view" for the full-page
   record view (record-page.js). */
export async function renderPpapDetail(number, { slot = "ppap" } = {}) {
    const numberEl = document.getElementById(slot + "-detail-number");
    const statusEl = document.getElementById(slot + "-detail-status");
    const body = document.getElementById(slot + "-detail");
    if (!body) return;

    body.replaceChildren(el("p", { class: "sm dim", text: "Loading..." }));

    try {
        const [{ record, transitions }, pkg] = await Promise.all([
            api.record(number),
            api.ppapPackage(number)
        ]);
        const d = record.data || {};
        const canManage = can("ppap.manage");
        lastPackage = pkg;

        if (numberEl) numberEl.textContent = number;
        if (statusEl) {
            statusEl.replaceChildren(pill(
                STATE_LABEL[record.status] || humanize(record.status),
                STATE_KIND[record.status] || "hold"
            ));
        }

        const header = el("dl", { class: "kv" });
        for (const [label, key] of HEADER_FIELDS) {
            const raw = d[key];
            if (raw == null || raw === "") continue;
            header.append(el("dt", { text: label }));
            header.append(el("dd", { text: /_on$/.test(key) ? formatDate(raw) : String(raw) }));
        }

        const gate = pkg.gate;
        const gateBanner = gate.ready_to_submit
            ? el("p", { class: "sm", style: "color:var(--ok);font-weight:600;margin:12px 0 4px",
                text: "Ready to submit - every required element for " + humanize(String(d.submission_level || "level 3")).toLowerCase() + " is on file." })
            : el("p", { class: "sm", style: "color:var(--crit);font-weight:600;margin:12px 0 4px",
                text: gate.missing.length + " required element" + (gate.missing.length === 1 ? "" : "s")
                    + " still to fill: " + gate.missing.join(", ") });

        body.replaceChildren(
            header,
            el("div", { class: "section-label", text: "The 18 elements" }),
            gateBanner,
            el("ul", { class: "ppap-list" }, pkg.elements.map((e) => elementRow(number, e, canManage))),
            transitionsRow(number, record, transitions, slot)
        );
        applyPermissions(body);
    } catch (error) {
        body.replaceChildren(el("p", { class: "sm", style: "color:var(--crit)", text: error.message }));
    }
}

/* Delegated once from each container the 18-element list can live in -
   the register side panel (#view-ppap) and the full-page record view
   (#view-record) - so the Link / N/A / Clear buttons work in both and
   survive a re-render. On #view-record a non-PPAP record has no
   data-ppap-* buttons, so the handler simply no-ops there. */
export function wirePpap() {
    for (const [viewId, slot] of [["view-ppap", "ppap"], ["view-record", "record-view"]]) {
        const view = document.getElementById(viewId);
        if (view) view.addEventListener("click", (event) => handlePpapClick(event, slot));
    }
}

function handlePpapClick(event, slot) {
    const number = document.getElementById(slot + "-detail-number")?.textContent;
    if (!number || number === "Select a PPAP") return;

    const link = event.target.closest("[data-ppap-link]");
    if (link) { openLinkForm(number, findElement(number, Number(link.dataset.ppapLink)), slot); return; }

    const na = event.target.closest("[data-ppap-na]");
    if (na) { openNaForm(number, findElement(number, Number(na.dataset.ppapNa)), slot); return; }

    const clear = event.target.closest("[data-ppap-clear]");
    if (clear) {
        const n = Number(clear.dataset.ppapClear);
        confirmStep({
            title: "Clear element " + n,
            body: "Takes whatever is on this slot off the package.",
            confirmLabel: "Clear",
            onConfirm: async () => {
                await api.clearPpapElement(number, n);
                await renderPpapDetail(number, { slot });
            }
        });
    }
}

function findElement(number, n) {
    const fallback = { element: n, name: "Element " + n, reference: "", note: "" };
    if (lastPackage && lastPackage.number === number) {
        return lastPackage.elements.find((e) => e.element === n) || fallback;
    }
    return fallback;
}
