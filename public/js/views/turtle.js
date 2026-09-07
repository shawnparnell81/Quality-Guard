/* ============================================================
   ISO 9001 turtle diagrams, one per department process.

   One screen, a department switcher, the six-side layout drawn from
   /api/turtle/<department>, an inline editor (turtle.manage), and a
   branded one-page PDF for the audit binder.
   ============================================================ */

import { api } from "../api.js";
import { openEntityForm } from "../entity-form.js";
import { el, toast, formatDate } from "../dom.js";

const SIDES = [
    ["resources", "With what", "Equipment, tooling, systems"],
    ["people",    "With whom", "Roles and competence"],
    ["inputs",    "Inputs",    "What the process receives"],
    ["outputs",   "Outputs",   "What it delivers"],
    ["methods",   "How",       "Procedures and methods"],
    ["metrics",   "How measured", "KPIs that say it works"]
];

function departmentSelect() {
    return document.getElementById("turtle-dept");
}

export async function renderTurtle() {
    const canvas = document.getElementById("turtle-canvas");
    const select = departmentSelect();
    if (!canvas || !select) return;

    const department = select.value || "purchasing";
    canvas.replaceChildren(el("p", { class: "sm dim", text: "Loading..." }));

    try {
        const diagram = await api.turtle(department);

        const process = el("div", { class: "turtle-process" }, [
            el("div", { class: "turtle-process-name", text: diagram.process_name }),
            diagram.process_desc
                ? el("div", { class: "turtle-process-desc", text: diagram.process_desc })
                : null
        ]);

        const grid = el("div", { class: "turtle-grid" },
            SIDES.map(([key, label, hint]) => {
                const lines = diagram.sides[key] || [];
                return el("div", { class: "turtle-side", "data-side": key }, [
                    el("div", { class: "turtle-side-label", text: label }),
                    el("div", { class: "turtle-side-hint", text: hint }),
                    lines.length === 0
                        ? el("p", { class: "sm dim", style: "margin:6px 0 0", text: "Not filled in" })
                        : el("ul", { class: "turtle-list" }, lines.map((entry) =>
                            el("li", {}, [
                                document.createTextNode(entry.text),
                                entry.doc_number
                                    ? el("span", { class: "turtle-doc", text: entry.doc_number })
                                    : null
                            ])))
                ]);
            })
        );

        const meta = diagram.updated_at
            ? el("p", { class: "sm dim", style: "margin-top:14px", text:
                "Last updated " + formatDate(diagram.updated_at)
                + (diagram.updated_by ? " by " + diagram.updated_by : "") })
            : el("p", { class: "sm dim", style: "margin-top:14px",
                text: "No turtle recorded for this process yet. Use Edit to build it." });

        canvas.replaceChildren(process, grid, meta);
    } catch (error) {
        canvas.replaceChildren(el("p", { class: "sm", style: "color:var(--crit)", text: error.message }));
    }
}

function openTurtleEditor(diagram) {
    const department = departmentSelect().value;

    openEntityForm({
        title: "Edit turtle - " + (diagram.department_label || department),
        fields: [
            { key: "process_name", label: "Process name", type: "text", required: true },
            { key: "process_desc", label: "What the process does", type: "memo" },
            ...SIDES.map(([key, label]) => ({
                key, label, type: "memo",
                hint: "One entry per line."
            }))
        ],
        values: {
            process_name: diagram.process_name,
            process_desc: diagram.process_desc || "",
            ...Object.fromEntries(SIDES.map(([key]) =>
                [key, (diagram.sides[key] || []).map((e) => e.text).join("\n")]))
        },
        submitLabel: "Save turtle",
        successMessage: "Turtle diagram saved",
        onSubmit: ({ values }) => api.saveTurtle(department, {
            process_name: values.process_name,
            process_desc: values.process_desc || "",
            sides: Object.fromEntries(SIDES.map(([key]) => [
                key,
                (values[key] || "").split("\n").map((s) => s.trim()).filter(Boolean)
            ]))
        }),
        onSaved: () => renderTurtle()
    });
}

export function wireTurtle() {
    const select = departmentSelect();
    if (select) select.addEventListener("change", () => renderTurtle());

    const editButton = document.getElementById("turtle-edit");
    if (editButton) {
        editButton.addEventListener("click", async () => {
            try {
                const diagram = await api.turtle(select.value);
                openTurtleEditor(diagram);
            } catch (error) {
                toast(error.message);
            }
        });
    }

    const pdfButton = document.getElementById("turtle-pdf");
    if (pdfButton) {
        pdfButton.addEventListener("click", () => {
            window.location.href = api.turtlePdfUrl(select.value);
        });
    }
}
