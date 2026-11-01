-- pgTAP harness (inlined: `supabase test db` runs every .sql file here as a test, so a
-- shared helper file would fail for having no plan).
--   pg_temp.q_as   run a SELECT as a signed-in staff member (or anon), return rows as jsonb
--   pg_temp.dml_as run a write as that role, return 'ok:<rows>' or 'err:<sqlstate>'
--   pg_temp.n_as   number of rows q_as returned (-1 if it errored)
-- They switch role inside a function and switch back before returning, so the pgTAP calls
-- in the test body always run as the owner (pgTAP's temp tables are not visible to
-- `authenticated`).
-- `aal` is the JWT assurance level: public.reporting_entity_id() returns NULL unless aal2.

begin;
create extension if not exists pgtap with schema extensions;

create function pg_temp.q_as(p_uid uuid, p_aal text, p_sql text, p_role text default 'authenticated')
returns jsonb language plpgsql as $$
declare v jsonb;
begin
    perform set_config('request.jwt.claims',
        json_build_object('sub', p_uid, 'role', p_role, 'aal', p_aal)::text, true);
    execute format('set local role %I', p_role);
    begin
        execute 'select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from (' || p_sql || ') t' into v;
    exception when others then
        reset role;
        perform set_config('request.jwt.claims', '', true);
        return jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate);
    end;
    reset role;
    perform set_config('request.jwt.claims', '', true);
    return v;
end $$;

create function pg_temp.dml_as(p_uid uuid, p_aal text, p_sql text, p_role text default 'authenticated')
returns text language plpgsql as $$
declare n bigint;
begin
    perform set_config('request.jwt.claims',
        json_build_object('sub', p_uid, 'role', p_role, 'aal', p_aal)::text, true);
    execute format('set local role %I', p_role);
    begin
        execute p_sql;
        get diagnostics n = row_count;
    exception when others then
        reset role;
        perform set_config('request.jwt.claims', '', true);
        return 'err:' || sqlstate;
    end;
    reset role;
    perform set_config('request.jwt.claims', '', true);
    return 'ok:' || n;
end $$;

create function pg_temp.n_as(p_uid uuid, p_aal text, p_sql text, p_role text default 'authenticated')
returns int language plpgsql as $$
declare v jsonb := pg_temp.q_as(p_uid, p_aal, p_sql, p_role);
begin
    if jsonb_typeof(v) = 'object' then return -1; end if;
    return jsonb_array_length(v);
end $$;

create function pg_temp.u(p_label text) returns uuid language sql immutable as $$ select md5(p_label)::uuid $$;

-- A bare TTR transaction (status 'draft' or 'complete').
create function pg_temp.mk_tx(p_label text, p_entity uuid, p_status text default 'complete', p_ref text default null)
returns uuid language plpgsql as $$
begin
    insert into ttr.transactions
        (id, reporting_entity_id, created_by_staff_id, scenario, transaction_ref, transaction_datetime,
         designated_service, location_snapshot, staff_member_name, staff_member_email,
         cash_currency, cash_amount, aud_value, status, completed_at)
    values
        (pg_temp.u(p_label), p_entity, null, 'bullion_sell', coalesce(p_ref, 'REF-' || p_label), '2026-01-01',
         'Sale of bullion for physical cash', 'Coburg, VIC', 'Staff', 'staff@example.test',
         'AUD', 15000, 15000, p_status::transaction_status,
         case when p_status = 'complete' then timestamptz '2026-01-01' end);
    return pg_temp.u(p_label);
end $$;


-- ─── Fixtures ───────────────────────────────────────────────────────────────────────────────
-- Two entities. Entity One: an ordinary staff member (S1), a manager (M1) and an inactive staff
-- member (X1). Entity Two: staff (S2).
insert into public.reporting_entities (id, legal_name) values
    ('11111111-1111-1111-1111-111111111111', 'Entity One'),
    ('22222222-2222-2222-2222-222222222222', 'Entity Two');
insert into auth.users (id, email) values
    ('a1111111-1111-1111-1111-111111111111', 'staff1@entity-one.test'),
    ('a1111111-1111-1111-1111-111111111112', 'manager1@entity-one.test'),
    ('a1111111-1111-1111-1111-111111111114', 'inactive1@entity-one.test'),
    ('a2222222-2222-2222-2222-222222222222', 'staff2@entity-two.test');
