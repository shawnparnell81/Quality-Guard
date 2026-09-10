CREATE SCHEMA public;
COMMENT ON SCHEMA public IS 'standard public schema';
CREATE FUNCTION public.log_record_audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
    v_user    uuid;
    v_old     jsonb;
    v_new     jsonb;
    v_old_d   jsonb := '{}'::jsonb;
    v_new_d   jsonb := '{}'::jsonb;
    k         text;
begin
    begin
        v_user := nullif(current_setting('app.user_id', true), '')::uuid;
    exception when others then
        v_user := null;
    end;
    if (tg_op = 'DELETE') then
        insert into record_audit (org_id, record_id, record_number, record_type,
                                  action_type, changed_by, old_values, new_values)
        values (old.org_id, old.id, old.number,
                (select key from record_types where id = old.record_type_id),
                'DELETE', v_user, to_jsonb(old), null);
        return old;
    elsif (tg_op = 'INSERT') then
        insert into record_audit (org_id, record_id, record_number, record_type,
                                  action_type, changed_by, old_values, new_values)
        values (new.org_id, new.id, new.number,
                (select key from record_types where id = new.record_type_id),
                'INSERT', v_user, null, to_jsonb(new));
        return new;
    else
        v_old := to_jsonb(old);
        v_new := to_jsonb(new);
        for k in select jsonb_object_keys(v_new) loop
            if (v_old -> k) is distinct from (v_new -> k) then
                v_old_d := v_old_d || jsonb_build_object(k, v_old -> k);
                v_new_d := v_new_d || jsonb_build_object(k, v_new -> k);
            end if;
        end loop;
        /* nothing actually changed - no audit row */
        if v_new_d = '{}'::jsonb then
            return new;
        end if;
        insert into record_audit (org_id, record_id, record_number, record_type,
                                  action_type, changed_by, old_values, new_values)
        values (new.org_id, new.id, new.number,
                (select key from record_types where id = new.record_type_id),
                'UPDATE', v_user, v_old_d, v_new_d);
        return new;
    end if;
end;
$$;
CREATE FUNCTION public.record_audit_prune(retain_days integer DEFAULT 730) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
declare
    n bigint;
begin
    delete from record_audit ra
     where ra.action_type = 'UPDATE'
       and ra.changed_at < now() - make_interval(days => retain_days)
       and not exists (
           select 1 from records r
            where r.id = ra.record_id and r.closed_at is null
       );
    get diagnostics n = row_count;
    return n;
end;
$$;
CREATE FUNCTION public.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
    new.updated_at := now();
    return new;
