/* First Article Inspection (clause 8.5.1) - see migration
   035_first_article_inspection. The characteristics table's "result"
   column and the conforming counts are filled in server-side by
   applyFairResults (routes/records.js), not typed. */
export default {
    key: "fair",
    name: "First Article Inspection",
    prefix: "FAIR",
    clause: "8.5.1",

    states: [
        ["draft", "Draft", 1, false],
        ["in_progress", "In progress", 2, false],
        ["complete", "Complete", 3, false],
        ["approved", "Approved", 4, true],
        ["rejected", "Rejected", 5, true]
    ],

    transitions: [
        ["draft", "in_progress", "fair.manage"],
        ["in_progress", "complete", "fair.manage"],
        ["complete", "in_progress", "fair.manage"],
        ["complete", "approved", "fair.manage"],
        ["complete", "rejected", "fair.manage"]
    ],

    form: {
        fields: [
            { key: "part_number", label: "Part number", type: "text", required: true, section: "Part" },
            { key: "part_name", label: "Part name", type: "text", section: "Part" },
            { key: "revision", label: "Revision", type: "text", required: true, section: "Part" },
            { key: "drawing", label: "Drawing / spec no.", type: "text", section: "Part" },
            { key: "customer", label: "Customer", type: "text", section: "Part" },
            { key: "po_number", label: "Customer PO / contract", type: "text", section: "Part" },

            { key: "process", label: "Manufacturing process / cell", type: "text", section: "Manufacturing" },
            { key: "serial_or_lot", label: "Serial / lot no.", type: "text", section: "Manufacturing" },
            { key: "material_cert", label: "Raw material cert no.", type: "text", section: "Manufacturing" },
            { key: "special_processes", label: "Special process certifications", type: "memo", section: "Manufacturing" },

            { key: "fai_type", label: "FAI type", type: "select", section: "Inspection",
              options: ["Full FAI", "Partial FAI", "Delta FAI"] },
            { key: "inspection_date", label: "Inspection date", type: "date", section: "Inspection" },
            { key: "inspected_by", label: "Inspected by", type: "signature", section: "Inspection" },
            { key: "equipment_used", label: "Gauges & equipment used", type: "memo", section: "Inspection" },

            { key: "characteristics", label: "Characteristics", type: "table", section: "Characteristics",
              columns: [
                  { key: "balloon", label: "Balloon #", type: "text" },
                  { key: "feature", label: "Characteristic", type: "text" },
                  { key: "char_class", label: "Class", type: "select",
                    options: ["Standard", "Key", "Critical", "Major", "Minor"] },
                  { key: "nominal", label: "Nominal", type: "number" },
                  { key: "tol_minus", label: "Tol −", type: "number" },
                  { key: "tol_plus", label: "Tol +", type: "number" },
                  { key: "method", label: "Method", type: "text" },
                  { key: "actual", label: "Actual", type: "number" },
                  { key: "result", label: "Result", type: "text" },
                  { key: "notes", label: "Notes", type: "text" }
              ] },

            { key: "disposition", label: "Disposition", type: "select", required: true, section: "Disposition",
              options: ["Accepted", "Accepted with deviation", "Rejected"] },
            { key: "deviation_reference", label: "Deviation / concession no.", type: "text", section: "Disposition" },
            { key: "nonconformances", label: "Nonconformance detail", type: "memo", section: "Disposition" },
            { key: "reviewed_by", label: "Reviewed by", type: "signature", section: "Disposition" },
            { key: "review_date", label: "Review date", type: "date", section: "Disposition" }
        ],
        rules: []
    }
};
