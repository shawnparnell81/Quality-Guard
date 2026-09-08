-- ============================================================
-- Organisation onboarding state (P5.3).
--
--   onboarded_at  set when the admin finishes (or skips) the
--                 first-run wizard; null means "show the wizard".
--   standards     the quality standard(s) the org runs to, picked in
--                 the wizard's second step - e.g. ["ISO 9001",
--                 "IATF 16949"]. Informational for now; drives which
--                 clause references the UI leans on later.
-- ============================================================

alter table organizations
    add column if not exists onboarded_at timestamptz;

alter table organizations
    add column if not exists standards jsonb not null default '[]'::jsonb;
