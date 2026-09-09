/* ============================================================
   Forced / voluntary password change page.

   Lifted out of an inline <script> in change-password.html so the
   app can ship an enforcing Content-Security-Policy with
   script-src 'self' (audit fix C2). Behaviour is unchanged.
   ============================================================ */

const form = document.getElementById("change-form");
const errorBox = document.getElementById("error-box");
const submit = document.getElementById("submit");

function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
}

/* Who is this, and did they arrive here because they had to?
   /api/me stays reachable during a forced change precisely so this
   screen can answer both questions. */
try {
    const response = await fetch("/api/me", { credentials: "same-origin" });

    if (response.status === 401) {
        window.location.href = "/login.html";
    } else {
        const me = await response.json();
        document.getElementById("who").textContent = me.name + " - " + me.role_name;
        document.getElementById("forced-notice").hidden = !me.must_change_password;
    }
} catch {
    document.getElementById("who").textContent = "Cannot reach the server";
}

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorBox.hidden = true;

    const current = document.getElementById("current").value;
    const next = document.getElementById("next").value;
    const confirm = document.getElementById("confirm").value;

    /* Check the obvious things here so an easy mistake does not need a
       round trip. The server checks all of it again regardless. */
    if (next !== confirm) {
        return showError("The two new passwords do not match");
    }

    if (next.length < 12) {
        return showError("Password must be at least 12 characters");
    }

    if (next === current) {
        return showError("The new password must be different from the current one");
    }

    submit.disabled = true;
    submit.textContent = "Saving...";

    try {
        const response = await fetch("/api/auth/change-password", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ current_password: current, new_password: next })
        });

        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
            showError(payload.error || "Could not change password");
            return;
        }

        window.location.href = "/app";
    } catch {
        showError("Cannot reach the server. Is it running on port 3001?");
    } finally {
        submit.disabled = false;
        submit.textContent = "Set password";
    }
});

document.getElementById("current").focus();
