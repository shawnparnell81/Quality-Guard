/* ============================================================
   The header bell: what wants your attention right now.

   Four kinds, all computed server-side (routes/notifications.js):
   assigned, overdue, approval, finding. Clicking one marks it read
   and deep-links to the record. The badge and list refresh on a
   stream ping (a record changed, or a notification was pushed) and
   on a slow poll as a backstop.
   ============================================================ */

import { api } from "./api.js";
import { currentUser } from "./session.js";
import { onStreamEvent } from "./stream.js";
import { openRecord } from "./record-nav.js";
import { el } from "./dom.js";

const KIND_LABEL = {
    assigned: "Assigned", overdue: "Overdue", approval: "Approval", finding: "Finding"
};

let items = [];

export function wireNotifications() {
    const bell = document.getElementById("notif-bell");
    const panel = document.getElementById("notif-panel");
    const badge = document.getElementById("notif-badge");
    const list = document.getElementById("notif-list");
    const readAll = document.getElementById("notif-read-all");
    if (!bell || !panel || !badge || !list) return;

    const setOpen = (open) => {
        panel.hidden = !open;
        bell.setAttribute("aria-expanded", open ? "true" : "false");
    };

    bell.addEventListener("click", (event) => {
        event.stopPropagation();
        const willOpen = panel.hidden;
        setOpen(willOpen);
        if (willOpen) { refetch(); loadPref(); }
    });
    document.addEventListener("click", (event) => {
        if (!panel.hidden && !panel.contains(event.target) && event.target !== bell) setOpen(false);
    });
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !panel.hidden) setOpen(false);
    });

    if (readAll) {
        readAll.addEventListener("click", async () => {
            try { await api.markAllNotificationsRead(); } catch { /* offline */ }
            refetch();
        });
    }

    /* Email preference (P3.5). Loaded once when the panel first opens,
       saved on change. */
    const pref = document.getElementById("notif-email-pref");
    let prefLoaded = false;
    async function loadPref() {
        if (prefLoaded || !pref) return;
        prefLoaded = true;
        try {
            const { email_notifications } = await api.getNotificationPrefs();
            pref.value = email_notifications || "off";
        } catch { prefLoaded = false; }
    }
    if (pref) {
        pref.addEventListener("change", async () => {
            try { await api.setNotificationPrefs(pref.value); } catch { /* offline */ }
        });
    }

    function render() {
        const unread = items.filter((n) => !n.read_at).length;
        badge.textContent = unread > 99 ? "99+" : String(unread);
        badge.hidden = unread === 0;
        bell.classList.toggle("has-unread", unread > 0);

        if (items.length === 0) {
            list.replaceChildren(el("p", { class: "notif-empty sm dim", text: "You're all caught up." }));
            return;
        }

        list.replaceChildren(...items.map((n) => {
            const row = el("button", {
                class: "notif-item" + (n.read_at ? "" : " is-unread"), type: "button"
            }, [
                el("span", { class: "notif-kind notif-kind-" + n.kind, text: KIND_LABEL[n.kind] || n.kind }),
                el("span", { class: "notif-title", text: n.title }),
                n.body ? el("span", { class: "notif-body sm dim", text: n.body }) : null
            ]);
            row.addEventListener("click", async () => {
                setOpen(false);
                if (!n.read_at) { try { await api.markNotificationRead(n.id); } catch { /* offline */ } }
                if (n.link_number) openRecord(n.link_number, n.link_type || undefined);
                refetch();
            });
            return row;
        }));
    }

    async function refetch() {
        try {
            const data = await api.notifications();
            items = data.items || [];
            render();
        } catch { /* offline - keep the last good list */ }
    }

    let timer = null;
    const scheduleRefetch = () => {
        clearTimeout(timer);
        timer = setTimeout(refetch, 500);
    };

    const me = currentUser();
    onStreamEvent("notifications", (event) => {
        if (!me || event.id === me.id) scheduleRefetch();
    });
    onStreamEvent("records", scheduleRefetch);

    refetch();
    setInterval(refetch, 90000);
}