insert into public.staff_members (id, reporting_entity_id, full_name, email, role, is_active) values
    ('a1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'Staff One',    'staff1@entity-one.test',    'staff',   true),
    ('a1111111-1111-1111-1111-111111111112', '11111111-1111-1111-1111-111111111111', 'Manager One',  'manager1@entity-one.test',  'manager', true),
    ('a1111111-1111-1111-1111-111111111114', '11111111-1111-1111-1111-111111111111', 'Inactive One', 'inactive1@entity-one.test', 'staff',   false),
    ('a2222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'Staff Two',    'staff2@entity-two.test',    'staff',   true);

-- Run a statement as the service role (what the edge functions use). Returns a jsonb array:
-- the rows, or [{"error", "sqlstate"}] when it raised.
create function pg_temp.svc(p_sql text) returns jsonb language sql as $$
    select case when jsonb_typeof(v) = 'object' then jsonb_build_array(v) else v end
    from (select pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2', p_sql, 'service_role') as v) q
$$;

create function pg_temp.cust(p_first text, p_last text, p_phone text default '0412 345 678', p_dob text default '1990-04-02')
returns jsonb language sql as $$
    select jsonb_build_object('first_name', p_first, 'middle_name', 'Q', 'last_name', p_last,
        'date_of_birth', p_dob, 'phone', p_phone, 'email', 'x@example.test',
        'res_street', '1 Test St', 'res_suburb', 'Coburg', 'res_state', 'VIC', 'res_postcode', '3058')
$$;

create function pg_temp.doc(p_type text, p_number text, p_other text default null)
returns jsonb language sql as $$
    select jsonb_build_object('document_type', p_type, 'document_type_other', p_other,
        'document_number', p_number, 'issuer', 'VIC', 'id_country_code', 'AU',
        'has_expiry', true, 'expiry_date', '2030-01-31')
$$;

create function pg_temp.imgs(p_customer uuid, p_ver uuid, p_tag text, p_front boolean default true, p_back boolean default true)
returns jsonb language sql as $$
    select coalesce(jsonb_agg(jsonb_build_object('side', s.side,
        'object_path', 'customers/' || p_customer || '/' || p_ver || '/' || s.side || '-' || p_tag || '.jpg',
        'content_hash_sha256', 'hash-' || p_tag || '-' || s.side, 'content_type', 'image/jpeg', 'byte_size', 1234)), '[]'::jsonb)
    from (select 'front' as side where p_front union all select 'back' where p_back) s
$$;

-- gold_create_customer(entity, staff, customer, verification, customer, aliases, id, images, different_person)
create function pg_temp.create_customer(
    p_label text, p_first text, p_last text, p_doc jsonb, p_back boolean default true,
    p_entity uuid default '11111111-1111-1111-1111-111111111111',
    p_staff uuid default 'a1111111-1111-1111-1111-111111111111',
    p_phone text default '0412 345 678', p_different boolean default false, p_front boolean default true
) returns jsonb language sql as $$
    select pg_temp.svc(format(
        $q$select public.gold_create_customer(%L, %L, %L, %L, %L::jsonb, %L::text[], %L::jsonb, %L::jsonb, %L) as r$q$,
        p_entity, p_staff, pg_temp.u('c_' || p_label), pg_temp.u('v_' || p_label),
        pg_temp.cust(p_first, p_last, p_phone), '{Janey,"J Citizen"}', p_doc,
        pg_temp.imgs(pg_temp.u('c_' || p_label), pg_temp.u('v_' || p_label), p_label, p_front, p_back), p_different))
$$;

-- gold_update_customer_id(entity, staff, customer, verification, reason, prior, id, images)
create function pg_temp.update_id(
    p_label text, p_customer text, p_reason text, p_prior uuid, p_doc jsonb,
    p_entity uuid default '11111111-1111-1111-1111-111111111111',
    p_staff uuid default 'a1111111-1111-1111-1111-111111111111', p_back boolean default true
) returns jsonb language sql as $$
    select pg_temp.svc(format(
        $q$select public.gold_update_customer_id(%L, %L, %L, %L, %L, %L, %L::jsonb, %L::jsonb) as r$q$,
        p_entity, p_staff, pg_temp.u('c_' || p_customer), pg_temp.u('v_' || p_label), p_reason, p_prior, p_doc,
        pg_temp.imgs(pg_temp.u('c_' || p_customer), pg_temp.u('v_' || p_label), p_label, true, p_back)))
$$;

create function pg_temp.update_customer(p_customer text, p_changes jsonb,
    p_entity uuid default '11111111-1111-1111-1111-111111111111',
    p_staff uuid default 'a1111111-1111-1111-1111-111111111112')
returns jsonb language sql as $$
    select pg_temp.svc(format($q$select public.gold_update_customer(%L, %L, %L, %L::jsonb) as r$q$,
        p_entity, p_staff, pg_temp.u('c_' || p_customer), p_changes))
$$;

select plan(97);

-- ═══ Grants ═══════════════════════════════════════════════════════════════════════════════════
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname in ('gold_create_customer', 'gold_update_customer_id', 'gold_update_customer', '_gold_assert_staff')
             and has_function_privilege('service_role', p.oid, 'execute')), 4,
    'the four write functions are executable by service_role');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname in ('gold_create_customer', 'gold_update_customer_id', 'gold_update_customer', '_gold_assert_staff')
             and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))), 0,
    'and by neither anon nor authenticated');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
                  lateral aclexplode(p.proacl) a
           where n.nspname = 'public' and a.grantee = 0 and a.privilege_type = 'EXECUTE'
             and p.proname in ('gold_create_customer', 'gold_update_customer_id', 'gold_update_customer', '_gold_assert_staff', 'update_customer_phone')), 0,
    'and PUBLIC holds no EXECUTE on any of them or on update_customer_phone');
