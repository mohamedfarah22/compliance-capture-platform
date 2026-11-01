-- pgTAP harness (inlined: `supabase test db` runs every .sql file here as a test, so a
-- shared helper file would fail for having no plan).
--   pg_temp.q_as   run a SELECT as a signed-in staff member (or anon), return rows as jsonb
--   pg_temp.dml_as run a write as that role, return 'ok:<rows>' or 'err:<sqlstate>'
-- Both switch role inside a function and switch back before returning, so the pgTAP calls
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

-- Fixtures: two reporting entities, one staff member in each.
insert into public.reporting_entities (id, legal_name) values
    ('11111111-1111-1111-1111-111111111111', 'Entity One'),
    ('22222222-2222-2222-2222-222222222222', 'Entity Two');
insert into auth.users (id, email) values
    ('a1111111-1111-1111-1111-111111111111', 'staff1@entity-one.test'),
    ('a2222222-2222-2222-2222-222222222222', 'staff2@entity-two.test');
insert into public.staff_members (id, reporting_entity_id, full_name, email) values
    ('a1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'Staff One', 'staff1@entity-one.test'),
    ('a2222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'Staff Two', 'staff2@entity-two.test');

-- Party fixtures. Labels become deterministic uuids so tests can refer to rows by name.
create function pg_temp.u(p_label text) returns uuid language sql immutable as $$ select md5(p_label)::uuid $$;

create function pg_temp.mk_tx(p_label text, p_entity uuid, p_status text default 'complete', p_staff uuid default null)
returns void language sql as $$
    insert into ttr.transactions
        (id, reporting_entity_id, created_by_staff_id, scenario, transaction_ref, transaction_datetime,
         designated_service, location_snapshot, staff_member_name, staff_member_email,
         cash_currency, cash_amount, aud_value, status, completed_at)
    values
        (pg_temp.u(p_label), p_entity, p_staff, 'bullion_sell', 'REF-' || p_label, '2026-01-01',
         'Sale of bullion for physical cash', 'Coburg, VIC', 'Staff', 'staff@example.test',
         'AUD', 15000, 15000, p_status::transaction_status,
         case when p_status = 'complete' then timestamptz '2026-01-01' end)
$$;

create function pg_temp.mk_ind(
    p_label text, p_tx text, p_first text, p_last text, p_dob date,
    p_updated timestamptz default '2026-01-01', p_complete boolean default true,
    p_alias text default null, p_phone text default null, p_occupation text default null,
    p_legal_form co_legal_form default null, p_post_street text default null
) returns void language plpgsql as $$
begin
    insert into ttr.parties
        (id, transaction_id, party_type, is_complete, first_name, last_name, date_of_birth, phone,
         occupation, legal_form, res_street, res_suburb, res_state, res_postcode,
         has_postal_address, post_street, post_suburb, updated_at)
    values
        (pg_temp.u(p_label), pg_temp.u(p_tx), 'individual', p_complete, p_first, p_last, p_dob, p_phone,
         p_occupation, p_legal_form, '1 Test St', 'Coburg', 'VIC', '3058',
         p_post_street is not null, p_post_street, case when p_post_street is not null then 'Postville' end,
         p_updated);
    if p_alias is not null then
        insert into ttr.party_aliases (party_id, alias) values (pg_temp.u(p_label), p_alias);
    end if;
end $$;

create function pg_temp.mk_co(
    p_label text, p_tx text, p_name text, p_reg text,
    p_updated timestamptz default '2026-01-01', p_complete boolean default true
) returns void language sql as $$
    insert into ttr.parties
        (id, transaction_id, party_type, is_complete, entity_name, reg_identifier, reg_id_type,
         biz_street, biz_suburb, biz_state, biz_postcode, updated_at)
    values
        (pg_temp.u(p_label), pg_temp.u(p_tx), 'company', p_complete, p_name, p_reg, 'ABN',
         '9 Biz Rd', 'Bizville', 'VIC', '3000', p_updated)
$$;

-- Ã¢â€â‚¬Ã¢â€â‚¬ Fixtures specific to the ID store Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
create function pg_temp.mk_cimg(p_label text, p_customer uuid, p_path text default null,
    p_staff uuid default 'a1111111-1111-1111-1111-111111111111')
returns void language sql as $$
    insert into ttr.stored_images (id, customer_id, object_path, content_hash_sha256, captured_by_staff_id)
    values (pg_temp.u(p_label), p_customer,
            coalesce(p_path, 'customers/' || p_customer || '/' || pg_temp.u(p_label) || '/front-x.jpg'),
            'hash-' || p_label, p_staff)
$$;

-- A customer-level capture (no transaction, party or conducting person).
create function pg_temp.mk_cidv(p_label text, p_customer uuid, p_doc text, p_num text,
    p_front text default null, p_created timestamptz default '2026-03-01')
returns void language sql as $$
    insert into ttr.id_verifications
        (id, customer_id, verification_method, document_type, document_number,
         verification_description, is_complete, front_image_id, created_at)
    values
        (pg_temp.u(p_label), p_customer, 'Sighted original document', p_doc::id_doc_type, p_num,
         'Sighted in person', true, case when p_front is null then null else pg_temp.u(p_front) end, p_created)
$$;

-- A TTR party capture (customer_id left null, as before this change).
create function pg_temp.mk_pidv(p_label text, p_party text, p_tx text, p_doc text, p_num text,
    p_basis text default 'new_capture', p_prior text default null)
returns void language sql as $$
    insert into ttr.id_verifications
        (id, transaction_id, party_id, verification_method, document_type, document_number,
         verification_description, verification_basis, prior_verification_id, reliance_reason, is_complete)
    values
        (pg_temp.u(p_label), pg_temp.u(p_tx), pg_temp.u(p_party), 'Sighted original document',
         p_doc::id_doc_type, p_num, 'Sighted in person', p_basis::id_verification_basis,
         case when p_prior is null then null else pg_temp.u(p_prior) end,
         case when p_basis = 'relied_on_prior_identification' then 'customer_known_to_business' end, true)
$$;

create function pg_temp.mk_cp(p_label text, p_tx text) returns void language sql as $$
    insert into ttr.conducting_persons
        (id, transaction_id, full_name, res_street, res_suburb, res_state, res_postcode,
         relationship, relationship_other, authority_to_act)
    values
        (pg_temp.u(p_label), pg_temp.u(p_tx), 'Con Ducting', '1 Test St', 'Coburg', 'VIC', '3058',
         'Other', 'friend', 'verbal')
$$;

insert into public.customers (id, reporting_entity_id, customer_type, source, first_name, last_name, date_of_birth) values
    ('c1000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'individual', 'gold', 'Alice', 'Gold',    '1980-01-01'),
    ('c1000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'individual', 'ttr',  'Alan',  'Other',   '1990-02-02'),
    ('c1000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'individual', 'ttr',  'Bea',   'Backfill','1960-06-06'),
    ('c2000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'individual', 'gold', 'Xena',  'Foreign', '1975-05-05');

select plan(63);

-- Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â A. stored_images owner rules Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
select pg_temp.mk_tx('t_draft', '11111111-1111-1111-1111-111111111111', 'draft', 'a1111111-1111-1111-1111-111111111111');

select lives_ok(
    $$select pg_temp.mk_cimg('img_c1_front', 'c1000000-0000-0000-0000-000000000001')$$,
    'a customer-owned image with a customers/{id}/ path is accepted');
select pg_temp.mk_cimg('img_c1_back', 'c1000000-0000-0000-0000-000000000001');
select pg_temp.mk_cimg('img_cx_front', 'c2000000-0000-0000-0000-000000000001', null,
    'a2222222-2222-2222-2222-222222222222');
select lives_ok(
    $$insert into ttr.stored_images (transaction_id, object_path, content_hash_sha256, captured_by_staff_id)
      values (md5('t_draft')::uuid, md5('t_draft')::uuid || '/party-x-front.jpg', 'h', 'a1111111-1111-1111-1111-111111111111')$$,
    'a transaction-owned image with its {transaction_id}/ path is still accepted');

select throws_ok(
    $$insert into ttr.stored_images (transaction_id, customer_id, object_path, content_hash_sha256, captured_by_staff_id)
      values (md5('t_draft')::uuid, 'c1000000-0000-0000-0000-000000000001', md5('t_draft')::uuid || '/both.jpg', 'h',
              'a1111111-1111-1111-1111-111111111111')$$,
    '23514', null, 'an image with both a transaction and a customer is rejected');
select throws_ok(
    $$insert into ttr.stored_images (object_path, content_hash_sha256, captured_by_staff_id)
      values ('customers/orphan.jpg', 'h', 'a1111111-1111-1111-1111-111111111111')$$,
    '23514', null, 'an image with neither owner is rejected');
select throws_ok(
    $$select pg_temp.mk_cimg('bad1', 'c1000000-0000-0000-0000-000000000001', 'somewhere/else.jpg')$$,
    '23514', null, 'a customer image outside customers/{id}/ is rejected');
select throws_ok(
    $$select pg_temp.mk_cimg('bad2', 'c1000000-0000-0000-0000-000000000002',
        'customers/c1000000-0000-0000-0000-000000000001/x.jpg')$$,
    '23514', null, 'a customer image under another customer''s prefix is rejected');
select throws_ok(
    $$insert into ttr.stored_images (transaction_id, object_path, content_hash_sha256, captured_by_staff_id)
      values (md5('t_draft')::uuid, 'customers/c1000000-0000-0000-0000-000000000001/x.jpg', 'h',
              'a1111111-1111-1111-1111-111111111111')$$,
    '23514', null, 'a transaction-owned image under customers/ is rejected');

-- RLS on stored_images: customer photos are visible to the customer's entity only; the
-- browser cannot write them.
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        'select count(*) as n from ttr.stored_images where customer_id is not null')->0->>'n', '2',
    'staff see their entity''s customer photos (and not the other entity''s)');
select is(pg_temp.q_as('a2222222-2222-2222-2222-222222222222', 'aal2',
        'select count(*) as n from ttr.stored_images where customer_id is not null')->0->>'n', '1',
    'the other entity''s staff see only their own');
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal1',
        'select count(*) as n from ttr.stored_images where customer_id is not null')->0->>'n', '0',
    'a session without MFA (aal1) sees none');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        $$insert into ttr.stored_images (customer_id, object_path, content_hash_sha256, captured_by_staff_id)
          values ('c1000000-0000-0000-0000-000000000001',
                  'customers/c1000000-0000-0000-0000-000000000001/browser.jpg', 'h',
                  'a1111111-1111-1111-1111-111111111111')$$),
    'err:42501', 'the browser cannot insert a customer image (no insert policy)');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        $$update ttr.stored_images set content_hash_sha256 = 'x' where customer_id is not null$$),
    'ok:0', 'the browser cannot update a customer image');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        $$delete from ttr.stored_images where customer_id is not null$$),
    'ok:0', 'the browser cannot delete a customer image');

-- Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â B. customer-level id_verifications Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
select lives_ok(
    $$select pg_temp.mk_cidv('cidv1', 'c1000000-0000-0000-0000-000000000001', 'Driver licence', 'DL-100',
                             'img_c1_front', '2026-03-01')$$,
    'a customer-level capture (no transaction, party or conducting person) is accepted');
select is((select reporting_entity_id::text from ttr.id_verifications where id = pg_temp.u('cidv1')),
    '11111111-1111-1111-1111-111111111111', 'its reporting entity comes from the customer');
select pg_temp.mk_cidv('cidv2', 'c1000000-0000-0000-0000-000000000001', 'Passport', ' ab-12 34 ');
select is((select number_norm from ttr.id_verifications where id = pg_temp.u('cidv2')), 'AB1234',
    'number_norm upper-cases and strips spaces and dashes');
select is((select number_norm from ttr.id_verifications where id = pg_temp.u('cidv1')), 'DL100',
    'number_norm of DL-100 is DL100');
select is((select count(*) from pg_indexes where schemaname = 'ttr' and tablename = 'id_verifications'
            and indexdef ilike '%btree%number_norm%'), 1::bigint, 'number_norm is btree-indexed');

select throws_ok(
    $$insert into ttr.id_verifications
        (customer_id, verification_method, document_type, document_number, verification_description,
         verification_basis, prior_verification_id, reliance_reason)
      values ('c1000000-0000-0000-0000-000000000001', 'Sighted original document', 'Passport', 'ZZ1', 'x',
              'relied_on_prior_identification', md5('cidv1')::uuid, 'customer_known_to_business')$$,
    '23514', null, 'a customer-level reliance row is rejected');
