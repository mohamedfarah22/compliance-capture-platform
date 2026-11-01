-- Gold: goods photos, export audit, the private photo bucket, and the read-only access rules
-- for every gold table (spec 4.2, 4.5, 6.1).

-- ─── Goods photos ────────────────────────────────────────────────────────────────────────
-- Kept apart from ttr.stored_images so the one-copy ID rules never touch goods photos.
-- Append-only: no row is updated or deleted, by anyone.

CREATE TABLE gold.goods_photos (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_id          UUID NOT NULL REFERENCES gold.purchases(id) ON DELETE RESTRICT,
    reporting_entity_id  UUID NOT NULL REFERENCES public.reporting_entities(id),
    storage_bucket       TEXT NOT NULL DEFAULT 'gold-goods' CHECK (storage_bucket = 'gold-goods'),
    object_path          TEXT NOT NULL,
    content_hash_sha256  TEXT NOT NULL,
    content_type         TEXT NOT NULL DEFAULT 'image/jpeg',
    byte_size            INTEGER,
    captured_by_staff_id UUID NOT NULL REFERENCES public.staff_members(id),
    captured_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    sort_order           SMALLINT NOT NULL DEFAULT 0,

    UNIQUE (storage_bucket, object_path),
    UNIQUE (purchase_id, sort_order),

    -- {purchase_id}/goods-{n}.jpg
    CONSTRAINT chk_gph_path_prefix CHECK (object_path LIKE (purchase_id::TEXT || '/goods-%'))
);

CREATE INDEX idx_gph_entity ON gold.goods_photos (reporting_entity_id);

CREATE TRIGGER trg_audit_append_only
    BEFORE UPDATE OR DELETE ON gold.goods_photos
    FOR EACH ROW EXECUTE FUNCTION ttr.deny_audit_mutation();

-- ─── Export audit ────────────────────────────────────────────────────────────────────────
-- One row per download or print of purchase records, written by gold-export (Phase 11)
-- before it signs any photo URL. Append-only.

CREATE TABLE gold.export_audit_log (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporting_entity_id UUID NOT NULL REFERENCES public.reporting_entities(id),
    staff_member_id     UUID NOT NULL REFERENCES public.staff_members(id),
    kind                TEXT NOT NULL CHECK (kind IN ('zip', 'record')),
    filters             JSONB,
    purchase_ids        UUID[] NOT NULL DEFAULT '{}',
    exported_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_geal_entity ON gold.export_audit_log (reporting_entity_id, exported_at DESC);

CREATE TRIGGER trg_audit_append_only
    BEFORE UPDATE OR DELETE ON gold.export_audit_log
    FOR EACH ROW EXECUTE FUNCTION ttr.deny_audit_mutation();

-- ─── Private bucket for goods photos ─────────────────────────────────────────────────────
-- No storage.objects policy is created for it: with RLS on and no policy, the signed-in
-- browser can neither list, read, upload nor delete. Objects are written by gold-save-purchase
-- with the service role and read through short-lived signed URLs from get-gold-photo-urls.

INSERT INTO storage.buckets (id, name, public)
VALUES ('gold-goods', 'gold-goods', FALSE)
ON CONFLICT (id) DO NOTHING;

-- ─── RLS: select only ────────────────────────────────────────────────────────────────────
-- No insert, update or delete policy exists, and the privileges are not granted either, so a
-- policy added by mistake later cannot open a write path on its own.

ALTER TABLE gold.purchases          ENABLE ROW LEVEL SECURITY;
ALTER TABLE gold.purchase_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE gold.goods_photos       ENABLE ROW LEVEL SECURITY;
ALTER TABLE gold.export_audit_log   ENABLE ROW LEVEL SECURITY;

CREATE POLICY "gold_purchases_select" ON gold.purchases
    FOR SELECT USING (reporting_entity_id = public.reporting_entity_id());

CREATE POLICY "gold_purchase_audit_select" ON gold.purchase_audit_log
    FOR SELECT USING (reporting_entity_id = public.reporting_entity_id());

CREATE POLICY "gold_goods_photos_select" ON gold.goods_photos
    FOR SELECT USING (reporting_entity_id = public.reporting_entity_id());

-- Managers and admins only (spec 2.3). has_role() is an exact match on the role, so an admin
-- does not satisfy has_role('manager'); both are named.
CREATE POLICY "gold_export_audit_select" ON gold.export_audit_log
    FOR SELECT USING (
        reporting_entity_id = public.reporting_entity_id()
        AND (public.has_role('manager') OR public.has_role('admin'))
    );

REVOKE ALL ON gold.purchases, gold.purchase_audit_log, gold.goods_photos, gold.export_audit_log
    FROM PUBLIC, anon, authenticated;
GRANT SELECT ON gold.purchases, gold.purchase_audit_log, gold.goods_photos, gold.export_audit_log
    TO authenticated;
GRANT ALL ON gold.purchases, gold.purchase_audit_log, gold.goods_photos, gold.export_audit_log
    TO service_role;
