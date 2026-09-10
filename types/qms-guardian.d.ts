/**
 * Shared shapes for QMS Guardian.
 *
 * This file has no import/export, so its declarations are GLOBAL: any
 * `// @ts-check` JavaScript file can reference `QmsField`, `ApiError`,
 * etc. from a JSDoc annotation without importing anything.
 *
 * The server is the source of truth for these shapes
 * (server/src/routes/*.js). Keep this in step with `problemWith` in
 * shared/schema.js and the record routes.
 */

// ---------- form schema ----------

type QmsFieldType =
  | "text" | "memo" | "number" | "date" | "select"
  | "link" | "file" | "signature" | "user" | "table" | "boolean";

type QmsColumnType =
  | "text" | "memo" | "number" | "date" | "select" | "computed"
  | "boolean" | "user";

/** One cell type in a repeating-table field. */
interface QmsColumn {
  key: string;
  label: string;
  type: QmsColumnType;
  /** `select` columns only. */
  options?: string[];
  /** `computed` columns only: how the value is derived. */
  compute?: "product" | "sum";
  /** `computed` columns only: keys of the number columns it reads. */
  inputs?: string[];
  /** `computed` columns only: a free arithmetic expression over sibling number columns. */
  expr?: string;
  /** `computed` columns only: amber / red cut-offs (e.g. RPN >= 100, >= 150). */
  thresholds?: { warn?: number; crit?: number };
}

/** One field on a record form, as published in a `form_versions` row. */
interface QmsField {
  key: string;
  label: string;
  type: QmsFieldType;
  required?: boolean;
  /** Starts a new labelled group when it changes between fields. */
  section?: string;
  /** `select` fields only. */
  options?: string[];
  /** `link` fields only: which option list in `QmsFormDefinition.options`. */
  target?: string;
  /** `number` fields only. */
  min?: number;
  /** `number` fields only. */
  max?: number;
  /** `text` fields only: a validation regex source. */
  pattern?: string;
  /** `link` fields targeting another record: optional type-key filter. */
  record_type?: string;
  /** `table` fields only. */
  columns?: QmsColumn[];
  /** `table` fields only: per-row file slots. */
  rowAttachments?: boolean;
}

/** A conditional rule carried on a form version (not editable in-app yet). */
interface QmsRule {
  when?: string;
  then: string;
  role?: string;
  field?: string;
}

/** One selectable option for a `link` or `user` field. */
interface QmsOption {
  value: string;
  label: string;
  disabled?: boolean;
  disabled_reason?: string;
}

/** Response of `GET /api/record-types/:key/form` (api.recordForm). */
interface QmsFormDefinition {
  key: string;
  name: string;
  clause: string | null;
  version: number;
  fields: QmsField[];
  rules: QmsRule[];
  /** Keyed by field `target` ("parts", "gages", "lots") plus "users". */
  options: Record<string, QmsOption[]>;
}

// ---------- records ----------

type QmsSeverity = "ok" | "warn" | "crit";

/** A row of the universal `records` table. */
interface QmsRecord {
  number: string;
  type: string;
  title: string;
  status: string;
  severity: QmsSeverity;
  data: Record<string, unknown>;
  form_version: number;
  due_at: string | null;
  owner: string | null;
  created_at?: string;
  updated_at?: string;
}

interface QmsRecordLink {
  link_type: string;
  direction: "out" | "in";
  number: string;
  title: string;
  status: string;
  severity: QmsSeverity;
  type: string;
}

/** Response of `GET /api/records/:number` (api.record). */
interface QmsRecordDetail {
  record: QmsRecord;
  links: QmsRecordLink[];
  history: Array<Record<string, unknown>>;
  transitions: Array<Record<string, unknown>>;
}

// ---------- errors ----------

/**
 * What `api.*` rejects with on a non-2xx response: a plain `Error`
 * with the server's status and parsed body attached (see api.js).
 */
interface ApiError extends Error {
  status?: number;
  payload?: {
    error?: string;
    fields?: string[];
    detail?: string;
  };
}
