/* ============================================================
   Receiving inspection and shipping.

   Clause 8.4.2 on the way in, clause 8.6 on the way out. Both screens
   are a register on the left and the checks behind one row on the
   right, because that is the shape of the decision in both cases.
   ============================================================ */

import { api } from "../api.js";
import { can } from "../session.js";
import { confirmStep, ensureDialog } from "../forms.js";
import { openFileWindow } from "../doc-windows.js";
import {
    el, pill, severity, recordId, fillTable, loadingRow, errorRow,
    formatDate, humanize, toast
} from "../dom.js";

/* ============================================================
   Receiving
   ============================================================ */

const RECEIPT_STATUS = {
    pending: ["Awaiting inspection", "prog"],
    accept:  ["Accepted",            "done"],
    reject:  ["Rejected",            "open"]
};

const YES_NO_NA = [
    ["", "—"], ["yes", "Yes"], ["no", "No"], ["na", "N/A"]
];
const PACKAGING_CONDITION = [
    ["", "—"], ["good", "Good"], ["minor", "Minor damage"], ["damaged", "Damaged / compromised"]
];
const DISPOSITION_RESULTS = [
    ["accepted", "Accepted"],
    ["accepted_with_notes", "Accepted with notes"],
    ["rejected", "Rejected"]
];

let selectedReceipt = null;

export async function renderReceiving() {
    const tbody = document.getElementById("receipt-table");
    loadingRow(tbody, 7);

    try {
        const { receipts } = await api.receipts();

        fillTable(tbody, receipts, [
            { className: "nowrap", render: (row) => [
                severity(row.status === "reject" ? "crit"
                       : row.status === "pending" ? "warn" : "ok"),
                recordId(row.receipt_number)
            ] },
            { className: "mono sm", render: (row) => row.po_number || "-" },
            { className: "sm", render: (row) => row.vendor || "-" },
            { className: "mono sm nowrap", render: (row) => row.part_number || "-" },
            { className: "num", render: (row) => row.qty_received.toLocaleString() },
            { className: "mono sm", render: (row) => row.sample_plan || "-" },
            { render: (row) => {
                const [label, kind] = RECEIPT_STATUS[row.status] || ["Unknown", "hold"];
                const out = [pill(label, kind)];
                if (row.quarantined) out.push(pill("Quarantine", "open"));
                if (row.ncr_number) out.push(pill(row.ncr_number, "prog"));
                return out;
            } }
        ], "Nothing received");

        tbody.querySelectorAll("tr").forEach((tr, index) => {
            if (!receipts[index]) return;
            tr.dataset.receipt = receipts[index].receipt_number;
            tr.classList.add("row-clickable");
        });

        const target = receipts.some((r) => r.receipt_number === selectedReceipt)
            ? selectedReceipt
            : (receipts[0] && receipts[0].receipt_number);

        if (target) {
            mark(tbody, "receipt", target);
            await renderReceipt(target);
        }
    } catch (error) {
        errorRow(tbody, 7, error);
    }
}

/* One labelled control in a .form-section grid. When the form is
   read-only (a dispositioned receipt, or no receiving.log) every
   helper returns a static value instead of an input, so the same
   section list renders both the working form and the finished
   record. Editable helpers push a reader onto `readers`; a reader
   returns [key, value] with value null for an emptied field, which
   the PATCH route drops from the merge. */
