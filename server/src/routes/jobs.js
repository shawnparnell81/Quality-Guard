/* ============================================================
   Async export jobs (audit M9). A heavy record export returns 202
   { job_id } instead of the file; these read its status and, once
   done, hand back the bytes. Cross-cutting router - see
   docs/api-conventions.md.
   ============================================================ */

import { Router } from "express";
import { getJob, readJobFile } from "../export-jobs.js";

export const jobs = Router();

jobs.get("/jobs/:id", async (request, response, next) => {
    try {
        const job = await getJob(request.user.org_id, request.user.id, request.params.id);
        if (!job) return response.status(404).json({ error: "No such job" });
        response.json({
            id: job.id,
            kind: job.kind,
            status: job.status,
            ready: job.status === "done" && job.has_file,
            filename: job.filename,
            error: job.error,
            created_at: job.created_at,
            finished_at: job.finished_at,
            download: job.status === "done" ? "/api/jobs/" + job.id + "/download" : null
        });
    } catch (error) {
        next(error);
    }
});

jobs.get("/jobs/:id/download", async (request, response, next) => {
    try {
        const job = await getJob(request.user.org_id, request.user.id, request.params.id);
        if (!job) return response.status(404).json({ error: "No such job" });
        if (job.status === "error") {
            return response.status(422).json({ error: job.error || "The export failed" });
        }
        if (job.status !== "done") {
            return response.status(409).json({ error: "Not ready yet", status: job.status });
        }

        const file = await readJobFile(request.user.org_id, request.user.id, request.params.id);
        if (!file) return response.status(410).json({ error: "The export file is gone" });

        response.setHeader("Content-Type", file.contentType || "application/octet-stream");
        response.setHeader("Content-Disposition",
            'attachment; filename="' + (file.filename || "export") + '"');
        response.send(file.buffer);
    } catch (error) {
        next(error);
    }
});