select ok(has_function_privilege('authenticated', 'public.update_customer_phone(uuid, text)', 'execute')
          and not has_function_privilege('anon', 'public.update_customer_phone(uuid, text)', 'execute'),
    'update_customer_phone is executable by authenticated and not by anon');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        format($$select public.gold_create_customer(%L, %L, %L, %L, '{}'::jsonb, '{}', '{}'::jsonb, '[]'::jsonb, false)$$,
               '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', md5('g')::uuid, md5('g')::uuid)),
    'err:42501', 'a signed-in staff member cannot call gold_create_customer');
select is(pg_temp.dml_as(null, 'aal2', 'select public.gold_update_customer(null, null, null, ''{}'')', 'anon'),
    'err:42501', 'anon cannot call gold_update_customer');

-- ═══ gold_create_customer ═════════════════════════════════════════════════════════════════════
create temp table r_create as
    select pg_temp.create_customer('one', 'Jane', 'Citizen', pg_temp.doc('Driver licence', 'DL-100')) as j;

select is((select j->0->'r'->>'customer_id' from r_create), pg_temp.u('c_one')::text, 'create returns the customer id');
select is((select j->0->'r'->>'verification_id' from r_create), pg_temp.u('v_one')::text, 'and the verification id');
select ok((select (j->0->'r'->>'front_image_id') is not null and (j->0->'r'->>'back_image_id') is not null from r_create),
    'and both image ids');

select results_eq(
    $$select source, customer_type::text, reporting_entity_id, created_by_staff_id, first_name, middle_name, last_name,
             date_of_birth, phone, email, res_street, res_suburb, res_state::text, res_postcode, res_country
      from public.customers where id = pg_temp.u('c_one')$$,
    $$values ('gold', 'individual', '11111111-1111-1111-1111-111111111111'::uuid, 'a1111111-1111-1111-1111-111111111111'::uuid,
              'Jane', 'Q', 'Citizen', date '1990-04-02', '0412 345 678', 'x@example.test',
              '1 Test St', 'Coburg', 'VIC', '3058', 'Australia')$$,
    'the customer row has source gold, the server-chosen entity and staff, and every field');
select results_eq(
    $$select alias, sort_order::int from public.customer_aliases where customer_id = pg_temp.u('c_one') order by sort_order$$,
    $$values ('Janey', 0), ('J Citizen', 1)$$, 'aliases are saved in order');

select results_eq(
    $$select transaction_id is null, party_id is null, conducting_person_id is null, customer_id, verification_basis::text,
             new_capture_reason is null, prior_verification_id is null, is_complete, verification_method::text,
             document_type::text, document_number, issuer, id_country_code::text, has_expiry, expiry_date,
             verification_description, reporting_entity_id
      from ttr.id_verifications where id = pg_temp.u('v_one')$$,
    $$values (true, true, true, pg_temp.u('c_one'), 'new_capture', true, true, true, 'Sighted original document',
              'Driver licence', 'DL-100', 'VIC', 'AU', true, date '2030-01-31',
              'Original Driver licence sighted in person', '11111111-1111-1111-1111-111111111111'::uuid)$$,
    'a customer-level new_capture row: no transaction, party or conducting person, entity from the customer');
select is((select count(*)::int from ttr.id_verifications where front_image_id is not null and back_image_id is not null
           and id = pg_temp.u('v_one')), 1, 'the capture references both photos');
