/* ECN - Engineering Change (clause 8.5.6). */
export default {
    key: "ecn",
    name: "Engineering Change",
    prefix: "ECN",
    clause: "8.5.6",

    states: [
        ["draft", "Draft", 1, false],
        ["impact", "Impact assessment", 2, false],
        ["review", "In review", 3, false],
        ["approved", "Approved", 4, false],
        ["implemented", "Implemented", 5, true]
    ],

    transitions: [
        ["draft", "impact", "change.create"],
        ["impact", "review", "change.create"],
        ["review", "approved", "change.approve"],
        ["approved", "implemented", "change.approve"]
    ],

    form: {
        fields: [
            { key: "part_number", label: "Part number", type: "text", required: true },
            { key: "from_rev", label: "From revision", type: "text" },
            { key: "to_rev", label: "To revision", type: "text" },
            { key: "reason", label: "Reason for change", type: "memo", required: true }
        ],
        rules: []
    }
};
