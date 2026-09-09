/* ============================================================
   Record context panel - everything about a record that is not one
   of its schema fields: where it is in its workflow, what it is
   linked to, its attachments, and its audit trail.

   The read-only record view used to show this alongside a key/value
   dump of the fields. Now the record opens straight into its editable
   form (forms.js openRecordEditor), and this panel sits below the
   form so the whole record - fields, workflow, links, files, history
   - is one page. It fetches its own data and re-renders itself after
   any change it makes.
   ============================================================ */

import { api } from "../api.js";
import { confirmStep } from "../forms.js";
import { applyPermissions } from "../session.js";
import { buildUploader } from "../attach-upload.js";
import { openFileWindow } from "../doc-windows.js";
import { recordLink } from "../record-nav.js";
import { el, pill, formatDate, humanize, statusKind, toast } from "../dom.js";

const LINK_KINDS = ["related", "caused_by", "corrects", "supersedes", "child_of"];

/* Returns a container that renders the context for `number` and keeps
   itself current. `onWorkflow` is called after a workflow transition
   so the caller can refresh the form (status pill, locked fields). */
export function buildRecordContext(type, number, { onWorkflow } = {}) {
    const host = el("div", { class: "record-context" });
    render();
    return host;

    async function render() {
        host.replaceChildren(el("p", { class: "sm dim", text: "Loading the rest of the record…" }));
        let record, links, transitions, history, attachments;
        try {
            const got = await api.record(number);
            record = got.record;
            links = got.links || [];
            transitions = got.transitions || [];
            history = got.history || [];
            attachments = (await api.attachments(number)).attachments || [];
        } catch (error) {
            host.replaceChildren(el("p", { class: "sm", style: "color:var(--crit)", text: error.message }));
            return;
        }

        const children = [];

        /* ---- workflow ---- */
        if (transitions.length > 0) {
            children.push(el("div", { class: "section-label no-print", text: "Move this forward" }));
            children.push(el("div", { class: "row no-print" }, transitions.map((step) => {
                const button = el("button", {
                    class: "btn" + (step.allowed ? " btn-primary" : " not-permitted"),
                    type: "button",
                    title: step.blocked_because || "Move to " + step.label
                }, step.label);
                if (!step.allowed) { button.disabled = true; return button; }
                button.addEventListener("click", () => confirmStep({
                    title: "Move " + record.number + " to " + step.label,
                    body: step.is_terminal
                        ? "This closes the record. The audit trail is sealed and it cannot be reopened."
                        : "The record moves from " + humanize(record.status) + " to " + step.label + ".",
                    confirmLabel: "Move to " + step.label,
                    onConfirm: async (reason) => {
                        await api.transition(record.number, { to: step.to, reason });
                        await render();
                        if (onWorkflow) await onWorkflow();
                    }
                }));
                return button;
            })));
            const blocked = transitions.filter((s) => !s.allowed);
            if (blocked.length > 0) {
                children.push(el("p", { class: "sm dim no-print", style: "margin:8px 0 0", text: blocked[0].blocked_because }));
            }
        }

        /* ---- linked records ---- */
        children.push(el("div", { class: "section-label", text: "Linked records" }));
        if (links.length > 0) {
            children.push(el("div", { class: "chip-list" }, links.map((link) => el("span", { class: "linked-rec" }, [
                recordLink(link),
                el("button", {
                    class: "linked-rec-x no-print", type: "button",
                    title: "Unlink " + link.number, "aria-label": "Unlink " + link.number,
                    onClick: async () => {
                        try { await api.unlinkRecord(record.number, link.number); await render(); }
                        catch (error) { toast(error.message, "error"); }
                    }
                }, "×")
            ]))));
        } else {
            children.push(el("p", { class: "sm dim", style: "margin:0", text: "No linked records." }));
        }

        const linkInput = el("input", { type: "text", class: "sm", placeholder: "e.g. CAPA-2026-0005" });
        const linkKind = el("select", { class: "sm" }, LINK_KINDS.map((k) => el("option", { value: k, text: humanize(k) })));
        const linkBtn = el("button", { class: "btn no-print", type: "button" }, "Link");
        linkBtn.addEventListener("click", async () => {
            const to = linkInput.value.trim();
            if (!to) { toast("Enter a record number", "error"); return; }
            try { await api.linkRecord(record.number, { to, link_type: linkKind.value }); await render(); }
            catch (error) { toast(error.message, "error"); }
        });
        children.push(el("div", { class: "row no-print", style: "gap:6px;margin:6px 0 4px;flex-wrap:wrap" },
            [linkInput, linkKind, linkBtn]));

        /* ---- attachments ---- */
        children.push(el("div", { class: "section-label", text: "Attachments" }));
        const rowTag = (a) => a.row_ref ? "[" + humanize(String(a.row_ref).split(":")[0]) + "]  " : "";
        if (attachments.length > 0) {
            children.push(el("div", { class: "chip-list" }, attachments.map((a) => {
                const meta = "  " + formatDate(a.uploaded_at) + (a.uploaded_by ? "  " + a.uploaded_by : "");
                if (a.has_file) {
                    return el("button", {
                        class: "chip chip-link no-print", type: "button", title: "Open " + a.filename,
                        onClick: () => openFileWindow(api.attachmentFileUrl(record.number, a.id), a.filename, a.mime_type)
                    }, rowTag(a) + a.filename + meta);
                }
                return el("span", { class: "chip", title: a.storage_key || "", text: rowTag(a) + a.filename + meta + "  (link)" });
            })));
        } else {
            children.push(el("p", { class: "sm dim", text: "No attachments yet." }));
        }
        children.push(buildUploader({
            url: "/records/" + encodeURIComponent(record.number) + "/attachments",
            onComplete: () => render()
        }));
        const addFilename = el("input", { type: "text", placeholder: "Filename", class: "sm" });
        const addLocation = el("input", { type: "text", placeholder: "or a path / link on a share", class: "sm" });
        const addButton = el("button", { class: "btn no-print", type: "button" }, "Link");
        addButton.addEventListener("click", async () => {
            const filename = addFilename.value.trim();
            const location = addLocation.value.trim();
            if (!filename || !location) { toast("Filename and location are both required", "error"); return; }
            try { await api.addAttachment(record.number, { filename, storage_key: location }); await render(); }
            catch (error) { toast(error.message, "error"); }
        });
        children.push(el("div", { class: "row no-print", style: "gap:6px;margin:0 0 12px;flex-wrap:wrap" },
            [addFilename, addLocation, addButton]));

        /* ---- audit trail ---- */
        if (history.length > 0) {
            children.push(el("div", { class: "section-label", text: "Audit trail" }));
            children.push(el("div", { class: "chip-list" }, history.slice(0, 6).map((entry) => el("span", {
                class: "chip",
                text: formatDate(entry.changed_at) + "  " + entry.changed_by + " set " + entry.field
                    + (entry.new_value ? " to " + entry.new_value : "")
            }))));
        }

        /* ---- audit -> discrepancy investigation ---- */
        if (type === "audit") {
            children.push(el("div", { class: "section-label", text: "Discrepancy Investigation" }));
            const existingDi = links.find((l) => l.type === "di");
            if (existingDi) {
                children.push(el("p", { class: "sm" }, [
                    recordLink(existingDi), document.createTextNode("  "),
                    pill(humanize(existingDi.status), statusKind(existingDi.status))
                ]));
            } else {
                const raise = el("button", {
                    class: "btn no-print", type: "button", dataset: { requires: "di.manage" },
                    text: "Raise Discrepancy Investigation"
                });
                raise.addEventListener("click", async () => {
                    const { raiseDiFromAudit } = await import("./events.js");
                    raiseDiFromAudit(record);
                });
                children.push(raise);
            }
        }

        host.replaceChildren(
            el("div", { class: "record-context-rule" }),
            ...children
        );
        applyPermissions(host);
    }
}