select results_eq(
    $$select customer_id, transaction_id is null, storage_bucket, side, captured_by_staff_id, content_hash_sha256, superseded_at is null
      from (select *, case when object_path like '%/front-%' then 'front' else 'back' end as side
            from ttr.stored_images where customer_id = pg_temp.u('c_one')) s order by side$$,
    $$values (pg_temp.u('c_one'), true, 'compliance-media', 'back',  'a1111111-1111-1111-1111-111111111111'::uuid, 'hash-one-back',  true),
             (pg_temp.u('c_one'), true, 'compliance-media', 'front', 'a1111111-1111-1111-1111-111111111111'::uuid, 'hash-one-front', true)$$,
    'both photos are customer-owned, in compliance-media, with their hashes and the capturing staff member');
select is((select count(*)::int from ttr.stored_images where customer_id = pg_temp.u('c_one')
           and object_path like 'customers/' || pg_temp.u('c_one') || '/' || pg_temp.u('v_one') || '/%'), 2,
    'and stored under customers/{customer_id}/');

select results_eq(
    $$select count(*)::int, min(source), min(changed_by::text), min(reporting_entity_id::text)
      from public.customer_audit_log where customer_id = pg_temp.u('c_one')$$,
    $$values (1, 'gold_create', 'a1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111')$$,
    'exactly one audit row, source gold_create, by the staff member');
select results_eq(
    $$select changes->'first_name', changes->'phone'->'new', changes->'phone'->'old', changes->'aliases'->'new',
             changes ? 'source', changes ? 'created_by_staff_id', changes ? 'id'
      from public.customer_audit_log where customer_id = pg_temp.u('c_one')$$,
    $$values ('{"old": null, "new": "Jane"}'::jsonb, '"0412 345 678"'::jsonb, 'null'::jsonb, '["Janey", "J Citizen"]'::jsonb,
              false, false, false)$$,
    'the audit row holds old (null) -> new for each value, and no system columns');

select is((select count(*)::int from ttr.parties) + (select count(*)::int from ttr.transactions), 0,
    'creating a customer makes no party and no transaction');

-- Boundaries and refusals leave nothing behind.
select is(pg_temp.create_customer('ph7', 'Seven', 'Digits', pg_temp.doc('Passport', 'PP-7'), false, p_phone => '123 4567')->0->>'error',
    'invalid_phone', 'a 7-digit phone is refused');
select is(pg_temp.create_customer('ph8', 'Eight', 'Digits', pg_temp.doc('Passport', 'PP-8'), false, p_phone => '1234 5678')->0->'r'->>'customer_id',
    pg_temp.u('c_ph8')::text, 'an 8-digit phone is accepted');
select is(pg_temp.create_customer('ph7', 'Seven', 'Digits', pg_temp.doc('Passport', 'PP-7'), false, p_phone => '+61 (0) 12-34')->0->>'error',
    'invalid_phone', 'punctuation does not count towards the 8 digits');
select is((select count(*)::int from public.customers where id = pg_temp.u('c_ph7')), 0, 'and the refused customer was not written');

select is(pg_temp.create_customer('nb', 'No', 'Back', pg_temp.doc('Driver licence', 'DL-NB'), false)->0->>'error',
    'back_image_required', 'a driver licence without a back photo is refused');
select is(pg_temp.create_customer('nf', 'No', 'Front', pg_temp.doc('Passport', 'PP-NF'), false, p_front => false)->0->>'error',
    'front_image_required', 'no front photo is refused');
select is(pg_temp.create_customer('pp', 'Pass', 'Port', pg_temp.doc('Passport', 'PP-1'), false)->0->'r'->>'back_image_id', null,
    'a passport needs no back photo');

select is((select (select count(*) from public.customers where id = pg_temp.u('c_nb'))
                + (select count(*) from public.customer_aliases where customer_id = pg_temp.u('c_nb'))
                + (select count(*) from ttr.stored_images where customer_id = pg_temp.u('c_nb'))
                + (select count(*) from ttr.id_verifications where customer_id = pg_temp.u('c_nb'))
                + (select count(*) from public.customer_audit_log where customer_id = pg_temp.u('c_nb'))), 0::bigint,
    'atomic: a failure after the customer, aliases and photos were written leaves no row in any table');
select is((select (select count(*) from public.customers where id = pg_temp.u('c_nf'))
                + (select count(*) from ttr.stored_images where customer_id = pg_temp.u('c_nf'))
                + (select count(*) from public.customer_audit_log where customer_id = pg_temp.u('c_nf'))), 0::bigint,
    'atomic: a failure with no front photo leaves nothing');

-- The same document number again.
select is(pg_temp.create_customer('dup', 'Dup', 'Licate', pg_temp.doc('Driver licence', 'dl-100 '))->0->>'sqlstate', '23505',
    'the same document number (any case or padding) is refused by the uniqueness index');
