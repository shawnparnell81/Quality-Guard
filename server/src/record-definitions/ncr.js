/* NCR - Nonconformance (clause 8.7).

   The plain, generic default a newly provisioned company gets:
   free-text where Ridgeline's own showcase form links to master data
   (parts, gages, lots) a brand new company has not entered yet. A
   company moves a field to a link once it has something to link to. */
export default {
    key: "ncr",
    name: "Nonconformance",
    prefix: "NCR",
    clause: "8.7",

    states: [
        ["draft", "Draft", 1, false],
        ["containment", "Containment", 2, false],
        ["mrb", "MRB review", 3, false],
        ["disposition", "Disposition executed", 4, false],
        ["verify", "Verification", 5, false],
        ["closed", "Closed", 6, true]
    ],

    transitions: [
        ["draft", "containment", "ncr.contain"],
        ["containment", "mrb", "ncr.disposition"],
        ["mrb", "disposition", "ncr.disposition"],
        ["disposition", "verify", "ncr.contain"],
        ["verify", "closed", "ncr.close"]
    ],

    form: {
        fields: [
            { key: "part_number", label: "Part number", type: "text" },
            { key: "lot_number", label: "Lot or serial", type: "text" },
            { key: "qty_affected", label: "Quantity affected", type: "number", min: 0 },
            { key: "characteristic", label: "Characteristic", type: "text" },
            { key: "measured", label: "Measured value", type: "text" },
            { key: "gage_id", label: "Gage used", type: "text" },
            { key: "disposition", label: "Disposition", type: "select", required: true,
              options: ["Rework", "Scrap", "Use-as-is", "Return to supplier", "Regrade"] },
            { key: "containment", label: "Containment", type: "memo" }
        ],
        rules: []
    }
};
