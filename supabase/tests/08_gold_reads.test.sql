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

-- Fixtures: two entities; staff, manager and admin in the first, staff and manager in the second.
insert into public.reporting_entities (id, legal_name) values
    ('11111111-1111-1111-1111-111111111111', 'Entity One'),
    ('22222222-2222-2222-2222-222222222222', 'Entity Two');
insert into auth.users (id, email) values
    ('a1111111-1111-1111-1111-111111111111', 'staff1@entity-one.test'),
    ('a1111111-1111-1111-1111-111111111112', 'manager1@entity-one.test'),
    ('a1111111-1111-1111-1111-111111111113', 'admin1@entity-one.test'),
    ('a2222222-2222-2222-2222-222222222222', 'staff2@entity-two.test'),
    ('a2222222-2222-2222-2222-222222222223', 'manager2@entity-two.test');
insert into public.staff_members (id, reporting_entity_id, full_name, email, role) values
    ('a1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'Staff One',   'staff1@entity-one.test',   'staff'),
    ('a1111111-1111-1111-1111-111111111112', '11111111-1111-1111-1111-111111111111', 'Manager One', 'manager1@entity-one.test', 'manager'),
    ('a1111111-1111-1111-1111-111111111113', '11111111-1111-1111-1111-111111111111', 'Admin One',   'admin1@entity-one.test',   'admin'),
    ('a2222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'Staff Two',   'staff2@entity-two.test',   'staff'),
    ('a2222222-2222-2222-2222-222222222223', '22222222-2222-2222-2222-222222222222', 'Manager Two', 'manager2@entity-two.test', 'manager');

-- An individual customer with a residential address. p_complete fills every other field a TTR needs.
create function pg_temp.mk_cust(
    p_label text, p_entity uuid, p_first text, p_last text, p_dob date default '1980-01-01',
    p_phone text default '0400 000 000', p_middle text default null, p_complete boolean default false
) returns uuid language plpgsql as $$
begin
    insert into public.customers
        (id, reporting_entity_id, customer_type, source, first_name, middle_name, last_name, date_of_birth, phone,
         res_street, res_suburb, res_state, res_postcode, occupation, gender,
         citizenship_country_code, tax_residency_country_code, is_sole_trader)
    values
        (pg_temp.u(p_label), p_entity, 'individual', 'gold', p_first, p_middle, p_last, p_dob, p_phone,
         '1 Test St', 'Coburg', 'VIC', '3058',
         case when p_complete then 'Jeweller' end, case when p_complete then 'F' end,
         case when p_complete then 'AU' end, case when p_complete then 'AU' end,
         case when p_complete then false end);
    return pg_temp.u(p_label);
end $$;

-- A customer-level ID capture (no transaction), with its front photo, for customer p_customer.
create function pg_temp.mk_cap(
    p_label text, p_customer uuid, p_doc text default 'Driver licence', p_num text default null,
    p_issuer text default 'VIC', p_country text default 'AU', p_created timestamptz default '2026-03-01',
    p_staff uuid default 'a1111111-1111-1111-1111-111111111111', p_expiry date default '2030-01-01',
    p_prior text default null, p_reason text default null
) returns uuid language plpgsql as $$
begin
    insert into ttr.stored_images (id, customer_id, object_path, content_hash_sha256, captured_by_staff_id)
    values (pg_temp.u('img_' || p_label), p_customer,
            'customers/' || p_customer || '/' || pg_temp.u(p_label) || '/front-x.jpg', 'hash-' || p_label, p_staff);
    insert into ttr.id_verifications
        (id, customer_id, verification_method, document_type, document_number, issuer, id_country_code,
         has_expiry, expiry_date, verification_description, is_complete, front_image_id, created_at,
         prior_verification_id, new_capture_reason)
    values
        (pg_temp.u(p_label), p_customer, 'Sighted original document', p_doc::id_doc_type,
         coalesce(p_num, 'NUM-' || p_label), p_issuer, p_country, p_expiry is not null, p_expiry,
         'Sighted in person', true, pg_temp.u('img_' || p_label), p_created,
         case when p_prior is null then null else pg_temp.u(p_prior) end, p_reason);
    return pg_temp.u(p_label);
end $$;

-- A gold purchase. p_cap / p_joint_cap are capture ids from mk_cap.
create function pg_temp.mk_purchase(
    p_label text, p_customer uuid, p_cap uuid,
    p_entity uuid default '11111111-1111-1111-1111-111111111111',
    p_staff uuid default 'a1111111-1111-1111-1111-111111111111',
    p_type text default 'scrap', p_reportable boolean default false, p_invoice text default null,
    p_date date default '2026-10-01', p_joint uuid default null, p_joint_cap uuid default null,
    p_created timestamptz default now(), p_tx uuid default null, p_phone text default '0412 345 678'
) returns uuid language plpgsql as $$
begin
    insert into gold.purchases
        (id, reporting_entity_id, customer_id, joint_customer_id, main_id_verification_id, joint_id_verification_id,
         purchase_type, cash_band, cash_10k_or_more, erp_invoice_no, sale_date, phone, id_sighted,
         ttr_transaction_id, created_at, created_by_staff_id)
    values
        (pg_temp.u(p_label), p_entity, p_customer, p_joint, p_cap, p_joint_cap,
         p_type::gold.purchase_type, case when p_reportable then '10k_plus' else 'under_10k' end, p_reportable,
         p_invoice, p_date, p_phone, true, p_tx, p_created, p_staff);
    return pg_temp.u(p_label);
end $$;

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

-- Helpers -------------------------------------------------------------------------------------
-- One column of an RPC call as comma-joined text, in return order, for staff p_uid at p_aal.
create function pg_temp.col_as(p_uid uuid, p_aal text, p_sql text, p_col text) returns text language sql as $$
    select coalesce(string_agg(x.v ->> p_col, ',' order by x.ord), '')
    from jsonb_array_elements(pg_temp.q_as(p_uid, p_aal, p_sql)) with ordinality x(v, ord)
$$;

-- A scalar expression as text (null stays null).
create function pg_temp.scalar_as(p_uid uuid, p_aal text, p_expr text) returns text language sql as $$
    select (pg_temp.q_as(p_uid, p_aal, 'select (' || p_expr || ')::text as r') -> 0) ->> 'r'
$$;

create function pg_temp.s1() returns uuid language sql as $$ select 'a1111111-1111-1111-1111-111111111111'::uuid $$;
create function pg_temp.s2() returns uuid language sql as $$ select 'a2222222-2222-2222-2222-222222222222'::uuid $$;
create function pg_temp.m1() returns uuid language sql as $$ select 'a1111111-1111-1111-1111-111111111112'::uuid $$;

-- A completed (or draft) TTR with one party who is customer p_customer, and that party's ID capture.
create function pg_temp.mk_ttr_capture(
    p_label text, p_customer uuid, p_status text, p_doc text, p_num text, p_created timestamptz,
    p_basis text default 'new_capture', p_prior text default null
) returns void language plpgsql as $$
begin
    perform pg_temp.mk_tx('t_' || p_label, '11111111-1111-1111-1111-111111111111', p_status);
    insert into ttr.parties (id, transaction_id, party_type, is_complete, first_name, last_name, date_of_birth,
        res_street, res_suburb, res_state, res_postcode, has_postal_address)
    select pg_temp.u('p_' || p_label), pg_temp.u('t_' || p_label), 'individual', true, c.first_name, c.last_name,
           c.date_of_birth, '1 Test St', 'Coburg', 'VIC', '3058', false
    from public.customers c where c.id = p_customer;
    update ttr.parties set customer_id = p_customer where id = pg_temp.u('p_' || p_label);
    insert into ttr.id_verifications
        (id, transaction_id, party_id, customer_id, verification_method, document_type, document_number, issuer,
         id_country_code, verification_description, verification_basis, prior_verification_id, reliance_reason,
         is_complete, created_at)
    values
        (pg_temp.u(p_label), pg_temp.u('t_' || p_label), pg_temp.u('p_' || p_label), p_customer,
         'Sighted original document', p_doc::id_doc_type, p_num, 'VIC', 'AU', 'Sighted in person',
         p_basis::id_verification_basis, case when p_prior is null then null else pg_temp.u(p_prior) end,
         case when p_basis = 'relied_on_prior_identification' then 'customer_known_to_business' end, true, p_created);
end $$;

-- ─── Seed: customers and IDs ─────────────────────────────────────────────────────────────
select pg_temp.mk_cust('cA',  '11111111-1111-1111-1111-111111111111', 'Alice', 'Alpha', '1980-01-01', '0412 111 222');
select pg_temp.mk_cust('cB',  '11111111-1111-1111-1111-111111111111', 'Bob',   'Beta',  '1981-01-01', '0412 333 444');
select pg_temp.mk_cust('cJ',  '11111111-1111-1111-1111-111111111111', 'Jo',    'Joint', '1982-01-01', '0412 555 666');
select pg_temp.mk_cust('cX',  '22222222-2222-2222-2222-222222222222', 'Xena',  'Other', '1983-01-01', '0412 777 888');
select pg_temp.mk_cap('k1', pg_temp.u('cA'), 'Driver licence', 'DL-A1', 'VIC', 'AU', '2026-01-01');
select pg_temp.mk_cap('k2', pg_temp.u('cA'), 'Passport', 'PA-A1', null, 'AU', '2026-06-01');
select pg_temp.mk_cap('capB', pg_temp.u('cB'), 'Driver licence', 'DL-B1');
select pg_temp.mk_cap('capJ', pg_temp.u('cJ'), 'Driver licence', 'DL-J1');
select pg_temp.mk_cap('capX', pg_temp.u('cX'), 'Driver licence', 'DL-X1', 'VIC', 'AU', '2026-03-01', pg_temp.s2());

-- ─── Seed: purchases ─────────────────────────────────────────────────────────────────────
select pg_temp.mk_tx('t_l1', '11111111-1111-1111-1111-111111111111', 'draft');
select pg_temp.mk_tx('t_l2', '11111111-1111-1111-1111-111111111111', 'complete');
select pg_temp.mk_tx('t_m2', '11111111-1111-1111-1111-111111111111', 'complete');
-- D = 2026-10-05
select pg_temp.mk_purchase('L1', pg_temp.u('cA'), pg_temp.u('k2'), p_reportable => true, p_invoice => 'INV-77', p_date => '2026-10-05', p_created => '2026-10-05 10:00', p_tx => pg_temp.u('t_l1'));
select pg_temp.mk_purchase('L2', pg_temp.u('cB'), pg_temp.u('capB'), p_type => 'bullion', p_reportable => true, p_invoice => 'inv-77 ', p_date => '2026-10-05',
    p_joint => pg_temp.u('cA'), p_joint_cap => pg_temp.u('k2'), p_created => '2026-10-05 10:10', p_tx => pg_temp.u('t_l2'));
select pg_temp.mk_purchase('L3', pg_temp.u('cA'), pg_temp.u('k2'), p_invoice => 'INV-77', p_date => '2026-10-06', p_created => '2026-10-05 10:20');
select pg_temp.mk_purchase('L4', pg_temp.u('cA'), pg_temp.u('k2'), p_staff => pg_temp.m1(), p_invoice => 'INV-78', p_date => '2026-10-05', p_created => '2026-10-05 10:30');
select pg_temp.mk_purchase('L5', pg_temp.u('cB'), pg_temp.u('capB'), p_invoice => 'INV-77', p_date => '2026-10-05', p_created => '2026-10-05 10:40');
select pg_temp.mk_purchase('L6', pg_temp.u('cA'), pg_temp.u('k2'), p_date => '2026-10-05', p_created => '2026-10-05 10:50');
select pg_temp.mk_purchase('L7', pg_temp.u('cA'), pg_temp.u('k2'), p_invoice => 'INV-77', p_date => '2026-10-05', p_created => '2026-10-05 11:00');
select pg_temp.mk_purchase('M1', pg_temp.u('cA'), pg_temp.u('k2'), p_reportable => true, p_invoice => 'INV-90', p_date => '2026-10-05', p_created => '2026-10-05 11:10');
select pg_temp.mk_purchase('M2', pg_temp.u('cB'), pg_temp.u('capB'), p_type => 'bullion', p_reportable => true, p_invoice => 'INV-91', p_date => '2026-10-05',
    p_created => '2026-10-05 11:20', p_tx => pg_temp.u('t_m2'));
-- Entity two
select pg_temp.mk_purchase('X1', pg_temp.u('cX'), pg_temp.u('capX'), '22222222-2222-2222-2222-222222222222', pg_temp.s2(),
    p_invoice => 'INV-77', p_date => '2026-10-05', p_created => '2026-10-05 12:00');
select pg_temp.mk_purchase('X2', pg_temp.u('cX'), pg_temp.u('capX'), '22222222-2222-2222-2222-222222222222', pg_temp.s2(),
    p_date => '2026-10-05', p_created => '2026-10-05 12:10');

select plan(113);

-- ═══ customer_current_id ═══════════════════════════════════════════════════════════════════
select is(pg_temp.scalar_as(pg_temp.s1(), 'aal2', format('(select verification_id from public.customer_current_id(%L))', pg_temp.u('cA'))),
    pg_temp.u('k2')::text, 'the current ID is the newest capture');
select is(pg_temp.q_as(pg_temp.s1(), 'aal2', format('select document_type, document_number, issuer, id_country_code, has_expiry, expiry_date, captured_at, captured_by_name, front_image_id, back_image_id from public.customer_current_id(%L)', pg_temp.u('cA'))),
    jsonb_build_array(jsonb_build_object('document_type', 'Passport', 'document_number', 'PA-A1', 'issuer', null, 'id_country_code', 'AU',
        'has_expiry', true, 'expiry_date', '2030-01-01', 'captured_at', '2026-06-01T00:00:00+00:00', 'captured_by_name', 'Staff One',
        'front_image_id', pg_temp.u('img_k2'), 'back_image_id', null)),
    'with its document, issuer, country, expiry, capture date, who took it and its images');

-- A completed TTR's capture of the same customer, newer than both.
select pg_temp.mk_ttr_capture('ttr1', pg_temp.u('cA'), 'complete', 'Medicare card', 'MC-A1', '2026-09-01');
select is(pg_temp.scalar_as(pg_temp.s1(), 'aal2', format('(select verification_id from public.customer_current_id(%L))', pg_temp.u('cA'))),
    pg_temp.u('ttr1')::text, 'a capture from a completed TTR counts, and is newest');
select is(pg_temp.scalar_as(pg_temp.s1(), 'aal2', format('(select captured_by_name from public.customer_current_id(%L))', pg_temp.u('cA'))),
    'Staff', 'whose staff name comes from the transaction');
-- A newer capture in a draft TTR does not count until that TTR completes.
select pg_temp.mk_ttr_capture('ttr_draft', pg_temp.u('cA'), 'draft', 'Other government document', 'OG-A1', '2026-10-15');
select is(pg_temp.scalar_as(pg_temp.s1(), 'aal2', format('(select verification_id from public.customer_current_id(%L))', pg_temp.u('cA'))),
    pg_temp.u('ttr1')::text, 'a draft TTR''s capture is ignored');
-- A newer reliance row (a TTR that relied on an earlier ID) is not an ID capture.
select pg_temp.mk_ttr_capture('ttr_rel', pg_temp.u('cA'), 'complete', 'Passport', 'PA-A1', '2026-12-01', 'relied_on_prior_identification', 'k2');
select is(pg_temp.scalar_as(pg_temp.s1(), 'aal2', format('(select verification_id from public.customer_current_id(%L))', pg_temp.u('cA'))),
    pg_temp.u('ttr1')::text, 'and a reliance row is ignored');
select is(pg_temp.n_as(pg_temp.s2(), 'aal2', format('select * from public.customer_current_id(%L)', pg_temp.u('cA'))), 0,
    'another entity''s staff get nothing for this customer');
select is(pg_temp.n_as(pg_temp.s1(), 'aal1', format('select * from public.customer_current_id(%L)', pg_temp.u('cA'))), 0,
    'nor does an aal1 session');
select is(pg_temp.n_as(pg_temp.s1(), 'aal2', format('select * from public.customer_current_id(%L)', pg_temp.u('cX'))), 0,
    'and entity one cannot read entity two''s customer');
select is(pg_temp.n_as(pg_temp.s1(), 'aal2', format('select * from public.customer_current_id(%L)', pg_temp.u('cJ'))), 1,
    'a customer with a capture returns one row');

-- ═══ customer_ttr_ready ═══════════════════════════════════════════════════════════════════
select pg_temp.mk_cust('rOk', '11111111-1111-1111-1111-111111111111', 'Ready', 'Ok', '1970-01-01', '0400 100 100', null, true);
select pg_temp.mk_cap('capROk', pg_temp.u('rOk'));
select is(pg_temp.scalar_as(pg_temp.s1(), 'aal2', format('public.customer_ttr_ready(%L)', pg_temp.u('rOk'))), '{}',
    'a complete customer has nothing missing');

insert into public.customers (id, reporting_entity_id, customer_type, source, first_name, last_name)
values (pg_temp.u('rBlank'), '11111111-1111-1111-1111-111111111111', 'individual', 'gold', 'Blank', 'Slate');
select is(pg_temp.scalar_as(pg_temp.s1(), 'aal2', format('public.customer_ttr_ready(%L)', pg_temp.u('rBlank'))),
    '{date_of_birth,res_street,res_suburb,res_state,res_postcode,phone,occupation,gender,citizenship_country_code,tax_residency_country_code,is_sole_trader,id_document}',
    'a customer with only a name lists every missing field, including no ID on file');

select pg_temp.mk_cust('rSole', '11111111-1111-1111-1111-111111111111', 'Sole', 'Trader', '1970-01-01', '0400 100 101', null, true);
update public.customers set is_sole_trader = true where id = pg_temp.u('rSole');
select pg_temp.mk_cap('capRSole', pg_temp.u('rSole'));
select is(pg_temp.scalar_as(pg_temp.s1(), 'aal2', format('public.customer_ttr_ready(%L)', pg_temp.u('rSole'))), '{abn}',
    'a sole trader without an ABN is missing the ABN');
update public.customers set abn = '12345678901' where id = pg_temp.u('rSole');
select is(pg_temp.scalar_as(pg_temp.s1(), 'aal2', format('public.customer_ttr_ready(%L)', pg_temp.u('rSole'))), '{}',
    'and not once it has one');

select pg_temp.mk_cust('rPost', '11111111-1111-1111-1111-111111111111', 'Post', 'Flag', '1970-01-01', '0400 100 102', null, true);
update public.customers set has_postal_address = true where id = pg_temp.u('rPost');
select pg_temp.mk_cap('capRPost', pg_temp.u('rPost'));
select is(pg_temp.scalar_as(pg_temp.s1(), 'aal2', format('public.customer_ttr_ready(%L)', pg_temp.u('rPost'))),
    '{post_street,post_suburb,post_state,post_postcode,post_country}', 'a flagged postal address must be complete');

select pg_temp.mk_cust('rIdGap', '11111111-1111-1111-1111-111111111111', 'Id', 'Gap', '1970-01-01', '0400 100 103', null, true);
select pg_temp.mk_cap('capRIdGap', pg_temp.u('rIdGap'), 'Driver licence', null, null, null);
select is(pg_temp.scalar_as(pg_temp.s1(), 'aal2', format('public.customer_ttr_ready(%L)', pg_temp.u('rIdGap'))),
    '{id_country_code,id_issuer}', 'the current ID needs an issuing country and issuer');

select pg_temp.mk_cust('rNoId', '11111111-1111-1111-1111-111111111111', 'No', 'Id', '1970-01-01', '0400 100 104', null, true);
select is(pg_temp.scalar_as(pg_temp.s1(), 'aal2', format('public.customer_ttr_ready(%L)', pg_temp.u('rNoId'))), '{id_document}',
    'a customer with no ID on file is missing the ID');

select is(pg_temp.scalar_as(pg_temp.s1(), 'aal2', format('public.customer_ttr_ready(%L)', pg_temp.u('cX'))), null,
    'another entity''s customer gives null');
select is(pg_temp.scalar_as(pg_temp.s1(), 'aal1', format('public.customer_ttr_ready(%L)', pg_temp.u('rOk'))), null, 'so does an aal1 session');
select is(pg_temp.scalar_as(pg_temp.s1(), 'aal2', 'public.customer_ttr_ready(gen_random_uuid())'), null, 'and an unknown customer');
insert into public.customers (id, reporting_entity_id, customer_type, source, entity_name, reg_identifier, reg_id_type)
values (pg_temp.u('co'), '11111111-1111-1111-1111-111111111111', 'company', 'gold', 'Acme', '12345678901', 'ABN');
select is(pg_temp.scalar_as(pg_temp.s1(), 'aal2', format('public.customer_ttr_ready(%L)', pg_temp.u('co'))), null, 'and a company');

-- ═══ find_possible_duplicate_customers ════════════════════════════════════════════════════
select pg_temp.mk_cust('pp', '11111111-1111-1111-1111-111111111111', 'Priya', 'Patel', '1990-09-09', '0412 888 999');
select pg_temp.mk_cust('pp2', '22222222-2222-2222-2222-222222222222', 'PRIYA', 'PATEL', '1990-09-09', '0412 888 999');
select is(pg_temp.q_as(pg_temp.s1(), 'aal2', $q$select customer_id, first_name, last_name, date_of_birth, phone, match_reason
        from public.find_possible_duplicate_customers(' priya', 'PATEL ', '1990-09-09', null)$q$),
    jsonb_build_array(jsonb_build_object('customer_id', pg_temp.u('pp'), 'first_name', 'Priya', 'last_name', 'Patel',
        'date_of_birth', '1990-09-09', 'phone', '0412 888 999', 'match_reason', 'name_dob')),
    'same name (any case) and date of birth is a name_dob match');
select is(pg_temp.n_as(pg_temp.s1(), 'aal2', $q$select * from public.find_possible_duplicate_customers('Priya', 'Patel', '1990-09-10', null)$q$), 0,
    'the same name with another date of birth is not');
select is(pg_temp.col_as(pg_temp.s1(), 'aal2', $q$select match_reason from public.find_possible_duplicate_customers('Someone', 'Else', '2000-01-01', '+61 412 888 999')$q$, 'match_reason'),
    'phone', 'the same phone (+61 form) is a phone match');
select is(pg_temp.col_as(pg_temp.s1(), 'aal2', $q$select match_reason from public.find_possible_duplicate_customers('Priya', 'Patel', '1990-09-09', '0412888999')$q$, 'match_reason'),
    'name_dob', 'a customer matching both ways is returned once, as name_dob');
select is(pg_temp.n_as(pg_temp.s1(), 'aal2', $q$select * from public.find_possible_duplicate_customers('A', 'B', '2000-01-01', '412')$q$), 0,
    'a short phone does not match');
select is(pg_temp.n_as(pg_temp.s1(), 'aal2', $q$select * from public.find_possible_duplicate_customers(null, null, null, null)$q$), 0, 'no input finds nothing');
select is(pg_temp.n_as(pg_temp.s1(), 'aal2', $q$select * from public.find_possible_duplicate_customers('Priya', null, '1990-09-09', null)$q$), 0,
    'a missing last name cannot name-match');
select is(pg_temp.col_as(pg_temp.s2(), 'aal2', $q$select customer_id from public.find_possible_duplicate_customers('Priya', 'Patel', '1990-09-09', null)$q$, 'customer_id'),
    pg_temp.u('pp2')::text, 'entity two sees only its own');
select is(pg_temp.n_as(pg_temp.s1(), 'aal1', $q$select * from public.find_possible_duplicate_customers('Priya', 'Patel', '1990-09-09', null)$q$), 0, 'aal1 sees nothing');
select pg_temp.mk_cust('pp3', '11111111-1111-1111-1111-111111111111', 'Pia', 'Pham', '1991-01-01', '0412 888 999');
select is(pg_temp.col_as(pg_temp.s1(), 'aal2', $q$select customer_id from public.find_possible_duplicate_customers('Priya', 'Patel', '1990-09-09', '0412888999')$q$, 'customer_id'),
    pg_temp.u('pp') || ',' || pg_temp.u('pp3'), 'name matches are listed before phone matches');

-- ═══ gold.linked_parts and gold.invoice_purchases ═════════════════════════════════════════
select is(pg_temp.col_as(pg_temp.s1(), 'aal2', format('select id from gold.linked_parts(%L, %L, %L)', pg_temp.u('cA'), 'inv-77', '2026-10-05'), 'id'),
    pg_temp.u('L1') || ',' || pg_temp.u('L2') || ',' || pg_temp.u('L7'),
    'linked parts: same invoice (any case), same day, customer as main or joint seller; not another day, invoice or seller');
select is(pg_temp.col_as(pg_temp.s1(), 'aal2', format('select ttr_status from gold.linked_parts(%L, %L, %L)', pg_temp.u('cA'), 'INV-77', '2026-10-05'), 'ttr_status'),
    'draft,complete', 'ttr_status is the raw TTR status (draft, complete)');
select is(pg_temp.scalar_as(pg_temp.s1(), 'aal2', format('(select ttr_status from gold.linked_parts(%L, %L, %L) where id = %L)',
        pg_temp.u('cA'), 'INV-77', '2026-10-05', pg_temp.u('L7'))), null, 'and null for a part without a TTR');
select is(pg_temp.q_as(pg_temp.s1(), 'aal2', format('select purchase_type, cash_10k_or_more, ttr_transaction_id, customer_id, joint_customer_id, erp_invoice_no, sale_date from gold.linked_parts(%L, %L, %L) limit 1 offset 1',
        pg_temp.u('cA'), ' Inv-77 ', '2026-10-05')),
    jsonb_build_array(jsonb_build_object('purchase_type', 'bullion', 'cash_10k_or_more', true, 'ttr_transaction_id', pg_temp.u('t_l2'),
        'customer_id', pg_temp.u('cB'), 'joint_customer_id', pg_temp.u('cA'), 'erp_invoice_no', 'inv-77 ', 'sale_date', '2026-10-05')),
    'a joint part is returned with both sellers, and the invoice as typed');
select is(pg_temp.col_as(pg_temp.s1(), 'aal2', format('select id from gold.linked_parts(%L, %L, %L)', pg_temp.u('cA'), 'INV-77', '2026-10-06'), 'id'),
    pg_temp.u('L3')::text, 'a different sale date links a different part');
select is(pg_temp.n_as(pg_temp.s1(), 'aal2', format('select * from gold.linked_parts(%L, %L, %L)', pg_temp.u('cA'), '', '2026-10-05')), 0, 'no invoice links nothing');
select is(pg_temp.n_as(pg_temp.s1(), 'aal2', format('select * from gold.linked_parts(%L, null, %L)', pg_temp.u('cA'), '2026-10-05')), 0, 'null invoice links nothing');
select is(pg_temp.n_as(pg_temp.s2(), 'aal2', format('select * from gold.linked_parts(%L, %L, %L)', pg_temp.u('cA'), 'INV-77', '2026-10-05')), 0,
    'entity two cannot see entity one''s parts');
select is(pg_temp.col_as(pg_temp.s2(), 'aal2', format('select id from gold.linked_parts(%L, %L, %L)', pg_temp.u('cX'), 'INV-77', '2026-10-05'), 'id'),
    pg_temp.u('X1')::text, 'and finds only its own, though the invoice number is the same');
select is(pg_temp.n_as(pg_temp.s1(), 'aal1', format('select * from gold.linked_parts(%L, %L, %L)', pg_temp.u('cA'), 'INV-77', '2026-10-05')), 0, 'aal1 sees nothing');

select is(pg_temp.col_as(pg_temp.s1(), 'aal2', $q$select id from gold.invoice_purchases('  inv-77 ')$q$, 'id'),
    pg_temp.u('L1') || ',' || pg_temp.u('L2') || ',' || pg_temp.u('L3') || ',' || pg_temp.u('L5') || ',' || pg_temp.u('L7'),
    'invoice_purchases normalises its input and returns every purchase on the invoice, any day, in the entity');
select is(pg_temp.q_as(pg_temp.s1(), 'aal2', $q$select customer_id, joint_customer_id, sale_date from gold.invoice_purchases('INV-90')$q$),
    jsonb_build_array(jsonb_build_object('customer_id', pg_temp.u('cA'), 'joint_customer_id', null, 'sale_date', '2026-10-05')),
    'with sellers and sale date');
select is(pg_temp.col_as(pg_temp.s2(), 'aal2', $q$select id from gold.invoice_purchases('inv-77')$q$, 'id'), pg_temp.u('X1')::text, 'entity two sees only its own');
select is(pg_temp.n_as(pg_temp.s1(), 'aal2', $q$select * from gold.invoice_purchases('  ')$q$), 0, 'a blank invoice matches nothing');
select is(pg_temp.n_as(pg_temp.s1(), 'aal1', $q$select * from gold.invoice_purchases('inv-77')$q$), 0, 'aal1 sees nothing');

-- ═══ gold.list_incomplete_purchases ═══════════════════════════════════════════════════════
select is(pg_temp.col_as(pg_temp.s1(), 'aal2', 'select id from gold.list_incomplete_purchases()', 'id'),
    pg_temp.u('M1') || ',' || pg_temp.u('L6') || ',' || pg_temp.u('L1'),
    'incomplete: no invoice, or reportable without a complete TTR (draft or none); newest first');
select is(pg_temp.n_as(pg_temp.s1(), 'aal2', format('select * from gold.list_incomplete_purchases() where id = %L', pg_temp.u('L2'))), 0,
    'a reportable purchase with a complete TTR is not listed');
select is(pg_temp.n_as(pg_temp.s1(), 'aal2', format('select * from gold.list_incomplete_purchases() where id = %L', pg_temp.u('L7'))), 0,
    'nor is a non-reportable purchase that has its invoice');
select is(pg_temp.q_as(pg_temp.s1(), 'aal2', format('select customer_first_name, customer_last_name, ttr_status, ttr_transaction_ref from gold.list_incomplete_purchases() where id = %L', pg_temp.u('L1'))),
    jsonb_build_array(jsonb_build_object('customer_first_name', 'Alice', 'customer_last_name', 'Alpha', 'ttr_status', 'draft', 'ttr_transaction_ref', 'REF-t_l1')),
    'rows carry the seller name and the TTR status and reference');
select is(pg_temp.scalar_as(pg_temp.s1(), 'aal2', format('(select ttr_status from gold.list_incomplete_purchases() where id = %L)', pg_temp.u('M1'))), null,
    'ttr_status is null when there is no TTR');
select is(pg_temp.col_as(pg_temp.s2(), 'aal2', 'select id from gold.list_incomplete_purchases()', 'id'), pg_temp.u('X2')::text, 'entity two sees only its own');
select is(pg_temp.n_as(pg_temp.s1(), 'aal1', 'select * from gold.list_incomplete_purchases()'), 0, 'aal1 sees nothing');

-- ═══ gold.search_gold_purchases ═══════════════════════════════════════════════════════════
create function pg_temp.sgp(p_filters text, p_page int default 1, p_size int default 100, p_uid uuid default 'a1111111-1111-1111-1111-111111111111', p_aal text default 'aal2')
returns text language sql as $$
    select pg_temp.col_as(p_uid, p_aal, format('select id from gold.search_gold_purchases(%L::jsonb, %s, %s)', p_filters, coalesce(p_page::text, 'null'), coalesce(p_size::text, 'null')), 'id')
$$;
create function pg_temp.ids(variadic p_labels text[]) returns text language sql as $$
    select string_agg(pg_temp.u(l)::text, ',') from unnest(p_labels) l
$$;
create function pg_temp.sgp_n(p_filters text, p_page int default 1, p_size int default 100) returns int language sql as $$
    select pg_temp.n_as(pg_temp.s1(), 'aal2', format('select id from gold.search_gold_purchases(%L::jsonb, %s, %s)', p_filters, p_page, p_size))
$$;

select is(pg_temp.sgp('{}'), pg_temp.ids('M2','M1','L7','L6','L5','L4','L3','L2','L1'), 'no filters: every purchase of the entity, newest first');
select is(pg_temp.sgp(null), pg_temp.ids('M2','M1','L7','L6','L5','L4','L3','L2','L1'), 'null filters are the same');
select is(pg_temp.sgp('{}', 1, 4), pg_temp.ids('M2','M1','L7','L6'), 'page 1 of size 4');
select is(pg_temp.sgp('{}', 2, 4), pg_temp.ids('L5','L4','L3','L2'), 'page 2');
select is(pg_temp.sgp('{}', 3, 4), pg_temp.ids('L1'), 'page 3 has the remainder');
select is(pg_temp.sgp_n('{}', 4, 4), 0, 'a page past the end is empty');
select is(pg_temp.scalar_as(pg_temp.s1(), 'aal2', $q$(select max(total_count) from gold.search_gold_purchases('{}', 2, 4))$q$), '9',
    'total_count is the number of matches over all pages');
select is(pg_temp.scalar_as(pg_temp.s1(), 'aal2', $q$(select total_count from gold.search_gold_purchases('{"status": "incomplete"}', 1, 1))$q$), '3',
    'and respects the filters');
select is(pg_temp.sgp_n('{}', 1, 0), 1, 'a page size of 0 is read as 1');
select is(pg_temp.sgp_n('{}', 0, 4), 4, 'page 0 is read as page 1');

select is(pg_temp.sgp('{"status": "incomplete"}'), pg_temp.ids('M1','L6','L1'), 'status incomplete');
select is(pg_temp.sgp('{"status": "complete"}'), pg_temp.ids('M2','L7','L5','L4','L3','L2'), 'status complete');
select is(pg_temp.sgp('{"status": "austrac_pending"}'), pg_temp.ids('M1','L1'), 'status austrac_pending: reportable, TTR draft or none');
select is(pg_temp.sgp('{"status": "austrac"}'), pg_temp.ids('M2','L2'), 'status austrac: reportable, TTR complete');
select is(pg_temp.sgp('{"status": "bogus"}'), '', 'an unknown status matches nothing');
select is(pg_temp.sgp('{"type": "bullion"}'), pg_temp.ids('M2','L2'), 'type bullion');
select is(pg_temp.sgp_n('{"type": "scrap"}'), 7, 'type scrap');
select is(pg_temp.sgp('{"cash": "yes"}'), pg_temp.ids('M2','M1','L2','L1'), 'cash yes: reportable');
select is(pg_temp.sgp_n('{"cash": "no"}'), 5, 'cash no');
select is(pg_temp.sgp('{"date_from": "2026-10-06"}'), pg_temp.ids('L3'), 'date_from is inclusive');
select is(pg_temp.sgp_n('{"date_to": "2026-10-05"}'), 8, 'date_to is inclusive');
select is(pg_temp.sgp('{"date_from": "2026-10-05", "date_to": "2026-10-05", "type": "bullion"}'), pg_temp.ids('M2','L2'), 'filters combine');
select is(pg_temp.sgp(format('{"recorded_by": "%s"}', pg_temp.m1())), pg_temp.ids('L4'), 'recorded_by');

select is(pg_temp.sgp('{"q": "alice"}'), pg_temp.ids('M1','L7','L6','L4','L3','L2','L1'),
    'q by name matches the main or the joint seller');
select is(pg_temp.sgp('{"q": "bob"}'), pg_temp.ids('M2','L5','L2'), 'q finds purchases where the customer is the main seller');
select is(pg_temp.sgp('{"q": "0412111222"}'), pg_temp.ids('M1','L7','L6','L4','L3','L2','L1'), 'q by phone');
select is(pg_temp.sgp('{"q": "dl-b1"}'), pg_temp.ids('M2','L5','L2'), 'q by ID number');
select is(pg_temp.sgp('{"q": "alice", "status": "incomplete"}'), pg_temp.ids('M1','L6','L1'), 'q combines with the other filters');
select is(pg_temp.sgp_n('{"q": "a"}'), 0, 'q under two characters matches nothing');
select is(pg_temp.sgp('{"q": "  "}'), pg_temp.ids('M2','M1','L7','L6','L5','L4','L3','L2','L1'), 'a blank q is no filter');
select is(pg_temp.sgp_n('{"q": "nobody"}'), 0, 'q with no match');
select is(pg_temp.q_as(pg_temp.s1(), 'aal2', format($q$select customer_first_name, customer_last_name, joint_customer_first_name, joint_customer_last_name, ttr_status, ttr_transaction_ref
        from gold.search_gold_purchases('{}', 1, 100) where id = %L$q$, pg_temp.u('L2'))),
    jsonb_build_array(jsonb_build_object('customer_first_name', 'Bob', 'customer_last_name', 'Beta', 'joint_customer_first_name', 'Alice',
        'joint_customer_last_name', 'Alpha', 'ttr_status', 'complete', 'ttr_transaction_ref', 'REF-t_l2')),
    'rows carry both sellers'' names and the TTR status');
select is(pg_temp.sgp('{}', 1, 100, pg_temp.s2()), pg_temp.ids('X2','X1'), 'entity two sees only its own');
select is(pg_temp.sgp('{"q": "alice"}', 1, 100, pg_temp.s2()), '', 'and cannot find entity one''s customers');
select is(pg_temp.sgp('{}', 1, 100, pg_temp.s1(), 'aal1'), '', 'aal1 sees nothing');

-- The page size is capped at 100.
insert into gold.purchases (reporting_entity_id, customer_id, main_id_verification_id, purchase_type, cash_band, cash_10k_or_more,
    phone, id_sighted, created_by_staff_id, sale_date, created_at, erp_invoice_no)
select '11111111-1111-1111-1111-111111111111', pg_temp.u('cB'), pg_temp.u('capB'), 'scrap', 'under_10k', false, '0412345678', true,
       pg_temp.s1(), '2026-09-01', timestamptz '2026-09-01' + i * interval '1 minute', 'BULK-' || i
from generate_series(1, 105) i;
select is(pg_temp.sgp_n('{}', 1, 1000), 100, 'a page size of 1000 returns at most 100 rows');
select is(pg_temp.scalar_as(pg_temp.s1(), 'aal2', $q$(select max(total_count) from gold.search_gold_purchases('{}', 1, 1000))$q$), '114', 'and total_count still counts them all');
select is(pg_temp.sgp_n('{}', 2, 1000), 14, 'page 2 of 100 has the other 14');

-- ═══ gold.list_recorded_by ════════════════════════════════════════════════════════════════
select is(pg_temp.col_as(pg_temp.s1(), 'aal2', 'select staff_member_id, full_name from gold.list_recorded_by()', 'full_name'), 'Manager One,Staff One',
    'staff who recorded purchases, by name');
select is(pg_temp.col_as(pg_temp.s2(), 'aal2', 'select staff_member_id, full_name from gold.list_recorded_by()', 'full_name'), 'Staff Two', 'only in the caller''s entity');
select is(pg_temp.n_as(pg_temp.s1(), 'aal1', 'select * from gold.list_recorded_by()'), 0, 'aal1 sees nothing');

-- ═══ gold.purchase_id_used ════════════════════════════════════════════════════════════════
select pg_temp.mk_cust('cK', '11111111-1111-1111-1111-111111111111', 'Kay', 'Kilo', '1979-01-01', '0412 999 000');
select pg_temp.mk_cap('kOld', pg_temp.u('cK'), 'Driver licence', 'DL-K', 'VIC', 'AU', '2026-01-01');
select pg_temp.mk_cap('kOther', pg_temp.u('cK'), 'Passport', 'PP-K', null, 'AU', '2026-06-01');
select pg_temp.mk_purchase('PU1', pg_temp.u('cK'), pg_temp.u('kOld'), p_joint => pg_temp.u('cJ'), p_joint_cap => pg_temp.u('capJ'));
select pg_temp.mk_purchase('PU3', pg_temp.u('cK'), pg_temp.u('kOther'));

select is(pg_temp.q_as(pg_temp.s1(), 'aal2', format('select role, verification_id, document_type, document_number, id_country_code, photos_replaced, current_copy_verification_id, front_image_id from gold.purchase_id_used(%L)', pg_temp.u('PU1'))),
    jsonb_build_array(
        jsonb_build_object('role', 'main', 'verification_id', pg_temp.u('kOld'), 'document_type', 'Driver licence', 'document_number', 'DL-K',
            'id_country_code', 'AU', 'photos_replaced', false, 'current_copy_verification_id', null, 'front_image_id', pg_temp.u('img_kOld')),
        jsonb_build_object('role', 'joint', 'verification_id', pg_temp.u('capJ'), 'document_type', 'Driver licence', 'document_number', 'DL-J1',
            'id_country_code', 'AU', 'photos_replaced', false, 'current_copy_verification_id', null, 'front_image_id', pg_temp.u('img_capJ'))),
    'the ID used for the main and joint seller, with their own photos while those are current');

-- The licence is renewed: a linked re-capture, and the old photo is superseded.
select pg_temp.mk_cap('kNew', pg_temp.u('cK'), 'Driver licence', 'DL-K', 'VIC', 'AU', '2026-05-01', pg_temp.s1(), '2031-01-01', 'kOld', 'id_changed');
update ttr.stored_images set superseded_at = now(), superseded_by_image_id = pg_temp.u('img_kNew') where id = pg_temp.u('img_kOld');
select pg_temp.mk_purchase('PU2', pg_temp.u('cK'), pg_temp.u('kNew'));

select is(pg_temp.q_as(pg_temp.s1(), 'aal2', format('select photos_replaced, current_copy_verification_id, current_copy_captured_at, front_image_id, back_image_id, captured_at, expiry_date from gold.purchase_id_used(%L) where role = ''main''', pg_temp.u('PU1'))),
    jsonb_build_array(jsonb_build_object('photos_replaced', true, 'current_copy_verification_id', pg_temp.u('kNew'),
        'current_copy_captured_at', '2026-05-01T00:00:00+00:00', 'front_image_id', pg_temp.u('img_kNew'), 'back_image_id', null,
        'captured_at', '2026-01-01T00:00:00+00:00', 'expiry_date', '2030-01-01')),
    'when the photos were replaced, the newer copy and its date are returned and its images are the ones to show');
select is(pg_temp.scalar_as(pg_temp.s1(), 'aal2', format('(select photos_replaced from gold.purchase_id_used(%L) where role = ''joint'')', pg_temp.u('PU1'))), 'false',
    'the joint seller''s ID is unaffected');
select is(pg_temp.q_as(pg_temp.s1(), 'aal2', format('select photos_replaced, current_copy_verification_id, front_image_id from gold.purchase_id_used(%L)', pg_temp.u('PU2'))),
    jsonb_build_array(jsonb_build_object('photos_replaced', false, 'current_copy_verification_id', null, 'front_image_id', pg_temp.u('img_kNew'))),
    'a purchase made with the newer capture is not replaced');
select is(pg_temp.scalar_as(pg_temp.s1(), 'aal2', format('(select photos_replaced from gold.purchase_id_used(%L))', pg_temp.u('PU3'))), 'false',
    'a different document is a separate capture and is never followed');

-- Renewed again: the chain is followed to the newest copy.
select pg_temp.mk_cap('kNew2', pg_temp.u('cK'), 'Driver licence', 'DL-K', 'VIC', 'AU', '2026-08-01', pg_temp.s1(), '2036-01-01', 'kNew', 'id_changed');
update ttr.stored_images set superseded_at = now(), superseded_by_image_id = pg_temp.u('img_kNew2') where id = pg_temp.u('img_kNew');
select is(pg_temp.scalar_as(pg_temp.s1(), 'aal2', format('(select current_copy_verification_id from gold.purchase_id_used(%L) where role = ''main'')', pg_temp.u('PU1'))),
    pg_temp.u('kNew2')::text, 'the chain is followed through every renewal to the newest unsuperseded capture');
select is(pg_temp.scalar_as(pg_temp.s1(), 'aal2', format('(select current_copy_verification_id from gold.purchase_id_used(%L))', pg_temp.u('PU2'))),
    pg_temp.u('kNew2')::text, 'including from a purchase made with the middle capture');

select is(pg_temp.n_as(pg_temp.s2(), 'aal2', format('select * from gold.purchase_id_used(%L)', pg_temp.u('PU1'))), 0, 'another entity gets nothing');
select is(pg_temp.n_as(pg_temp.s1(), 'aal1', format('select * from gold.purchase_id_used(%L)', pg_temp.u('PU1'))), 0, 'aal1 gets nothing');
select is(pg_temp.n_as(pg_temp.s1(), 'aal2', 'select * from gold.purchase_id_used(gen_random_uuid())'), 0, 'an unknown purchase gets nothing');

-- ═══ Signatures: the agreed return columns ════════════════════════════════════════════════
select is((select proargnames::text from pg_proc where oid = 'public.customer_current_id(uuid)'::regprocedure),
    '{p_customer_id,verification_id,document_type,document_number,issuer,id_country_code,has_expiry,expiry_date,captured_at,captured_by_name,front_image_id,back_image_id}',
    'customer_current_id signature');
select is((select proargnames::text from pg_proc where oid = 'public.find_possible_duplicate_customers(text,text,date,text)'::regprocedure),
    '{p_first_name,p_last_name,p_dob,p_phone,customer_id,first_name,last_name,date_of_birth,phone,match_reason}', 'find_possible_duplicate_customers signature');
select is((select proargnames::text from pg_proc where oid = 'gold.linked_parts(uuid,text,date)'::regprocedure),
    '{p_customer_id,p_invoice_norm,p_sale_date,id,purchase_type,cash_10k_or_more,cash_amount,ttr_transaction_id,ttr_status,customer_id,joint_customer_id,erp_invoice_no,sale_date,created_at}',
    'linked_parts signature');
select is((select proargnames::text from pg_proc where oid = 'gold.invoice_purchases(text)'::regprocedure),
    '{p_invoice,id,customer_id,joint_customer_id,sale_date}', 'invoice_purchases signature');
select is((select proargnames::text from pg_proc where oid = 'gold.list_recorded_by()'::regprocedure),
    '{staff_member_id,full_name}', 'list_recorded_by signature');
select is((select proargnames::text from pg_proc where oid = 'gold.purchase_id_used(uuid)'::regprocedure),
    '{p_purchase_id,role,verification_id,document_type,document_number,issuer,id_country_code,expiry_date,captured_at,captured_by_name,photos_replaced,current_copy_verification_id,current_copy_captured_at,front_image_id,back_image_id}',
    'purchase_id_used signature');
select ok((select proargnames from pg_proc where oid = 'gold.list_incomplete_purchases()'::regprocedure)
        @> array['id','customer_id','joint_customer_id','erp_invoice_no','cash_10k_or_more','ttr_transaction_id','customer_first_name','customer_last_name','ttr_status','ttr_transaction_ref'],
    'list_incomplete_purchases returns the purchase columns plus names and TTR status');
select is((select proargnames[array_length(proargnames, 1)] from pg_proc where oid = 'gold.search_gold_purchases(jsonb,int,int)'::regprocedure), 'total_count',
    'search_gold_purchases ends with total_count');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('public', 'gold') and p.proname in ('search_customers','customer_current_id','find_possible_duplicate_customers','customer_ttr_ready',
               'linked_parts','invoice_purchases','list_incomplete_purchases','search_gold_purchases','list_recorded_by','purchase_id_used')
             and (has_function_privilege('anon', p.oid, 'execute') or not has_function_privilege('authenticated', p.oid, 'execute')
                  or not has_function_privilege('service_role', p.oid, 'execute'))), 0,
    'every read RPC is executable by authenticated and service_role and not by anon');

select * from finish();
rollback;