end;
$$;
CREATE TABLE public.apqp_deliverables (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    record_id uuid NOT NULL,
    slot text NOT NULL,
    document_id uuid NOT NULL,
    added_by uuid,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT apqp_deliverables_slot_check CHECK ((slot = ANY (ARRAY['process_flow'::text, 'fmea'::text, 'control_plan'::text])))
);
CREATE TABLE public.attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    record_id uuid NOT NULL,
    filename text NOT NULL,
    mime_type text,
    size_bytes bigint,
    storage_key text,
    uploaded_by uuid,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    storage_path text,
    row_ref text,
    CONSTRAINT attachments_has_a_location CHECK (((storage_path IS NOT NULL) OR (storage_key IS NOT NULL)))
);
CREATE TABLE public.audit_log (
    id bigint NOT NULL,
    org_id uuid NOT NULL,
    record_id uuid,
    entity text NOT NULL,
    entity_id uuid,
    field text NOT NULL,
    old_value text,
    new_value text,
    reason text,
    changed_by uuid,
    changed_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE public.audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.audit_log_id_seq OWNED BY public.audit_log.id;
CREATE TABLE public.automation_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    customer_id uuid,
    step text NOT NULL,
    status text NOT NULL,
    run_source text NOT NULL,
    detail text,
    error text,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    record_id uuid,
    lpa_audit_id uuid,
    CONSTRAINT automation_logs_one_subject CHECK ((num_nonnulls(customer_id, record_id, lpa_audit_id) = 1)),
    CONSTRAINT automation_logs_run_source_check CHECK ((run_source = ANY (ARRAY['auto'::text, 'manual'::text]))),
    CONSTRAINT automation_logs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'done'::text, 'failed'::text, 'skipped'::text])))
);
CREATE TABLE public.certifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    site_id uuid,
    standard text NOT NULL,
    registrar text,
    certificate_number text,
    issued_on date,
    expires_on date,
    next_audit_on date,
    audit_type text,
    scope text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT certifications_audit_type_check CHECK ((audit_type = ANY (ARRAY['stage_1'::text, 'stage_2'::text, 'surveillance'::text, 'recertification'::text])))
);
CREATE TABLE public.change_impact_assessments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    record_id uuid NOT NULL,
    area text NOT NULL,
    impact text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    signed_by uuid,
    signed_at timestamp with time zone,
    "position" integer NOT NULL,
    CONSTRAINT change_impact_assessments_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'signed'::text, 'not_applicable'::text])))
);
CREATE TABLE public.customer_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    stage_id uuid,
    category text,
    kind text NOT NULL,
    original_filename text,
    mime_type text,
    size_bytes bigint,
    storage_path text,
    document_id uuid,
    note text,
    uploaded_by uuid,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    folder_id uuid,
    CONSTRAINT customer_documents_category_check CHECK ((category = ANY (ARRAY['quote'::text, 'spec'::text, 'drawing'::text, 'contract'::text, 'correspondence'::text, 'other'::text]))),
    CONSTRAINT customer_documents_kind_check CHECK ((kind = ANY (ARRAY['upload'::text, 'link'::text]))),
    CONSTRAINT customer_documents_target_one CHECK (((((stage_id IS NOT NULL))::integer + ((folder_id IS NOT NULL))::integer) = 1))
);
CREATE TABLE public.customer_folders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    folder_key text NOT NULL,
    name text NOT NULL,
    "position" integer NOT NULL,
    path text,
    storage_path text,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customer_folders_folder_key_check CHECK ((folder_key = ANY (ARRAY['admin'::text, 'quality'::text, 'engineering'::text, 'production'::text, 'supply_chain'::text, 'orders'::text, 'projects'::text]))),
    CONSTRAINT customer_folders_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'created'::text])))
);
CREATE TABLE public.customer_metadata (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    billing_address text,
    shipping_address text,
    contacts jsonb DEFAULT '[]'::jsonb NOT NULL,
    quality_requirements jsonb DEFAULT '{}'::jsonb NOT NULL,
    engineering_requirements jsonb DEFAULT '{}'::jsonb NOT NULL,
    folder_root text,
    synced_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.customer_onboarding_stages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    stage_key text NOT NULL,
    name text NOT NULL,
    detail text,
    status text DEFAULT 'pending'::text NOT NULL,
    completed_by uuid,
    completed_at timestamp with time zone,
    "position" integer NOT NULL,
    CONSTRAINT customer_onboarding_stages_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'complete'::text, 'skipped'::text])))
);
CREATE TABLE public.customers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    code text,
    status text DEFAULT 'prospect'::text NOT NULL,
    primary_contact_name text,
    primary_contact_email text,
    phone text,
    address text,
    notes text,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customers_status_check CHECK ((status = ANY (ARRAY['prospect'::text, 'active'::text, 'inactive'::text])))
);
CREATE TABLE public.di_deliverables (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    record_id uuid NOT NULL,
    slot text NOT NULL,
    document_id uuid NOT NULL,
    added_by uuid,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT di_deliverables_slot_check CHECK ((slot = ANY (ARRAY['ncr'::text, 'eightd'::text, 'capa'::text])))
);
CREATE TABLE public.document_requirements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    role text NOT NULL,
    document_id uuid NOT NULL
);
CREATE TABLE public.document_revisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    revision text NOT NULL,
    change_summary text NOT NULL,
    author_id uuid,
    approved_by uuid,
    effective_date date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    original_filename text,
    mime_type text,
    size_bytes bigint,
    storage_path text,
    body text,
    superseded_at timestamp with time zone
);
COMMENT ON COLUMN public.document_revisions.storage_path IS 'Path under server/storage/documents/ where this revision''s real file lives. Required for every revision created through the API; historical seed revisions predate real file storage and may have none.';
CREATE TABLE public.documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    doc_number text NOT NULL,
    title text NOT NULL,
    owner_id uuid,
    current_revision text,
    status text DEFAULT 'draft'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    record_id uuid,
    category text,
    versioning text DEFAULT 'letter'::text NOT NULL,
    CONSTRAINT documents_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'in_approval'::text, 'released'::text, 'obsolete'::text]))),
    CONSTRAINT documents_versioning_check CHECK ((versioning = ANY (ARRAY['letter'::text, 'numeric'::text])))
);
CREATE TABLE public.drawing_revisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    drawing_id uuid NOT NULL,
    revision text NOT NULL,
    change_summary text NOT NULL,
    ecn_number text,
    status text DEFAULT 'draft'::text NOT NULL,
    released_by uuid,
    released_at timestamp with time zone,
    original_filename text,
    mime_type text,
    size_bytes bigint,
    storage_path text,
    CONSTRAINT drawing_revisions_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'in_review'::text, 'released'::text, 'superseded'::text])))
);
CREATE TABLE public.drawings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    drawing_number text NOT NULL,
    title text NOT NULL,
    part_id uuid,
    customer text,
    current_revision text,
    status text DEFAULT 'released'::text NOT NULL,
    access_level text DEFAULT 'eng_qa'::text NOT NULL,
    owner_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT drawings_access_level_check CHECK ((access_level = ANY (ARRAY['all_plant'::text, 'eng_qa'::text, 'eng_only'::text]))),
    CONSTRAINT drawings_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'in_review'::text, 'released'::text, 'obsolete'::text])))
);
CREATE TABLE public.export_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    requested_by uuid,
    kind text NOT NULL,
    params jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    filename text,
    content_type text,
    storage_path text,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    CONSTRAINT export_jobs_kind_check CHECK ((kind = ANY (ARRAY['record_pdf'::text, 'record_excel'::text]))),
    CONSTRAINT export_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'done'::text, 'error'::text])))
);
CREATE TABLE public.first_article_results (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    work_order_id uuid NOT NULL,
    characteristic_no integer NOT NULL,
    specification text NOT NULL,
    actual text,
    result text,
    gage_id text,
    measured_by uuid,
    measured_at timestamp with time zone,
    CONSTRAINT first_article_results_result_check CHECK ((result = ANY (ARRAY['pass'::text, 'fail'::text])))
);
CREATE TABLE public.form_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    record_type_id uuid NOT NULL,
    version integer NOT NULL,
    schema jsonb NOT NULL,
    published_at timestamp with time zone,
    published_by uuid,
    excel_map jsonb
);
CREATE TABLE public.gage_calibrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    gage_id uuid NOT NULL,
    performed_at timestamp with time zone DEFAULT now() NOT NULL,
    performed_by uuid,
    result text NOT NULL,
    reading text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    performed_on date,
    cal_supplier text,
    as_found text,
    as_left text,
    standard_used text,
    certificate_path text,
    certificate_filename text,
    CONSTRAINT gage_calibrations_result_check CHECK ((result = ANY (ARRAY['pass'::text, 'fail'::text])))
);
CREATE TABLE public.gages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    gage_id text NOT NULL,
    description text NOT NULL,
    range_text text,
    interval_months integer NOT NULL,
    last_cal date,
    next_due date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    availability text DEFAULT 'available'::text NOT NULL,
    manufacturer text,
    model text,
    serial_number text,
    location text,
    cal_supplier text,
    CONSTRAINT gages_availability_check CHECK ((availability = ANY (ARRAY['available'::text, 'hold'::text, 'retired'::text])))
);
CREATE TABLE public.imported_forms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    original_name text,
    storage_path text NOT NULL,
    schema jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'inferred'::text NOT NULL,
    applied_key text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT imported_forms_status_check CHECK ((status = ANY (ARRAY['inferred'::text, 'applied'::text])))
);
CREATE TABLE public.lots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    lot_number text NOT NULL,
    part_id uuid,
    parent_lot_id uuid,
    heat_number text,
    qty integer DEFAULT 0 NOT NULL,
    location text,
    status text DEFAULT 'released'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT lots_status_check CHECK ((status = ANY (ARRAY['released'::text, 'on_hold'::text, 'quarantine'::text, 'scrapped'::text, 'shipped'::text])))
);
CREATE TABLE public.lpa_answers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    audit_id uuid NOT NULL,
    question_id uuid NOT NULL,
    result text NOT NULL,
    note text,
    ncr_number text,
    answered_by uuid,
    answered_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT lpa_answers_result_check CHECK ((result = ANY (ARRAY['pass'::text, 'fail'::text, 'na'::text])))
);
CREATE TABLE public.lpa_audits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    schedule_id uuid,
    template_id uuid NOT NULL,
    layer text NOT NULL,
    area text NOT NULL,
    auditor_id uuid,
    due_on date NOT NULL,
    performed_on date,
    status text DEFAULT 'scheduled'::text NOT NULL,
    score_pass integer DEFAULT 0 NOT NULL,
    score_total integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    folder_root text,
    CONSTRAINT lpa_audits_status_check CHECK ((status = ANY (ARRAY['scheduled'::text, 'in_progress'::text, 'complete'::text, 'missed'::text])))
);
CREATE TABLE public.lpa_questions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    template_id uuid NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    text text NOT NULL,
    guidance text,
    critical boolean DEFAULT false NOT NULL
);
CREATE TABLE public.lpa_schedules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    template_id uuid NOT NULL,
    layer text NOT NULL,
    area text NOT NULL,
    auditor_id uuid,
    frequency_days integer NOT NULL,
    next_due date NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT lpa_schedules_frequency_days_check CHECK (((frequency_days >= 1) AND (frequency_days <= 365)))
);
CREATE TABLE public.lpa_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    active boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.management_review_actions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    review_id uuid NOT NULL,
    decision text NOT NULL,
    owner_id uuid,
    due_on date,
    status text DEFAULT 'open'::text NOT NULL,
    "position" integer NOT NULL,
    linked_record text,
    CONSTRAINT management_review_actions_status_check CHECK ((status = ANY (ARRAY['open'::text, 'in_progress'::text, 'done'::text, 'dropped'::text])))
);
CREATE TABLE public.management_review_attendance (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    review_id uuid NOT NULL,
    name text NOT NULL,
    role text,
    present boolean DEFAULT true NOT NULL,
    "position" integer DEFAULT 0 NOT NULL
);
CREATE TABLE public.management_reviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    reference text NOT NULL,
    period text NOT NULL,
    held_on date,
    chair_id uuid,
    status text DEFAULT 'planned'::text NOT NULL,
    notes text,
    CONSTRAINT management_reviews_status_check CHECK ((status = ANY (ARRAY['planned'::text, 'in_progress'::text, 'closed'::text])))
);
CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    user_id uuid NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    body text,
    link_type text,
    link_number text,
    dedupe_key text,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notifications_kind_check CHECK ((kind = ANY (ARRAY['assigned'::text, 'overdue'::text, 'approval'::text, 'finding'::text])))
);
CREATE TABLE public.org_layouts (
    org_id uuid NOT NULL,
    kind text NOT NULL,
    layout jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT org_layouts_kind_check CHECK ((kind = ANY (ARRAY['dashboard'::text, 'nav'::text])))
);
CREATE TABLE public.organizations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    onboarded_at timestamp with time zone,
    standards jsonb DEFAULT '[]'::jsonb NOT NULL
);
CREATE TABLE public.parts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    part_number text NOT NULL,
    description text NOT NULL,
    revision text NOT NULL,
    customer text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.permissions (
    key text NOT NULL,
    resource text NOT NULL,
    action text NOT NULL,
    description text NOT NULL,
    clause text
);
CREATE TABLE public.ppap_elements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    record_id uuid NOT NULL,
    element integer NOT NULL,
    reference text,
    note text,
    not_applicable boolean DEFAULT false NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ppap_elements_element_check CHECK (((element >= 1) AND (element <= 18)))
);
CREATE TABLE public.presence (
    org_id uuid NOT NULL,
    record_number text NOT NULL,
    user_id uuid NOT NULL,
    user_name text NOT NULL,
    dirty boolean DEFAULT false NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.production_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    pl_number text NOT NULL,
    wo_number text,
    customer text,
    customer_po text,
    part_number text,
    revision text,
    status text DEFAULT 'scheduled'::text NOT NULL,
    order_date date,
    promised_date date,
    qty_ordered integer,
    qty_completed integer,
    qty_scrapped integer,
    qty_shipped integer,
    line text,
    notes text,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT production_logs_status_check CHECK ((status = ANY (ARRAY['scheduled'::text, 'in_production'::text, 'hold'::text, 'shipped'::text, 'closed'::text, 'cancelled'::text])))
);
CREATE TABLE public.purchase_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    po_number text NOT NULL,
    vendor_id uuid,
    vendor_name text,
    status text DEFAULT 'open'::text NOT NULL,
    order_date date,
    need_by_date date,
    total_amount numeric(14,2),
    currency text DEFAULT 'USD'::text NOT NULL,
    buyer_id uuid,
    notes text,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT purchase_orders_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'open'::text, 'partially_received'::text, 'received'::text, 'closed'::text, 'cancelled'::text])))
);
CREATE TABLE public.purchase_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    pr_number text NOT NULL,
    requested_by uuid,
    department text,
    status text DEFAULT 'submitted'::text NOT NULL,
    needed_by_date date,
    estimated_cost numeric(14,2),
    description text,
    po_number text,
    notes text,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT purchase_requests_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'submitted'::text, 'approved'::text, 'rejected'::text, 'ordered'::text, 'closed'::text])))
);
CREATE TABLE public.quality_objectives (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    clause text,
    target_value numeric(12,2) NOT NULL,
    unit text,
    direction text NOT NULL,
    source text,
    stored_actual numeric(12,2),
    owner_id uuid,
    period text,
    "position" integer NOT NULL,
    CONSTRAINT quality_objectives_direction_check CHECK ((direction = ANY (ARRAY['min'::text, 'max'::text])))
);
CREATE TABLE public.receipt_measurements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    receipt_id uuid NOT NULL,
    characteristic text NOT NULL,
    specification text,
    actual text,
    result text,
    gage_id text,
    "position" integer NOT NULL,
    CONSTRAINT receipt_measurements_result_check CHECK ((result = ANY (ARRAY['pass'::text, 'fail'::text])))
);
CREATE TABLE public.receipts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    receipt_number text NOT NULL,
    po_number text,
    vendor_id uuid,
    part_number text,
    lot_id uuid,
    qty_received integer DEFAULT 0 NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    sample_plan text,
    status text DEFAULT 'pending'::text NOT NULL,
    inspected_by uuid,
    inspected_at timestamp with time zone,
    notes text,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    quarantined boolean DEFAULT false NOT NULL,
    ncr_number text,
    CONSTRAINT receipts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accept'::text, 'reject'::text])))
);
CREATE TABLE public.record_audit (
    id bigint NOT NULL,
    org_id uuid,
    record_id uuid NOT NULL,
    record_number text,
    record_type text,
    action_type text NOT NULL,
    changed_by uuid,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    old_values jsonb,
    new_values jsonb,
    CONSTRAINT record_audit_action_type_check CHECK ((action_type = ANY (ARRAY['INSERT'::text, 'UPDATE'::text, 'DELETE'::text])))
);
CREATE SEQUENCE public.record_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.record_audit_id_seq OWNED BY public.record_audit.id;
CREATE TABLE public.record_drafts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    user_id uuid NOT NULL,
    draft_key text NOT NULL,
    snapshot jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.record_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    from_record_id uuid NOT NULL,
    to_record_id uuid NOT NULL,
    link_type text DEFAULT 'related'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT record_links_check CHECK ((from_record_id <> to_record_id)),
    CONSTRAINT record_links_link_type_check CHECK ((link_type = ANY (ARRAY['related'::text, 'caused_by'::text, 'corrects'::text, 'supersedes'::text, 'child_of'::text])))
);
CREATE TABLE public.record_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    prefix text NOT NULL,
    clause text,
    active boolean DEFAULT true NOT NULL
);
CREATE TABLE public.records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    site_id uuid,
    record_type_id uuid NOT NULL,
    number text NOT NULL,
    title text NOT NULL,
    status text NOT NULL,
    severity text DEFAULT 'ok'::text NOT NULL,
    owner_id uuid,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    form_version integer DEFAULT 1 NOT NULL,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    due_at timestamp with time zone,
    closed_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    idempotency_key text,
    CONSTRAINT records_severity_check CHECK ((severity = ANY (ARRAY['ok'::text, 'warn'::text, 'crit'::text])))
);
CREATE TABLE public.review_chart_points (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    chart_id uuid NOT NULL,
    label text NOT NULL,
    value numeric(14,4) DEFAULT 0 NOT NULL,
    "position" integer DEFAULT 0 NOT NULL
);
CREATE TABLE public.review_charts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    review_id uuid NOT NULL,
    title text NOT NULL,
    chart_type text NOT NULL,
    x_label text,
    y_label text,
    "position" integer DEFAULT 0 NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT review_charts_chart_type_check CHECK ((chart_type = ANY (ARRAY['bar'::text, 'line'::text, 'pareto'::text])))
);
CREATE TABLE public.role_permissions (
    role_key text NOT NULL,
    permission_key text NOT NULL,
    org_id uuid NOT NULL
);
COMMENT ON COLUMN public.role_permissions.org_id IS 'Denormalized from roles.org_id so this table can be queried and
     locked down (org_id = $1) without a join back to roles first.';