function fieldKit(editable, data, readers) {
    const raw = (key) => {
        const v = data[key];
        return v === undefined || v === null ? "" : v;
    };

    const group = (label, control, opts) =>
        el("div", { class: "field-group" + (opts && opts.span ? " span-2" : "") },
            [el("label", { text: label }), control]);

    const staticGroup = (label, text, opts) => {
        const has = text !== "" && text !== null && text !== undefined;
        return el("div", { class: "field-group" + (opts && opts.span ? " span-2" : "") }, [
            el("label", { text: label }),
            el("div", { class: "static-value" + (has ? "" : " empty"),
                text: has ? String(text) : "—" })
        ]);
    };

    return {
        text(key, label, opts = {}) {
            const type = opts.type || "text";
            if (!editable || opts.readonly) {
                return staticGroup(label, raw(key), opts);
            }
            const input = el("input", { type });
            if (raw(key) !== "") input.value = String(raw(key));
            readers.push(() => {
                const s = input.value.trim();
                if (s === "") return [key, null];
                return [key, type === "number" ? Number(s) : s];
            });
            return group(label, input, opts);
        },
        num(key, label, opts = {}) { return this.text(key, label, { ...opts, type: "number" }); },
        date(key, label, opts = {}) {
            if (!editable) {
                return staticGroup(label, raw(key) ? formatDate(raw(key)) : "", opts);
            }
            const input = el("input", { type: "date" });
            if (raw(key)) input.value = String(raw(key)).slice(0, 10);
            readers.push(() => [key, input.value || null]);
            return group(label, input, opts);
        },
        select(key, label, options, opts = {}) {
            const current = String(raw(key) || "");
            if (!editable) {
                const hit = options.find(([v]) => v === current);
                return staticGroup(label, hit ? hit[1] : current, opts);
            }
            const sel = el("select", {}, options.map(([v, t]) => el("option", { value: v, text: t })));
            sel.value = current;
            readers.push(() => [key, sel.value || null]);
            return group(label, sel, opts);
        },
        /* Returns { node, box } - box is null when read-only, so a
           caller wiring a conditional row can guard on it. */
        check(key, label) {
            const on = raw(key) === true;
            if (!editable) {
                return {
                    node: el("div", { class: "check-row" }, [
                        el("span", { text: label + ":" }),
                        el("strong", { text: on ? "Yes" : "No" })
                    ]),
                    box: null
                };
            }
            const box = el("input", { type: "checkbox" });
            box.checked = on;
            readers.push(() => [key, box.checked]);
            return {
                node: el("label", { class: "check-row" }, [box, el("span", { text: label })]),
                box
            };
        },
        memo(key, label) {
            if (!editable) return staticGroup(label, raw(key), { span: true });
            const ta = el("textarea", { rows: 2 });
            if (raw(key) !== "") ta.value = String(raw(key));
            readers.push(() => {
                const s = ta.value.trim();
                return [key, s === "" ? null : s];
            });
            return group(label, ta, { span: true });
        }
    };
}

function formSection(title, nodes) {
    return el("section", { class: "form-section" }, [
        el("h3", { text: title }),
        el("div", { class: "field-grid" }, nodes.filter(Boolean))
    ]);
}

/* The dimensional check - a handful of characteristic / nominal /
   actual / result rows, stored as data.dimensions. Read-only when the
   receipt is closed; otherwise an add-a-row repeater. */
function dimensionRepeater(editable, rows) {
    const body = el("tbody");
    const data = Array.isArray(rows) ? rows.slice() : [];

    function addRow(seed = {}) {
        if (!editable) {
            body.append(el("tr", {}, [
                el("td", { text: seed.characteristic || "-" }),
                el("td", { class: "mono", text: seed.nominal || "-" }),
                el("td", { class: "mono", text: seed.actual || "-" }),
                el("td", {}, seed.result === "fail" ? pill("Fail", "open")
                    : seed.result === "pass" ? pill("Pass", "done") : "-")
            ]));
            return;
        }
        const ch = el("input", { type: "text" });
        const nom = el("input", { type: "text" });
        const act = el("input", { type: "text" });
        const res = el("select", {}, [
            el("option", { value: "", text: "—" }),
            el("option", { value: "pass", text: "Pass" }),
            el("option", { value: "fail", text: "Fail" })
        ]);
        if (seed.characteristic) ch.value = seed.characteristic;
        if (seed.nominal) nom.value = seed.nominal;
        if (seed.actual) act.value = seed.actual;
        if (seed.result) res.value = seed.result;
        const tr = el("tr", {}, [
            el("td", {}, ch), el("td", {}, nom), el("td", {}, act), el("td", {}, res),
            el("td", {}, el("button", {
                class: "btn sm", type: "button", text: "×",
                onClick: () => tr.remove()
            }))
        ]);
        body.append(tr);
    }

    (data.length ? data : (editable ? [{}] : [])).forEach(addRow);

    const table = el("table", { class: "dim-repeater" }, [
        el("thead", {}, el("tr", {}, [
            el("th", { text: "Characteristic" }), el("th", { text: "Nominal" }),
            el("th", { text: "Actual" }), el("th", { text: "Result" }),
            editable ? el("th", {}) : null
        ].filter(Boolean))),
        body
    ]);

    const wrap = el("div", {}, [table]);
    if (editable) {
        wrap.append(el("button", {
            class: "btn sm no-print", type: "button", text: "Add row",
            onClick: () => addRow({})
        }));
    }

    return {
        node: wrap,
        read() {
            return [...body.querySelectorAll("tr")].map((tr) => {
                const inputs = tr.querySelectorAll("input, select");
                if (inputs.length < 4) return null;
                const row = {
                    characteristic: inputs[0].value.trim(),
                    nominal: inputs[1].value.trim(),
                    actual: inputs[2].value.trim(),
                    result: inputs[3].value
                };
                return row.characteristic || row.nominal || row.actual || row.result ? row : null;
            }).filter(Boolean);
        }
    };
}

