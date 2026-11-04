-- Gold Phase 9a UAT defect D3 (rows 9.44, 9.70): the cash a gold sale was paid across all its parts.
--
-- Spec 3.4: a mixed invoice ($6,000 scrap + $6,000 bullion) gives two TTRs of $6,000 each, and both must be
-- completable although each is under $10,000. The $10,000-per-report check is waived only for a TTR linked to gold
-- purchases (gold.purchases.ttr_transaction_id) whose same-day linked cash, across all types, reaches $10,000.
-- complete-transaction re-checks this on the server with gold._ttr_linked_cash; the wizard reads the same figure
-- through gold.ttr_linked_cash (its Continue button). A TTR no gold purchase points at returns NULL, so the plain
-- $10,000 rule applies to it exactly as before.
--
-- The sum uses the same linked-part rule as gold.linked_parts / gold._ttr_type_cash: same invoice, same sale
-- date, and the parts belong to the sellers (main or joint) of a part linked to the TTR. An amount not entered
-- counts as 0.

CREATE OR REPLACE FUNCTION gold._ttr_linked_cash(p_entity UUID, p_ttr UUID)
RETURNS NUMERIC
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = gold, public, pg_temp
AS $$
    SELECT CASE WHEN EXISTS (SELECT 1 FROM gold.purchases l
                             WHERE l.reporting_entity_id = p_entity AND l.ttr_transaction_id = p_ttr)
        THEN coalesce((
            SELECT sum(coalesce(q.cash_amount, 0))
            FROM gold.purchases q
            WHERE q.reporting_entity_id = p_entity
              AND EXISTS (
                  SELECT 1 FROM gold.purchases l
                  WHERE l.reporting_entity_id = p_entity AND l.ttr_transaction_id = p_ttr
                    AND l.erp_invoice_norm = q.erp_invoice_norm AND l.sale_date = q.sale_date
                    AND (q.customer_id IN (l.customer_id, coalesce(l.joint_customer_id, l.customer_id))
                         OR coalesce(q.joint_customer_id IN (l.customer_id, coalesce(l.joint_customer_id, l.customer_id)), false))
              )
        ), 0)
    END
$$;

-- The wizard's read: the caller's own business only (NULL below aal2, like the other gold read RPCs).
CREATE OR REPLACE FUNCTION gold.ttr_linked_cash(p_ttr UUID)
RETURNS NUMERIC
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = gold, public, pg_temp
AS $$
    SELECT gold._ttr_linked_cash(public.reporting_entity_id(), p_ttr)
    WHERE public.reporting_entity_id() IS NOT NULL
$$;

REVOKE EXECUTE ON FUNCTION gold._ttr_linked_cash(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gold.ttr_linked_cash(UUID)        FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION gold._ttr_linked_cash(UUID, UUID) TO service_role;
GRANT  EXECUTE ON FUNCTION gold.ttr_linked_cash(UUID)        TO authenticated, service_role;
