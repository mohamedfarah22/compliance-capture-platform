-- Shared customer table (Gold Due Diligence spec 1.3, 4.2). One row per person or company,
-- used by both journeys. ttr.parties stay per-transaction copies (a TTR keeps the details
-- as reported); parties get a nullable customer_id in the next migration.
--
-- Writes happen only through service-role code (the complete-transaction SQL function, the
-- backfill, and later the gold functions). The browser can read its own entity's customers
-- and nothing else: no INSERT, UPDATE or DELETE policy, and the table privileges are
-- revoked as well, so a mistaken policy later cannot open a write path on its own.
--
-- MFA: every policy resolves access through public.reporting_entity_id(), which returns
-- NULL unless the JWT is aal2 (20261030000001_security_hardening.sql). A password-only
-- session therefore sees no rows.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE public.customers (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporting_entity_id  UUID NOT NULL REFERENCES public.reporting_entities(id),
    customer_type        party_kind NOT NULL,
    source               TEXT NOT NULL CHECK (source IN ('gold', 'ttr')),
    created_by_staff_id  UUID REFERENCES public.staff_members(id),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- INDIVIDUAL fields
    first_name                 TEXT,
    middle_name                TEXT,
    last_name                  TEXT,
    date_of_birth              DATE,
    gender                     CHAR(1) CHECK (gender IN ('M', 'F', 'U')),
    phone                      TEXT,
    email                      TEXT,
    occupation                 TEXT,
    res_street                 TEXT,
    res_suburb                 TEXT,
    res_state                  aus_state,
    res_postcode               TEXT,
    res_country                TEXT NOT NULL DEFAULT 'Australia',
    has_postal_address         BOOLEAN NOT NULL DEFAULT FALSE,
    post_street                TEXT,
    post_suburb                TEXT,
    post_state                 aus_state,
    post_postcode              TEXT,
    post_country               TEXT,
    citizenship_country_code   CHAR(2),
    tax_residency_country_code CHAR(2),
    is_sole_trader             BOOLEAN,   -- NULL = never asked (gold-created customers)
    abn                        TEXT,
    business_trading_name      TEXT,

    -- COMPANY fields (as on ttr.parties)
    entity_name                TEXT,
    company_trading_name       TEXT,
    legal_form                 co_legal_form,
    reg_id_type                reg_id_kind,
    reg_identifier             TEXT,
    company_phone              TEXT,
    principal_activity         TEXT,
    biz_street                 TEXT,
    biz_suburb                 TEXT,
    biz_state                  aus_state,
    biz_postcode               TEXT,
    biz_country                TEXT NOT NULL DEFAULT 'Australia',
    has_company_postal_address BOOLEAN NOT NULL DEFAULT FALSE,
    co_post_street             TEXT,
    co_post_suburb             TEXT,
    co_post_state              aus_state,
    co_post_postcode           TEXT,
    co_post_country            TEXT,
    is_express_trust           BOOLEAN,
    trust_type_other           TEXT,
    trust_name                 TEXT,

    -- Search columns. The expressions are mirrored by the JS keys in
    -- supabase/functions/_shared/goldKeys.ts: change one and the other must change too.
    name_search TEXT GENERATED ALWAYS AS (
        btrim(regexp_replace(
            lower(coalesce(first_name, '') || ' ' || coalesce(middle_name, '') || ' ' || coalesce(last_name, '')),
            '\s+', ' ', 'g'
        ))
    ) STORED,
    phone_digits TEXT GENERATED ALWAYS AS (
        nullif(regexp_replace(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), '^61', '0'), '')
    ) STORED,

    CONSTRAINT chk_customer_individual CHECK (
        customer_type <> 'individual' OR (first_name IS NOT NULL AND last_name IS NOT NULL)
    ),
    CONSTRAINT chk_customer_company CHECK (
        customer_type <> 'company' OR (entity_name IS NOT NULL AND reg_identifier IS NOT NULL)
    )
);

-- No unique key on name + DOB: gold treats duplicates as a prompt, not an error.
CREATE INDEX idx_customers_name_trgm ON public.customers USING GIN (name_search gin_trgm_ops);
CREATE INDEX idx_customers_phone     ON public.customers (reporting_entity_id, phone_digits)
    WHERE phone_digits IS NOT NULL;
CREATE INDEX idx_customers_ind_key   ON public.customers
    (reporting_entity_id, lower(last_name), lower(first_name), date_of_birth)
    WHERE customer_type = 'individual';
CREATE INDEX idx_customers_co_key    ON public.customers
    (reporting_entity_id, lower(entity_name), replace(coalesce(reg_identifier, ''), ' ', ''))
    WHERE customer_type = 'company';