async function renderReceipt(number) {
    selectedReceipt = number;

    const heading = document.getElementById("receipt-number");
    const panel = document.getElementById("receipt-detail");
    const measureBody = document.getElementById("measurement-table");

    if (measureBody) loadingRow(measureBody, 5);

    try {
        const { receipt, photos = [], measurements, can_disposition,
                can_log_measurement, can_edit } = await api.receipt(number);
        const d = receipt.data || {};
        const editable = Boolean(can_edit);

        if (heading) heading.textContent = receipt.receipt_number;

        /* code_letter/sample_size are the real ANSI/ASQ Z1.4 Table I
           numbers for this lot's actual quantity, not a static label. */
        const samplingLine = receipt.code_letter
            ? "Pull " + receipt.sample_size + " (code " + receipt.code_letter + "), "
              + receipt.accept_on
            : (receipt.sample_size ? "Inspect all " + receipt.sample_size : "-");

        const children = [];

        /* Status line - what state the receipt is in, plus the two
           flags the register also shows. */
        const flags = [pill(...(RECEIPT_STATUS[receipt.status] || ["Unknown", "hold"]))];
        if (receipt.quarantined) flags.push(pill("Quarantined", "open"));
        if (receipt.ncr_number) flags.push(pill("NCR " + receipt.ncr_number, "prog"));
        children.push(el("div", { class: "row", style: "gap:6px;flex-wrap:wrap;margin-bottom:6px" }, flags));

        children.push(el("dl", { class: "kv" }, [
            el("dt", { text: "Supplier" }),
            el("dd", { text: (receipt.vendor || "-")
                + (receipt.vendor_grade ? "  grade " + receipt.vendor_grade : "")
                + (receipt.on_avl ? "" : "  (not on AVL)") }),
            el("dt", { text: "Sampling" }),
            el("dd", { class: "mono", text: receipt.sample_plan || "-" }),
            el("dt", { text: "Quality gate" }),
            el("dd", { class: "mono", text: samplingLine }),
            el("dt", { text: "Received" }),
            el("dd", { class: "mono", text: formatDate(receipt.received_at) })
        ]));

        if (receipt.vendor_grade === "D") {
            children.push(el("p", {
                class: "sm dim", style: "margin:4px 0 0",
                text: "Grade D vendors are inspected 100 percent until five consecutive "
                    + "lots are accepted."
            }));
        }

        const readers = [];
        const F = fieldKit(editable, d, readers);

        /* ---- Section 1 : shipment identification ---- */
        children.push(formSection("1 · Shipment identification", [
            F.text("supplier_name", "Supplier", { readonly: receipt.on_avl }),
            F.text("packing_slip_number", "Packing slip #"),
            F.text("carrier", "Carrier"),
            F.date("received_date", "Date received"),
            F.text("po_number", "Purchase order"),
            F.text("part_number", "Part number"),
            F.text("part_description", "Part description", { span: true })
        ]));

        /* ---- Section 2 : material details ---- */
        const expiryPresent = F.check("expiration_date_present", "Material carries an expiration / use-by date");
        const expiryField = F.date("expiration_date", "Expiration date");
        const expiryWrap = el("div", { class: "field-grid" }, [expiryField]);
        const syncExpiry = () => {
            expiryWrap.hidden = expiryPresent.box
                ? !expiryPresent.box.checked
                : d.expiration_date_present !== true;
        };
        if (expiryPresent.box) expiryPresent.box.addEventListener("change", syncExpiry);
        syncExpiry();
        children.push(el("section", { class: "form-section" }, [
            el("h3", { text: "2 · Material details" }),
            el("div", { class: "field-grid" }, [
                F.text("lot_number", "Lot / batch number"),
                F.text("manufacturer", "Manufacturer"),
                F.text("country_of_origin", "Country of origin"),
                F.num("qty_received", "Quantity received"),
                F.text("unit_of_measure", "Unit of measure")
            ]),
            expiryPresent.node,
            expiryWrap
        ]));

        /* ---- Section 3 : visual & packaging ---- */
        const visualDefects = F.check("visual_defects", "Visual defects found");
        const visualNotesField = F.memo("visual_notes", "Describe the defects");
        const visualWrap = el("div", { class: "field-grid" }, [visualNotesField]);
        const syncVisual = () => {
            visualWrap.hidden = visualDefects.box
                ? !visualDefects.box.checked
                : d.visual_defects !== true;
        };
        if (visualDefects.box) visualDefects.box.addEventListener("change", syncVisual);
        syncVisual();
        children.push(el("section", { class: "form-section" }, [
            el("h3", { text: "3 · Visual & packaging" }),
            el("div", { class: "field-grid" }, [
                F.select("packaging_condition", "Packaging condition", PACKAGING_CONDITION),
                F.select("labelling_correct", "Labelling correct", YES_NO_NA),
                F.select("quantity_matches_packing_slip", "Quantity matches packing slip", YES_NO_NA),
                F.select("material_matches_po", "Material matches the PO", YES_NO_NA)
            ]),
            visualDefects.node,
            visualWrap
        ]));

        /* ---- Section 4 : dimensional / physical ---- */
        const dimReq = F.check("dimension_check_required", "A dimensional check is required");
        const dimRep = dimensionRepeater(editable, d.dimensions);
        const dimWrap = el("div", {}, [dimRep.node]);
        const syncDim = () => {
            dimWrap.hidden = dimReq.box ? !dimReq.box.checked : d.dimension_check_required !== true;
        };
        if (dimReq.box) dimReq.box.addEventListener("change", syncDim);
        syncDim();

        const weightReq = F.check("weight_check_required", "A weight check is required");
        const weightWrap = el("div", { class: "field-grid" }, [
            F.num("weight_expected", "Expected weight"),
            F.num("weight_actual", "Actual weight")
        ]);
        const syncWeight = () => {
            weightWrap.hidden = weightReq.box ? !weightReq.box.checked : d.weight_check_required !== true;
        };
        if (weightReq.box) weightReq.box.addEventListener("change", syncWeight);
        syncWeight();

        children.push(el("section", { class: "form-section" }, [
            el("h3", { text: "4 · Dimensional & physical" }),
            dimReq.node,
            dimWrap,
            weightReq.node,
            weightWrap,
            el("div", { class: "field-grid" }, [F.memo("physical_notes", "Physical notes")])
        ]));

        /* ---- Section 5 : documentation verification ---- */
        children.push(el("section", { class: "form-section" }, [
            el("h3", { text: "5 · Documentation verification" }),
            F.check("cert_of_conformance_received", "Certificate of Conformance received").node,
            F.check("material_cert_received", "Material / mill certificate received").node,
            F.check("rohs_reach_received", "RoHS / REACH declaration received").node,
            F.check("test_report_received", "Test / inspection report received").node,
            el("div", { class: "field-grid" }, [F.memo("documentation_notes", "Documentation notes")])
        ]));

        /* ---- Save ---- */
        if (editable) {
            const save = el("button", { class: "btn btn-primary no-print", type: "button" }, "Save inspection");
            save.addEventListener("click", async () => {
                const payload = {};
                for (const read of readers) {
                    const [key, value] = read();
                    payload[key] = value;
                }
                payload.dimensions = dimRep.read();
                save.disabled = true;
                save.textContent = "Saving...";
                try {
                    await api.updateReceipt(number, { data: payload });
                    toast("Inspection saved");
                    await renderReceipt(number);
                } catch (error) {
                    toast(error.message, "error");
                    save.disabled = false;
                    save.textContent = "Save inspection";
                }
            });
            children.push(el("div", { class: "row", style: "margin:4px 0 8px" }, save));
        }

        /* ---- Section 6 : disposition ---- */
        if (receipt.status === "pending" && can_disposition) {
            const result = el("select", {}, DISPOSITION_RESULTS.map(([v, t]) =>
                el("option", { value: v, text: t })));
            const rejectionReason = el("textarea", { rows: 2, placeholder: "Why is the shipment being rejected?" });
            const reasonWrap = el("div", { class: "field-group span-2" },
                [el("label", { text: "Rejection reason" }), rejectionReason]);
            const ncrBox = el("input", { type: "checkbox" });
            ncrBox.checked = true;
            const quarantineBox = el("input", { type: "checkbox" });
            quarantineBox.checked = true;
            const ncrRow = el("label", { class: "check-row" }, [ncrBox, el("span", { text: "Raise a linked NCR" })]);
            const quarantineRow = el("label", { class: "check-row" },
                [quarantineBox, el("span", { text: "Quarantine the material" })]);

            const sync = () => {
                const rejected = result.value === "rejected";
                reasonWrap.hidden = !rejected;
                ncrRow.hidden = !rejected;
                quarantineRow.hidden = !rejected;
            };
            result.addEventListener("change", sync);
            sync();

            const go = el("button", { class: "btn btn-primary", type: "button" }, "Record disposition");
            go.addEventListener("click", () => {
                const chosen = result.value;
                const rejected = chosen === "rejected";
                if (rejected && !rejectionReason.value.trim()) {
                    toast("A rejection reason is required", "error");
                    return;
                }
                confirmStep({
                    title: "Disposition " + receipt.receipt_number,
                    body: rejected
                        ? "The shipment is rejected."
                          + (ncrBox.checked ? " A linked NCR will be raised." : "")
                          + (quarantineBox.checked ? " The material is quarantined." : "")
                        : "The material is released to stores.",
                    confirmLabel: "Record",
                    onConfirm: async (notes) => {
                        const out = await api.dispositionReceipt(number, {
                            result: chosen,
                            rejection_reason: rejectionReason.value.trim() || undefined,
                            notes: notes || undefined,
                            requires_ncr: rejected && ncrBox.checked,
                            requires_quarantine: rejected && quarantineBox.checked
                        });
                        if (out.ncr_created) toast("NCR " + out.ncr_number + " raised", "ok");
                        await renderReceiving();
                    }
                });
            });

            children.push(el("section", { class: "form-section" }, [
                el("h3", { text: "6 · Disposition" }),
                el("div", { class: "field-grid" }, [
                    el("div", { class: "field-group" }, [el("label", { text: "Result" }), result]),
                    reasonWrap
                ]),
                ncrRow,
                quarantineRow,
                el("div", { class: "row", style: "margin-top:4px" }, go)
            ]));
        } else if (receipt.inspected_by) {
            const line = humanize(receipt.status) + " by " + receipt.inspected_by
                + ", " + formatDate(receipt.inspected_at)
                + (d.inspection_result ? "  (" + humanize(d.inspection_result) + ")" : "");
            children.push(el("p", { class: "sm dim", style: "margin:12px 0 0", text: line }));
            if (d.rejection_reason) {
                children.push(el("p", { class: "sm", style: "margin:4px 0 0", text: d.rejection_reason }));
            }
        }

        /* ---- Photos & scans ---- */
        const photoNodes = photos.length
            ? [el("ul", { class: "sm", style: "margin:0;padding-left:18px" }, photos.map((p) =>
                el("li", {}, [
                    el("button", {
                        class: "btn sm", type: "button", text: p.filename || ("Photo " + (p.index + 1)),
                        onClick: () => openFileWindow(
                            api.receiptPhotoUrl(number, p.index), p.filename, p.mime_type)
                    }),
                    el("span", { class: "dim", text: "  " + (p.uploaded_by || "?")
                        + " · " + formatDate(p.uploaded_at) })
                ])))]
            : [el("p", { class: "sm dim", style: "margin:0", text: "None attached." })];

        if (can_log_measurement) {
            const file = el("input", { type: "file" });
            const up = el("button", { class: "btn no-print", type: "button" }, "Upload");
            up.addEventListener("click", async () => {
                if (!file.files || !file.files[0]) {
                    toast("Choose a file first", "error");
                    return;
                }
                const form = new FormData();
                form.append("file", file.files[0]);
                up.disabled = true;
                try {
                    await api.uploadReceiptPhoto(number, form);
                    toast("Photo added");
                    await renderReceipt(number);
                } catch (error) {
                    toast(error.message, "error");
                } finally {
                    up.disabled = false;
                }
            });
            photoNodes.push(el("div", { class: "row no-print", style: "gap:6px;margin-top:8px" }, [file, up]));
        }

        children.push(el("section", { class: "form-section" },
            [el("h3", { text: "Photos & scans" }), ...photoNodes]));

        if (receipt.notes) {
            children.push(el("p", { class: "sm", style: "margin:12px 0 0", text: receipt.notes }));
        }

        if (panel) panel.replaceChildren(...children);

        fillTable(measureBody, measurements, [
            { className: "sm", render: (row) => row.characteristic },
            { className: "mono sm", render: (row) => row.specification || "-" },
            { className: "mono sm", render: (row) => row.actual || "-" },
            { className: "mono sm dim", render: (row) => row.gage_id || "-" },
            { render: (row) => row.result === "pass" ? pill("Pass", "done") : pill("Fail", "open") }
        ], "No measurements recorded");

        const addArea = document.getElementById("measurement-add");
        if (addArea) {
            if (can_log_measurement && receipt.status === "pending") {
                addArea.replaceChildren(buildMeasurementForm(number));
            } else {
                addArea.replaceChildren();
            }
        }
    } catch (error) {
        errorRow(measureBody, 5, error);
    }
}

