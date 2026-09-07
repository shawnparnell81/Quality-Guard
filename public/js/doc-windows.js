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
   start a drag.

   The move is driven by pointer capture on the header, not by
   window-level listeners. Every window body is an <iframe>, and while
   the mouse is over an iframe its events go to that iframe's document
   rather than this page - so a window-listener drag freezes the moment
   the pointer crosses any window, then keeps chasing the cursor because
   the mouseup was swallowed too. setPointerCapture keeps the whole
   gesture on this handle regardless of what it passes over, and the
   body.doc-window-dragging class (see style.css) makes the iframes
   inert for the duration as a belt-and-braces measure. The listeners
   live on the handle, which is removed with the window, so closing a
   window leaves nothing behind. */
function makeDraggable(node, handle) {
    let dragging = false;
    let pointerId = null;
    let startX, startY, originX, originY;

    handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        if (event.target.closest("[data-doc-window-close]")) return;

        dragging = true;
        pointerId = event.pointerId;
        startX = event.clientX;
        startY = event.clientY;

        const rect = node.getBoundingClientRect();
        originX = rect.left;
        originY = rect.top;

        handle.setPointerCapture(pointerId);
        document.body.classList.add("doc-window-dragging");
        event.preventDefault();
    });

    handle.addEventListener("pointermove", (event) => {
        if (!dragging || event.pointerId !== pointerId) return;

        const maxLeft = window.innerWidth - node.offsetWidth;
        const maxTop = window.innerHeight - node.offsetHeight;

        const left = originX + (event.clientX - startX);
        const top = originY + (event.clientY - startY);

        node.style.left = Math.min(Math.max(0, left), Math.max(0, maxLeft)) + "px";
        node.style.top = Math.min(Math.max(0, top), Math.max(0, maxTop)) + "px";
    });

    /* pointerup stops the move at once. lostpointercapture is the
       backstop: the spec guarantees it fires whenever capture ends -
       normal release, the pointer going away, the node being removed -
       so the dragging flag and the body class can never get stuck on,
       which was the old bug's worst symptom. */
    handle.addEventListener("pointerup", (event) => {
        if (event.pointerId === pointerId) dragging = false;
    });

    handle.addEventListener("lostpointercapture", () => {
        dragging = false;
        pointerId = null;
        document.body.classList.remove("doc-window-dragging");
    });
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

    /* A press anywhere on the window raises it. This bubbles up from
       the header too, so the drag handler below does not raise it
       again - one bump per interaction. */
    node.addEventListener("pointerdown", () => bringToFront(node));
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
