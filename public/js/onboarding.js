/* ============================================================
   First-run onboarding wizard (P5.3).

   Shown once, to an admin, on the first sign-in for an organisation
   that has not been through it: confirm the company name, pick the
   standard(s) it runs to, install starter form templates, invite a
   few teammates, and raise a first record. Each step saves as you
   go; "Skip setup" (or Finish) sets organizations.onboarded_at so it
   never reappears.
   ============================================================ */

import { api } from "./api.js";
import { can } from "./session.js";
import { openRecordEditor } from "./forms.js";
import { el, toast } from "./dom.js";

const STANDARDS = [
    "ISO 9001", "IATF 16949", "AS9100", "ISO 13485", "ISO 14001", "ISO 45001"
];

export async function maybeShowOnboarding() {
    if (!can("roles.manage")) return;

    let org;
    try {
        org = await api.organization();
    } catch { return; }
    if (!org || org.onboarded) return;

    const host = document.getElementById("onboarding");
    if (!host) return;

    let roles = [];
    try {
        const r = await api.roles();
        roles = Array.isArray(r) ? r : (r.roles || []);
    } catch { roles = []; }

    const state = {
        step: 0,
        name: org.organization || "",
        standards: new Set(org.standards && org.standards.length ? org.standards : ["ISO 9001"])
    };

    async function saveOrg(patch) {
        try { await api.updateOrganization(patch); } catch (error) { toast(error.message, "error"); }
    }

    function close() {
        host.replaceChildren();
        host.hidden = true;
    }

    async function finish(raiseNcr) {
        await saveOrg({ name: state.name.trim() || org.organization, standards: [...state.standards], onboarded: true });
        close();
        if (raiseNcr) {
            document.dispatchEvent(new CustomEvent("navigate", { detail: { view: "ncr" } }));
            openRecordEditor("ncr", { returnView: "ncr" });
        }
    }

    /* ---------- steps ---------- */

    const steps = [
        {
            title: "Welcome to QMS Guardian",
            hint: "A minute of setup, then you are running. You can change any of this later.",
            body() {
                const input = el("input", { type: "text", value: state.name, class: "onb-input" });
                input.addEventListener("input", () => { state.name = input.value; });
                return el("label", { class: "onb-field" }, [
                    el("span", { class: "onb-label", text: "Company name" }), input
                ]);
            },
            onNext: () => saveOrg({ name: state.name.trim() || org.organization })
        },
        {
            title: "Which standard do you run to?",
            hint: "Pick every one that applies. It tunes which clause references the app leans on.",
            body() {
                return el("div", { class: "onb-checks" }, STANDARDS.map((s) => {
                    const cb = el("input", { type: "checkbox" });
                    cb.checked = state.standards.has(s);
                    cb.addEventListener("change", () => {
                        cb.checked ? state.standards.add(s) : state.standards.delete(s);
                    });
                    return el("label", { class: "onb-check" }, [cb, el("span", { text: s })]);
                }));
            },
            onNext: () => saveOrg({ standards: [...state.standards] })
        },
        {
            title: "Add starter forms",
            hint: "The AIAG core-tool forms, ready to use. Tick the ones you want.",
            async body() {
                const wrap = el("div", { class: "onb-templates" });
                wrap.append(el("p", { class: "onb-loading sm dim", text: "Loading templates..." }));
                try {
                    const { templates, installed } = await api.formTemplates();
                    wrap.replaceChildren(...templates.map((t) => {
                        const done = Boolean(installed[t.key]);
                        const cb = el("input", { type: "checkbox", value: t.key });
                        cb.checked = !done;
                        cb.disabled = done;
                        cb.dataset.key = t.key;
                        return el("label", { class: "onb-check" }, [
                            cb,
                            el("span", {}, [
                                el("strong", { text: t.name }),
                                el("span", { class: "sm dim", text: "  " + t.prefix + " · " + t.field_count + " fields"
                                    + (done ? " · installed" : "") })
                            ])
                        ]);
                    }));
                    wrap._templateBox = true;
                } catch {
                    wrap.replaceChildren(el("p", { class: "sm dim", text: "Templates unavailable - you can add them later from Import Form." }));
                }
                return wrap;
            },
            async onNext(bodyNode) {
                const picks = [...bodyNode.querySelectorAll("input[type=checkbox]:checked:not(:disabled)")]
                    .map((cb) => cb.dataset.key);
                for (const key of picks) {
                    try { await api.installFormTemplate(key); }
                    catch (error) { toast(key + ": " + error.message, "error"); }
                }
                if (picks.length) toast(picks.length + " form" + (picks.length === 1 ? "" : "s") + " added");
            }
        },
        {
            title: "Invite your team",
            hint: "Add a few people now, or skip and do it later in Administration. They set their own password on first sign-in.",
            body() {
                const rows = el("div", { class: "onb-invite" });
                const roleOptions = [el("option", { value: "", text: "Role..." }),
                    ...roles.map((r) => el("option", { value: r.key, text: r.name }))];
                for (let i = 0; i < 3; i++) {
                    rows.append(el("div", { class: "onb-invite-row" }, [
                        el("input", { type: "text", placeholder: "Full name", class: "onb-input i-name" }),
                        el("input", { type: "email", placeholder: "Email", class: "onb-input i-email" }),
                        el("select", { class: "onb-input i-role" }, roleOptions.map((o) => o.cloneNode(true)))
                    ]));
                }
                return rows;
            },
            async onNext(bodyNode) {
                const results = [];
                for (const row of bodyNode.querySelectorAll(".onb-invite-row")) {
                    const name = row.querySelector(".i-name").value.trim();
                    const email = row.querySelector(".i-email").value.trim();
                    const role = row.querySelector(".i-role").value;
                    if (!name || !email || !role) continue;
                    const initials = name.split(/\s+/).map((p) => p[0]).join("").toUpperCase().slice(0, 4)
                        || "U" + Math.floor(Math.random() * 1000);
                    try {
                        const u = await api.createUser({ full_name: name, email, initials, role });
                        results.push(name + " — temp password " + (u.temporary_password || "sent by email"));
                    } catch (error) {
                        results.push(name + " — " + error.message);
                    }
                }
                if (results.length) {
                    toast(results.length + " invite" + (results.length === 1 ? "" : "s") + " created");
                    window.alert("Invites created:\n\n" + results.join("\n")
                        + "\n\nShare the temporary passwords - each person is prompted to change it.");
                }
            }
        },
        {
            title: "You're set up",
            hint: "Everything here lives in Administration if you want to revisit it.",
            body() {
                return el("div", { class: "onb-done" }, [
                    el("p", { text: state.name + " · " + ([...state.standards].join(", ") || "no standard picked") }),
                    el("p", { class: "sm dim", text: "Raise your first record now, or head to the dashboard." })
                ]);
            }
        }
    ];

    /* ---------- render ---------- */

    async function render() {
        const step = steps[state.step];
        const bodyNode = await step.body();

        const isLast = state.step === steps.length - 1;
        const back = el("button", { class: "btn", type: "button", text: "Back" });
        back.disabled = state.step === 0;
        back.addEventListener("click", () => { state.step--; render(); });

        const next = el("button", { class: "btn btn-primary", type: "button",
            text: isLast ? "Go to dashboard" : "Next" });
        next.addEventListener("click", async () => {
            next.disabled = true;
            if (step.onNext) await step.onNext(bodyNode);
            if (isLast) { await finish(false); return; }
            state.step++;
            render();
        });

        const children = [
            el("div", { class: "onb-head" }, [
                el("div", { class: "onb-progress", text: "Step " + (state.step + 1) + " of " + steps.length }),
                el("button", { class: "onb-skip", type: "button", text: "Skip setup",
                    onClick: () => finish(false) })
            ]),
            el("h2", { class: "onb-title", text: step.title }),
            el("p", { class: "onb-hint", text: step.hint }),
            el("div", { class: "onb-body" }, bodyNode),
            el("div", { class: "onb-foot" }, isLast
                ? [back, el("button", { class: "btn btn-primary", type: "button", text: "Raise first NCR",
                    onClick: () => finish(true) }), next]
                : [back, next])
        ];

        host.replaceChildren(el("div", { class: "onb-overlay" }, el("div", { class: "onb-card" }, children)));
        host.hidden = false;
    }

    render();
}