select is((select (select count(*) from public.customers where id = pg_temp.u('c_dup'))
                + (select count(*) from ttr.stored_images where customer_id = pg_temp.u('c_dup'))
                + (select count(*) from public.customer_audit_log where customer_id = pg_temp.u('c_dup'))), 0::bigint,
    'atomic: and nothing of that attempt remains');
select is(pg_temp.create_customer('dp', 'Diff', 'Erent', pg_temp.doc('Driver licence', 'DL-100'), true, p_different => true)->0->'r'->>'customer_id',
    pg_temp.u('c_dp')::text, 'the same number saves when the operator says different person');
select is((select new_capture_reason from ttr.id_verifications where id = pg_temp.u('v_dp')), 'different_person',
    'and is recorded as different_person');
select is(pg_temp.create_customer('dp2', 'Diff', 'Erent2', pg_temp.doc('Driver licence', 'DL-100'), true, p_different => true)->0->'r'->>'customer_id',
    pg_temp.u('c_dp2')::text, 'a third holder of the number may also be a different person');
select is(pg_temp.create_customer('oth', 'Doc', 'Other', pg_temp.doc('Other', 'OT-1', 'Student card'), false)->0->'r'->>'verification_id',
    pg_temp.u('v_oth')::text, 'document type Other saves with its description');
select is((select verification_description from ttr.id_verifications where id = pg_temp.u('v_oth')),
    'Original Student card sighted in person', 'and the description names it');

-- Entity and staff are checked inside the function.
select is(pg_temp.create_customer('x2', 'Cross', 'Entity', pg_temp.doc('Passport', 'PP-X2'), false,
        p_entity => '22222222-2222-2222-2222-222222222222', p_staff => 'a1111111-1111-1111-1111-111111111111')->0->>'sqlstate', '42501',
    'a staff member of another entity cannot create into this one');
select is(pg_temp.create_customer('x3', 'Cross', 'Entity', pg_temp.doc('Passport', 'PP-X3'), false,
        p_entity => '11111111-1111-1111-1111-111111111111', p_staff => 'a2222222-2222-2222-2222-222222222222')->0->>'sqlstate', '42501',
    'nor into another entity by naming its staff');
select is(pg_temp.create_customer('x4', 'Inactive', 'Staff', pg_temp.doc('Passport', 'PP-X4'), false,
        p_entity => '11111111-1111-1111-1111-111111111111', p_staff => 'a1111111-1111-1111-1111-111111111114')->0->>'sqlstate', '42501',
    'an inactive staff member cannot create');
select is(pg_temp.create_customer('x5', 'No', 'Staff', pg_temp.doc('Passport', 'PP-X5'), false,
        p_entity => '11111111-1111-1111-1111-111111111111', p_staff => md5('nobody')::uuid)->0->>'sqlstate', '42501',
    'an unknown staff id cannot create');
select is((select count(*)::int from public.customers where id in (pg_temp.u('c_x2'), pg_temp.u('c_x3'), pg_temp.u('c_x4'), pg_temp.u('c_x5'))), 0,
    'and none of those customers exist');

-- ═══ gold_update_customer_id ══════════════════════════════════════════════════════════════════
-- Customer c_one holds Driver licence DL-100 (v_one, 2 photos). c_dp holds the same number as a
-- different person (v_dp, 2 photos); it must never be touched by c_one's renewals.
create temp table r_renew as
    select pg_temp.update_id('ren1', 'one', 'id_changed', pg_temp.u('v_one'), pg_temp.doc('Driver licence', 'DL-100')) as j;

select results_eq(
    $$select new_capture_reason, prior_verification_id, customer_id, transaction_id is null, verification_basis::text, is_complete
      from ttr.id_verifications where id = pg_temp.u('v_ren1')$$,
    $$values ('id_changed', pg_temp.u('v_one'), pg_temp.u('c_one'), true, 'new_capture', true)$$,
    'renewed: a new customer-level capture, id_changed, linked to the capture on file');
select is((select count(*)::int from jsonb_array_elements_text((select j->0->'r'->'stale_image_ids' from r_renew)) i
           where i::uuid in (select front_image_id from ttr.id_verifications where id = pg_temp.u('v_one')
                             union select back_image_id from ttr.id_verifications where id = pg_temp.u('v_one'))), 2,
    'and returns the two old photos of that document to be superseded');
select is(jsonb_array_length((select j->0->'r'->'stale_image_ids' from r_renew)), 2,
    'and only those two: not the new photos, not the different person''s');
select is((select count(*)::int from ttr.stored_images where customer_id = pg_temp.u('c_one')), 4,
    'the new photos are stored beside the old (the function does not delete or stamp)');
