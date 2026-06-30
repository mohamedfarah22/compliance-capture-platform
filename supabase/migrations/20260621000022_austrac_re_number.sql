-- AUSTRAC-assigned reporting entity number, required in every TTR-FBS report header.
-- Distinct from ABN — issued by AUSTRAC when the entity registers as a reporting entity.
ALTER TABLE public.reporting_entities
  ADD COLUMN austrac_re_number VARCHAR(20);
