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

-- ─── Seed: one customer, ID and purchase per entity, with photos and audit rows ───────────
select pg_temp.mk_cust('cA', '11111111-1111-1111-1111-111111111111', 'Alice', 'Alpha');
select pg_temp.mk_cust('cB', '22222222-2222-2222-2222-222222222222', 'Bob', 'Beta');
select pg_temp.mk_cap('capA', pg_temp.u('cA'));
select pg_temp.mk_cap('capB', pg_temp.u('cB'), 'Passport', null, null, 'AU', '2026-03-01', 'a2222222-2222-2222-2222-222222222222');
select pg_temp.mk_purchase('pA', pg_temp.u('cA'), pg_temp.u('capA'));
select pg_temp.mk_purchase('pB', pg_temp.u('cB'), pg_temp.u('capB'), '22222222-2222-2222-2222-222222222222',
    'a2222222-2222-2222-2222-222222222222');

insert into gold.goods_photos (id, purchase_id, reporting_entity_id, object_path, content_hash_sha256, captured_by_staff_id)
values (pg_temp.u('phA'), pg_temp.u('pA'), '11111111-1111-1111-1111-111111111111', pg_temp.u('pA') || '/goods-1.jpg', 'h', 'a1111111-1111-1111-1111-111111111111'),
       (pg_temp.u('phB'), pg_temp.u('pB'), '22222222-2222-2222-2222-222222222222', pg_temp.u('pB') || '/goods-1.jpg', 'h', 'a2222222-2222-2222-2222-222222222222');

-- An update writes an audit row for each purchase.
update gold.purchases set cash_amount = 100 where id in (pg_temp.u('pA'), pg_temp.u('pB'));

insert into gold.export_audit_log (id, reporting_entity_id, staff_member_id, kind, purchase_ids) values
    (pg_temp.u('exA'), '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111112', 'zip', array[pg_temp.u('pA')]),
    (pg_temp.u('exB'), '22222222-2222-2222-2222-222222222222', 'a2222222-2222-2222-2222-222222222223', 'record', array[pg_temp.u('pB')]);

select plan(32);

-- ─── Reads: own entity only, and only at aal2 ─────────────────────────────────────────────
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2', 'select id from gold.purchases'),
    jsonb_build_array(jsonb_build_object('id', pg_temp.u('pA'))), 'staff in entity one sees only entity one''s purchase');
select is(pg_temp.q_as('a2222222-2222-2222-2222-222222222222', 'aal2', 'select id from gold.purchases'),
    jsonb_build_array(jsonb_build_object('id', pg_temp.u('pB'))), 'staff in entity two sees only entity two''s purchase');
select is(pg_temp.n_as('a1111111-1111-1111-1111-111111111111', 'aal1', 'select id from gold.purchases'), 0,
    'a password-only (aal1) session sees no purchases');
select is(pg_temp.n_as('a1111111-1111-1111-1111-111111111111', 'aal2', 'select id from gold.goods_photos'), 1,
    'goods photos: own entity only');
select is(pg_temp.n_as('a1111111-1111-1111-1111-111111111111', 'aal1', 'select id from gold.goods_photos'), 0,
    'goods photos: nothing at aal1');
select is(pg_temp.n_as('a1111111-1111-1111-1111-111111111111', 'aal2', 'select id from gold.purchase_audit_log'), 1,
    'purchase audit log: own entity only');
select is(pg_temp.n_as('a1111111-1111-1111-1111-111111111111', 'aal1', 'select id from gold.purchase_audit_log'), 0,
    'purchase audit log: nothing at aal1');

-- ─── export_audit_log: managers and admins of the entity only ────────────────────────────
select is(pg_temp.n_as('a1111111-1111-1111-1111-111111111111', 'aal2', 'select id from gold.export_audit_log'), 0,
    'staff cannot read the export audit log');
select is(pg_temp.n_as('a1111111-1111-1111-1111-111111111112', 'aal2', 'select id from gold.export_audit_log'), 1,
    'a manager reads their entity''s export audit log');
select is(pg_temp.n_as('a1111111-1111-1111-1111-111111111113', 'aal2', 'select id from gold.export_audit_log'), 1,
    'an admin reads their entity''s export audit log');
select is(pg_temp.n_as('a1111111-1111-1111-1111-111111111112', 'aal1', 'select id from gold.export_audit_log'), 0,
    'a manager at aal1 reads nothing');
select is(pg_temp.q_as('a2222222-2222-2222-2222-222222222223', 'aal2', 'select id from gold.export_audit_log'),
    jsonb_build_array(jsonb_build_object('id', pg_temp.u('exB'))), 'and a manager never sees another entity''s rows');

