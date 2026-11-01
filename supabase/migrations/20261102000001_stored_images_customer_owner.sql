-- ID photos can belong to a customer instead of a TTR.
--
-- Until now every stored image hung off a transaction: transaction_id NOT NULL and an
-- object path of {transaction_id}/... A gold customer's ID is captured with no TTR at all,
-- so an image can now be owned by a customer. Exactly one owner, enforced below.
--
-- Customer photos live under customers/{customer_id}/ in the same compliance-media bucket.
-- Only the upload-id-image edge function writes them, with the service role (it hashes the
-- bytes server-side and writes object and row together), so there is deliberately NO insert
-- policy here: the browser cannot add a stored_images row for a customer, exactly as it
-- cannot update or delete one. The only new policy is select, which get-id-image-urls needs
-- to resolve a customer photo under the caller's own JWT before signing it.

ALTER TABLE ttr.stored_images
    ALTER COLUMN transaction_id DROP NOT NULL;

ALTER TABLE ttr.stored_images
    ADD COLUMN customer_id UUID REFERENCES public.customers(id);

CREATE INDEX idx_img_customer ON ttr.stored_images (customer_id) WHERE customer_id IS NOT NULL;

-- Exactly one owner.
ALTER TABLE ttr.stored_images
    ADD CONSTRAINT chk_img_one_owner CHECK ((transaction_id IS NULL) <> (customer_id IS NULL));

-- The old prefix check was `object_path LIKE transaction_id || '/%'`. With a NULL
-- transaction_id that evaluates to NULL, which a CHECK accepts, so a customer row could
-- have carried any path at all. Replaced by one that names the prefix for each owner.
ALTER TABLE ttr.stored_images DROP CONSTRAINT chk_img_path_prefix;

ALTER TABLE ttr.stored_images
    ADD CONSTRAINT chk_img_path_prefix CHECK (
        (transaction_id IS NOT NULL AND object_path LIKE (transaction_id::TEXT || '/%'))
        OR
        (customer_id IS NOT NULL AND object_path LIKE ('customers/' || customer_id::TEXT || '/%'))
    );

-- Select by the customer's reporting entity. The subquery runs under the caller's own RLS
-- on public.customers (entity-scoped select), so it can only ever see their own customers.
-- Policies are additive: img_select still covers transaction-owned rows.
CREATE POLICY "img_select_customer" ON ttr.stored_images FOR SELECT
    USING (customer_id IN (
        SELECT id FROM public.customers WHERE reporting_entity_id = public.reporting_entity_id()
    ));