select throws_ok(
    $$insert into ttr.id_verifications
        (transaction_id, customer_id, verification_method, document_type, document_number, verification_description)
      values (md5('t_draft')::uuid, 'c1000000-0000-0000-0000-000000000001', 'Sighted original document',
              'Passport', 'ZZ2', 'x')$$,
    '23514', null, 'a customer-level row with a transaction set (and no party) is rejected');
select throws_ok(
    $$insert into ttr.id_verifications
        (customer_id, reporting_entity_id, verification_method, document_type, document_number, verification_description)
      values ('c2000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
              'Sighted original document', 'Passport', 'ZZ3', 'x')$$,
    '23514', null, 'a customer from another entity is rejected');
select throws_ok(
    $$select pg_temp.mk_cidv('bad_img', 'c1000000-0000-0000-0000-000000000002', 'Passport', 'ZZ4', 'img_c1_front')$$,
    'P0001', null, 'a customer-level capture cannot point at another customer''s image');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        $$insert into ttr.id_verifications
            (customer_id, verification_method, document_type, document_number, verification_description)
          values ('c1000000-0000-0000-0000-000000000001', 'Sighted original document', 'Passport', 'ZZ5', 'x')$$),
    'err:42501', 'the browser cannot insert a customer-level capture');

-- Another entity may hold the same document number (uniqueness is per entity).
select pg_temp.mk_cidv('cidv_x', 'c2000000-0000-0000-0000-000000000001', 'Driver licence', 'DL-100', 'img_cx_front');
select is((select count(*) from ttr.id_verifications where upper(document_number) = 'DL-100'), 2::bigint,
    'the same licence number can be on file in two entities');

-- Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â C. TTR fixtures, uniqueness, consistency Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
select pg_temp.mk_tx('t_c1', '11111111-1111-1111-1111-111111111111', 'complete', 'a1111111-1111-1111-1111-111111111111');
select pg_temp.mk_ind('p_c1', 't_c1', 'Alice', 'Gold', '1980-01-01');
update ttr.parties set customer_id = 'c1000000-0000-0000-0000-000000000001' where id = pg_temp.u('p_c1');

select throws_ok(
    $$select pg_temp.mk_pidv('dup_ttr', 'p_c1', 't_c1', 'Driver licence', 'dl-100')$$,
    '23505', null, 'a TTR capture of a document a customer capture already holds is a unique violation');

select pg_temp.mk_pidv('pidv_pass', 'p_c1', 't_c1', 'Passport', 'PA-555');
select throws_ok(
    $$select pg_temp.mk_cidv('dup_cust', 'c1000000-0000-0000-0000-000000000001', 'Passport', 'pa-555')$$,
    '23505', null, 'and a customer capture of a document a TTR capture already holds is too');

select pg_temp.mk_tx('t_c1b', '11111111-1111-1111-1111-111111111111', 'complete', 'a1111111-1111-1111-1111-111111111111');
select pg_temp.mk_ind('p_c1b', 't_c1b', 'Alice', 'Gold', '1980-01-01');
update ttr.parties set customer_id = 'c1000000-0000-0000-0000-000000000001' where id = pg_temp.u('p_c1b');
select pg_temp.mk_pidv('pidv_rel', 'p_c1b', 't_c1b', 'Driver licence', 'DL-100',
    'relied_on_prior_identification', 'cidv1');

-- A draft TTR holding a different document for the same customer.
select pg_temp.mk_ind('p_d', 't_draft', 'Alice', 'Gold', '1980-01-01');
update ttr.parties set customer_id = 'c1000000-0000-0000-0000-000000000001' where id = pg_temp.u('p_d');
select pg_temp.mk_pidv('pidv_draft', 'p_d', 't_draft', 'Driver licence', 'DL-999');

-- A namesake-adjacent customer in the same entity.
select pg_temp.mk_tx('t_c2', '11111111-1111-1111-1111-111111111111', 'complete', 'a1111111-1111-1111-1111-111111111111');
select pg_temp.mk_ind('p_c2', 't_c2', 'Alan', 'Other', '1990-02-02');
update ttr.parties set customer_id = 'c1000000-0000-0000-0000-000000000002' where id = pg_temp.u('p_c2');
select pg_temp.mk_pidv('pidv_c2', 'p_c2', 't_c2', 'Medicare card', 'MC-1');

