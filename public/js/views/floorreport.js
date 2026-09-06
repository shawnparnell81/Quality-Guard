/* ============================================================
   Floor Report.

   The one screen in the app built for a phone or a tablet mounted at
   a workstation, not a desk: big touch targets, a barcode scanner
   welcome to type into it, and it works when the shop floor's WiFi
   does not. Everything it submits is a real NCR, through the same
   record engine and the same per-org form every other screen uses -
   nothing here hardcodes a field list, because what a nonconformance
   report requires is exactly the thing this project already made
   configurable per organization.
   ============================================================ */

import { api } from "../api.js";
import { currentUser, can } from "../session.js";
import { buildField, readValue, validate } from "../forms.js";
import { el, toast } from "../dom.js";
import {
    enqueueRecord, listQueue, cacheForm, getCachedForm, wireAutoSync
} from "../offline-queue.js";

const TYPE_KEY = "ncr";
let autoSyncStarted = false;

export async function renderFloorReport() {
    const body = document.getElementById("floor-report-body");
    const statusBox = document.getElementById("floor-report-status");
    if (!body) return;

    const me = currentUser();
    if (!me) return;

    if (!can("ncr.create")) {
        body.replaceChildren(el("p", { class: "floor-empty", text:
            "You do not have permission to raise a nonconformance. Requires ncr.create." }));
        if (statusBox) statusBox.hidden = true;
        return;
    }

    if (!autoSyncStarted) {
        autoSyncStarted = true;
        wireAutoSync(me.org_id, (result) => {
            if (result.synced > 0) toast(result.synced + " queued report(s) synced");
            paintQueueStatus(me.org_id, statusBox);
        });
    }

    body.replaceChildren(el("p", { class: "sm dim", text: "Loading..." }));

    let definition;
    let usingCache = false;

    try {
        definition = await api.recordForm(TYPE_KEY);
        await cacheForm(me.org_id, TYPE_KEY, definition);
    } catch {
        definition = await getCachedForm(me.org_id, TYPE_KEY);
        usingCache = Boolean(definition);
    }

    if (!definition) {
        body.replaceChildren(
            el("p", { class: "floor-empty", text:
                "This device has never been online for this yet - connect once so it can learn the current form, then it will keep working without a connection." })
        );
        return;
    }

    buildForm(body, definition, me.org_id, usingCache);
    paintQueueStatus(me.org_id, statusBox);
}

function paintQueueStatus(orgId, statusBox) {
    if (!statusBox) return;

    listQueue(orgId).then((queue) => {
        if (queue.length === 0) {
            statusBox.hidden = true;
            return;
        }

        const failed = queue.filter((entry) => entry.status === "failed").length;
        statusBox.hidden = false;
        statusBox.textContent = queue.length + " report(s) waiting to sync"
            + (failed > 0 ? " - " + failed + " need attention" : "")
            + (navigator.onLine ? "" : " (offline)");
    });
}

/* Enter moves to the next field instead of submitting - a barcode
   scanner ends every scan with an Enter keystroke, and a worker
   scanning a part then a lot in quick succession should never
   accidentally submit the form after only the first one. Only the
   Submit button itself submits. */
function wireScanAdvance(form) {
    const focusable = () => [...form.querySelectorAll("input, select, textarea, button[type=submit]")]
        .filter((node) => !node.disabled);

    form.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.target.tagName === "TEXTAREA") return;

        event.preventDefault();
        const fields = focusable();
        const index = fields.indexOf(event.target);
        if (index > -1 && index < fields.length - 1) fields[index + 1].focus();
        else if (index === fields.length - 1) event.target.click?.();
    });
}

function buildForm(body, definition, orgId, usingCache) {
    const errorBox = el("div", { class: "floor-error", hidden: "hidden" });

    const titleInput = el("input", {
        type: "text", id: "floor-title", class: "floor-input", required: true,
        placeholder: "What's wrong, in a few words"
    });

    const severityGroup = el("div", { class: "floor-severity-group" }, [
        el("button", { type: "button", class: "floor-sev floor-sev-ok", dataset: { severity: "ok" }, text: "OK" }),
        el("button", { type: "button", class: "floor-sev floor-sev-warn", dataset: { severity: "warn" }, text: "Warning" }),
        el("button", { type: "button", class: "floor-sev floor-sev-crit", dataset: { severity: "crit" }, text: "Critical" })
    ]);
    let selectedSeverity = "warn";
    severityGroup.querySelector('[data-severity="warn"]').classList.add("selected");

    function resetForm() {
        form.reset();
        selectedSeverity = "warn";
        severityGroup.querySelectorAll(".floor-sev").forEach((node) =>
            node.classList.toggle("selected", node.dataset.severity === "warn"));
        titleInput.focus();
    }

    const entries = definition.fields.map((field) => buildField(field, definition.options));

    const submit = el("button", { type: "submit", class: "btn btn-primary floor-submit", text: "Submit report" });

    const form = el("form", { class: "floor-form" }, [
        usingCache ? el("p", { class: "floor-cache-note",
            text: "Working from the last form seen while online - reconnect if this looks out of date." }) : null,
        errorBox,
        el("label", { class: "floor-label", for: "floor-title", text: "Summary" }),
        titleInput,
        el("label", { class: "floor-label", text: "Severity" }),
        severityGroup,
        ...entries.map((entry) => el("div", { class: "floor-field" }, entry.wrapper)),
        submit
    ]);

    body.replaceChildren(form);
    wireScanAdvance(form);

    severityGroup.addEventListener("click", (event) => {
        const button = event.target.closest("[data-severity]");
        if (!button) return;
        selectedSeverity = button.dataset.severity;
        severityGroup.querySelectorAll(".floor-sev").forEach((node) =>
            node.classList.toggle("selected", node === button));
    });

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        errorBox.hidden = true;

        const problems = validate(entries);
        if (!titleInput.value.trim()) problems.unshift("Summary is required");

        if (problems.length > 0) {
            errorBox.textContent = problems.join(". ");
            errorBox.hidden = false;
            return;
        }

        const data = {};
        for (const entry of entries) {
            const value = readValue(entry);
            if (value !== undefined) data[entry.field.key] = value;
        }

        const payload = {
            type: TYPE_KEY,
            title: titleInput.value.trim(),
            owner: currentUser()?.initials,
            severity: selectedSeverity,
            data
        };

        submit.disabled = true;
        submit.textContent = "Saving...";

        try {
            const idempotencyKey = crypto.randomUUID();
            await api.createRecord({ ...payload, idempotency_key: idempotencyKey });
            toast(payload.title.slice(0, 40) + " reported");
            resetForm();
        } catch (error) {
            if (typeof error.message === "string" && error.message.includes("Cannot reach the server")) {
                await enqueueRecord(currentUser().org_id, payload);
                toast("No connection - saved on this device, will sync automatically");
                resetForm();
                paintQueueStatus(currentUser().org_id, document.getElementById("floor-report-status"));
            } else {
                errorBox.textContent = error.message;
                errorBox.hidden = false;
            }
        } finally {
            submit.disabled = false;
            submit.textContent = "Submit report";
        }
    });

    titleInput.focus();
}
