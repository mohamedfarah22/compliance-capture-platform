-- Records why a fresh copy of an ID was taken when one was already on file.
--
-- Privacy policy §3: "We will only take a new copy if your ID has changed (for
-- example, a renewed licence) or if our stored copy is unclear." Those are the
-- two permitted reasons; 'other' exists so staff are never forced to mis-state
-- the reason to proceed, and an unusual value is visible in the record.
--
-- The 'stored_copy_unclear' case is the one that needs a link: it re-captures the
-- SAME document, which the uniqueness index in the previous migration would
-- otherwise reject. Linking it via prior_verification_id keeps the chain intact
-- so the re-capture is a tracked reuse rather than a silent duplicate.

ALTER TABLE ttr.id_verifications
    ADD COLUMN new_capture_reason TEXT;

-- 'different_person' is the escape hatch for a genuine collision: licence numbers
-- are unique per state, not nationally, and issuer is not part of the uniqueness
-- key, so two real people can share one. It is a specific factual assertion by
-- staff ("I sighted both, they are different people"), recorded on the row and
-- queryable, rather than a way to wave the rule away — the index exempts only
-- this value, not 'other'.
-- 'different_document' covers the common case of a customer who has ID on file
-- presenting a different one — a licence last time, a passport today. Nothing is
-- being duplicated (that number has never been seen), so it never links and stays
-- indexed; it exists so the record says what actually happened instead of falling
-- back to 'other'. The distinction from 'id_changed' is real: "renewed" and
-- "presented a different type" are different answers to "why does this customer
-- have three documents on file?".
ALTER TABLE ttr.id_verifications
    ADD CONSTRAINT chk_idv_new_capture_reason_values CHECK (
        new_capture_reason IS NULL OR new_capture_reason IN (
            'id_changed',
            'stored_copy_unclear',
            'other',
            'different_person',
            'different_document'
        )
    );

-- Replaces the original constraint from 20260621000021_idverify_reliance.sql,
-- which hard-required prior_verification_id IS NULL on every new_capture row.
-- That is exactly the case this change needs to permit, so the constraint is
-- rewritten rather than added to.
--
-- For a new_capture row:
--   'stored_copy_unclear' MUST link — it re-photographs the same document, so
--     without a link it would be an untracked duplicate.
--   'id_changed' MAY link — Australian driver licence NUMBERS persist across
--     renewal (the card changes, the number does not), so a renewed licence
--     collides with the record on file and has to link to save. A genuinely new
--     document (new passport number) does not collide and links to nothing.
--     Requiring NULL here made the dropdown's own example unsatisfiable.
--   Everything else must NOT link.
--
-- trg_idv_recapture_link below guarantees any link points at the same document,
-- so an 'id_changed' link is only constructible when the number really is
-- unchanged — the two rules are self-consistent.
--
-- coalesce() is load-bearing in BOTH branches. A NULL reason makes a bare
-- `IN (...)` or `<>` evaluate to NULL rather than FALSE, and a CHECK that
-- evaluates to NULL passes — so without it, a link carrying no reason at all
-- would be accepted, which is the one thing this constraint exists to stop.
ALTER TABLE ttr.id_verifications DROP CONSTRAINT chk_idv_reliance_reason;

ALTER TABLE ttr.id_verifications
    ADD CONSTRAINT chk_idv_reliance_reason CHECK (
        (verification_basis = 'new_capture'
            AND reliance_reason IS NULL
            AND (
                (prior_verification_id IS NOT NULL
                    AND coalesce(new_capture_reason, '') IN ('stored_copy_unclear', 'id_changed'))
                OR
                (prior_verification_id IS NULL
                    AND coalesce(new_capture_reason, '') <> 'stored_copy_unclear')
            ))
        OR
        (verification_basis = 'relied_on_prior_identification'
            AND prior_verification_id IS NOT NULL
            AND reliance_reason IS NOT NULL
            AND new_capture_reason IS NULL)
    );

-- A re-capture must point at the prior record for the same document, not an
-- arbitrary row. Without this, the uniqueness index could be sidestepped by
-- linking a duplicate to any unrelated verification.
CREATE OR REPLACE FUNCTION ttr.check_idv_recapture_link()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = ttr
AS $$
DECLARE
    prior RECORD;
BEGIN
    IF NEW.verification_basis <> 'new_capture' OR NEW.prior_verification_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT document_type, document_number, reporting_entity_id
      INTO prior
      FROM ttr.id_verifications
     WHERE id = NEW.prior_verification_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'prior_verification_id % does not exist', NEW.prior_verification_id;
    END IF;

    IF prior.reporting_entity_id IS DISTINCT FROM NEW.reporting_entity_id THEN
        RAISE EXCEPTION 'prior verification % belongs to a different reporting entity',
            NEW.prior_verification_id;
    END IF;

    IF prior.document_type IS DISTINCT FROM NEW.document_type
       OR upper(btrim(prior.document_number)) IS DISTINCT FROM upper(btrim(NEW.document_number))
    THEN
        RAISE EXCEPTION
            're-capture must reference the prior verification of the same document (% %), not % %',
            prior.document_type, prior.document_number, NEW.document_type, NEW.document_number;
    END IF;

    RETURN NEW;