-- Backfill fixture: a completed TTR whose party is linked but whose capture is not yet, plus
-- a conducting person's capture in the same TTR.
select pg_temp.mk_tx('t_bf', '11111111-1111-1111-1111-111111111111', 'complete', 'a1111111-1111-1111-1111-111111111111');
select pg_temp.mk_ind('p_bf', 't_bf', 'Bea', 'Backfill', '1960-06-06');
update ttr.parties set customer_id = 'c1000000-0000-0000-0000-000000000003' where id = pg_temp.u('p_bf');
select pg_temp.mk_cp('cp_bf', 't_bf');
select pg_temp.mk_pidv('bf_party', 'p_bf', 't_bf', 'Medicare card', 'MC-BF');
insert into ttr.id_verifications
    (id, transaction_id, conducting_person_id, verification_method, document_type, document_number, verification_description)
values (pg_temp.u('bf_cp'), pg_temp.u('t_bf'), pg_temp.u('cp_bf'), 'Sighted original document', 'Passport', 'PP-BF', 'x');

-- A party capture cannot carry a customer other than its party's, nor a conducting person any.
select throws_ok(
    $$update ttr.id_verifications set customer_id = 'c1000000-0000-0000-0000-000000000002'
      where id = md5('pidv_draft')::uuid$$,
    '23514', null, 'a party capture cannot carry a customer other than its party''s');
select throws_ok(
    $$update ttr.id_verifications set customer_id = 'c2000000-0000-0000-0000-000000000001'
      where id = md5('pidv_draft')::uuid$$,
    '23514', null, 'nor a customer from another entity');
select throws_ok(
    $$update ttr.id_verifications set customer_id = 'c1000000-0000-0000-0000-000000000003'
      where id = md5('bf_cp')::uuid$$,
    '23514', null, 'and a conducting person''s capture can never carry a customer');

-- Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â D. backfill Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
select is((select count(*) from ttr.id_verifications where party_id is not null and customer_id is not null),
    0::bigint, 'before the backfill no party capture has a customer_id');
select is(public._backfill_idv_customer_ids(), 5::bigint,
    'the backfill stamps the five party captures whose party has a customer');
select is((select customer_id::text from ttr.id_verifications where id = pg_temp.u('bf_party')),
    'c1000000-0000-0000-0000-000000000003', 'a party capture takes its party''s customer');
select is((select customer_id from ttr.id_verifications where id = pg_temp.u('bf_cp')), null,
    'a conducting person''s capture stays unlinked');
select is(public._backfill_idv_customer_ids(), 0::bigint, 'running it again changes nothing');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2', 'select public._backfill_idv_customer_ids()'),
    'err:42501', 'the browser cannot call the backfill');

-- Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â E. get_verification_for_document Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        $$select id::text, owner_kind, owner_name, owner_dob::text, customer_id::text, transaction_ref,
                 verified_by_name, front_image_id::text
          from public.get_verification_for_document('Driver licence', 'dl-100')$$),
    jsonb_build_array(jsonb_build_object(
        'id', pg_temp.u('cidv1')::text, 'owner_kind', 'customer', 'owner_name', 'Alice Gold',
        'owner_dob', '1980-01-01', 'customer_id', 'c1000000-0000-0000-0000-000000000001',
        'transaction_ref', null, 'verified_by_name', 'Staff One', 'front_image_id', pg_temp.u('img_c1_front')::text)),
    'the collision lookup finds a customer-level capture and returns its customer');
select is(pg_temp.q_as('a2222222-2222-2222-2222-222222222222', 'aal2',
        $$select id::text from public.get_verification_for_document('Driver licence', 'DL-100')$$),
    jsonb_build_array(jsonb_build_object('id', pg_temp.u('cidv_x')::text)),
    'another entity finds only its own record of the same number');
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal1',
        $$select id from public.get_verification_for_document('Driver licence', 'DL-100')$$),
    '[]'::jsonb, 'a session without MFA finds nothing');
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        $$select id::text, owner_kind from public.get_verification_for_document('Passport', 'PA-555')$$),
    jsonb_build_array(jsonb_build_object('id', pg_temp.u('pidv_pass')::text, 'owner_kind', 'party')),
    'a TTR capture is found as before, owner_kind party');

-- Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â F. get_prior_verifications_individual Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        $$select document_number from public.get_prior_verifications_individual(
              p_customer_id := 'c1000000-0000-0000-0000-000000000001') order by lower(document_number)$$),
    '[{"document_number":" ab-12 34 "},{"document_number":"DL-100"},{"document_number":"PA-555"}]'::jsonb,
    'by customer_id: the customer-level captures and the completed TTR capture, no draft, no reliance row');
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        $$select verified_by_name, transaction_ref from public.get_prior_verifications_individual(
              p_customer_id := 'c1000000-0000-0000-0000-000000000001') where document_number = 'DL-100'$$),
    '[{"verified_by_name":"Staff One","transaction_ref":null}]'::jsonb,
    'a customer-level capture names the staff member who took the photo, and has no TTR reference');
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        $$select front_image_id::text from public.get_prior_verifications_individual(
              p_customer_id := 'c1000000-0000-0000-0000-000000000001') where document_number = 'DL-100'$$),
    jsonb_build_array(jsonb_build_object('front_image_id', pg_temp.u('img_c1_front')::text)),
    'and returns its image ids');