CREATE TABLE public.roles (
    key text NOT NULL,
    name text NOT NULL,
    description text,
    "position" integer NOT NULL,
    org_id uuid NOT NULL
);
COMMENT ON COLUMN public.roles.org_id IS 'Each company keeps its own copy of the role list, so changing one
     company''s permission matrix can never affect another''s.';
CREATE TABLE public.sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    ip text,
    user_agent text
);
CREATE TABLE public.shipment_checks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shipment_id uuid NOT NULL,
    description text NOT NULL,
    evidence text,
    status text DEFAULT 'pending'::text NOT NULL,
    "position" integer NOT NULL,
    CONSTRAINT shipment_checks_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'pass'::text, 'fail'::text])))
);
CREATE TABLE public.shipments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    shipment_number text NOT NULL,
    customer text NOT NULL,
    part_number text,
    lot_id uuid,
    qty integer DEFAULT 0 NOT NULL,
    ship_date date,
    carrier text,
    status text DEFAULT 'preparing'::text NOT NULL,
    released_by uuid,
    released_at timestamp with time zone,
    CONSTRAINT shipments_status_check CHECK ((status = ANY (ARRAY['preparing'::text, 'awaiting_release'::text, 'shipped'::text, 'blocked'::text])))
);
CREATE TABLE public.sites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL
);
CREATE TABLE public.training_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    user_id uuid NOT NULL,
    document_id uuid NOT NULL,
    revision_trained text NOT NULL,
    trained_on date NOT NULL,
    next_review date,
    trained_by uuid,
    evidence_path text,
    evidence_filename text,
    notes text
);
CREATE TABLE public.turtle_diagrams (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    department text NOT NULL,
    process_name text NOT NULL,
    process_desc text,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.turtle_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    diagram_id uuid NOT NULL,
    side text NOT NULL,
    text text NOT NULL,
    document_id uuid,
    "position" integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT turtle_entries_side_check CHECK ((side = ANY (ARRAY['inputs'::text, 'outputs'::text, 'resources'::text, 'people'::text, 'methods'::text, 'metrics'::text])))
);
CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    email text NOT NULL,
    full_name text NOT NULL,
    initials text NOT NULL,
    role text NOT NULL,
    discipline text,
    job_title text,
    password_hash text,
    password_salt text,
    must_change_password boolean DEFAULT false NOT NULL,
    last_login_at timestamp with time zone,
    failed_attempts integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    active boolean DEFAULT true NOT NULL,
    deactivated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    email_notifications text DEFAULT 'off'::text NOT NULL,
    CONSTRAINT users_email_notifications_check CHECK ((email_notifications = ANY (ARRAY['off'::text, 'immediate'::text, 'digest'::text])))
);
CREATE TABLE public.vendor_evaluations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vendor_id uuid NOT NULL,
    audit_date date NOT NULL,
    performance_score numeric(5,2),
    non_conformance_count integer DEFAULT 0 NOT NULL,
    notes text,
    evaluated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.vendor_onboarding_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    stage_id uuid NOT NULL,
    kind text NOT NULL,
    original_filename text,
    mime_type text,
    size_bytes bigint,
    storage_path text,
    document_id uuid,
    note text,
    uploaded_by uuid,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vendor_onboarding_documents_kind_check CHECK ((kind = ANY (ARRAY['upload'::text, 'link'::text])))
);
CREATE TABLE public.vendor_onboarding_stages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vendor_id uuid NOT NULL,
    stage_key text NOT NULL,
    name text NOT NULL,
    detail text,
    status text DEFAULT 'pending'::text NOT NULL,
    completed_by uuid,
    completed_at timestamp with time zone,
    "position" integer NOT NULL,
    CONSTRAINT vendor_onboarding_stages_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'complete'::text, 'skipped'::text])))
);
CREATE TABLE public.vendors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    scope text NOT NULL,
    cert_type text,
    cert_expires date,
    otd_pct numeric(5,2),
    ppm integer,
    grade character(1),
    status text DEFAULT 'approved'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vendors_grade_check CHECK ((grade = ANY (ARRAY['A'::bpchar, 'B'::bpchar, 'C'::bpchar, 'D'::bpchar]))),
    CONSTRAINT vendors_status_check CHECK ((status = ANY (ARRAY['approved'::text, 'on_watch'::text, 'scar_open'::text, 'onboarding'::text, 'suspended'::text])))
);
CREATE TABLE public.work_order_operations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    work_order_id uuid NOT NULL,
    op_number text NOT NULL,
    description text NOT NULL,
    operator_id uuid,
    status text DEFAULT 'planned'::text NOT NULL,
    completed_at timestamp with time zone,
    notes text,
    "position" integer NOT NULL,
    CONSTRAINT work_order_operations_status_check CHECK ((status = ANY (ARRAY['planned'::text, 'running'::text, 'pass'::text, 'fail'::text, 'blocked'::text])))
);
CREATE TABLE public.work_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    wo_number text NOT NULL,
    part_id uuid,
    lot_id uuid,
    qty integer NOT NULL,
    current_op text,
    total_ops text,
    cell text,
    status text DEFAULT 'running'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    hold_reason text,
    held_by uuid,
    held_at timestamp with time zone,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT work_orders_status_check CHECK ((status = ANY (ARRAY['planned'::text, 'running'::text, 'quality_hold'::text, 'mrb_hold'::text, 'complete'::text])))
);
CREATE TABLE public.workflow_states (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    record_type_id uuid NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    "position" integer NOT NULL,
    is_terminal boolean DEFAULT false NOT NULL
);
CREATE TABLE public.workflow_transitions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    record_type_id uuid NOT NULL,
    from_state text NOT NULL,
    to_state text NOT NULL,
    required_permission text
);
COMMENT ON COLUMN public.workflow_transitions.required_permission IS 'Permission key the actor must hold to make this move.';
ALTER TABLE ONLY public.audit_log ALTER COLUMN id SET DEFAULT nextval('public.audit_log_id_seq'::regclass);
ALTER TABLE ONLY public.record_audit ALTER COLUMN id SET DEFAULT nextval('public.record_audit_id_seq'::regclass);
ALTER TABLE ONLY public.apqp_deliverables
    ADD CONSTRAINT apqp_deliverables_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.apqp_deliverables
    ADD CONSTRAINT apqp_deliverables_record_id_slot_key UNIQUE (record_id, slot);
ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.automation_logs
    ADD CONSTRAINT automation_logs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.certifications
    ADD CONSTRAINT certifications_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.change_impact_assessments
    ADD CONSTRAINT change_impact_assessments_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.change_impact_assessments
    ADD CONSTRAINT change_impact_assessments_record_id_area_key UNIQUE (record_id, area);
