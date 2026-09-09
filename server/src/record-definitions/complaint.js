/* Customer Complaint (clause 8.2.1). */
export default {
    key: "complaint",
    name: "Customer Complaint",
    prefix: "COMP",
    clause: "8.2.1",

    states: [
        ["draft", "Draft", 1, false],
        ["investigating", "Investigating", 2, false],
        ["with_logistics", "With logistics", 3, false],
        ["response_drafted", "Response drafted", 4, false],
        ["response_received", "Customer response in", 5, false],
        ["closed", "Closed", 6, true]
    ],

    transitions: [
        ["draft", "investigating", "complaint.create"],
        ["investigating", "with_logistics", "complaint.create"],
        ["investigating", "response_drafted", "complaint.respond"],
        ["with_logistics", "response_drafted", "complaint.respond"],
        ["response_drafted", "response_received", "complaint.respond"],
        ["response_received", "closed", "complaint.respond"]
    ],

    form: {
        fields: [
            { key: "customer", label: "Customer", type: "text", required: true },
            { key: "contact", label: "Contact", type: "text" },
            { key: "part_number", label: "Part number", type: "text" },
            { key: "qty", label: "Quantity", type: "number", min: 0 },
            { key: "description", label: "Description", type: "memo", required: true }
        ],
        rules: []
    }
};