/* One line of the sample this receipt's quality gate called for -
   inline, not a dialog, because an inspector works through several
   of these in a row while the sample is in front of them. */
function buildMeasurementForm(number) {
    const characteristic = el("input", { type: "text", placeholder: "Characteristic", class: "sm" });
    const specification = el("input", { type: "text", placeholder: "Specification", class: "sm" });
    const actual = el("input", { type: "text", placeholder: "Actual", class: "sm" });
    const result = el("select", { class: "sm" }, [
        el("option", { value: "pass", text: "Pass" }),
        el("option", { value: "fail", text: "Fail" })
    ]);
    const add = el("button", { class: "btn no-print", type: "button" }, "Add");

    add.addEventListener("click", async () => {
        if (!characteristic.value.trim()) {
            toast("Characteristic is required", "error");
            return;
        }

        try {
            await api.addReceiptMeasurement(number, {
                characteristic: characteristic.value.trim(),
                specification: specification.value.trim() || null,
                actual: actual.value.trim() || null,
                result: result.value
            });
            await renderReceipt(number);
        } catch (error) {
            toast(error.message, "error");
        }
    });

    return el("div", { class: "row no-print", style: "gap:6px;flex-wrap:wrap" },
        [characteristic, specification, actual, result, add]);
}

/* "Log receipt" - clause 8.4.2's actual starting gate. Captures
   section 1 (shipment identification) so the inspection opens with
   the header already filled; the rest of the form is done on the
   detail screen. Vendor options come from the same computed list the
   AVL screen shows, so the grade behind the quality gate is never
   stale - and a supplier not on the AVL can still be logged by name. */
