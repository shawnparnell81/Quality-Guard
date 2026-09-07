/* ============================================================
   API client.

   Every call to the server goes through here. One place to add
   auth headers later, one place that knows how errors are shaped,
   and view code that never touches fetch directly.
   ============================================================ */

const BASE = "/api";

/* Identity travels in an httpOnly session cookie the browser attaches
   on its own. Nothing here reads or sets it, which is the point: code
   that cannot touch the cookie cannot leak it. */
async function request(method, path, body) {
    const options = {
        method,
        headers: {},
        credentials: "same-origin"
    };

    if (body !== undefined) {
        options.headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(body);
    }

    let response;

    try {
        response = await fetch(BASE + path, options);
    } catch (cause) {
        /* fetch only rejects when the request never completed, which
           in practice means the server is not running. Say that,
           rather than surfacing "Failed to fetch". */
        throw new Error("Cannot reach the server. Is it running on port 3001?");
    }

    /* The session has expired or been revoked. Nothing on the page is
       valid any more, so go back to sign-in rather than showing a
       screen full of permission errors. */
    if (response.status === 401 && !path.startsWith("/auth/")) {
        window.location.href = "/login.html";
        throw new Error("Session ended");
    }

    /* 428: the session is fine, but a temporary password has to be
       replaced before anything else will answer. */
    if (response.status === 428) {
        window.location.href = "/change-password.html";
        throw new Error("Password change required");
    }

    if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const error = new Error(payload.error || response.status + " " + response.statusText);
        error.status = response.status;
        error.payload = payload;
        throw error;
    }

    return response.json();
}

const get = (path) => request("GET", path);

/* A real file upload - FormData, not JSON. Shares request()'s
   session/error handling by duplicating just the two lines that
   differ (no Content-Type header of our own: the browser sets the
   multipart boundary itself, and setting one by hand breaks it; no
   JSON.stringify, FormData is already the wire format) rather than
   bending request() itself around a body shape most callers never
   send. */
async function postForm(path, formData, method = "POST") {
    let response;

    try {
        response = await fetch(BASE + path, {
            method,
            credentials: "same-origin",
            body: formData
        });
    } catch (cause) {
        throw new Error("Cannot reach the server. Is it running on port 3001?");
    }

    if (response.status === 401 && !path.startsWith("/auth/")) {
        window.location.href = "/login.html";
        throw new Error("Session ended");
    }

    if (response.status === 428) {
        window.location.href = "/change-password.html";
        throw new Error("Password change required");
    }

    if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const error = new Error(payload.error || response.status + " " + response.statusText);
        error.status = response.status;
        error.payload = payload;
        throw error;
    }

    return response.json();
}

function withQuery(path, params) {
    const search = new URLSearchParams(
        Object.entries(params || {}).filter(([, value]) => value !== undefined)
    ).toString();

    return search ? path + "?" + search : path;
}

