CREATE TABLE public.branches (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporting_entity_id UUID NOT NULL REFERENCES public.reporting_entities(id),
    name                TEXT NOT NULL,
    address_street      TEXT,
    address_suburb      TEXT,
    address_state       aus_state,
    address_postcode    TEXT,
    address_country     TEXT NOT NULL DEFAULT 'Australia',
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_branch_entity ON public.branches (reporting_entity_id);

CREATE TRIGGER handle_updated_at
    BEFORE UPDATE ON public.branches
    FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);

ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;