-- ─── The browser cannot write: no privilege, no policy ───────────────────────────────────
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111112', 'aal2',
    format($q$insert into gold.purchases (reporting_entity_id, customer_id, main_id_verification_id, purchase_type, cash_band,
        cash_10k_or_more, phone, id_sighted, created_by_staff_id)
        values (%L, %L, %L, 'scrap', 'under_10k', false, '0412345678', true, %L)$q$,
        '11111111-1111-1111-1111-111111111111', pg_temp.u('cA'), pg_temp.u('capA'), 'a1111111-1111-1111-1111-111111111112')),
    'err:42501', 'a manager cannot insert a purchase');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111113', 'aal2',
    format($q$update gold.purchases set cash_amount = 1 where id = %L$q$, pg_temp.u('pA'))),
    'err:42501', 'an admin cannot update a purchase');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
    format($q$delete from gold.purchases where id = %L$q$, pg_temp.u('pA'))),
    'err:42501', 'staff cannot delete a purchase');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
    format($q$insert into gold.goods_photos (purchase_id, reporting_entity_id, object_path, content_hash_sha256, captured_by_staff_id)
        values (%L, %L, %L, 'h', %L)$q$, pg_temp.u('pA'), '11111111-1111-1111-1111-111111111111',
        pg_temp.u('pA') || '/goods-9.jpg', 'a1111111-1111-1111-1111-111111111111')),
    'err:42501', 'cannot insert a goods photo');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2', 'update gold.goods_photos set sort_order = 5'),
    'err:42501', 'cannot update a goods photo');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2', 'delete from gold.goods_photos'),
    'err:42501', 'cannot delete a goods photo');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
    format($q$insert into gold.purchase_audit_log (purchase_id, reporting_entity_id, changes)
        values (%L, %L, '{}')$q$, pg_temp.u('pA'), '11111111-1111-1111-1111-111111111111')),
    'err:42501', 'cannot insert a purchase audit row');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2', 'update gold.purchase_audit_log set source = ''x'''),
    'err:42501', 'cannot update a purchase audit row');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2', 'delete from gold.purchase_audit_log'),
    'err:42501', 'cannot delete a purchase audit row');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111112', 'aal2',
    format($q$insert into gold.export_audit_log (reporting_entity_id, staff_member_id, kind)
        values (%L, %L, 'zip')$q$, '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111112')),
    'err:42501', 'a manager cannot write the export audit log');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111112', 'aal2', 'delete from gold.export_audit_log'),
    'err:42501', 'a manager cannot delete export audit rows');

-- ─── anon has no access at all ───────────────────────────────────────────────────────────
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2', 'select id from gold.purchases', 'anon') ->> 'sqlstate',
    '42501', 'anon cannot read gold.purchases');
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2', 'select * from gold.list_incomplete_purchases()', 'anon') ->> 'sqlstate',
    '42501', 'anon cannot call a gold RPC');
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2', 'select * from public.search_customers(''alice'')', 'anon') ->> 'sqlstate',
    '42501', 'anon cannot call search_customers');

-- ─── Internal helpers are closed to the browser ──────────────────────────────────────────
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2', 'select * from gold._id_captures') ->> 'sqlstate',
    '42501', 'the internal ID captures view is not readable by staff');
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2',
    format('select * from public._search_customer_ids(%L, ''alice'')', '11111111-1111-1111-1111-111111111111')) ->> 'sqlstate',
    '42501', 'and the search core cannot be called with a chosen entity');

-- ─── Goods bucket: private, and no storage policy lets the browser at it ─────────────────
select is((select public from storage.buckets where id = 'gold-goods'), false, 'the gold-goods bucket exists and is private');
select is((select count(*)::int from pg_policies
           where schemaname = 'storage' and tablename = 'objects'
             and (coalesce(qual, '') || coalesce(with_check, '')) like '%gold-goods%'), 0,
    'no storage policy mentions gold-goods');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111112', 'aal2',
    format($q$insert into storage.objects (bucket_id, name, owner) values ('gold-goods', %L, %L)$q$,
        pg_temp.u('pA') || '/goods-1.jpg', 'a1111111-1111-1111-1111-111111111112')),
    'err:42501', 'staff cannot upload to gold-goods');
select is(pg_temp.n_as('a1111111-1111-1111-1111-111111111112', 'aal2', 'select id from storage.objects where bucket_id = ''gold-goods'''), 0,
    'and cannot list it');

select * from finish();
rollback;
