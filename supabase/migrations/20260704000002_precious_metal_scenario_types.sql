-- Add scenario codes for the Precious metal designated service (PRECIOUS), alongside
-- the existing bullion_sell/bullion_buy (BULSER) scenarios. No DDL needed beyond this
-- INSERT, per ttr.scenario_types' extensible design (20260621000004_scenario_types.sql).

INSERT INTO ttr.scenario_types (code, label) VALUES
    ('precious_metal_sell', 'Sale of precious metal for physical cash'),
    ('precious_metal_buy',  'Purchase of precious metal for physical cash')
ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label;