END;
$$;

-- Fires after trg_idv_consistency (alphabetical order for same-timing triggers),
-- which is what populates NEW.reporting_entity_id that this function compares.
CREATE TRIGGER trg_idv_recapture_link
    BEFORE INSERT OR UPDATE ON ttr.id_verifications
    FOR EACH ROW EXECUTE FUNCTION ttr.check_idv_recapture_link();

-- ─── Uniqueness: one copy of a document on file ──────────────────────────────
--
-- PRE-FLIGHT CHECK — run this before applying to any database holding real data.
-- Re-capture was unrestricted until now, so historical duplicates are plausible
-- and would make the index below fail to create:
--
--   SELECT t.reporting_entity_id,
--          idv.document_type,
--          upper(btrim(idv.document_number)) AS doc_number,
--          count(*)
--     FROM ttr.id_verifications idv
--     JOIN ttr.transactions t ON t.id = idv.transaction_id
--    WHERE idv.verification_basis = 'new_capture'
--    GROUP BY 1, 2, 3
--   HAVING count(*) > 1;
--
-- Any rows returned need a human decision. Deliberately not auto-resolved here.
--
-- Normalised (upper/trimmed) because a bare index is defeated by a trailing space
-- or a case difference. Reliance rows are excluded (verification_basis) because
-- they legitimately copy the same document number and are already chained via
-- prior_verification_id; linked re-captures are excluded for the same reason.
-- Both are tracked reuses. What remains blocked is the untracked second copy.
--
-- Deliberately role-agnostic — parties and conducting persons alike. The promise
-- is "we keep one copy of YOUR identification on file", which does not
-- distinguish a customer from someone transacting on their behalf. One index also
-- catches the crossover case (the same real person appearing as a customer on one
-- transaction and a conducting person on another), which two role-scoped indexes
-- would miss.
--
-- Applying this to every role is only safe because the UI's escape hatch keys on
-- the same thing this index does — see public.get_verification_for_document
-- below. An escape hatch keyed on anything else (a name lookup, say) is not
-- guaranteed to fire when this index blocks, and every non-coincidence would be a
-- dead end for staff rather than a prompt.
CREATE UNIQUE INDEX uq_idv_doc_new_capture
    ON ttr.id_verifications (reporting_entity_id, document_type, upper(btrim(document_number)))
    WHERE verification_basis = 'new_capture'
      AND prior_verification_id IS NULL
      AND new_capture_reason IS DISTINCT FROM 'different_person';

-- ─── Collision lookup ────────────────────────────────────────────────────────
--
-- Mirrors the index predicate exactly, so the UI can always tell staff what they
-- are colliding with instead of letting Postgres raise 23505 at save time.
-- Returns the same column shape as public.get_prior_verifications_individual so
-- the existing prior-verification picker, evaluateReliance() and signed-image
-- plumbing all work on the result unchanged.
--
-- Two deliberate omissions:
--   * No t.status = 'complete' filter. The index has none, so an abandoned draft
--     holding the number still blocks — filtering here would hide exactly the row
--     that causes the rejection.
--   * p_exclude_id lets an already-saved row avoid matching itself when its own
--     verification is reopened for editing.
--
-- At most one row can match, by definition of the unique index.
CREATE OR REPLACE FUNCTION public.get_verification_for_document(
  p_document_type   text,
  p_document_number text,
  p_exclude_id      uuid DEFAULT NULL
)
RETURNS TABLE (
  id                 uuid,
  document_type      text,
  document_number    text,
  issuer             text,
  has_expiry         boolean,
  expiry_date        date,
  verification_basis text,
  created_at         timestamptz,
  transaction_ref    text,
  verified_by_name   text,
  front_image_id     uuid,
  back_image_id      uuid
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    idv.id,
    idv.document_type::text,
    idv.document_number,
    idv.issuer,
    idv.has_expiry,
    idv.expiry_date,
    idv.verification_basis::text,
    idv.created_at,
    t.transaction_ref,
    t.staff_member_name AS verified_by_name,
    idv.front_image_id,
    idv.back_image_id
  FROM ttr.id_verifications idv
  JOIN ttr.transactions t ON t.id = idv.transaction_id
  WHERE idv.reporting_entity_id = public.reporting_entity_id()
    AND idv.verification_basis  = 'new_capture'
    AND idv.prior_verification_id IS NULL
    AND idv.new_capture_reason IS DISTINCT FROM 'different_person'
    AND idv.document_type::text = p_document_type
    AND upper(btrim(idv.document_number)) = upper(btrim(p_document_number))
    AND (p_exclude_id IS NULL OR idv.id <> p_exclude_id)
  LIMIT 1;
$$;
