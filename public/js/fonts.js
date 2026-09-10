/* ============================================================
   Promotes the web font stylesheet once it has actually arrived.

   The Google Fonts stylesheet is the only third-party request on the
   critical path. A plant network with no WAN route holds the first
   paint until TCP gives up, so the <link> ships as media="print" -
   fetched, but never render-blocking - and is promoted to media="all"
   here. If the request never completes the page simply keeps the
   local fallback stack in style.css and paints immediately.

   This is a file rather than an onload="" attribute on the link
   because the CSP is script-src 'self' with no 'unsafe-inline'.
   ============================================================ */

for (const link of document.querySelectorAll("link[data-font-css]")) {
    if (link.sheet) link.media = "all";
    else link.addEventListener("load", () => { link.media = "all"; }, { once: true });
}
