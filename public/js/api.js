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
    readiness:    ()        => get("/dashboard/readiness"),

    recordTypes:  ()        => get("/record-types"),
    recordForm:   (typeKey) => get("/record-types/" + encodeURIComponent(typeKey) + "/form"),
    updateRecordForm: (typeKey, fields) =>
        request("PUT", "/record-types/" + encodeURIComponent(typeKey) + "/form", { fields }),
    records:      (params)  => get(withQuery("/records", params)),
    searchRecords: (q)      => get(withQuery("/records/search", { q })),
    record:       (number)  => get("/records/" + encodeURIComponent(number)),
    createRecord: (payload) => request("POST", "/records", payload),
    updateRecord: (number, payload) =>
        request("PATCH", "/records/" + encodeURIComponent(number), payload),
    transition:   (number, payload) =>
        request("POST", "/records/" + encodeURIComponent(number) + "/transition", payload),

    workOrders:   (params)  => get(withQuery("/work-orders", params)),
    workOrder:    (wo)      => get("/work-orders/" + encodeURIComponent(wo)),
    holdWorkOrder: (wo, payload) =>
        request("POST", "/work-orders/" + encodeURIComponent(wo) + "/hold", payload),
    releaseWorkOrder: (wo, payload) =>
        request("POST", "/work-orders/" + encodeURIComponent(wo) + "/release", payload),

    changeImpact: (number)  => get("/changes/" + encodeURIComponent(number) + "/impact"),
    signImpact:   (number, area, payload) =>
        request("POST", "/changes/" + encodeURIComponent(number)
                + "/impact/" + encodeURIComponent(area) + "/sign", payload),

    drawings:      ()       => get("/drawings"),
    drawing:       (number) => get("/drawings/" + encodeURIComponent(number)),
    releaseDrawing: (number, revision, payload) =>
        request("POST", "/drawings/" + encodeURIComponent(number)
                + "/revisions/" + encodeURIComponent(revision) + "/release", payload),

    receipts:      ()       => get("/receipts"),
    receipt:       (number) => get("/receipts/" + encodeURIComponent(number)),
    dispositionReceipt: (number, payload) =>
        request("POST", "/receipts/" + encodeURIComponent(number) + "/disposition", payload),

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

    onboarding:    ()       => get("/onboarding"),
    onboardingStages: (vendor) => get("/onboarding/" + encodeURIComponent(vendor)),
    completeOnboardingStage: (vendor, stageKey, payload) =>
        request("POST", "/onboarding/" + encodeURIComponent(vendor)
                + "/stages/" + encodeURIComponent(stageKey) + "/complete", payload),

    vendors:      ()        => get("/vendors"),
    gages:        ()        => get("/gages"),
    gageCalibrations: (gageId) => get("/gages/" + encodeURIComponent(gageId) + "/calibrations"),
    recordCalibration: (gageId, payload) =>
        request("POST", "/gages/" + encodeURIComponent(gageId) + "/calibrations", payload),
    documents:    ()        => get("/documents"),
    revisions:    (doc)     => get("/documents/" + encodeURIComponent(doc) + "/revisions"),
    parts:        ()        => get("/parts"),
    lots:         (params)  => get(withQuery("/lots", params)),
    genealogy:    (lot)     => get("/lots/" + encodeURIComponent(lot) + "/genealogy"),

    trainingGaps:   ()      => get("/training/gaps"),
    trainingMatrix: ()      => get("/training/matrix")
};
