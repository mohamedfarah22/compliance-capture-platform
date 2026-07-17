-- Extensible reference table for transaction scenarios.
-- Adding a new scenario requires only an INSERT — no DDL, no enum migration.

CREATE TABLE ttr.scenario_types (
    code       TEXT PRIMARY KEY,
    label      TEXT NOT NULL,
    is_active  BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO ttr.scenario_types (code, label) VALUES
    ('bullion_sell', 'Sale of bullion for physical cash'),
    ('bullion_buy',  'Purchase of bullion for physical cash')
ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label;

ALTER TABLE ttr.scenario_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY "scenario_types_select" ON ttr.scenario_types
    FOR SELECT TO authenticated USING (is_active = TRUE);
