/* ============================================================
   Document viewer windows.

   Real files stay real files. A browser can only ever display a
   handful of formats on its own - a PDF or an image goes straight
   into an <iframe> here, the browser's own viewer, not a
   reimplementation of one. Anything it cannot show (Excel, Word)
   still opens for real, in the real application that made it - the
   window is a tracked "Open" placeholder for that file, not a
   preview of content nothing in a browser can actually render.

   Several can be open at once, each independently closeable, drawn
   over whatever screen happens to be showing rather than replacing
   it - the closest a page-based app gets to real desktop windows,
   which is exactly what was asked for.
   ============================================================ */

import { api } from "./api.js";
import { el } from "./dom.js";

let topZ = 10;
let cascade = 0;
const openWindows = new Map(); // "DOC-NUMBER@REVISION" -> window element

function host() {
    return document.getElementById("doc-windows");
}

function bringToFront(node) {
    topZ += 1;
    node.style.zIndex = topZ;
}

/* Dragging by the header only, the same convention every real
   window manager uses - the close button living inside that same
   header is excluded explicitly, or every click on it would also
   start a drag. */
function makeDraggable(node, handle) {
    let dragging = false;
    let startX, startY, originX, originY;

    handle.addEventListener("mousedown", (event) => {
        if (event.target.closest("[data-doc-window-close]")) return;

        dragging = true;
        startX = event.clientX;
        startY = event.clientY;

        const rect = node.getBoundingClientRect();
        originX = rect.left;
        originY = rect.top;

        bringToFront(node);
        event.preventDefault();
    });

    window.addEventListener("mousemove", (event) => {
        if (!dragging) return;
        node.style.left = Math.max(0, originX + (event.clientX - startX)) + "px";
        node.style.top = Math.max(0, originY + (event.clientY - startY)) + "px";
    });

    window.addEventListener("mouseup", () => { dragging = false; });
}

function canRenderInline(mimeType) {
    if (!mimeType) return false;
    return mimeType === "application/pdf"
        || mimeType.startsWith("image/")
        || mimeType === "text/plain"
        || mimeType === "text/csv";
}

/* docNumber + a real revision letter - never the "current" alias the
   download URL itself accepts, since resolving which letter that is
   belongs to whoever already has the document row (doc.current_
   revision), not guessed at again here from the revision list alone. */
export async function openDocumentWindow(docNumber, revision, title) {
    const container = host();
    if (!container) return;

    const key = docNumber + "@" + revision;

    if (openWindows.has(key)) {
        bringToFront(openWindows.get(key));
        return;
    }

    cascade = (cascade + 1) % 8;
    const offset = 40 + cascade * 28;

    const closeButton = el("button", {
        type: "button", class: "doc-window-close", "data-doc-window-close": "true",
        "aria-label": "Close", text: "×"
    });

    const head = el("div", { class: "doc-window-head" }, [
        el("span", { class: "doc-window-title", text: title || (docNumber + " - " + revision) }),
        closeButton
    ]);

    const body = el("div", { class: "doc-window-body" }, el("p", { class: "sm dim", text: "Loading..." }));

    const node = el("div", {
        class: "doc-window",
        style: "left:" + offset + "px; top:" + offset + "px;"
    }, [head, body]);

    container.append(node);
    openWindows.set(key, node);
    bringToFront(node);

    node.addEventListener("mousedown", () => bringToFront(node));
    makeDraggable(node, head);

    closeButton.addEventListener("click", () => {
        node.remove();
        openWindows.delete(key);
    });

    try {
        const { revisions } = await api.revisions(docNumber);
        const info = revisions.find((r) => r.revision === revision);

        if (!info || !info.has_file) {
            body.replaceChildren(el("p", { class: "sm", style: "color:var(--crit)", text: "No file on this revision." }));
            return;
        }

        const url = api.documentDownloadUrl(docNumber, revision);

        if (canRenderInline(info.mime_type)) {
            body.replaceChildren(el("iframe", { src: url, title: info.original_filename }));
        } else {
            body.replaceChildren(el("div", { class: "doc-window-placeholder" }, [
                el("p", { class: "sm", style: "font-weight:600", text: info.original_filename }),
                el("p", { class: "sm dim", text: "This file type opens in its own application." }),
                el("a", { class: "btn btn-primary", href: url, text: "Open " + info.original_filename })
            ]));
        }
    } catch (error) {
        body.replaceChildren(el("p", { class: "sm", style: "color:var(--crit)", text: error.message }));
    }
}