export const api = {
    health:       ()        => get("/health"),
    organization: ()        => get("/organization"),

    me:            ()       => get("/me"),
    roles:         ()       => get("/roles"),
    logout:        ()       => request("POST", "/auth/logout"),
    changePassword: (payload) => request("POST", "/auth/change-password", payload),

    setRolePermission: (roleKey, permissionKey, granted) =>
        request("PUT", "/roles/" + encodeURIComponent(roleKey)
                + "/permissions/" + encodeURIComponent(permissionKey), { granted }),

    users:         ()       => get("/users"),
    createUser:    (payload) => request("POST", "/users", payload),
    updateUser:    (initials, payload) =>
        request("PATCH", "/users/" + encodeURIComponent(initials), payload),
    deactivateUser: (initials, payload) =>
        request("POST", "/users/" + encodeURIComponent(initials) + "/deactivate", payload),
    resetPassword: (initials, payload) =>
        request("POST", "/users/" + encodeURIComponent(initials) + "/reset-password", payload),

    dashboard:    ()        => get("/dashboard"),
    openEvents:   ()        => get("/dashboard/open-events"),
    escalations:  (days)    => get(withQuery("/dashboard/escalations", { days })),
    readiness:    ()        => get("/dashboard/readiness"),

    layout:       (kind)    => get("/layout/" + encodeURIComponent(kind)),
    saveLayout:   (kind, layout) =>
        request("PUT", "/layout/" + encodeURIComponent(kind), { layout }),

    recordTypes:  ()        => get("/record-types"),
    recordForm:   (typeKey) => get("/record-types/" + encodeURIComponent(typeKey) + "/form"),
    updateRecordForm: (typeKey, fields) =>
        request("PUT", "/record-types/" + encodeURIComponent(typeKey) + "/form", { fields }),
    createRecordType: (payload) => request("POST", "/record-types", payload),
    importForm:       (formData) => postForm("/forms/import", formData),
    formImports:      ()        => get("/forms/imports"),
    formImportDetail: (id)      => get("/forms/imports/" + encodeURIComponent(id)),
    applyFormImport:  (id, payload) =>
        request("POST", "/forms/imports/" + encodeURIComponent(id) + "/apply", payload),
    records:      (params)  => get(withQuery("/records", params)),
    searchRecords: (q)      => get(withQuery("/records/search", { q })),
    record:       (number)  => get("/records/" + encodeURIComponent(number)),
    createRecord: (payload) => request("POST", "/records", payload),
    updateRecord: (number, payload) =>
        request("PATCH", "/records/" + encodeURIComponent(number), payload),
    transition:   (number, payload) =>
        request("POST", "/records/" + encodeURIComponent(number) + "/transition", payload),

    linkRecord: (number, payload) =>
        request("POST", "/records/" + encodeURIComponent(number) + "/links", payload),
    unlinkRecord: (number, target) =>
        request("DELETE", "/records/" + encodeURIComponent(number)
                + "/links/" + encodeURIComponent(target)),

    attachments:      (number)  => get("/records/" + encodeURIComponent(number) + "/attachments"),
    addAttachment: (number, payload) =>
        request("POST", "/records/" + encodeURIComponent(number) + "/attachments", payload),
    uploadAttachment: (number, formData) =>
        postForm("/records/" + encodeURIComponent(number) + "/attachments", formData),
    attachmentFileUrl: (number, id) =>
        "/api/records/" + encodeURIComponent(number)
        + "/attachments/" + encodeURIComponent(id) + "/file",

    workOrders:   (params)  => get(withQuery("/work-orders", params)),
    workOrder:    (wo)      => get("/work-orders/" + encodeURIComponent(wo)),
    createWorkOrder: (payload) => request("POST", "/work-orders", payload),
    updateWorkOrder: (wo, payload) =>
        request("PATCH", "/work-orders/" + encodeURIComponent(wo), payload),
    holdWorkOrder: (wo, payload) =>
        request("POST", "/work-orders/" + encodeURIComponent(wo) + "/hold", payload),
    releaseWorkOrder: (wo, payload) =>
        request("POST", "/work-orders/" + encodeURIComponent(wo) + "/release", payload),

    purchaseOrders:      ()       => get("/purchase-orders"),
    purchaseOrder:       (number) => get("/purchase-orders/" + encodeURIComponent(number)),
    createPurchaseOrder: (payload) => request("POST", "/purchase-orders", payload),
    updatePurchaseOrder: (number, payload) =>
        request("PATCH", "/purchase-orders/" + encodeURIComponent(number), payload),

    purchaseRequests:      ()       => get("/purchase-requests"),
    purchaseRequest:       (number) => get("/purchase-requests/" + encodeURIComponent(number)),
    createPurchaseRequest: (payload) => request("POST", "/purchase-requests", payload),
    updatePurchaseRequest: (number, payload) =>
        request("PATCH", "/purchase-requests/" + encodeURIComponent(number), payload),

    changeImpact: (number)  => get("/changes/" + encodeURIComponent(number) + "/impact"),
    signImpact:   (number, area, payload) =>
        request("POST", "/changes/" + encodeURIComponent(number)
                + "/impact/" + encodeURIComponent(area) + "/sign", payload),

    drawings:      ()       => get("/drawings"),
    drawing:       (number) => get("/drawings/" + encodeURIComponent(number)),
    createDrawing: (formData) => postForm("/drawings", formData),
    addDrawingRevision: (number, formData) =>
        postForm("/drawings/" + encodeURIComponent(number) + "/revisions", formData),
    drawingFileUrl: (number, revision) =>
        "/api/drawings/" + encodeURIComponent(number)
        + "/revisions/" + encodeURIComponent(revision) + "/file",
    releaseDrawing: (number, revision, payload) =>
        request("POST", "/drawings/" + encodeURIComponent(number)
                + "/revisions/" + encodeURIComponent(revision) + "/release", payload),

    receipts:      ()       => get("/receipts"),
    receipt:       (number) => get("/receipts/" + encodeURIComponent(number)),
    createReceipt: (payload) => request("POST", "/receipts", payload),
    updateReceipt: (number, payload) =>
        request("PATCH", "/receipts/" + encodeURIComponent(number), payload),
    addReceiptMeasurement: (number, payload) =>
        request("POST", "/receipts/" + encodeURIComponent(number) + "/measurements", payload),
    dispositionReceipt: (number, payload) =>
        request("POST", "/receipts/" + encodeURIComponent(number) + "/disposition", payload),
    uploadReceiptPhoto: (number, formData) =>
        postForm("/receipts/" + encodeURIComponent(number) + "/photos", formData),
    receiptPhotoUrl: (number, index) =>
        "/api/receipts/" + encodeURIComponent(number)
        + "/photos/" + encodeURIComponent(index),

    shipments:     ()       => get("/shipments"),
    shipment:      (number) => get("/shipments/" + encodeURIComponent(number)),
    releaseShipment: (number, payload) =>
        request("POST", "/shipments/" + encodeURIComponent(number) + "/release", payload),
    passShipmentCheck: (number, position, payload) =>
        request("POST", "/shipments/" + encodeURIComponent(number)
                + "/checks/" + encodeURIComponent(position) + "/pass", payload),

    objectives:    ()       => get("/objectives"),
    reviews:       ()       => get("/reviews"),
    reviewInputs:  (ref)    => get("/reviews/" + encodeURIComponent(ref) + "/inputs"),

    reviewCharts:  (ref)    => get("/reviews/" + encodeURIComponent(ref) + "/charts"),
    reviewChartSeed: (ref, kind) =>
        get("/reviews/" + encodeURIComponent(ref) + "/charts/seed/" + encodeURIComponent(kind)),
    createReviewChart: (ref, payload) =>
        request("POST", "/reviews/" + encodeURIComponent(ref) + "/charts", payload),
    updateReviewChart: (ref, id, payload) =>
        request("PUT", "/reviews/" + encodeURIComponent(ref) + "/charts/" + encodeURIComponent(id), payload),
    deleteReviewChart: (ref, id) =>
        request("DELETE", "/reviews/" + encodeURIComponent(ref) + "/charts/" + encodeURIComponent(id)),

    onboarding:    ()       => get("/onboarding"),
    onboardingStages: (vendor) => get("/onboarding/" + encodeURIComponent(vendor)),
    onboardingPacket: (vendor) => get("/onboarding/" + encodeURIComponent(vendor) + "/packet"),
    completeOnboardingStage: (vendor, stageKey, payload) =>
        request("POST", "/onboarding/" + encodeURIComponent(vendor)
                + "/stages/" + encodeURIComponent(stageKey) + "/complete", payload),
    addOnboardingDocument: (vendor, stageKey, formData) =>
        postForm("/onboarding/" + encodeURIComponent(vendor)
                + "/stages/" + encodeURIComponent(stageKey) + "/documents", formData),
    deleteOnboardingDocument: (vendor, stageKey, id) =>
        request("DELETE", "/onboarding/" + encodeURIComponent(vendor)
                + "/stages/" + encodeURIComponent(stageKey) + "/documents/" + encodeURIComponent(id)),
    onboardingDocumentUrl: (vendor, stageKey, id) =>
        "/api/onboarding/" + encodeURIComponent(vendor)
        + "/stages/" + encodeURIComponent(stageKey) + "/documents/" + encodeURIComponent(id) + "/download",

    vendors:      ()        => get("/vendors"),
    vendorEvaluations: (name) => get("/vendors/" + encodeURIComponent(name) + "/evaluations"),
    addVendorEvaluation: (name, payload) =>
        request("POST", "/vendors/" + encodeURIComponent(name) + "/evaluations", payload),
    gages:        ()        => get("/gages"),
    createGage:    (payload) => request("POST", "/gages", payload),
    updateGage:    (gageId, payload) =>
        request("PATCH", "/gages/" + encodeURIComponent(gageId), payload),
    retireGage:    (gageId, payload) =>
        request("POST", "/gages/" + encodeURIComponent(gageId) + "/retire", payload),
    gageCalibrations: (gageId) => get("/gages/" + encodeURIComponent(gageId) + "/calibrations"),
    /* A calibration is recorded as multipart every time - the same
       shape whether or not a certificate PDF rides along - so the
       caller always hands over a FormData. */
    recordCalibration: (gageId, formData) =>
        postForm("/gages/" + encodeURIComponent(gageId) + "/calibrations", formData),
    /* Plain browser navigation to the cert file, same reasoning as
       documentDownloadUrl - the session cookie travels on its own. */
    gageCertificateUrl: (gageId, calId) =>
        "/api/gages/" + encodeURIComponent(gageId)
        + "/calibrations/" + encodeURIComponent(calId) + "/certificate",
    documents:    (params)  => get(withQuery("/documents",
        typeof params === "string" ? { record: params } : (params || {}))),
    revisions:    (doc)     => get("/documents/" + encodeURIComponent(doc) + "/revisions"),
    uploadDocument: (formData) => postForm("/documents", formData),
    uploadDocumentRevision: (doc, formData) =>
        postForm("/documents/" + encodeURIComponent(doc) + "/revisions", formData),
    releaseDocumentRevision: (doc, revision) =>
        request("POST", "/documents/" + encodeURIComponent(doc)
                + "/revisions/" + encodeURIComponent(revision) + "/release"),
    /* Not fetched through request() - this is a real file, and the
       point is a plain browser navigation/download, not JSON the app
       reads. The session cookie still travels with it automatically
       (same-origin), so a signed-out tab still can't reach it. */
    documentDownloadUrl: (doc, revision) =>
        "/api/documents/" + encodeURIComponent(doc)
        + "/revisions/" + encodeURIComponent(revision) + "/download",
    parts:        ()        => get("/parts"),
    lots:         (params)  => get(withQuery("/lots", params)),
    genealogy:    (lot)     => get("/lots/" + encodeURIComponent(lot) + "/genealogy"),

    trainingGaps:   ()      => get("/training/gaps"),
    trainingMatrix: ()      => get("/training/matrix"),
    training:       ()      => get("/training"),
    trainingRecord: (id)    => get("/training/" + encodeURIComponent(id)),
    /* multipart every time - one route handles a batch (users: JSON
       array) and a single entry alike, with an optional evidence file. */
    recordTraining: (formData) => postForm("/training", formData),
    updateTraining: (id, formData) =>
        postForm("/training/" + encodeURIComponent(id), formData, "PATCH"),
    trainingEvidenceUrl: (id) =>
        "/api/training/" + encodeURIComponent(id) + "/evidence",

    turtles:     ()          => get("/turtle"),
    turtle:      (department) => get("/turtle/" + encodeURIComponent(department)),
    saveTurtle:  (department, payload) =>
        request("PUT", "/turtle/" + encodeURIComponent(department), payload),
    turtlePdfUrl: (department) => "/api/turtle/" + encodeURIComponent(department) + "/pdf",

    apqpDeliverables: (number) =>
        get("/apqp/" + encodeURIComponent(number) + "/deliverables"),
    attachApqpDeliverable: (number, slot, formData) =>
        postForm("/apqp/" + encodeURIComponent(number)
                + "/deliverables/" + encodeURIComponent(slot), formData),
    removeApqpDeliverable: (number, slot) =>
        request("DELETE", "/apqp/" + encodeURIComponent(number)
                + "/deliverables/" + encodeURIComponent(slot)),

    raiseDi:       (payload) => request("POST", "/di", payload),
    diForms:       (number)  => get("/di/" + encodeURIComponent(number) + "/forms"),
    attachDiForm:  (number, slot, formData) =>
        postForm("/di/" + encodeURIComponent(number)
                + "/forms/" + encodeURIComponent(slot), formData),
    removeDiForm:  (number, slot) =>
        request("DELETE", "/di/" + encodeURIComponent(number)
                + "/forms/" + encodeURIComponent(slot))
};