select is((select count(*)::int from ttr.stored_images where customer_id = pg_temp.u('c_one') and superseded_at is not null), 0,
    'superseding is left to the caller, after the commit');
select results_eq($$select document_number, prior_verification_id is null from ttr.id_verifications where id = pg_temp.u('v_one')$$,
    $$values ('DL-100', true)$$, 'the old capture row is unchanged');

-- A different document: unlinked, nothing to supersede.
create temp table r_other as
    select pg_temp.update_id('pass1', 'one', 'different_document', null, pg_temp.doc('Passport', 'PP-ONE'), p_back => false) as j;
select results_eq(
    $$select new_capture_reason, prior_verification_id is null from ttr.id_verifications where id = pg_temp.u('v_pass1')$$,
    $$values ('different_document', true)$$, 'different document: saved unlinked');
select is(jsonb_array_length((select j->0->'r'->'stale_image_ids' from r_other)), 0,
    'and nothing is returned to supersede: earlier photos stay');
select is((select count(*)::int from ttr.stored_images where customer_id = pg_temp.u('c_one') and superseded_at is null), 5,
    'all earlier photos are still live');

-- Photo unclear: linked again. Chain root is v_one, so the earlier renewal's photos are stale, the
-- passport's are not, and photos already superseded are not returned again.
update ttr.stored_images set superseded_at = now(), superseded_by_image_id = (select front_image_id from ttr.id_verifications where id = pg_temp.u('v_ren1'))
 where id in (select front_image_id from ttr.id_verifications where id = pg_temp.u('v_one')
              union select back_image_id from ttr.id_verifications where id = pg_temp.u('v_one'));
create temp table r_unclear as
    select pg_temp.update_id('unc1', 'one', 'stored_copy_unclear', pg_temp.u('v_one'), pg_temp.doc('Driver licence', 'DL-100')) as j;
select results_eq(
    $$select new_capture_reason, prior_verification_id from ttr.id_verifications where id = pg_temp.u('v_unc1')$$,
    $$values ('stored_copy_unclear', pg_temp.u('v_one'))$$, 'photo unclear: stored_copy_unclear, linked');
select is((select array_agg(i::uuid order by i) from jsonb_array_elements_text((select j->0->'r'->'stale_image_ids' from r_unclear)) i),
    (select array_agg(x order by x) from (select front_image_id as x from ttr.id_verifications where id = pg_temp.u('v_ren1')
                                          union select back_image_id from ttr.id_verifications where id = pg_temp.u('v_ren1')) s),
    'only the previous renewal''s photos are returned: not the passport''s, not those already superseded');

-- Refusals roll back, photos included.
select is(pg_temp.update_id('bad1', 'one', 'stored_copy_unclear', null, pg_temp.doc('Driver licence', 'DL-100'))->0->>'sqlstate', '23514',
    'stored_copy_unclear without a link is refused');
select is(pg_temp.update_id('bad2', 'one', 'id_changed', pg_temp.u('v_dp'), pg_temp.doc('Driver licence', 'DL-100'))->0->>'error', 'prior_not_found',
    'a link to another customer''s capture is refused');
select is(pg_temp.update_id('bad3', 'one', 'id_changed', pg_temp.u('v_one'), pg_temp.doc('Passport', 'PP-NEW'))->0->>'sqlstate', 'P0001',
    'a link to a different document is refused by the re-capture trigger');
select is(pg_temp.update_id('bad4', 'one', 'different_document', null, pg_temp.doc('Driver licence', 'DL-100'))->0->>'sqlstate', '23505',
    'an unlinked copy of a document already on file is refused by the uniqueness index');
select is(pg_temp.update_id('bad5', 'one', 'renewed', null, pg_temp.doc('Passport', 'PP-X'))->0->>'error', 'invalid_reason',
    'only the three stored reasons are accepted');
select is(pg_temp.update_id('bad6', 'one', 'id_changed', pg_temp.u('v_one'), pg_temp.doc('Driver licence', 'DL-100'),
        p_back => false)->0->>'error', 'back_image_required', 'a driver licence update without a back photo is refused');
select is((select count(*)::int from ttr.stored_images where customer_id = pg_temp.u('c_one')), 7,
    'atomic: no photo of any refused update remains (2 + 2 + 1 + 2 = 7 stored)');
select is((select count(*)::int from ttr.id_verifications where customer_id = pg_temp.u('c_one')), 4,
    'and no capture row remains (one, ren1, pass1, unc1)');