ALTER TABLE ONLY public.customer_documents
    ADD CONSTRAINT customer_documents_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.customer_folders
    ADD CONSTRAINT customer_folders_customer_id_folder_key_key UNIQUE (customer_id, folder_key);
ALTER TABLE ONLY public.customer_folders
    ADD CONSTRAINT customer_folders_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.customer_metadata
    ADD CONSTRAINT customer_metadata_customer_id_key UNIQUE (customer_id);
ALTER TABLE ONLY public.customer_metadata
    ADD CONSTRAINT customer_metadata_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.customer_onboarding_stages
    ADD CONSTRAINT customer_onboarding_stages_customer_id_stage_key_key UNIQUE (customer_id, stage_key);
ALTER TABLE ONLY public.customer_onboarding_stages
    ADD CONSTRAINT customer_onboarding_stages_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_org_id_name_key UNIQUE (org_id, name);
ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.di_deliverables
    ADD CONSTRAINT di_deliverables_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.di_deliverables
    ADD CONSTRAINT di_deliverables_record_id_slot_key UNIQUE (record_id, slot);
ALTER TABLE ONLY public.document_requirements
    ADD CONSTRAINT document_requirements_org_id_role_document_id_key UNIQUE (org_id, role, document_id);
ALTER TABLE ONLY public.document_requirements
    ADD CONSTRAINT document_requirements_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.document_revisions
    ADD CONSTRAINT document_revisions_document_id_revision_key UNIQUE (document_id, revision);