CREATE TRIGGER handle_updated_at
    BEFORE UPDATE ON public.customers
    FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);

-- ─── Aliases ─────────────────────────────────────────────────────────────────

CREATE TABLE public.customer_aliases (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
    alias       TEXT NOT NULL,
    sort_order  SMALLINT NOT NULL DEFAULT 0
);

CREATE INDEX idx_customer_alias_customer ON public.customer_aliases (customer_id, sort_order);
CREATE INDEX idx_customer_alias_trgm     ON public.customer_aliases USING GIN (alias gin_trgm_ops);

-- ─── Audit log ───────────────────────────────────────────────────────────────
--
-- Append-only, like ttr.transaction_audit_log: no FK to customers and a copy of
-- reporting_entity_id, so rows survive any administrative deletion and RLS needs no join.
-- `changes` is {"column": {"old": ..., "new": ...}}. `source` says which path made the
-- change (gold_edit, phone_change, ttr_completion); it is NULL for an unlabelled direct
-- update, which is still recorded rather than blocked.

CREATE TABLE public.customer_audit_log (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id         UUID NOT NULL,
    reporting_entity_id UUID NOT NULL,
    changed_by          UUID,
    source              TEXT CHECK (source IN ('gold_edit', 'phone_change', 'ttr_completion')),
    changed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    changes             JSONB NOT NULL
);

CREATE INDEX idx_customer_audit_customer ON public.customer_audit_log (customer_id, changed_at DESC);
CREATE INDEX idx_customer_audit_entity   ON public.customer_audit_log (reporting_entity_id, changed_at DESC);

CREATE TRIGGER trg_audit_append_only
    BEFORE UPDATE OR DELETE ON public.customer_audit_log
    FOR EACH ROW EXECUTE FUNCTION ttr.deny_audit_mutation();

-- Service-role code sets these per transaction before it writes:
--   app.actor_staff_id  the staff member responsible (falls back to auth.uid())
--   app.change_source   one of the CHECK values above
CREATE OR REPLACE FUNCTION public._write_customer_audit(
    p_customer_id UUID,
    p_entity_id   UUID,
    p_changes     JSONB
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_actor UUID := nullif(current_setting('app.actor_staff_id', true), '')::uuid;
BEGIN
    IF v_actor IS NULL THEN
        SELECT id INTO v_actor FROM public.staff_members WHERE id = auth.uid();
    END IF;

    INSERT INTO public.customer_audit_log (customer_id, reporting_entity_id, changed_by, source, changes)
    VALUES (
        p_customer_id,
        p_entity_id,
        v_actor,
        nullif(current_setting('app.change_source', true), ''),
        p_changes
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.customers_audit_update()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_changes JSONB;
BEGIN
    SELECT jsonb_object_agg(n.key, jsonb_build_object('old', o.value, 'new', n.value))
    INTO v_changes
    FROM jsonb_each(to_jsonb(NEW)) n
    JOIN jsonb_each(to_jsonb(OLD)) o ON o.key = n.key
    WHERE n.value IS DISTINCT FROM o.value
      AND n.key NOT IN ('updated_at', 'name_search', 'phone_digits');

    IF v_changes IS NOT NULL THEN
        PERFORM public._write_customer_audit(NEW.id, NEW.reporting_entity_id, v_changes);
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER trg_customers_audit
    AFTER UPDATE ON public.customers
    FOR EACH ROW EXECUTE FUNCTION public.customers_audit_update();

-- ─── RLS: select only ────────────────────────────────────────────────────────

ALTER TABLE public.customers          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_aliases   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "customers_select" ON public.customers
    FOR SELECT USING (reporting_entity_id = public.reporting_entity_id());

CREATE POLICY "customer_aliases_select" ON public.customer_aliases
    FOR SELECT USING (EXISTS (
        SELECT 1 FROM public.customers c
        WHERE c.id = customer_aliases.customer_id
          AND c.reporting_entity_id = public.reporting_entity_id()
    ));

CREATE POLICY "customer_audit_select" ON public.customer_audit_log
    FOR SELECT USING (reporting_entity_id = public.reporting_entity_id());

-- Supabase grants new public tables to anon and authenticated by default. Take that back
-- and give the signed-in browser SELECT only.
REVOKE ALL ON public.customers, public.customer_aliases, public.customer_audit_log FROM anon, authenticated;
GRANT SELECT ON public.customers, public.customer_aliases, public.customer_audit_log TO authenticated;

REVOKE EXECUTE ON FUNCTION public._write_customer_audit(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.customers_audit_update() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public._write_customer_audit(UUID, UUID, JSONB) TO service_role;
