/* CAPA - Corrective Action (clause 10.2).

   Five-phase CAPA process - see migration 046, which brings existing
   orgs to this same shape. The form is grouped by phase (section).
   Only problem_statement is required at creation; the workflow
   enforces the rest. */
export default {
    key: "capa",
    name: "Corrective Action",
    prefix: "CAPA",
    clause: "10.2",

    states: [
        ["initiation", "Initiation & evaluation", 1, false],
        ["investigation", "Investigation & root cause", 2, false],
        ["planning", "Action planning", 3, false],
        ["implementation", "Implementation & monitoring", 4, false],
        ["effectiveness", "Effectiveness verification", 5, false],
        ["closed", "Closed", 6, true],
        ["escalated", "Escalated", 7, true]
    ],

    transitions: [
        ["initiation", "investigation", "capa.create"],
        ["initiation", "closed", "capa.close"],
        ["investigation", "planning", "capa.create"],
        ["planning", "implementation", "capa.create"],
        ["implementation", "effectiveness", "capa.create"],
        ["effectiveness", "closed", "capa.close"],
        ["effectiveness", "planning", "capa.create"],
        ["effectiveness", "escalated", "capa.close"]
    ],

    form: {
        fields: [
            { key: "source", label: "Source", type: "text", section: "Initiation & evaluation" },
            { key: "problem_statement", label: "Problem statement", type: "memo", required: true, section: "Initiation & evaluation" },
            { key: "trigger_event", label: "Trigger event", type: "memo", section: "Initiation & evaluation" },
            { key: "preliminary_findings", label: "Preliminary investigation", type: "memo", section: "Initiation & evaluation" },
            { key: "significance", label: "Significance", type: "select", options: ["Low", "Medium", "High", "Critical"], section: "Initiation & evaluation" },
            { key: "capa_warranted", label: "CAPA warranted", type: "boolean", section: "Initiation & evaluation" },
            { key: "necessity_rationale", label: "Necessity determination", type: "memo", section: "Initiation & evaluation" },

            { key: "investigation_team", label: "Investigation team", type: "text", section: "Investigation & root cause" },
            { key: "rca_method", label: "RCA method", type: "select", options: ["5 Why", "Fishbone", "Fault Tree", "Human Factors", "FMEA", "Other"], section: "Investigation & root cause" },
            { key: "why_1", label: "Why 1", type: "memo", section: "Investigation & root cause" },
            { key: "why_2", label: "Why 2", type: "memo", section: "Investigation & root cause" },
            { key: "why_3", label: "Why 3", type: "memo", section: "Investigation & root cause" },
            { key: "why_4", label: "Why 4", type: "memo", section: "Investigation & root cause" },
            { key: "why_5", label: "Why 5", type: "memo", section: "Investigation & root cause" },
            { key: "root_cause", label: "Root cause", type: "memo", section: "Investigation & root cause" },
            { key: "risk_ref", label: "Linked risk record", type: "text", section: "Investigation & root cause" },

            { key: "actions", label: "Action plan", type: "table", rowAttachments: true, section: "Action planning", columns: [
                { key: "action", label: "Action", type: "text" },
                { key: "type", label: "Type", type: "select", options: ["Containment", "Corrective", "Preventive"] },
                { key: "owner", label: "Owner", type: "text" },
                { key: "due", label: "Due", type: "date" },
                { key: "status", label: "Status", type: "select", options: ["Open", "In progress", "Done"] }
            ] },
            { key: "resources_required", label: "Resources required", type: "memo", section: "Action planning" },

            { key: "implementation_notes", label: "Implementation notes", type: "memo", section: "Implementation & monitoring" },
            { key: "implementation_complete", label: "Implementation complete", type: "boolean", section: "Implementation & monitoring" },

            { key: "verification_plan", label: "Verification plan (method, sample, acceptance)", type: "memo", section: "Effectiveness verification" },
            { key: "effectiveness_criterion", label: "How effectiveness is judged", type: "memo", section: "Effectiveness verification" },
            { key: "verification_result", label: "Verification result", type: "memo", section: "Effectiveness verification" },
            { key: "effectiveness_outcome", label: "Effectiveness outcome", type: "select", options: ["Effective", "Not effective - re-plan", "Not effective - escalate"], section: "Effectiveness verification" },
            { key: "closure_summary", label: "Closure summary", type: "memo", section: "Effectiveness verification" }
        ],
        rules: []
    }
};