function buildLogReceiptDialog(vendors) {
    const node = ensureDialog();
    const errorBox = el("div", { class: "signin-error", hidden: "hidden" });

    const vendorSelect = el("select", {}, [
        el("option", { value: "", text: "Choose a vendor..." }),
        ...vendors.map((v) => el("option", { value: v.name, text: v.name + "  grade " + (v.grade || "?") })),
        el("option", { value: "__other__", text: "Other - not on the AVL" })
    ]);
    const otherSupplier = el("input", { type: "text", placeholder: "Supplier name" });
    const otherWrap = el("div", { class: "field-group" },
        [el("label", { text: "Supplier name" }), otherSupplier]);
    otherWrap.hidden = true;
    vendorSelect.addEventListener("change", () => {
        otherWrap.hidden = vendorSelect.value !== "__other__";
    });

    const packingSlip = el("input", { type: "text", placeholder: "PS-8842" });
    const carrier = el("input", { type: "text", placeholder: "Carrier" });
    const receivedDate = el("input", { type: "date" });
    const poNumber = el("input", { type: "text", placeholder: "PO-4471" });
    const partNumber = el("input", { type: "text", placeholder: "RP-4471-A" });
    const partDescription = el("input", { type: "text", placeholder: "Optional" });
    const lotNumber = el("input", { type: "text", placeholder: "Lot / batch" });
    const qty = el("input", { type: "number", min: "1", step: "1" });
    const notes = el("textarea", { rows: 2, placeholder: "Optional" });

    const go = el("button", { class: "btn btn-primary", type: "button" }, "Log receipt");

    node.replaceChildren(
        el("div", { class: "modal-head" }, el("h2", { class: "modal-title", text: "Log a new receipt" })),
        el("div", { class: "modal-body" }, [
            errorBox,
            el("div", { class: "field-group" }, [el("label", { text: "Supplier" }), vendorSelect]),
            otherWrap,
            el("div", { class: "field-group" }, [el("label", { text: "Packing slip #" }), packingSlip]),
            el("div", { class: "field-group" }, [el("label", { text: "Carrier" }), carrier]),
            el("div", { class: "field-group" }, [el("label", { text: "Date received" }), receivedDate]),
            el("div", { class: "field-group" }, [el("label", { text: "Purchase order" }), poNumber]),
            el("div", { class: "field-group" }, [el("label", { text: "Part number" }), partNumber]),
            el("div", { class: "field-group" }, [el("label", { text: "Part description" }), partDescription]),
            el("div", { class: "field-group" }, [el("label", { text: "Lot / batch number" }), lotNumber]),
            el("div", { class: "field-group" }, [el("label", { text: "Quantity received" }), qty]),
            el("div", { class: "field-group" }, [el("label", { text: "Notes" }), notes])
        ]),
        el("div", { class: "modal-foot" }, [
            el("button", { class: "btn", type: "button", onClick: () => node.close() }, "Cancel"),
            go
        ])
    );

    go.addEventListener("click", async () => {
        errorBox.hidden = true;

        const onAvl = vendorSelect.value && vendorSelect.value !== "__other__";
        const supplierName = onAvl ? vendorSelect.value : otherSupplier.value.trim();

        if (!supplierName || !qty.value || Number(qty.value) <= 0) {
            errorBox.textContent = "A supplier and a positive quantity are both required.";
            errorBox.hidden = false;
            return;
        }

        go.disabled = true;
        go.textContent = "Logging...";

        try {
            const created = await api.createReceipt({
                vendor: onAvl ? vendorSelect.value : undefined,
                po_number: poNumber.value.trim() || null,
                part_number: partNumber.value.trim() || null,
                qty_received: Number(qty.value),
                notes: notes.value.trim() || null,
                data: {
                    supplier_name: supplierName,
                    packing_slip_number: packingSlip.value.trim() || undefined,
                    carrier: carrier.value.trim() || undefined,
                    received_date: receivedDate.value || undefined,
                    part_description: partDescription.value.trim() || undefined,
                    lot_number: lotNumber.value.trim() || undefined
                }
            });
            node.close();
            toast(created.receipt_number + " logged");
            selectedReceipt = created.receipt_number;
            await renderReceiving();
        } catch (error) {
            errorBox.textContent = error.message;
            errorBox.hidden = false;
        } finally {
            go.disabled = false;
            go.textContent = "Log receipt";
        }
    });

    node.showModal();
}