select is(pg_temp.q_as('a2222222-2222-2222-2222-222222222222', 'aal2',
        $$select * from public.get_prior_verifications_individual(
              p_customer_id := 'c1000000-0000-0000-0000-000000000001')$$),
    '[]'::jsonb, 'another entity''s staff cannot read this customer''s captures by id');
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        $$select * from public.get_prior_verifications_individual(
              p_customer_id := 'c2000000-0000-0000-0000-000000000001')$$),
    '[]'::jsonb, 'nor read another entity''s customer by id');
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        $$select document_number from public.get_prior_verifications_individual(
              p_customer_id := 'c1000000-0000-0000-0000-000000000002')$$),
    '[{"document_number":"MC-1"}]'::jsonb, 'a customer sees only their own captures, not a namesake''s');
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        $$select count(*) as n from public.get_prior_verifications_individual(
              p_last_name := 'Gold', p_first_name := 'ALICE', p_dob := '1980-01-01')$$)->0->>'n',
    '3', 'the name + DOB fallback finds the same three, customer-level included');
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        $$select count(*) as n from public.get_prior_verifications_individual(
              p_last_name := 'Gold', p_first_name := 'Alice', p_dob := '1981-01-01')$$)->0->>'n',
    '0', 'the fallback still requires the date of birth to match');
select is(pg_temp.q_as('a2222222-2222-2222-2222-222222222222', 'aal2',
        $$select count(*) as n from public.get_prior_verifications_individual(
              p_last_name := 'Gold', p_first_name := 'Alice')$$)->0->>'n',
    '0', 'the fallback never crosses entities');
select is(pg_temp.q_as('a2222222-2222-2222-2222-222222222222', 'aal2',
        $$select document_number from public.get_prior_verifications_individual(
              p_last_name := 'Foreign', p_first_name := 'Xena')$$),
    '[{"document_number":"DL-100"}]'::jsonb, 'and finds that entity''s own customer-level capture');
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        $$select count(*) as n from public.get_prior_verifications_individual('Gold', 'Alice', '1980-01-01')$$)->0->>'n',
    '3', 'the old positional call (last, first, dob) still works');

-- A renewal chain: the newest capture of a document is the one offered.
select pg_temp.mk_cimg('img_c1_new', 'c1000000-0000-0000-0000-000000000001');
insert into ttr.id_verifications
    (id, customer_id, verification_method, document_type, document_number, verification_description,
     new_capture_reason, prior_verification_id, front_image_id, created_at)
values (pg_temp.u('cidv1_renewed'), 'c1000000-0000-0000-0000-000000000001', 'Sighted original document',
        'Driver licence', 'DL-100', 'Renewed', 'id_changed', pg_temp.u('cidv1'), pg_temp.u('img_c1_new'), '2026-06-01');
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        $$select id::text from public.get_prior_verifications_individual(
              p_customer_id := 'c1000000-0000-0000-0000-000000000001') where document_number = 'DL-100'$$),
    jsonb_build_array(jsonb_build_object('id', pg_temp.u('cidv1_renewed')::text)),
    'after a linked renewal the newest capture of the document is offered');
select is((select count(*) from ttr.find_unsuperseded_duplicates() where image_id = pg_temp.u('img_c1_front')),
    1::bigint, 'and the replaced customer photo is reported as an unsuperseded duplicate');
select is((select replacement_image_id::text from ttr.find_unsuperseded_duplicates() where image_id = pg_temp.u('img_c1_front')),
    pg_temp.u('img_c1_new')::text, 'replaced by the newest capture''s image');