select is(pg_temp.update_id('x1', 'one', 'id_changed', pg_temp.u('v_one'), pg_temp.doc('Driver licence', 'DL-100'),
        p_entity => '22222222-2222-2222-2222-222222222222', p_staff => 'a2222222-2222-2222-2222-222222222222')->0->>'error', 'customer_not_found',
    'another entity''s staff cannot update this customer''s ID');
select is(pg_temp.update_id('x2', 'one', 'id_changed', pg_temp.u('v_one'), pg_temp.doc('Driver licence', 'DL-100'),
        p_entity => '11111111-1111-1111-1111-111111111111', p_staff => 'a1111111-1111-1111-1111-111111111114')->0->>'sqlstate', '42501',
    'an inactive staff member cannot update an ID');
select is(pg_temp.update_id('x3', 'nobody', 'id_changed', null, pg_temp.doc('Passport', 'PP-X3'))->0->>'error', 'customer_not_found',
    'an unknown customer is customer_not_found');

-- ═══ gold_update_customer ═════════════════════════════════════════════════════════════════════
-- A completed TTR holds a party copy of c_one: it must not change.
select pg_temp.mk_tx('t1', '11111111-1111-1111-1111-111111111111');
insert into ttr.parties (id, transaction_id, party_type, first_name, last_name, date_of_birth, phone, res_street, res_suburb, res_state, res_postcode, customer_id)
values (pg_temp.u('party1'), pg_temp.u('t1'), 'individual', 'Jane', 'Citizen', '1990-04-02', '0412 345 678', '1 Test St', 'Coburg', 'VIC', '3058', pg_temp.u('c_one'));
create temp table party_before as select to_jsonb(p) as j from ttr.parties p where id = pg_temp.u('party1');

create temp table r_edit as
    select pg_temp.update_customer('one', '{"first_name": "Janet", "res_street": "9 New St", "email": null, "last_name": "Citizen"}') as j;
select is((select array_agg(c order by c) from jsonb_array_elements_text((select j->0->'r'->'changed' from r_edit)) c),
    array['email', 'first_name', 'res_street'], 'update reports the columns that really changed (last_name was sent equal)');
select results_eq($$select first_name, res_street, email, last_name from public.customers where id = pg_temp.u('c_one')$$,
    $$values ('Janet', '9 New St', null, 'Citizen')$$, 'and applies them');
select results_eq(
    $$select count(*)::int, min(source), min(changed_by::text)
      from public.customer_audit_log where customer_id = pg_temp.u('c_one') and source = 'gold_edit'$$,
    $$values (1, 'gold_edit', 'a1111111-1111-1111-1111-111111111112')$$,
    'one gold_edit audit row, by the manager');
select results_eq(
    $$select changes from public.customer_audit_log where customer_id = pg_temp.u('c_one') and source = 'gold_edit'$$,
    $$values ('{"first_name": {"old": "Jane", "new": "Janet"},
               "res_street": {"old": "1 Test St", "new": "9 New St"},
               "email": {"old": "x@example.test", "new": null}}'::jsonb)$$,
    'holding old -> new for every changed column and nothing else');
select is((select to_jsonb(p) from ttr.parties p where id = pg_temp.u('party1')), (select j from party_before),
    'the past TTR party copy is unchanged');
select is((select count(*)::int from ttr.parties where customer_id = pg_temp.u('c_one')), 1, 'and still linked');

select is(jsonb_array_length(pg_temp.update_customer('one', '{"first_name": "Janet"}')->0->'r'->'changed'), 0,
    'sending the current value changes nothing');
select is((select count(*)::int from public.customer_audit_log where customer_id = pg_temp.u('c_one') and source = 'gold_edit'), 1,
    'and writes no audit row');
select is(jsonb_array_length(pg_temp.update_customer('one', '{}')->0->'r'->'changed'), 0, 'an empty change set is a no-op');

select is(pg_temp.update_customer('one', '{"document_number": "X"}')->0->>'error', 'invalid_field', 'ID details are refused');
select is(pg_temp.update_customer('one', '{"reporting_entity_id": "22222222-2222-2222-2222-222222222222"}')->0->>'error', 'invalid_field',
    'moving a customer to another entity is refused');
select is(pg_temp.update_customer('one', '{"source": "ttr"}')->0->>'error', 'invalid_field', 'source cannot be changed');
select is(pg_temp.update_customer('one', '{"phone": "1234567"}')->0->>'error', 'invalid_phone', 'a 7-digit phone is refused');
select is(pg_temp.update_customer('one', '{"phone": null}')->0->>'error', 'invalid_phone', 'a phone cannot be cleared');
select is(pg_temp.update_customer('one', '{"phone": "1234 5678"}')->0->'r'->'changed', '["phone"]'::jsonb, 'an 8-digit phone is accepted');
select is(pg_temp.update_customer('one', '{"first_name": null}')->0->>'sqlstate', '23514', 'the first name cannot be cleared');
select results_eq($$select first_name, res_street from public.customers where id = pg_temp.u('c_one')$$,
    $$values ('Janet', '9 New St')$$, 'atomic: a refused update changes nothing (first_name still Janet)');