/* ============================================================
   Shipping
   ============================================================ */

const SHIP_STATUS = {
    preparing:        ["Preparing",        "hold"],
    awaiting_release: ["Awaiting release", "prog"],
    shipped:          ["Shipped",          "done"],
    blocked:          ["Blocked",          "open"]
};

let selectedShipment = null;

export async function renderShipping() {
    const tbody = document.getElementById("shipment-table");
    loadingRow(tbody, 7);

    try {
        const { shipments } = await api.shipments();

        fillTable(tbody, shipments, [
            { className: "nowrap", render: (row) => [
                severity(row.status === "blocked" ? "crit"
                       : row.status === "awaiting_release" ? "warn" : "ok"),
                recordId(row.shipment_number)
            ] },
            { className: "sm", render: (row) => row.customer },
            { className: "mono sm nowrap", render: (row) => row.part_number || "-" },
            { className: "mono sm", render: (row) => row.lot_number || "-" },
            { className: "num", render: (row) => row.qty.toLocaleString() },
            { className: "mono sm", render: (row) =>
                row.checks_passed + " of " + row.checks_total },
            { render: (row) => {
                const [label, kind] = SHIP_STATUS[row.status] || ["Unknown", "hold"];
                return pill(label, kind);
            } }
        ], "Nothing to ship");

        tbody.querySelectorAll("tr").forEach((tr, index) => {
            if (!shipments[index]) return;
            tr.dataset.shipment = shipments[index].shipment_number;
            tr.classList.add("row-clickable");
        });

        const target = shipments.some((s) => s.shipment_number === selectedShipment)
            ? selectedShipment
            : (shipments[0] && shipments[0].shipment_number);

        if (target) {
            mark(tbody, "shipment", target);
            await renderShipment(target);
        }
    } catch (error) {
        errorRow(tbody, 7, error);
    }
}

