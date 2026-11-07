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

-- Seed: Kay's licence (kOld) and passport (kOther), a joint seller with a licence, three purchases, one more business.
select pg_temp.mk_cust('cK', '11111111-1111-1111-1111-111111111111', 'Kay', 'Kilo', '1979-01-01', '0412 999 000');
select pg_temp.mk_cust('cJ', '11111111-1111-1111-1111-111111111111', 'Jo', 'Joint', '1982-01-01', '0412 555 666');
select pg_temp.mk_cust('cX', '22222222-2222-2222-2222-222222222222', 'Xena', 'Other', '1983-01-01', '0412 777 888');
select pg_temp.mk_cap('kOld', pg_temp.u('cK'), 'Driver licence', 'DL-K', 'VIC', 'AU', '2026-01-01');
select pg_temp.mk_cap('kOther', pg_temp.u('cK'), 'Passport', 'PP-K', null, 'AU', '2026-06-01');
select pg_temp.mk_cap('capJ', pg_temp.u('cJ'), 'Driver licence', 'DL-J1');
select pg_temp.mk_cap('capX', pg_temp.u('cX'), 'Driver licence', 'DL-X1', 'VIC', 'AU', '2026-03-01', pg_temp.s2());
select pg_temp.mk_purchase('PE1', pg_temp.u('cK'), pg_temp.u('kOld'), p_joint => pg_temp.u('cJ'), p_joint_cap => pg_temp.u('capJ'));
select pg_temp.mk_purchase('PE3', pg_temp.u('cK'), pg_temp.u('kOther'));
select pg_temp.mk_purchase('PX1', pg_temp.u('cX'), pg_temp.u('capX'), '22222222-2222-2222-2222-222222222222', pg_temp.s2());

select plan(16);

create function pg_temp.eip(p_ids text, p_uid uuid default 'a1111111-1111-1111-1111-111111111111', p_aal text default 'aal2') returns jsonb language sql as $$
    select pg_temp.q_as(p_uid, p_aal, format('select purchase_id, role, document_number, photos_replaced, front_object_path, back_object_path from gold.export_id_photos(%s)', p_ids))
$$;
create function pg_temp.ids(variadic p_labels text[]) returns text language sql as $$
    select 'array[' || string_agg(quote_literal(pg_temp.u(l)) || '::uuid', ',' order by o) || ']'
    from unnest(p_labels) with ordinality t(l, o)
$$;

-- ═══ Before any photo is replaced ═══════════════════════════════════════════════════════════
select is(pg_temp.eip(pg_temp.ids('PE1')),
    jsonb_build_array(
        jsonb_build_object('purchase_id', pg_temp.u('PE1'), 'role', 'main', 'document_number', 'DL-K', 'photos_replaced', false,
            'front_object_path', 'customers/' || pg_temp.u('cK') || '/' || pg_temp.u('kOld') || '/front-x.jpg', 'back_object_path', null),
        jsonb_build_object('purchase_id', pg_temp.u('PE1'), 'role', 'joint', 'document_number', 'DL-J1', 'photos_replaced', false,
            'front_object_path', 'customers/' || pg_temp.u('cJ') || '/' || pg_temp.u('capJ') || '/front-x.jpg', 'back_object_path', null)),
    'the main and joint seller''s ID photos for a purchase, with the storage path of each');

-- ═══ The licence is renewed: the old photo is superseded (C1) ═══════════════════════════════════
select pg_temp.mk_cap('kNew', pg_temp.u('cK'), 'Driver licence', 'DL-K', 'VIC', 'AU', '2026-05-01', pg_temp.s1(), '2031-01-01', 'kOld', 'id_changed');
update ttr.stored_images set superseded_at = now(), superseded_by_image_id = pg_temp.u('img_kNew') where id = pg_temp.u('img_kOld');

select is(pg_temp.q_as(pg_temp.s1(), 'aal2', format('select role, document_number, photos_replaced, current_copy_captured_at, front_object_path from gold.export_id_photos(%s) where role = ''main''', pg_temp.ids('PE1'))),
    jsonb_build_array(jsonb_build_object('role', 'main', 'document_number', 'DL-K', 'photos_replaced', true,
        'current_copy_captured_at', '2026-05-01T00:00:00+00:00',
        'front_object_path', 'customers/' || pg_temp.u('cK') || '/' || pg_temp.u('kNew') || '/front-x.jpg')),
    'a replaced capture exports the newer copy''s photo, says it was replaced, and keeps the ID details the purchase used');
