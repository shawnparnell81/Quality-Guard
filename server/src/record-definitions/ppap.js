/* PPAP Submission (clause 8.3.4.4) - see migration 037_ppap_package.
   The 18 PPAP elements are slots (ppap_elements), not form fields;
   the screen renders them separately. */
export default {
    key: "ppap",
    name: "PPAP Submission",
    prefix: "PPAP",
    clause: "8.3.4.4",

    states: [
        ["draft", "Draft", 1, false],
        ["assembling", "Assembling package", 2, false],
        ["submitted", "Submitted", 3, false],
        ["interim", "Interim approval", 4, false],
        ["approved", "Approved", 5, true],
        ["rejected", "Rejected", 6, true]
    ],

    transitions: [
        ["draft", "assembling", "ppap.manage"],
        ["assembling", "submitted", "ppap.manage"],
        ["submitted", "interim", "ppap.manage"],
        ["submitted", "approved", "ppap.manage"],
        ["submitted", "rejected", "ppap.manage"],
        ["interim", "approved", "ppap.manage"],
        ["interim", "rejected", "ppap.manage"],
        ["rejected", "assembling", "ppap.manage"]
    ],

    form: {
        fields: [
            { key: "part_number", label: "Part number", type: "text", required: true, section: "Part" },
            { key: "part_name", label: "Part name", type: "text", section: "Part" },
            { key: "revision", label: "Revision / change level", type: "text", required: true, section: "Part" },
            { key: "customer", label: "Customer", type: "text", required: true, section: "Part" },
            { key: "customer_part_number", label: "Customer part number", type: "text", section: "Part" },
            { key: "drawing", label: "Drawing / spec no.", type: "text", section: "Part" },

            { key: "submission_level", label: "Submission level", type: "select", required: true, section: "Submission",
              options: ["Level 1", "Level 2", "Level 3", "Level 4", "Level 5"] },
            { key: "reason", label: "Reason for submission", type: "select", section: "Submission",
              options: ["Initial submission", "Engineering change",
                  "Tooling: transfer / replacement / refurbishment", "Material or sub-supplier change",
                  "Process change", "Correction of discrepancy", "Annual revalidation", "Other"] },
            { key: "part_weight", label: "Part weight", type: "text", section: "Submission" },
            { key: "psw_number", label: "PSW number", type: "text", section: "Submission" },

            { key: "submitted_on", label: "Submitted on", type: "date", section: "Approval" },
            { key: "submitted_by", label: "Submitted by", type: "signature", section: "Approval" },
            { key: "customer_disposition", label: "Customer disposition", type: "select", section: "Approval",
              options: ["Not submitted", "Submitted", "Interim Approval", "Full Approval", "Rejected"] },
            { key: "customer_signoff", label: "Customer approver / date", type: "text", section: "Approval" }
        ],
        rules: []
    }
};