select is(pg_temp.update_customer('one', '{"first_name": "Nope"}', '22222222-2222-2222-2222-222222222222', 'a2222222-2222-2222-2222-222222222222')->0->>'error',
    'customer_not_found', 'another entity''s staff cannot edit this customer');
select is(pg_temp.update_customer('one', '{"first_name": "Nope"}', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111114')->0->>'sqlstate',
    '42501', 'an inactive staff member cannot edit');
select is((select first_name from public.customers where id = pg_temp.u('c_one')), 'Janet', 'and the customer is unchanged by those refusals');

insert into public.customers (id, reporting_entity_id, customer_type, source, entity_name, reg_identifier)
values (pg_temp.u('c_co'), '11111111-1111-1111-1111-111111111111', 'company', 'ttr', 'Acme Pty Ltd', '12345678901');
select is(pg_temp.update_customer('co', '{"phone": "0412 345 678"}')->0->>'error', 'customer_not_found', 'a company customer is not editable here');

-- ═══ update_customer_phone ════════════════════════════════════════════════════════════════════
create temp table phone_party_before as select to_jsonb(p) as j from ttr.parties p where id = pg_temp.u('party1');
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        format($$select public.update_customer_phone(%L, '0499 111 222') as changed$$, pg_temp.u('c_one')))->0->>'changed', 'true',
    'an ordinary staff member changes a phone');
select results_eq($$select phone from public.customers where id = pg_temp.u('c_one')$$, $$values ('0499 111 222')$$, 'and it is saved');
select results_eq(
    $$select count(*)::int, min(source), min(changed_by::text), min(changes::text)
      from public.customer_audit_log where customer_id = pg_temp.u('c_one') and source = 'phone_change'$$,
    $$values (1, 'phone_change', 'a1111111-1111-1111-1111-111111111111',
              '{"phone": {"new": "0499 111 222", "old": "1234 5678"}}')$$,
    'audited: one phone_change row, by the caller, old -> new for the phone only');
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        format($$select public.update_customer_phone(%L, ' 0499 111 222 ') as changed$$, pg_temp.u('c_one')))->0->>'changed', 'false',
    'the same number (trimmed) changes nothing');
select is((select count(*)::int from public.customer_audit_log where customer_id = pg_temp.u('c_one') and source = 'phone_change'), 1,
    'and writes no audit row');
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        format($$select public.update_customer_phone(%L, '1234567')$$, pg_temp.u('c_one')))->>'error', 'invalid_phone', 'a 7-digit phone is refused');
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        format($$select public.update_customer_phone(%L, '')$$, pg_temp.u('c_one')))->>'error', 'invalid_phone', 'an empty phone is refused');
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal1',
        format($$select public.update_customer_phone(%L, '0499 111 333')$$, pg_temp.u('c_one')))->>'sqlstate', '42501', 'aal1 is refused');
select is(pg_temp.q_as(null, 'aal2',
        format($$select public.update_customer_phone(%L, '0499 111 333')$$, pg_temp.u('c_one')), 'anon')->>'sqlstate', '42501', 'anon is refused');
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111114', 'aal2',
        format($$select public.update_customer_phone(%L, '0499 111 333')$$, pg_temp.u('c_one')))->>'sqlstate', '42501', 'an inactive staff member is refused');
select is(pg_temp.q_as('a2222222-2222-2222-2222-222222222222', 'aal2',
        format($$select public.update_customer_phone(%L, '0499 111 333')$$, pg_temp.u('c_one')))->>'error', 'customer_not_found',
    'another entity''s staff cannot change this customer''s phone');
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        format($$select public.update_customer_phone(%L, '0499 111 333')$$, pg_temp.u('c_co')))->>'error', 'customer_not_found',
    'a company customer is refused');
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        format($$select public.update_customer_phone(%L, '(03) 9123 4567') as changed$$, pg_temp.u('c_one')))->0->>'changed', 'true',
    'a phone with punctuation and 8 or more digits is accepted');
select is((select phone from public.customers where id = pg_temp.u('c_one')), '(03) 9123 4567', 'and refusals changed nothing in between');
select is((select to_jsonb(p) from ttr.parties p where id = pg_temp.u('party1')), (select j from phone_party_before),
    'the past TTR party copy still has its own phone');

select * from finish();
rollback;
