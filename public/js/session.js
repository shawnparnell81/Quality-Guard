/* ============================================================
   The signed-in person and what they may do.

   IMPORTANT: everything here is presentation only.

   Hiding a button stops an honest person pressing it by mistake. It
   stops nobody determined, because anyone can open the console and
   call the API directly. Every one of these permissions is also
   enforced on the server, and the server is the one that counts.

   Treat this module as a way to keep the UI honest, never as a
   security boundary.
   ============================================================ */

import { api } from "./api.js";

let me = null;

export async function loadSession() {
    me = await api.me();
    return me;
}

export function currentUser() {
    return me;
}

export function can(permission) {
    return Boolean(me && me.permissions.includes(permission));
}

/* Applies permissions to the page.

   Any element carrying data-requires="some.permission" is disabled
   and explained when the current role lacks it. Disabled rather than
   hidden, because a control that vanishes leaves someone wondering
   whether the feature exists; one that is visible and explains itself
   teaches them who to ask. */
export function applyPermissions(root = document) {
    for (const node of root.querySelectorAll("[data-requires]")) {
        const permission = node.dataset.requires;
        const allowed = can(permission);

        node.disabled = !allowed;
        node.classList.toggle("not-permitted", !allowed);

        if (allowed) {
            node.removeAttribute("title");
        } else {
            node.setAttribute(
                "title",
                "Requires " + permission + ". Your role is "
                + (me ? me.role_name : "unknown") + "."
            );
        }
    }
}

export function paintCurrentUser() {
    const avatar = document.getElementById("user-avatar");
    const name = document.getElementById("user-name");
    const role = document.getElementById("user-role");

    if (!me) return;

    if (avatar) {
        avatar.textContent = me.initials;
        avatar.title = me.name + " - " + me.role_name;
    }

    if (name) name.textContent = me.name;
    if (role) role.textContent = me.role_name;
}

export function wireSignOut() {
    const button = document.getElementById("sign-out");
    if (!button) return;

    button.addEventListener("click", async () => {
        try {
            await api.logout();
        } finally {
            /* Leave even if the call failed. The cookie is httpOnly so
               the page cannot clear it itself, but landing on sign-in
               is still the right place to be. */
            window.location.href = "/login.html";
        }
    });
}
