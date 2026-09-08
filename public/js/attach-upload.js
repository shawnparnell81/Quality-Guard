/* ============================================================
   A drop-zone that takes several files at once and shows a progress
   bar per file. Used by the record detail panel's Attachments
   section; written as a standalone widget so document control and
   anything else with an upload endpoint can reuse it.

   buildUploader({ url, onComplete, accept }) -> HTMLElement

   `url` is the multipart POST endpoint (one file per request, field
   name "file"). `onComplete` fires once, after the last file in a
   batch settles, if at least one succeeded. `accept` is an optional
   input accept string.
   ============================================================ */

import { el } from "./dom.js";
import { xhrUpload } from "./api.js";

const prettySize = (bytes) => {
    if (!Number.isFinite(bytes)) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
};

export function buildUploader({ url, onComplete, accept }) {
    const input = el("input", {
        type: "file", multiple: true, class: "uploader-input",
        ...(accept ? { accept } : {})
    });

    const zone = el("label", { class: "uploader-zone no-print" }, [
        el("span", { class: "uploader-prompt", text: "Drop files here, or click to browse" }),
        input
    ]);

    const queue = el("div", { class: "uploader-queue" });
    const wrap = el("div", { class: "uploader no-print" }, [zone, queue]);

    let running = false;

    async function uploadOne(file) {
        const bar = el("span", { class: "uploader-bar" });
        const track = el("span", { class: "uploader-track" }, bar);
        const status = el("span", { class: "uploader-status", text: "waiting" });
        const row = el("div", { class: "uploader-item" }, [
            el("span", { class: "uploader-name", text: file.name, title: file.name }),
            el("span", { class: "uploader-size sm dim", text: prettySize(file.size) }),
            track,
            status
        ]);
        queue.append(row);

        const form = new FormData();
        form.append("file", file);

        try {
            status.textContent = "uploading";
            await xhrUpload(url, form, (fraction) => {
                if (fraction === null) { row.classList.add("is-indeterminate"); return; }
                bar.style.width = Math.round(fraction * 100) + "%";
            });
            bar.style.width = "100%";
            row.classList.add("is-done");
            status.textContent = "done";
            return true;
        } catch (error) {
            row.classList.add("is-error");
            status.textContent = error.message || "failed";
            return false;
        }
    }

    async function handleFiles(fileList) {
        const files = [...fileList];
        if (!files.length || running) return;
        running = true;
        zone.classList.add("is-busy");

        let anyOk = false;
        for (const file of files) {
            /* one at a time: clearer progress, and it keeps a stack of
               large files from all racing the same connection */
            const ok = await uploadOne(file);
            anyOk = anyOk || ok;
        }

        running = false;
        zone.classList.remove("is-busy");
        input.value = "";
        if (anyOk && typeof onComplete === "function") onComplete();
    }

    input.addEventListener("change", () => handleFiles(input.files));

    ["dragenter", "dragover"].forEach((name) =>
        zone.addEventListener(name, (event) => {
            event.preventDefault();
            zone.classList.add("is-dragover");
        }));
    ["dragleave", "dragend", "drop"].forEach((name) =>
        zone.addEventListener(name, (event) => {
            event.preventDefault();
            if (name !== "drop" && event.target !== zone) return;
            zone.classList.remove("is-dragover");
        }));
    zone.addEventListener("drop", (event) => {
        const dropped = event.dataTransfer && event.dataTransfer.files;
        if (dropped && dropped.length) handleFiles(dropped);
    });

    return wrap;
}