ALTER TABLE ONLY public.document_revisions
    ADD CONSTRAINT document_revisions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_org_id_doc_number_key UNIQUE (org_id, doc_number);
ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.drawing_revisions
    ADD CONSTRAINT drawing_revisions_drawing_id_revision_key UNIQUE (drawing_id, revision);
ALTER TABLE ONLY public.drawing_revisions
    ADD CONSTRAINT drawing_revisions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.drawings
    ADD CONSTRAINT drawings_org_id_drawing_number_key UNIQUE (org_id, drawing_number);
ALTER TABLE ONLY public.drawings
    ADD CONSTRAINT drawings_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.export_jobs
    ADD CONSTRAINT export_jobs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.first_article_results
    ADD CONSTRAINT first_article_results_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.first_article_results
    ADD CONSTRAINT first_article_results_work_order_id_characteristic_no_key UNIQUE (work_order_id, characteristic_no);
ALTER TABLE ONLY public.form_versions
    ADD CONSTRAINT form_versions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.form_versions
    ADD CONSTRAINT form_versions_record_type_id_version_key UNIQUE (record_type_id, version);
ALTER TABLE ONLY public.gage_calibrations
    ADD CONSTRAINT gage_calibrations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.gages
    ADD CONSTRAINT gages_org_id_gage_id_key UNIQUE (org_id, gage_id);
ALTER TABLE ONLY public.gages
    ADD CONSTRAINT gages_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.imported_forms
    ADD CONSTRAINT imported_forms_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.lots
    ADD CONSTRAINT lots_org_id_lot_number_key UNIQUE (org_id, lot_number);
ALTER TABLE ONLY public.lots
    ADD CONSTRAINT lots_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.lpa_answers
    ADD CONSTRAINT lpa_answers_audit_id_question_id_key UNIQUE (audit_id, question_id);
ALTER TABLE ONLY public.lpa_answers
    ADD CONSTRAINT lpa_answers_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.lpa_audits
    ADD CONSTRAINT lpa_audits_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.lpa_questions
    ADD CONSTRAINT lpa_questions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.lpa_schedules
    ADD CONSTRAINT lpa_schedules_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.lpa_templates
    ADD CONSTRAINT lpa_templates_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.management_review_actions
    ADD CONSTRAINT management_review_actions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.management_review_attendance
    ADD CONSTRAINT management_review_attendance_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.management_reviews
    ADD CONSTRAINT management_reviews_org_id_reference_key UNIQUE (org_id, reference);
ALTER TABLE ONLY public.management_reviews
    ADD CONSTRAINT management_reviews_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.org_layouts
    ADD CONSTRAINT org_layouts_pkey PRIMARY KEY (org_id, kind);
ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.parts
    ADD CONSTRAINT parts_org_id_part_number_key UNIQUE (org_id, part_number);
ALTER TABLE ONLY public.parts
    ADD CONSTRAINT parts_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_pkey PRIMARY KEY (key);
ALTER TABLE ONLY public.ppap_elements
    ADD CONSTRAINT ppap_elements_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.ppap_elements
    ADD CONSTRAINT ppap_elements_record_id_element_key UNIQUE (record_id, element);
ALTER TABLE ONLY public.presence
    ADD CONSTRAINT presence_pkey PRIMARY KEY (org_id, record_number, user_id);
ALTER TABLE ONLY public.production_logs
    ADD CONSTRAINT production_logs_org_id_pl_number_key UNIQUE (org_id, pl_number);
ALTER TABLE ONLY public.production_logs
    ADD CONSTRAINT production_logs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_org_id_po_number_key UNIQUE (org_id, po_number);
ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.purchase_requests
    ADD CONSTRAINT purchase_requests_org_id_pr_number_key UNIQUE (org_id, pr_number);
ALTER TABLE ONLY public.purchase_requests
    ADD CONSTRAINT purchase_requests_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.quality_objectives
    ADD CONSTRAINT quality_objectives_org_id_name_key UNIQUE (org_id, name);
ALTER TABLE ONLY public.quality_objectives
    ADD CONSTRAINT quality_objectives_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.receipt_measurements
    ADD CONSTRAINT receipt_measurements_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.receipts
    ADD CONSTRAINT receipts_org_id_receipt_number_key UNIQUE (org_id, receipt_number);
ALTER TABLE ONLY public.receipts
    ADD CONSTRAINT receipts_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.record_audit
    ADD CONSTRAINT record_audit_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.record_drafts
    ADD CONSTRAINT record_drafts_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.record_drafts
    ADD CONSTRAINT record_drafts_user_id_draft_key_key UNIQUE (user_id, draft_key);
ALTER TABLE ONLY public.record_links
    ADD CONSTRAINT record_links_from_record_id_to_record_id_link_type_key UNIQUE (from_record_id, to_record_id, link_type);
ALTER TABLE ONLY public.record_links
    ADD CONSTRAINT record_links_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.record_types
    ADD CONSTRAINT record_types_org_id_key_key UNIQUE (org_id, key);
ALTER TABLE ONLY public.record_types
    ADD CONSTRAINT record_types_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.records
    ADD CONSTRAINT records_org_id_number_key UNIQUE (org_id, number);
ALTER TABLE ONLY public.records
    ADD CONSTRAINT records_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.review_chart_points
    ADD CONSTRAINT review_chart_points_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.review_charts
    ADD CONSTRAINT review_charts_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (org_id, role_key, permission_key);
ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (org_id, key);
ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.shipment_checks
    ADD CONSTRAINT shipment_checks_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.shipments
    ADD CONSTRAINT shipments_org_id_shipment_number_key UNIQUE (org_id, shipment_number);
ALTER TABLE ONLY public.shipments
    ADD CONSTRAINT shipments_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.sites
    ADD CONSTRAINT sites_org_id_code_key UNIQUE (org_id, code);
ALTER TABLE ONLY public.sites
    ADD CONSTRAINT sites_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.training_records
    ADD CONSTRAINT training_records_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.training_records
    ADD CONSTRAINT training_records_user_id_document_id_key UNIQUE (user_id, document_id);
ALTER TABLE ONLY public.turtle_diagrams
    ADD CONSTRAINT turtle_diagrams_org_id_department_key UNIQUE (org_id, department);
ALTER TABLE ONLY public.turtle_diagrams
    ADD CONSTRAINT turtle_diagrams_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.turtle_entries
    ADD CONSTRAINT turtle_entries_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.vendor_evaluations
    ADD CONSTRAINT vendor_evaluations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.vendor_onboarding_documents
    ADD CONSTRAINT vendor_onboarding_documents_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.vendor_onboarding_stages
    ADD CONSTRAINT vendor_onboarding_stages_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.vendor_onboarding_stages
    ADD CONSTRAINT vendor_onboarding_stages_vendor_id_stage_key_key UNIQUE (vendor_id, stage_key);
