/* Internal Audit (clause 9.2). */
export default {
    key: "audit",
    name: "Internal Audit",
    prefix: "AUD",
    clause: "9.2",

    states: [
        ["draft", "Draft", 1, false],
        ["scheduled", "Scheduled", 2, false],
        ["overdue", "Overdue", 3, false],
        ["closed", "Closed", 4, true]
    ],

    transitions: [
        ["draft", "scheduled", "audit.schedule"],
        ["scheduled", "overdue", "audit.schedule"],
        ["scheduled", "closed", "audit.close"],
        ["overdue", "closed", "audit.close"]
    ],

    form: {
        fields: [
            { key: "scope", label: "Scope", type: "text", required: true },
            { key: "auditor", label: "Auditor", type: "text" },
            { key: "planned", label: "Planned date", type: "date" }
        ],
        rules: []
    }
};
