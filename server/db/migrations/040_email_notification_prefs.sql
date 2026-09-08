-- ============================================================
-- Per-user email notification preference (P3.5).
--
--   off        the default - nothing is emailed (in-app bell only)
--   immediate  email me as each notification is raised
--   digest     one email a day summarising what is on my list
--
-- SMTP itself is configured in the environment; with none set every
-- send is a no-op, so this column does nothing until a deployment
-- opts in.
-- ============================================================

alter table users
    add column if not exists email_notifications text not null default 'off'
        check (email_notifications in ('off', 'immediate', 'digest'));