ALTER TABLE ONLY public.vendors
    ADD CONSTRAINT vendors_org_id_name_key UNIQUE (org_id, name);
ALTER TABLE ONLY public.vendors
    ADD CONSTRAINT vendors_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.work_order_operations
    ADD CONSTRAINT work_order_operations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.work_order_operations
    ADD CONSTRAINT work_order_operations_work_order_id_op_number_key UNIQUE (work_order_id, op_number);
ALTER TABLE ONLY public.work_orders
    ADD CONSTRAINT work_orders_org_id_wo_number_key UNIQUE (org_id, wo_number);
ALTER TABLE ONLY public.work_orders
    ADD CONSTRAINT work_orders_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.workflow_states
    ADD CONSTRAINT workflow_states_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.workflow_states
    ADD CONSTRAINT workflow_states_record_type_id_key_key UNIQUE (record_type_id, key);
ALTER TABLE ONLY public.workflow_transitions
    ADD CONSTRAINT workflow_transitions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.workflow_transitions
    ADD CONSTRAINT workflow_transitions_record_type_id_from_state_to_state_key UNIQUE (record_type_id, from_state, to_state);
CREATE INDEX idx_apqp_deliverables ON public.apqp_deliverables USING btree (record_id);
CREATE INDEX idx_attachments_row_ref ON public.attachments USING btree (record_id, row_ref) WHERE (row_ref IS NOT NULL);
CREATE INDEX idx_audit_entity ON public.audit_log USING btree (entity, entity_id);
CREATE INDEX idx_audit_record ON public.audit_log USING btree (record_id, changed_at DESC);
CREATE INDEX idx_automation_logs_customer ON public.automation_logs USING btree (customer_id, step, created_at DESC);
CREATE INDEX idx_automation_logs_lpa_audit ON public.automation_logs USING btree (lpa_audit_id, step, created_at DESC) WHERE (lpa_audit_id IS NOT NULL);
CREATE INDEX idx_automation_logs_record ON public.automation_logs USING btree (record_id, step, created_at DESC) WHERE (record_id IS NOT NULL);
CREATE INDEX idx_cert_next_audit ON public.certifications USING btree (org_id, next_audit_on);
CREATE INDEX idx_customer_documents_customer ON public.customer_documents USING btree (customer_id);
CREATE INDEX idx_customer_documents_stage ON public.customer_documents USING btree (stage_id);
CREATE INDEX idx_customer_folders_customer ON public.customer_folders USING btree (customer_id, "position");
CREATE INDEX idx_customer_stages ON public.customer_onboarding_stages USING btree (customer_id, "position");
CREATE UNIQUE INDEX idx_customers_code ON public.customers USING btree (org_id, code) WHERE (code IS NOT NULL);
CREATE INDEX idx_customers_org_status ON public.customers USING btree (org_id, status);
CREATE INDEX idx_di_deliverables ON public.di_deliverables USING btree (record_id);
CREATE INDEX idx_docreq_role ON public.document_requirements USING btree (org_id, role);
CREATE INDEX idx_docrev_document ON public.document_revisions USING btree (document_id);
CREATE INDEX idx_documents_category ON public.documents USING btree (org_id, category);
CREATE INDEX idx_drawing_revs ON public.drawing_revisions USING btree (drawing_id);
CREATE INDEX idx_export_jobs_claim ON public.export_jobs USING btree (created_at) WHERE (status = 'queued'::text);
CREATE INDEX idx_export_jobs_org ON public.export_jobs USING btree (org_id, created_at DESC);
CREATE INDEX idx_fai_order ON public.first_article_results USING btree (work_order_id, characteristic_no);
CREATE INDEX idx_gage_calibrations_gage ON public.gage_calibrations USING btree (gage_id, performed_at DESC);
CREATE INDEX idx_gages_due ON public.gages USING btree (org_id, next_due);
CREATE INDEX idx_impact_record ON public.change_impact_assessments USING btree (record_id, "position");
CREATE INDEX idx_imported_forms_org ON public.imported_forms USING btree (org_id, created_at DESC);
CREATE INDEX idx_links_from ON public.record_links USING btree (from_record_id);
CREATE INDEX idx_links_to ON public.record_links USING btree (to_record_id);
CREATE INDEX idx_lots_parent ON public.lots USING btree (parent_lot_id);
CREATE INDEX idx_lots_part ON public.lots USING btree (part_id);
CREATE INDEX idx_lpa_answers ON public.lpa_answers USING btree (audit_id);
CREATE INDEX idx_lpa_audits ON public.lpa_audits USING btree (org_id, status, due_on);
CREATE INDEX idx_lpa_questions ON public.lpa_questions USING btree (template_id, "position");
CREATE INDEX idx_lpa_schedules ON public.lpa_schedules USING btree (org_id, active, next_due);
CREATE INDEX idx_onboarding ON public.vendor_onboarding_stages USING btree (vendor_id, "position");
CREATE INDEX idx_onboarding_docs ON public.vendor_onboarding_documents USING btree (stage_id);
CREATE INDEX idx_ppap_elements ON public.ppap_elements USING btree (record_id, element);
CREATE INDEX idx_presence_sweep ON public.presence USING btree (last_seen_at);
CREATE INDEX idx_production_logs_org ON public.production_logs USING btree (org_id, status, order_date DESC);
CREATE INDEX idx_production_logs_wo ON public.production_logs USING btree (org_id, wo_number);
CREATE INDEX idx_purchase_orders_org ON public.purchase_orders USING btree (org_id, status, order_date DESC);
CREATE INDEX idx_purchase_requests_org ON public.purchase_requests USING btree (org_id, status, created_at DESC);
CREATE INDEX idx_receipt_meas ON public.receipt_measurements USING btree (receipt_id, "position");
CREATE INDEX idx_record_audit_org ON public.record_audit USING btree (org_id, changed_at DESC);
CREATE INDEX idx_record_audit_row ON public.record_audit USING btree (record_id, changed_at DESC);
CREATE INDEX idx_record_drafts_key ON public.record_drafts USING btree (org_id, draft_key);
CREATE INDEX idx_record_drafts_user ON public.record_drafts USING btree (user_id);
CREATE INDEX idx_records_data_gin ON public.records USING gin (data);
CREATE INDEX idx_records_due ON public.records USING btree (due_at) WHERE (closed_at IS NULL);
CREATE INDEX idx_records_org_type ON public.records USING btree (org_id, record_type_id);
CREATE INDEX idx_records_severity ON public.records USING btree (org_id, severity);
CREATE INDEX idx_records_status ON public.records USING btree (org_id, status);
CREATE INDEX idx_review_acts ON public.management_review_actions USING btree (review_id, "position");
CREATE INDEX idx_review_attendance ON public.management_review_attendance USING btree (review_id, "position");
CREATE INDEX idx_review_chart_points ON public.review_chart_points USING btree (chart_id, "position");
CREATE INDEX idx_review_charts ON public.review_charts USING btree (review_id, "position");
CREATE INDEX idx_sessions_live ON public.sessions USING btree (expires_at) WHERE (revoked_at IS NULL);
CREATE INDEX idx_sessions_user ON public.sessions USING btree (user_id);
CREATE INDEX idx_ship_checks ON public.shipment_checks USING btree (shipment_id, "position");
CREATE INDEX idx_training_user ON public.training_records USING btree (user_id);
CREATE INDEX idx_turtle_entries ON public.turtle_entries USING btree (diagram_id, side, "position");
CREATE INDEX idx_vendor_evaluations_vendor ON public.vendor_evaluations USING btree (vendor_id, audit_date DESC);
CREATE INDEX idx_wo_ops_order ON public.work_order_operations USING btree (work_order_id, "position");
CREATE UNIQUE INDEX notifications_dedupe ON public.notifications USING btree (user_id, dedupe_key) WHERE ((dedupe_key IS NOT NULL) AND (read_at IS NULL));
CREATE INDEX notifications_user_feed ON public.notifications USING btree (user_id, read_at, created_at DESC);
CREATE UNIQUE INDEX records_org_idempotency_key ON public.records USING btree (org_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);
CREATE TRIGGER record_drafts_touch BEFORE UPDATE ON public.record_drafts FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER records_touch BEFORE UPDATE ON public.records FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER trg_record_audit AFTER INSERT OR DELETE OR UPDATE ON public.records FOR EACH ROW EXECUTE FUNCTION public.log_record_audit();
ALTER TABLE ONLY public.apqp_deliverables
    ADD CONSTRAINT apqp_deliverables_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.apqp_deliverables
    ADD CONSTRAINT apqp_deliverables_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.apqp_deliverables
    ADD CONSTRAINT apqp_deliverables_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.apqp_deliverables
    ADD CONSTRAINT apqp_deliverables_record_id_fkey FOREIGN KEY (record_id) REFERENCES public.records(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_record_id_fkey FOREIGN KEY (record_id) REFERENCES public.records(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_record_id_fkey FOREIGN KEY (record_id) REFERENCES public.records(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.automation_logs
    ADD CONSTRAINT automation_logs_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.automation_logs
    ADD CONSTRAINT automation_logs_lpa_audit_id_fkey FOREIGN KEY (lpa_audit_id) REFERENCES public.lpa_audits(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.automation_logs
    ADD CONSTRAINT automation_logs_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.automation_logs
    ADD CONSTRAINT automation_logs_record_id_fkey FOREIGN KEY (record_id) REFERENCES public.records(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.certifications
    ADD CONSTRAINT certifications_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.certifications
    ADD CONSTRAINT certifications_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.change_impact_assessments
    ADD CONSTRAINT change_impact_assessments_record_id_fkey FOREIGN KEY (record_id) REFERENCES public.records(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.change_impact_assessments
    ADD CONSTRAINT change_impact_assessments_signed_by_fkey FOREIGN KEY (signed_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.customer_documents
    ADD CONSTRAINT customer_documents_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.customer_documents
    ADD CONSTRAINT customer_documents_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.customer_documents
    ADD CONSTRAINT customer_documents_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES public.customer_folders(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.customer_documents
    ADD CONSTRAINT customer_documents_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.customer_documents
    ADD CONSTRAINT customer_documents_stage_id_fkey FOREIGN KEY (stage_id) REFERENCES public.customer_onboarding_stages(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.customer_documents
    ADD CONSTRAINT customer_documents_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.customer_folders
    ADD CONSTRAINT customer_folders_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.customer_metadata
    ADD CONSTRAINT customer_metadata_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.customer_onboarding_stages
    ADD CONSTRAINT customer_onboarding_stages_completed_by_fkey FOREIGN KEY (completed_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.customer_onboarding_stages
    ADD CONSTRAINT customer_onboarding_stages_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.di_deliverables
    ADD CONSTRAINT di_deliverables_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.di_deliverables
    ADD CONSTRAINT di_deliverables_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.di_deliverables
    ADD CONSTRAINT di_deliverables_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.di_deliverables
    ADD CONSTRAINT di_deliverables_record_id_fkey FOREIGN KEY (record_id) REFERENCES public.records(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.document_requirements
    ADD CONSTRAINT document_requirements_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.document_requirements
    ADD CONSTRAINT document_requirements_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.document_revisions
    ADD CONSTRAINT document_revisions_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.document_revisions
    ADD CONSTRAINT document_revisions_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.document_revisions
    ADD CONSTRAINT document_revisions_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_record_id_fkey FOREIGN KEY (record_id) REFERENCES public.records(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.drawing_revisions
    ADD CONSTRAINT drawing_revisions_drawing_id_fkey FOREIGN KEY (drawing_id) REFERENCES public.drawings(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.drawing_revisions
    ADD CONSTRAINT drawing_revisions_released_by_fkey FOREIGN KEY (released_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.drawings
    ADD CONSTRAINT drawings_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.drawings
    ADD CONSTRAINT drawings_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.drawings
    ADD CONSTRAINT drawings_part_id_fkey FOREIGN KEY (part_id) REFERENCES public.parts(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.export_jobs
    ADD CONSTRAINT export_jobs_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.export_jobs
    ADD CONSTRAINT export_jobs_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.first_article_results
    ADD CONSTRAINT first_article_results_measured_by_fkey FOREIGN KEY (measured_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.first_article_results
    ADD CONSTRAINT first_article_results_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES public.work_orders(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.form_versions
    ADD CONSTRAINT form_versions_published_by_fkey FOREIGN KEY (published_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.form_versions
    ADD CONSTRAINT form_versions_record_type_id_fkey FOREIGN KEY (record_type_id) REFERENCES public.record_types(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.gage_calibrations
    ADD CONSTRAINT gage_calibrations_gage_id_fkey FOREIGN KEY (gage_id) REFERENCES public.gages(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.gage_calibrations
    ADD CONSTRAINT gage_calibrations_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.gage_calibrations
    ADD CONSTRAINT gage_calibrations_performed_by_fkey FOREIGN KEY (performed_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.gages
    ADD CONSTRAINT gages_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.imported_forms
    ADD CONSTRAINT imported_forms_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.imported_forms
    ADD CONSTRAINT imported_forms_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.lots
    ADD CONSTRAINT lots_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.lots
    ADD CONSTRAINT lots_parent_lot_id_fkey FOREIGN KEY (parent_lot_id) REFERENCES public.lots(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.lots
    ADD CONSTRAINT lots_part_id_fkey FOREIGN KEY (part_id) REFERENCES public.parts(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.lpa_answers
    ADD CONSTRAINT lpa_answers_answered_by_fkey FOREIGN KEY (answered_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.lpa_answers
    ADD CONSTRAINT lpa_answers_audit_id_fkey FOREIGN KEY (audit_id) REFERENCES public.lpa_audits(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.lpa_answers
    ADD CONSTRAINT lpa_answers_question_id_fkey FOREIGN KEY (question_id) REFERENCES public.lpa_questions(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.lpa_audits
    ADD CONSTRAINT lpa_audits_auditor_id_fkey FOREIGN KEY (auditor_id) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.lpa_audits
    ADD CONSTRAINT lpa_audits_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.lpa_audits
    ADD CONSTRAINT lpa_audits_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES public.lpa_schedules(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.lpa_audits
    ADD CONSTRAINT lpa_audits_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.lpa_templates(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.lpa_questions
    ADD CONSTRAINT lpa_questions_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.lpa_templates(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.lpa_schedules
    ADD CONSTRAINT lpa_schedules_auditor_id_fkey FOREIGN KEY (auditor_id) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.lpa_schedules
    ADD CONSTRAINT lpa_schedules_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.lpa_schedules
    ADD CONSTRAINT lpa_schedules_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.lpa_schedules
    ADD CONSTRAINT lpa_schedules_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.lpa_templates(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.lpa_templates
    ADD CONSTRAINT lpa_templates_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.lpa_templates
    ADD CONSTRAINT lpa_templates_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.management_review_actions
    ADD CONSTRAINT management_review_actions_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.management_review_actions
    ADD CONSTRAINT management_review_actions_review_id_fkey FOREIGN KEY (review_id) REFERENCES public.management_reviews(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.management_review_attendance
    ADD CONSTRAINT management_review_attendance_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.management_review_attendance
    ADD CONSTRAINT management_review_attendance_review_id_fkey FOREIGN KEY (review_id) REFERENCES public.management_reviews(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.management_reviews
    ADD CONSTRAINT management_reviews_chair_id_fkey FOREIGN KEY (chair_id) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.management_reviews
    ADD CONSTRAINT management_reviews_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.org_layouts
    ADD CONSTRAINT org_layouts_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.org_layouts
    ADD CONSTRAINT org_layouts_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.parts
    ADD CONSTRAINT parts_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.ppap_elements
    ADD CONSTRAINT ppap_elements_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.ppap_elements
    ADD CONSTRAINT ppap_elements_record_id_fkey FOREIGN KEY (record_id) REFERENCES public.records(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.ppap_elements
    ADD CONSTRAINT ppap_elements_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.presence
    ADD CONSTRAINT presence_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.presence
    ADD CONSTRAINT presence_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.production_logs
    ADD CONSTRAINT production_logs_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.production_logs
    ADD CONSTRAINT production_logs_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.purchase_requests
    ADD CONSTRAINT purchase_requests_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.purchase_requests
    ADD CONSTRAINT purchase_requests_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.purchase_requests
    ADD CONSTRAINT purchase_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.quality_objectives
    ADD CONSTRAINT quality_objectives_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.quality_objectives
    ADD CONSTRAINT quality_objectives_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.receipt_measurements
    ADD CONSTRAINT receipt_measurements_receipt_id_fkey FOREIGN KEY (receipt_id) REFERENCES public.receipts(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.receipts
    ADD CONSTRAINT receipts_inspected_by_fkey FOREIGN KEY (inspected_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.receipts
    ADD CONSTRAINT receipts_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES public.lots(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.receipts
    ADD CONSTRAINT receipts_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.receipts
    ADD CONSTRAINT receipts_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.record_drafts
    ADD CONSTRAINT record_drafts_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.record_drafts
    ADD CONSTRAINT record_drafts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.record_links
    ADD CONSTRAINT record_links_from_record_id_fkey FOREIGN KEY (from_record_id) REFERENCES public.records(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.record_links
    ADD CONSTRAINT record_links_to_record_id_fkey FOREIGN KEY (to_record_id) REFERENCES public.records(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.record_types
    ADD CONSTRAINT record_types_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.records
    ADD CONSTRAINT records_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.records
    ADD CONSTRAINT records_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.records
    ADD CONSTRAINT records_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.records
    ADD CONSTRAINT records_record_type_id_fkey FOREIGN KEY (record_type_id) REFERENCES public.record_types(id);
ALTER TABLE ONLY public.records
    ADD CONSTRAINT records_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.review_chart_points
    ADD CONSTRAINT review_chart_points_chart_id_fkey FOREIGN KEY (chart_id) REFERENCES public.review_charts(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.review_charts
    ADD CONSTRAINT review_charts_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.review_charts
    ADD CONSTRAINT review_charts_review_id_fkey FOREIGN KEY (review_id) REFERENCES public.management_reviews(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.review_charts
    ADD CONSTRAINT review_charts_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_permission_key_fkey FOREIGN KEY (permission_key) REFERENCES public.permissions(key) ON DELETE CASCADE;
ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_role_fkey FOREIGN KEY (org_id, role_key) REFERENCES public.roles(org_id, key) ON DELETE CASCADE;
ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.shipment_checks
    ADD CONSTRAINT shipment_checks_shipment_id_fkey FOREIGN KEY (shipment_id) REFERENCES public.shipments(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.shipments
    ADD CONSTRAINT shipments_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES public.lots(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.shipments
    ADD CONSTRAINT shipments_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.shipments
    ADD CONSTRAINT shipments_released_by_fkey FOREIGN KEY (released_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.sites
    ADD CONSTRAINT sites_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.training_records
    ADD CONSTRAINT training_records_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.training_records
    ADD CONSTRAINT training_records_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.training_records
    ADD CONSTRAINT training_records_trained_by_fkey FOREIGN KEY (trained_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.training_records
    ADD CONSTRAINT training_records_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.turtle_diagrams
    ADD CONSTRAINT turtle_diagrams_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.turtle_diagrams
    ADD CONSTRAINT turtle_diagrams_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.turtle_entries
    ADD CONSTRAINT turtle_entries_diagram_id_fkey FOREIGN KEY (diagram_id) REFERENCES public.turtle_diagrams(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.turtle_entries
    ADD CONSTRAINT turtle_entries_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_role_fkey FOREIGN KEY (org_id, role) REFERENCES public.roles(org_id, key);
ALTER TABLE ONLY public.vendor_evaluations
    ADD CONSTRAINT vendor_evaluations_evaluated_by_fkey FOREIGN KEY (evaluated_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.vendor_evaluations
    ADD CONSTRAINT vendor_evaluations_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.vendor_onboarding_documents
    ADD CONSTRAINT vendor_onboarding_documents_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.vendor_onboarding_documents
    ADD CONSTRAINT vendor_onboarding_documents_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.vendor_onboarding_documents
    ADD CONSTRAINT vendor_onboarding_documents_stage_id_fkey FOREIGN KEY (stage_id) REFERENCES public.vendor_onboarding_stages(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.vendor_onboarding_documents
    ADD CONSTRAINT vendor_onboarding_documents_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.vendor_onboarding_stages
    ADD CONSTRAINT vendor_onboarding_stages_completed_by_fkey FOREIGN KEY (completed_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.vendor_onboarding_stages
    ADD CONSTRAINT vendor_onboarding_stages_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.vendors
    ADD CONSTRAINT vendors_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.work_order_operations
    ADD CONSTRAINT work_order_operations_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.work_order_operations
    ADD CONSTRAINT work_order_operations_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES public.work_orders(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.work_orders
    ADD CONSTRAINT work_orders_held_by_fkey FOREIGN KEY (held_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.work_orders
    ADD CONSTRAINT work_orders_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES public.lots(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.work_orders
    ADD CONSTRAINT work_orders_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.work_orders
    ADD CONSTRAINT work_orders_part_id_fkey FOREIGN KEY (part_id) REFERENCES public.parts(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.workflow_states
    ADD CONSTRAINT workflow_states_record_type_id_fkey FOREIGN KEY (record_type_id) REFERENCES public.record_types(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.workflow_transitions
    ADD CONSTRAINT workflow_transitions_record_type_id_fkey FOREIGN KEY (record_type_id) REFERENCES public.record_types(id) ON DELETE CASCADE;
