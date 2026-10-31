-- ttr.parties stay per-transaction copies; customer_id says which shared customer a copy
-- belongs to. It is nullable: drafts have no link until a staff member picks a search
-- result, and completion links the rest (20261101000005).

ALTER TABLE ttr.parties
    ADD COLUMN customer_id UUID REFERENCES public.customers(id);

CREATE INDEX idx_party_customer ON ttr.parties (customer_id) WHERE customer_id IS NOT NULL;

-- The browser can set customer_id on its own draft parties (RLS allows the insert/update),
-- so the database has to refuse an ID that belongs to another reporting entity. Without
-- this a staff member could link their party to a customer in another business, and the
-- completion step would then write their details onto that customer.
-- SECURITY DEFINER so the check sees every customer, not only the caller's.
CREATE OR REPLACE FUNCTION ttr.check_party_customer_tenant()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, ttr
AS $$
BEGIN
    IF NEW.customer_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM public.customers c
        JOIN ttr.transactions t ON t.id = NEW.transaction_id
        WHERE c.id = NEW.customer_id
          AND c.reporting_entity_id = t.reporting_entity_id
    ) THEN
        RAISE EXCEPTION 'Customer % does not belong to the reporting entity of transaction %',
            NEW.customer_id, NEW.transaction_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_party_customer_tenant
    BEFORE INSERT OR UPDATE OF customer_id, transaction_id ON ttr.parties
    FOR EACH ROW EXECUTE FUNCTION ttr.check_party_customer_tenant();
