-- ============================================================
-- Drop workflow_transitions.required_role.
--
-- Migration 002 replaced it with required_permission and said this
-- column would go "once 002 has been running for a while." It has
-- been unused by the application since then. Dropping a column is
-- the one migration that cannot be undone from a backup taken
-- afterwards, which is exactly why it waited until now rather than
-- riding along with 002.
-- ============================================================

alter table workflow_transitions drop column if exists required_role;
