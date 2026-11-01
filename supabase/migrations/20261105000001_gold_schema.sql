-- Gold Due Diligence: the `gold` schema and gold.purchases (spec 4.2, 4.3).
--
-- A purchase is one scrap or bullion buy from one seller (or two, with a joint seller). Rows are
-- written only by service-role code (the gold-* edge functions, Phase 7). The browser reads
-- its own entity's rows and nothing else: select policies only (20261105000003), and the
-- table privileges are revoked as well.
--
-- Everything the database can enforce by itself lives here as a CHECK. Rules that need other
-- tables or the history of a row (immutability, invoice rules, audit) are in
-- 20261105000002_gold_purchase_triggers.sql.
--
-- MFA: every policy resolves access through public.reporting_entity_id(), which returns NULL
-- unless the JWT is aal2 (20261030000001_security_hardening.sql).

CREATE SCHEMA gold;

-- The browser needs USAGE to reach the schema through the API; service-role code needs it
-- to write. anon gets nothing. Table and function grants are given one object at a time.
REVOKE ALL ON SCHEMA gold FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA gold TO authenticated, service_role;

-- Anything created in gold later is closed to the API roles until a migration opens it.
ALTER DEFAULT PRIVILEGES IN SCHEMA gold REVOKE ALL ON TABLES    FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA gold REVOKE ALL ON ROUTINES  FROM PUBLIC, anon;

CREATE TYPE gold.purchase_type AS ENUM ('scrap', 'bullion');

CREATE TABLE gold.purchases (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporting_entity_id      UUID NOT NULL REFERENCES public.reporting_entities(id),

    -- Sellers. The joint seller is optional and must be a different person.
    customer_id              UUID NOT NULL REFERENCES public.customers(id),
    joint_customer_id        UUID REFERENCES public.customers(id),

    -- The ID capture used for each seller, as it was when the purchase was saved.
    main_id_verification_id  UUID NOT NULL REFERENCES ttr.id_verifications(id),
    joint_id_verification_id UUID REFERENCES ttr.id_verifications(id),

    purchase_type            gold.purchase_type NOT NULL,

    -- Cash. Scrap is asked "$10,000 or more?" (under_10k / 10k_plus); bullion is banded
    -- (under_5k / 5k_to_10k / 10k_plus). These are the values supabase/functions/_shared/
    -- goldRules.js stores (cashBand, BULLION_BANDS). cash_10k_or_more is isReportable.
    cash_band                TEXT NOT NULL,
    cash_10k_or_more         BOOLEAN NOT NULL,
    cash_amount              NUMERIC(15,2),
    -- Snapshot of the linked total shown when this part was saved. Never rewritten by later parts.
    invoice_cash_total       NUMERIC(15,2),

    -- ERP invoice. Null until added, and cannot be changed or removed once set (trigger).
    erp_invoice_no           TEXT,
    erp_invoice_norm         TEXT GENERATED ALWAYS AS (upper(btrim(erp_invoice_no))) STORED,

    -- Local calendar date of the sale in the business time zone, set by the server. Used to
    -- link same-day parts of one invoice and for the AUSTRAC deadline.
    sale_date                DATE NOT NULL DEFAULT ((now() AT TIME ZONE 'Australia/Melbourne')::date),

    phone                    TEXT NOT NULL,
    id_sighted               BOOLEAN NOT NULL,

    -- State of the ID at capture (C2).
    id_expired_at_time          BOOLEAN NOT NULL DEFAULT FALSE,
    id_outside_window_at_time   BOOLEAN NOT NULL DEFAULT FALSE,

    -- Counter answers (spec 3.3a). NULL when not asked.
    ttr_self_conducted       BOOLEAN,
    ttr_details_confirmed    BOOLEAN,

    ttr_transaction_id       UUID REFERENCES ttr.transactions(id) ON DELETE SET NULL,

    -- Set by the server only.
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by_staff_id      UUID NOT NULL REFERENCES public.staff_members(id),
    completed_at             TIMESTAMPTZ,
    completed_by_staff_id    UUID REFERENCES public.staff_members(id),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_gp_cash_band CHECK (
        (purchase_type = 'scrap'   AND cash_band IN ('under_10k', '10k_plus'))
     OR (purchase_type = 'bullion' AND cash_band IN ('under_5k', '5k_to_10k', '10k_plus'))
    ),
    CONSTRAINT chk_gp_joint_differs CHECK (joint_customer_id IS NULL OR joint_customer_id <> customer_id),
    -- A joint seller comes with the ID used for them, and an ID only with a joint seller.
    CONSTRAINT chk_gp_joint_id CHECK ((joint_customer_id IS NULL) = (joint_id_verification_id IS NULL)),
    CONSTRAINT chk_gp_cash_amount CHECK (cash_amount IS NULL OR cash_amount >= 0),
    CONSTRAINT chk_gp_invoice_cash_total CHECK (invoice_cash_total IS NULL OR invoice_cash_total >= 0),
    CONSTRAINT chk_gp_invoice_not_blank CHECK (erp_invoice_no IS NULL OR btrim(erp_invoice_no) <> ''),
    CONSTRAINT chk_gp_id_sighted CHECK (id_sighted = TRUE),
    CONSTRAINT chk_gp_phone CHECK (length(regexp_replace(phone, '\D', '', 'g')) >= 8),
    CONSTRAINT chk_gp_completed_pair CHECK ((completed_at IS NULL) = (completed_by_staff_id IS NULL))
);

-- Linked parts and invoice look-ups: same entity + invoice + day.
CREATE INDEX idx_gp_invoice  ON gold.purchases (reporting_entity_id, erp_invoice_norm, sale_date);
CREATE INDEX idx_gp_customer ON gold.purchases (customer_id);
CREATE INDEX idx_gp_joint    ON gold.purchases (joint_customer_id) WHERE joint_customer_id IS NOT NULL;
CREATE INDEX idx_gp_recent   ON gold.purchases (reporting_entity_id, created_at DESC);
CREATE INDEX idx_gp_ttr_tx   ON gold.purchases (ttr_transaction_id) WHERE ttr_transaction_id IS NOT NULL;
CREATE INDEX idx_gp_creator  ON gold.purchases (reporting_entity_id, created_by_staff_id);

CREATE TRIGGER handle_updated_at
    BEFORE UPDATE ON gold.purchases
    FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);

ALTER TABLE gold.purchases ENABLE ROW LEVEL SECURITY;