async function renderShipment(number) {
    selectedShipment = number;

    const heading = document.getElementById("shipment-number");
    const note = document.getElementById("shipment-note");
    const checkBody = document.getElementById("check-table");
    const panel = document.getElementById("shipment-detail");

    if (checkBody) loadingRow(checkBody, 4);

    try {
        const { shipment, checks, outstanding, can_release } = await api.shipment(number);

        if (heading) heading.textContent = shipment.shipment_number;
        if (note) {
            note.textContent = outstanding === 0
                ? "All checks passed"
                : outstanding + " check(s) outstanding";
        }

        const releasable = can_release && shipment.status !== "shipped";

        fillTable(checkBody, checks, [
            { className: "sm", render: (row) => row.description },
            { className: "mono sm dim", render: (row) => row.evidence || "-" },
            { render: (row) => {
                if (row.status === "pass") return pill("Pass", "done");
                if (row.status === "fail") return pill("Fail", "open");
                return pill("Pending", "prog");
            } },
            { render: (row) => {
                if (row.status === "pass" || !can("shipping.release")
                    || shipment.status === "shipped") {
                    return "";
                }

                const button = el("button", { class: "btn", type: "button" }, "Mark passed");
                button.addEventListener("click", () => {
                    confirmStep({
                        title: row.description,
                        body: "Records this check as complete against your name.",
                        confirmLabel: "Mark passed",
                        onConfirm: async (evidence) => {
                            await api.passShipmentCheck(number, row.position, { evidence });
                            await renderShipment(number);
                        }
                    });
                });
                return button;
            } }
        ], "No checks defined");

        const children = [
            el("dl", { class: "kv" }, [
                el("dt", { text: "Customer" }),
                el("dd", { text: shipment.customer }),
                el("dt", { text: "Part" }),
                el("dd", { class: "mono", text: shipment.part_number || "-" }),
                el("dt", { text: "Lot" }),
                el("dd", { class: "mono", text: shipment.lot_number || "-" }),
                el("dt", { text: "Heat" }),
                el("dd", { class: "mono", text: shipment.heat_number || "-" }),
                el("dt", { text: "Quantity" }),
                el("dd", { class: "mono", text: shipment.qty.toLocaleString() }),
                el("dt", { text: "Carrier" }),
                el("dd", { text: shipment.carrier || "-" }),
                el("dt", { text: "Ship date" }),
                el("dd", { class: "mono", text: formatDate(shipment.ship_date) })
            ])
        ];

        if (shipment.released_by) {
            children.push(el("p", {
                class: "sm dim", style: "margin:12px 0 0",
                text: "Released by " + shipment.released_by + ", " + formatDate(shipment.released_at)
            }));
        } else if (releasable) {
            const button = el("button", { class: "btn btn-primary", type: "button" }, "Authorise release");
            button.addEventListener("click", () => {
                confirmStep({
                    title: "Release " + shipment.shipment_number,
                    body: "Every planned verification is complete. This authorises the "
                        + "product to leave, under your name.",
                    confirmLabel: "Authorise release",
                    onConfirm: async (reason) => {
                        await api.releaseShipment(number, { reason });
                        await renderShipping();
                    }
                });
            });
            children.push(el("div", { class: "section-label", text: "Release" }));
            children.push(el("div", { class: "row" }, button));
        } else if (outstanding > 0) {
            children.push(el("div", { class: "section-label", text: "Release" }));
            children.push(el("p", {
                class: "sm dim", style: "margin:0",
                text: "Cannot release until every check passes. Clause 8.6."
            }));
        }

        if (panel) panel.replaceChildren(...children);
    } catch (error) {
        errorRow(checkBody, 4, error);
    }
}

