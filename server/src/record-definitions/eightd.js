/* 8D Investigation (clause 10.2). The eight disciplines are the
   workflow; the form itself stays minimal because each discipline is
   captured as it is worked through the states. */
export default {
    key: "eightd",
    name: "8D Investigation",
    prefix: "8D",
    clause: "10.2",

    states: [
        ["d1", "D1 Team formed", 1, false],
        ["d2", "D2 Problem described", 2, false],
        ["d3", "D3 Interim containment", 3, false],
        ["d4", "D4 Root cause", 4, false],
        ["d5", "D5 Corrective action", 5, false],
        ["d6", "D6 Implement and validate", 6, false],
        ["d7", "D7 Prevent recurrence", 7, false],
        ["d8", "D8 Recognise the team", 8, false],
        ["closed", "Closed", 9, true]
    ],

    transitions: [
        ["d1", "d2", "capa.create"],
        ["d2", "d3", "ncr.contain"],
        ["d3", "d4", "capa.create"],
        ["d4", "d5", "capa.create"],
        ["d5", "d6", "capa.create"],
        ["d6", "d7", "capa.create"],
        ["d7", "d8", "capa.create"],
        ["d8", "closed", "capa.close"]
    ],

    form: {
        fields: [
            { key: "customer", label: "Customer", type: "text" },
            { key: "summary", label: "Summary", type: "memo" }
        ],
        rules: []
    }
};
