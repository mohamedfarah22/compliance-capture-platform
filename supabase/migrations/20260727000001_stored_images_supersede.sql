-- Makes "we keep one copy of your identification on file" literally true.
--
-- The problem (UAT finding #9): uq_idv_doc_new_capture guarantees one *unlinked row*
-- per document. It says nothing about images. A linked re-capture — 'stored_copy_unclear'
-- or 'id_changed' — stores a fresh front/back pair alongside the one already held, so a
-- single licence accumulated four image pairs across one UAT pass. Meanwhile the UI tells
-- staff the re-capture "replaces" the copy on file, and privacy policy §3 tells customers
-- we do not take "a new copy for every visit". Neither was true.
--
-- The resolution is to delete the superseded IMAGE but keep its METADATA ROW. AML/CTF
-- record-keeping requires records of identification procedures be retained for seven
-- years, and the row carries content_hash_sha256, captured_by_staff_id and captured_at —
-- provable evidence that a document was sighted, by whom, when, and what it hashed to.
-- Deleting the row as well would destroy that; keeping the object would break §3. Keeping
-- the row and dropping the object satisfies both.
--
-- This amends the "images are immutable after capture" rule stated on ttr.stored_images
-- (20260621000014). The rule is now:
--   * the metadata row is never deleted, and is never written by any client;
--   * the storage object may be removed once superseded, recorded on the two columns
--     below by a service-role function (complete-transaction).
-- No new RLS policy is added deliberately. Service role bypasses RLS, so client-side
-- immutability is preserved exactly as it was — there is still no UPDATE or DELETE policy
-- for an ordinary authenticated session.

ALTER TABLE ttr.stored_images
    ADD COLUMN superseded_at          TIMESTAMPTZ,
    ADD COLUMN superseded_by_image_id UUID REFERENCES ttr.stored_images(id);

-- Both or neither. A superseded row must say what replaced it, otherwise the chain that
-- justifies the deletion is not reconstructable from the record.
ALTER TABLE ttr.stored_images
    ADD CONSTRAINT chk_img_supersede_complete CHECK (
        (superseded_at IS NULL     AND superseded_by_image_id IS NULL)
     OR (superseded_at IS NOT NULL AND superseded_by_image_id IS NOT NULL)
    );

-- An image cannot supersede itself.
ALTER TABLE ttr.stored_images
    ADD CONSTRAINT chk_img_supersede_not_self CHECK (
        superseded_by_image_id IS DISTINCT FROM id
    );

-- get-id-image-urls filters on this to avoid minting signed URLs for objects that no
-- longer exist, and complete-transaction scans it to skip already-superseded rows.
CREATE INDEX idx_img_superseded ON ttr.stored_images (superseded_at)
    WHERE superseded_at IS NULL;
