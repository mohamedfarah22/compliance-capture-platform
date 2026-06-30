-- Metadata for images stored in Supabase Storage bucket 'compliance-media'.
-- No BYTEAs — images live in object storage; this table holds the chain of custody.
--
-- Object path convention (flat — single folder depth for reliable list() cleanup):
--   {transaction_id}/{person_type}-{person_id}-{side}.jpg
-- Example:
--   8c2f1a.../party-abc123-front.jpg
--   8c2f1a.../cp-xyz456-back.jpg
-- All objects for a transaction sit directly under {transaction_id}/ — no subfolders.
--
-- content_hash_sha256: computed before upload; proves image was not altered after capture.
-- captured_by_staff_id: NOT NULL — chain of custody requires a known uploader.
-- No UPDATE or DELETE policies — images are immutable after capture.

CREATE TABLE ttr.stored_images (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id       UUID NOT NULL REFERENCES ttr.transactions(id) ON DELETE RESTRICT,
    storage_bucket       TEXT NOT NULL DEFAULT 'compliance-media',
    object_path          TEXT NOT NULL,
    content_hash_sha256  TEXT NOT NULL,
    content_type         TEXT NOT NULL DEFAULT 'image/jpeg',
    byte_size            INTEGER,
    captured_by_staff_id UUID NOT NULL REFERENCES public.staff_members(id),
    captured_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (storage_bucket, object_path),

    -- object_path must begin with the transaction_id/ prefix (matches path convention)
    CONSTRAINT chk_img_path_prefix CHECK (
        object_path LIKE (transaction_id::TEXT || '/%')
    )
);

CREATE INDEX idx_img_tx ON ttr.stored_images (transaction_id);

ALTER TABLE ttr.stored_images ENABLE ROW LEVEL SECURITY;

CREATE POLICY "img_select" ON ttr.stored_images FOR SELECT
    USING (transaction_id IN (
        SELECT id FROM ttr.transactions WHERE reporting_entity_id = public.reporting_entity_id()
    ));

CREATE POLICY "img_insert" ON ttr.stored_images FOR INSERT
    WITH CHECK (
        captured_by_staff_id = auth.uid()
        AND transaction_id IN (
            SELECT id FROM ttr.transactions
            WHERE reporting_entity_id = public.reporting_entity_id() AND status = 'draft'
        )
    );
