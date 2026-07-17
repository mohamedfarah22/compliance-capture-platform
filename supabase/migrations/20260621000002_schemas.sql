-- Isolate all TTR compliance data in a dedicated schema.
-- public holds cross-cutting platform tables (reporting_entities, branches, staff_members).

CREATE SCHEMA IF NOT EXISTS ttr;
