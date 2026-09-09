/* APQP Program (clause 8.3) - see migration 013_apqp_program_record_type.

   The five non-draft states ARE the five APQP phases themselves - a
   program's workflow position on screen IS its phase, nothing else
   tracks that separately. */
export default {
    key: "apqp",
    name: "APQP Program",
    prefix: "APQP",
    clause: "8.3",

    states: [
        ["draft", "Draft", 1, false],
        ["plan_define", "Phase 1 - Plan & Define Program", 2, false],
        ["product_design", "Phase 2 - Product Design & Dev.", 3, false],
        ["process_design", "Phase 3 - Process Design & Dev.", 4, false],
        ["validation", "Phase 4 - Product & Process Validation", 5, false],
        ["production", "Phase 5 - Feedback & Corrective Action", 6, false],
        ["closed", "Closed", 7, true]
    ],

    transitions: [
        ["draft", "plan_define", "apqp.manage"],
        ["plan_define", "product_design", "apqp.manage"],
        ["product_design", "process_design", "apqp.manage"],
        ["process_design", "validation", "apqp.manage"],
        ["validation", "production", "apqp.manage"],
        ["production", "closed", "apqp.manage"]
    ],

    form: {
        fields: [
            { key: "customer", label: "Customer", type: "text", required: true },
            { key: "part_number", label: "Part number", type: "text" },
            { key: "target_sop", label: "Target start of production", type: "date" },
            { key: "ppap_level", label: "PPAP submission level", type: "select",
              options: ["Level 1", "Level 2", "Level 3", "Level 4", "Level 5"] },
            { key: "psw_status", label: "PSW status", type: "select",
              options: ["Not submitted", "Submitted", "Interim Approval", "Approved", "Rejected"] },
            { key: "program_risk_summary", label: "Top program risks", type: "memo" },
            { key: "lessons_learned", label: "Lessons learned", type: "memo" }
        ],
        rules: []
    }
};
