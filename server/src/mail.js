/* ============================================================
   Outbound email. Optional: with no SMTP_HOST in the environment
   every send is a logged no-op, so the app runs exactly as before
   for anyone who has not set it up.

   Environment:
     SMTP_HOST      required to enable sending
     SMTP_PORT      default 587
     SMTP_SECURE    "true" for implicit TLS (port 465)
     SMTP_USER      optional (auth)
     SMTP_PASS      optional (auth)
     SMTP_FROM      From: header, default "QMS Guardian <no-reply@localhost>"
   ============================================================ */

import nodemailer from "nodemailer";

let transporter = null;

export function isMailConfigured() {
    return Boolean(process.env.SMTP_HOST);
}

function getTransport() {
    if (transporter) return transporter;
    transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === "true",
        auth: process.env.SMTP_USER
            ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
            : undefined
    });
    return transporter;
}

const FROM = () => process.env.SMTP_FROM || "QMS Guardian <no-reply@localhost>";

/* Resolves to { skipped: true } when mail is off, else the
   nodemailer info object. Never throws for a normal delivery failure -
   a bounced digest must not take a request or the schedule down. */
export async function sendMail({ to, subject, text, html }) {
    if (!to || !isMailConfigured()) {
        console.log("[mail:noop] would send to " + to + " - " + subject);
        return { skipped: true };
    }
    try {
        const info = await getTransport().sendMail({ from: FROM(), to, subject, text, html });
        return info;
    } catch (error) {
        console.error("[mail] send failed to " + to + ": " + error.message);
        return { error: error.message };
    }
}