/* ---------- shared ---------- */

function mark(tbody, key, value) {
    tbody.querySelectorAll("tr").forEach((tr) => {
        tr.classList.toggle("row-selected", tr.dataset[key] === value);
    });
}

export function wireOperations() {
    const receipts = document.getElementById("receipt-table");
    if (receipts) {
        receipts.addEventListener("click", (event) => {
            const row = event.target.closest("tr[data-receipt]");
            if (!row) return;
            mark(receipts, "receipt", row.dataset.receipt);
            renderReceipt(row.dataset.receipt);
        });
    }

    const logReceiptBtn = document.getElementById("log-receipt-btn");
    if (logReceiptBtn) {
        if (!can("receiving.log")) {
            logReceiptBtn.hidden = true;
        } else {
            logReceiptBtn.addEventListener("click", async () => {
                try {
                    const { vendors } = await api.vendors();
                    buildLogReceiptDialog(vendors);
                } catch (error) {
                    toast(error.message, "error");
                }
            });
        }
    }

    const shipments = document.getElementById("shipment-table");
    if (shipments) {
        shipments.addEventListener("click", (event) => {
            const row = event.target.closest("tr[data-shipment]");
            if (!row) return;
            mark(shipments, "shipment", row.dataset.shipment);
            renderShipment(row.dataset.shipment);
        });
    }
}