-- A re-capture linked to a record for a different person is refused, customer-level too.
select pg_temp.mk_cimg('img_c2', 'c1000000-0000-0000-0000-000000000002');
select throws_ok(
    $$insert into ttr.id_verifications
        (customer_id, verification_method, document_type, document_number, verification_description,
         new_capture_reason, prior_verification_id)
      values ('c1000000-0000-0000-0000-000000000002', 'Sighted original document',
              'Driver licence', 'DL-100', 'x', 'id_changed', md5('cidv1')::uuid)$$,
    'P0001', null, 'a customer-level re-capture linked to another person''s record (DOB differs) is refused');

-- Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â G. completion stamps customer_id Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
-- A new person: customer created at completion, capture stamped. A conducting person's
-- capture in the same TTR is left alone.
select pg_temp.mk_tx('t_k1', '11111111-1111-1111-1111-111111111111', 'draft', 'a1111111-1111-1111-1111-111111111111');
select pg_temp.mk_ind('p_k1', 't_k1', 'Kim', 'Newperson', '1999-09-09');
select pg_temp.mk_cp('cp_k1', 't_k1');
select pg_temp.mk_pidv('k1_party', 'p_k1', 't_k1', 'Passport', 'PK-1');
insert into ttr.id_verifications
    (id, transaction_id, conducting_person_id, verification_method, document_type, document_number, verification_description)
values (pg_temp.u('k1_cp'), pg_temp.u('t_k1'), pg_temp.u('cp_k1'), 'Sighted original document', 'Passport', 'PK-CP', 'x');
select is((select customer_id from ttr.id_verifications where id = pg_temp.u('k1_party')), null,
    'before completion the new person''s capture has no customer');
select ttr.complete_transaction(pg_temp.u('t_k1'), 'a1111111-1111-1111-1111-111111111111');
select isnt((select customer_id from ttr.id_verifications where id = pg_temp.u('k1_party')), null,
    'completion stamps the party''s capture with a customer');
select is((select customer_id from ttr.id_verifications where id = pg_temp.u('k1_party')),
    (select customer_id from ttr.parties where id = pg_temp.u('p_k1')),
    'the same customer the party is linked to');
select is((select count(*) from public.customers where last_name = 'Newperson'), 1::bigint,
    'which was created at completion');
select is((select customer_id from ttr.id_verifications where id = pg_temp.u('k1_cp')), null,
    'the conducting person''s capture stays unlinked');

-- A customer picked from search: its capture carries that customer.
select pg_temp.mk_tx('t_k2', '11111111-1111-1111-1111-111111111111', 'draft', 'a1111111-1111-1111-1111-111111111111');
select pg_temp.mk_ind('p_k2', 't_k2', 'Alice', 'Gold', '1980-01-01');
update ttr.parties set customer_id = 'c1000000-0000-0000-0000-000000000001' where id = pg_temp.u('p_k2');
select pg_temp.mk_pidv('k2_party', 'p_k2', 't_k2', 'Medicare card', 'MC-K2');
select ttr.complete_transaction(pg_temp.u('t_k2'), 'a1111111-1111-1111-1111-111111111111');
select is((select customer_id::text from ttr.id_verifications where id = pg_temp.u('k2_party')),
    'c1000000-0000-0000-0000-000000000001', 'a picked customer''s capture is stamped with that customer');

-- A TTR that re-captures a gold customer's document links to it, and completes.
select pg_temp.mk_tx('t_k3', '11111111-1111-1111-1111-111111111111', 'draft', 'a1111111-1111-1111-1111-111111111111');
select pg_temp.mk_ind('p_k3', 't_k3', 'Alice', 'Gold', '1980-01-01');
update ttr.parties set customer_id = 'c1000000-0000-0000-0000-000000000001' where id = pg_temp.u('p_k3');
select lives_ok(
    $$insert into ttr.id_verifications
        (id, transaction_id, party_id, verification_method, document_type, document_number, verification_description,
         new_capture_reason, prior_verification_id)
      values (md5('k3_party')::uuid, md5('t_k3')::uuid, md5('p_k3')::uuid, 'Sighted original document',
              'Passport', 'PA-555', 'Re-sighted', 'stored_copy_unclear', md5('pidv_pass')::uuid)$$,
    'a TTR re-capture can link to a prior capture of the same document');
select lives_ok($$select ttr.complete_transaction(md5('t_k3')::uuid, 'a1111111-1111-1111-1111-111111111111')$$,
    'and completes');
select is((select customer_id::text from ttr.id_verifications where id = pg_temp.u('k3_party')),
    'c1000000-0000-0000-0000-000000000001', 'and its capture is stamped with the customer too');

select * from finish();
rollback;
