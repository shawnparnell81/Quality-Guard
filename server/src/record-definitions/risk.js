/* Risk or Opportunity (clause 6.1). severity / occurrence / detection
   feed the server-computed RPN (withComputedRpn in routes/records.js);
   see also migration 016_risk_residual_scores. */
export default {
    key: "risk",
    name: "Risk or Opportunity",
    prefix: "R",
    clause: "6.1",

    states: [
        ["draft", "Draft", 1, false],
        ["unmitigated", "Unmitigated", 2, false],
        ["opportunity", "Opportunity", 3, false],
        ["in_progress", "In progress", 4, false],
        ["controlled", "Controlled", 5, true]
    ],

    transitions: [
        ["draft", "unmitigated", "risk.manage"],
        ["draft", "opportunity", "risk.manage"],
        ["unmitigated", "in_progress", "risk.manage"],
        ["opportunity", "in_progress", "risk.manage"],
        ["in_progress", "controlled", "risk.manage"]
    ],

    form: {
        fields: [
            { key: "process", label: "Process", type: "text" },
            { key: "severity", label: "Severity (1-10)", type: "number", min: 1 },
            { key: "occurrence", label: "Occurrence (1-10)", type: "number", min: 1 },
            { key: "detection", label: "Detection (1-10)", type: "number", min: 1 },
            { key: "action", label: "Planned action", type: "memo" }
        ],
        rules: []
    }
};
