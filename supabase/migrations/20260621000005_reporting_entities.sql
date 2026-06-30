CREATE TABLE public.reporting_entities (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legal_name       TEXT NOT NULL,
    trading_name     TEXT,
    abn              CHAR(11),   -- digits only, no spaces
    acn              CHAR(9),
    address_street   TEXT,
    address_suburb   TEXT,
    address_state    aus_state,
    address_postcode TEXT,
    address_country  TEXT NOT NULL DEFAULT 'Australia',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER handle_updated_at
    BEFORE UPDATE ON public.reporting_entities
    FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);

ALTER TABLE public.reporting_entities ENABLE ROW LEVEL SECURITY;