select is(pg_temp.n_as(pg_temp.s1(), 'aal2', format('select * from gold.export_id_photos(%s) where front_object_path like %L', pg_temp.ids('PE1'), '%/' || pg_temp.u('kOld') || '/%')), 0,
    'the superseded photo is never named');
select is(pg_temp.scalar_as(pg_temp.s1(), 'aal2', format('(select front_object_path from gold.export_id_photos(%s) where role = ''joint'')', pg_temp.ids('PE1'))),
    'customers/' || pg_temp.u('cJ') || '/' || pg_temp.u('capJ') || '/front-x.jpg', 'the joint seller''s photo is unaffected');
select is(pg_temp.q_as(pg_temp.s1(), 'aal2', format('select photos_replaced, front_object_path from gold.export_id_photos(%s)', pg_temp.ids('PE3'))),
    jsonb_build_array(jsonb_build_object('photos_replaced', false,
        'front_object_path', 'customers/' || pg_temp.u('cK') || '/' || pg_temp.u('kOther') || '/front-x.jpg')),
    'a different document is a separate capture: its photo stays and is not replaced');

-- ═══ Order, and who may ask ═══════════════════════════════════════════════════════════════
select is(pg_temp.col_as(pg_temp.s1(), 'aal2', format('select purchase_id || '':'' || role as k from gold.export_id_photos(%s)', pg_temp.ids('PE3', 'PE1')), 'k'),
    pg_temp.u('PE3') || ':main,' || pg_temp.u('PE1') || ':main,' || pg_temp.u('PE1') || ':joint',
    'rows follow the order of the ids asked for, main seller before joint');
select is(pg_temp.n_as(pg_temp.s1(), 'aal2', format('select * from gold.export_id_photos(%s)', pg_temp.ids('PX1'))), 0, 'another business''s purchase returns nothing');
select is(pg_temp.n_as(pg_temp.s2(), 'aal2', format('select * from gold.export_id_photos(%s)', pg_temp.ids('PE1'))), 0, 'and the other business cannot read this one');
select is(pg_temp.n_as(pg_temp.s1(), 'aal1', format('select * from gold.export_id_photos(%s)', pg_temp.ids('PE1'))), 0, 'aal1 gets nothing');
select is(pg_temp.n_as(pg_temp.s1(), 'aal2', 'select * from gold.export_id_photos(array[gen_random_uuid()])'), 0, 'an unknown purchase returns nothing');
select is(pg_temp.n_as(pg_temp.s1(), 'aal2', 'select * from gold.export_id_photos(array[]::uuid[])'), 0, 'no ids, no rows');
select ok(not has_function_privilege('anon', 'gold.export_id_photos(uuid[])', 'execute')
    and has_function_privilege('authenticated', 'gold.export_id_photos(uuid[])', 'execute')
    and has_function_privilege('service_role', 'gold.export_id_photos(uuid[])', 'execute'),
    'executable by authenticated and service_role, not anon');

-- ═══ gold.export_audit_log: written by the service role, append-only, never by the browser ════════
select is(pg_temp.dml_as(pg_temp.m1(), 'aal2', format('insert into gold.export_audit_log (reporting_entity_id, staff_member_id, kind, purchase_ids) values (%L, %L, ''zip'', array[%L]::uuid[])',
    '11111111-1111-1111-1111-111111111111', pg_temp.m1(), pg_temp.u('PE1'))), 'err:42501', 'a manager''s own session cannot write an export audit row');
select is(pg_temp.dml_as(pg_temp.m1(), 'aal2', format('insert into gold.export_audit_log (reporting_entity_id, staff_member_id, kind, filters, purchase_ids) values (%L, %L, ''zip'', %L::jsonb, array[%L]::uuid[])',
    '11111111-1111-1111-1111-111111111111', pg_temp.m1(), '{"q":"Kay"}', pg_temp.u('PE1')), 'service_role'), 'ok:1', 'the service role writes one');
select is(pg_temp.dml_as(pg_temp.m1(), 'aal2', 'update gold.export_audit_log set kind = ''record''', 'service_role'), 'err:P0001', 'an audit row cannot be updated, even by the service role');
select is(pg_temp.dml_as(pg_temp.m1(), 'aal2', 'delete from gold.export_audit_log', 'service_role'), 'err:P0001', 'or deleted');

select * from finish();
rollback;
