-- Storage policies for the compliance-media bucket.
-- All policies operate on storage.objects and scope access by transaction_id,
-- which is the first path segment of every object: {transaction_id}/{filename}.
--
-- (storage.foldername(name))[1] extracts that first segment as a text value.
--
-- No UPDATE or DELETE policies — images are immutable after upload.
-- All deletions go through Edge Functions using the service_role key (bypasses RLS).

CREATE POLICY "img_download" ON storage.objects
    FOR SELECT
    USING (
        bucket_id = 'compliance-media'
        AND (storage.foldername(name))[1] IN (
            SELECT id::TEXT
            FROM ttr.transactions
            WHERE reporting_entity_id = public.reporting_entity_id()
        )
    );

CREATE POLICY "img_upload" ON storage.objects
    FOR INSERT
    WITH CHECK (
        bucket_id = 'compliance-media'
        AND auth.uid() IS NOT NULL
        AND (storage.foldername(name))[1] IN (
            SELECT id::TEXT
            FROM ttr.transactions
            WHERE reporting_entity_id = public.reporting_entity_id()
              AND status = 'draft'
        )
    );
