-- Exports (spec 6.2, 1.7 C1): the ID used for each seller of many purchases at once, with the storage path of the
-- image to include. gold-export calls it once for the whole export, through the caller's own JWT, instead of calling
-- gold.purchase_id_used once per purchase.
--
-- It is gold.purchase_id_used for each id in p_ids, so the C1 rule has one definition: the capture saved with the
-- purchase, or, when its photos were replaced, the newest capture of the same document that still has them. A purchase
-- of another business, or an id that is no purchase, returns no rows (purchase_id_used identifies the caller by
-- auth.uid() and filters by entity), so every image named here belongs to the caller's business. Only images that are
-- still stored are named (superseded_at IS NULL). Rows come back in the order of p_ids, main seller before joint.
--
-- Read-only. Executable by authenticated and service_role, like the other gold read RPCs. A signed-in staff member can
-- already read these paths from ttr.stored_images (img_select_customer); the object itself is served only through a
-- signed URL, which gold-export signs after checking the role and writing gold.export_audit_log.
CREATE OR REPLACE FUNCTION gold.export_id_photos(p_ids UUID[])
RETURNS TABLE (
    purchase_id               UUID,
    role                      TEXT,
    verification_id           UUID,
    document_type             TEXT,
    document_number           TEXT,
    expiry_date               DATE,
    captured_at               TIMESTAMPTZ,
    photos_replaced           BOOLEAN,
    current_copy_captured_at  TIMESTAMPTZ,
    front_object_path         TEXT,
    back_object_path          TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = gold, public, ttr, pg_temp
AS $$
    SELECT i.id, u.role, u.verification_id, u.document_type, u.document_number, u.expiry_date, u.captured_at,
           u.photos_replaced, u.current_copy_captured_at, f.object_path, b.object_path
    FROM unnest(p_ids) WITH ORDINALITY AS i(id, ord)
    CROSS JOIN LATERAL gold.purchase_id_used(i.id) u
    LEFT JOIN ttr.stored_images f ON f.id = u.front_image_id AND f.superseded_at IS NULL
    LEFT JOIN ttr.stored_images b ON b.id = u.back_image_id AND b.superseded_at IS NULL
    ORDER BY i.ord, (u.role = 'joint')
$$;

REVOKE EXECUTE ON FUNCTION gold.export_id_photos(UUID[]) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION gold.export_id_photos(UUID[]) TO authenticated, service_role;
