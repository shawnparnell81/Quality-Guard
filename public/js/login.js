/* ============================================================
   Sign-in page.

   Lifted out of an inline <script> in login.html so the app can
   ship an enforcing Content-Security-Policy with script-src 'self'
   (audit fix C2). Behaviour is unchanged.
   ============================================================ */

const form = document.getElementById("signin-form");
const errorBox = document.getElementById("signin-error");
const submit = document.getElementById("signin-submit");

function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
}

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    submit.disabled = true;
    submit.textContent = "Signing in...";

    try {
        const response = await fetch("/api/auth/login", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                email: document.getElementById("email").value.trim(),
                password: document.getElementById("password").value,
                remember: document.getElementById("remember").checked
            })
        });

        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
            showError(payload.error || "Could not sign in");
            return;
        }

        /* A temporary password gets you exactly one place: the screen
           that replaces it. */
        window.location.href = payload.must_change_password
            ? "/change-password.html"
            : "/app";
    } catch (error) {
        console.error("Sign-in request failed:", error);
        showError("The server could not be reached. Contact your system administrator.");
    } finally {
        submit.disabled = false;
        submit.textContent = "Sign in";
    }
});

document.getElementById("email").focus();
