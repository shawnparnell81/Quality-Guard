/* Discrepancy Investigation (clause 9.2) - see migration
   026_discrepancy_investigation. Bridges an audit finding to its
   corrective form: linked_closure waits on that form to close. */
export default {
    key: "di",
    name: "Discrepancy Investigation",
    prefix: "DI",
    clause: "9.2",

    states: [
        ["open", "Open", 1, false],
        ["investigating", "Investigating", 2, false],
        ["linked_closure", "Awaiting form closure", 3, false],
        ["closed", "Closed", 4, true]
    ],

    transitions: [
        ["open", "investigating", "di.manage"],
        ["investigating", "linked_closure", "di.manage"],
        ["linked_closure", "investigating", "di.manage"],
        ["linked_closure", "closed", "di.close"]
    ],

    form: {
        fields: [
            { key: "department", label: "Department under review", type: "text", required: true },
            { key: "finding", label: "What the audit found", type: "memo", required: true },
            { key: "investigator", label: "Investigator", type: "text" },
            { key: "root_cause", label: "Root cause", type: "memo" },
            { key: "containment", label: "Containment / interim action", type: "memo" },
            { key: "corrective_plan", label: "Corrective plan", type: "memo" }
        ],
        rules: []
    }
};
