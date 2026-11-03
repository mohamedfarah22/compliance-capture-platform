-- pgTAP: the atomic write functions behind gold-save-purchase and gold-complete-purchase
-- (20261107000001_gold_purchase_writes.sql): grants, atomicity, entity scoping, audit rows, and
-- the Phase 5 immutability rules still holding after a save.
--
-- Harness inlined, as in 05 and 06 (`supabase test db` runs every .sql here as its own test).

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

create function pg_temp.u(p_label text) returns uuid language sql immutable as $$ select md5(p_label)::uuid $$;

-- Fixtures: two entities, one active staff member in each, and an inactive one in the first.
insert into public.reporting_entities (id, legal_name) values
    ('11111111-1111-1111-1111-111111111111', 'Entity One'),
    ('22222222-2222-2222-2222-222222222222', 'Entity Two');
insert into auth.users (id, email) values
    ('a1111111-1111-1111-1111-111111111111', 'staff1@entity-one.test'),
    ('a1111111-1111-1111-1111-111111111112', 'manager1@entity-one.test'),
    ('a1111111-1111-1111-1111-111111111119', 'gone1@entity-one.test'),
    ('a2222222-2222-2222-2222-222222222222', 'staff2@entity-two.test');
insert into public.staff_members (id, reporting_entity_id, full_name, email, role, is_active) values
    ('a1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'Staff One',   'staff1@entity-one.test',   'staff',   true),
    ('a1111111-1111-1111-1111-111111111112', '11111111-1111-1111-1111-111111111111', 'Manager One', 'manager1@entity-one.test', 'manager', true),
    ('a1111111-1111-1111-1111-111111111119', '11111111-1111-1111-1111-111111111111', 'Gone One',    'gone1@entity-one.test',    'staff',   false),
    ('a2222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'Staff Two',   'staff2@entity-two.test',   'staff',   true);

create function pg_temp.mk_cust(p_label text, p_entity uuid, p_first text, p_last text) returns uuid language plpgsql as $$
begin
    insert into public.customers
        (id, reporting_entity_id, customer_type, source, first_name, last_name, date_of_birth, phone,
         res_street, res_suburb, res_state, res_postcode)
    values
        (pg_temp.u(p_label), p_entity, 'individual', 'gold', p_first, p_last, '1980-01-01', '0400 000 000',
         '1 Test St', 'Coburg', 'VIC', '3058');
    return pg_temp.u(p_label);
end $$;

create function pg_temp.mk_cap(p_label text, p_customer uuid) returns uuid language plpgsql as $$
begin
    insert into ttr.stored_images (id, customer_id, object_path, content_hash_sha256, captured_by_staff_id)
    values (pg_temp.u('img_' || p_label), p_customer,
            'customers/' || p_customer || '/' || pg_temp.u(p_label) || '/front-x.jpg', 'hash-' || p_label,
            'a1111111-1111-1111-1111-111111111111');
    insert into ttr.id_verifications
        (id, customer_id, verification_method, document_type, document_number, issuer, id_country_code,
         has_expiry, expiry_date, verification_description, is_complete, front_image_id, created_at)
    values
        (pg_temp.u(p_label), p_customer, 'Sighted original document', 'Driver licence'::id_doc_type,
         'NUM-' || p_label, 'VIC', 'AU', true, '2030-01-01', 'Sighted in person', true,
         pg_temp.u('img_' || p_label), '2026-03-01');
    return pg_temp.u(p_label);
end $$;

select pg_temp.mk_cust('cA', '11111111-1111-1111-1111-111111111111', 'Jane', 'Citizen');
select pg_temp.mk_cust('cB', '11111111-1111-1111-1111-111111111111', 'Joan', 'Citizen');
select pg_temp.mk_cust('cC', '22222222-2222-2222-2222-222222222222', 'Carl', 'Elsewhere');
select pg_temp.mk_cap('capA', pg_temp.u('cA'));
select pg_temp.mk_cap('capB', pg_temp.u('cB'));
select pg_temp.mk_cap('capC', pg_temp.u('cC'));

-- The row gold-save-purchase would build, with some keys overridden.
create function pg_temp.pj(p_label text, p_over jsonb default '{}') returns jsonb language sql as $$
    select jsonb_build_object(
        'id', pg_temp.u(p_label), 'customer_id', pg_temp.u('cA'), 'main_id_verification_id', pg_temp.u('capA'),
        'purchase_type', 'scrap', 'cash_band', 'under_10k', 'cash_10k_or_more', false,
        'sale_date', '2026-11-07', 'phone', '0412 345 678', 'id_sighted', true,
        'id_expired_at_time', false, 'id_outside_window_at_time', false
    ) || p_over
$$;

-- n goods photos for purchase p_label.
create function pg_temp.ph(p_label text, p_n int default 1) returns jsonb language sql as $$
    select jsonb_agg(jsonb_build_object(
        'object_path', pg_temp.u(p_label)::text || '/goods-' || i || '.jpg',
        'content_hash_sha256', 'hash' || i, 'byte_size', 100 * i))
    from generate_series(1, p_n) i
$$;

-- Call gold.save_purchase as the service role. Returns the jsonb row set (or {error, sqlstate}).
create function pg_temp.save_as(p_role text, p_purchase jsonb, p_photos jsonb, p_fills jsonb default '[]',
    p_entity uuid default '11111111-1111-1111-1111-111111111111',
    p_staff uuid default 'a1111111-1111-1111-1111-111111111111') returns jsonb language sql as $$
    select pg_temp.q_as(null, 'aal2', format('select gold.save_purchase(%L, %L, %L::jsonb, %L::jsonb, %L::jsonb) as id',
        p_entity, p_staff, p_purchase, p_photos, p_fills), p_role)
$$;

-- Fixtures for the invoice lock (migration 20261107000002): a complete TTR linked to a scrap part of INV-C.
insert into ttr.transactions (id, reporting_entity_id, scenario, transaction_ref, transaction_datetime, designated_service,
    location_snapshot, staff_member_name, staff_member_email, cash_currency, cash_amount, aud_value, status, completed_at)
values (pg_temp.u('tx'), '11111111-1111-1111-1111-111111111111', 'precious_metal_buy', 'INV-C', now(),
    'Purchase of precious metal for cash', 'Coburg, VIC', 'T', 't@example.test', 'AUD', 12000, 12000, 'complete', now());

create function pg_temp.mk(p_label text, p_cust text, p_cap text, p_type text, p_inv text, p_date date,
    p_amount numeric default 100, p_tx uuid default null)
returns void language sql as $$
    insert into gold.purchases (id, reporting_entity_id, customer_id, main_id_verification_id, purchase_type, cash_band,
        cash_10k_or_more, cash_amount, erp_invoice_no, sale_date, phone, id_sighted, ttr_transaction_id, created_by_staff_id)
    values (pg_temp.u(p_label), '11111111-1111-1111-1111-111111111111', pg_temp.u(p_cust), pg_temp.u(p_cap),
        p_type::gold.purchase_type, 'under_10k', false, p_amount, p_inv, p_date, '0412 345 678', true, p_tx,
        'a1111111-1111-1111-1111-111111111111')
$$;
select pg_temp.mk('dupA', 'cA', 'capA', 'scrap', 'INV-D', '2026-11-07');
select pg_temp.mk('ttrA', 'cA', 'capA', 'scrap', 'INV-C', '2026-11-07', 100, pg_temp.u('tx'));
select pg_temp.mk('noinv', 'cA', 'capA', 'scrap', null, '2026-11-07');
select pg_temp.mk('compB', 'cA', 'capA', 'scrap', null, '2026-11-07');
select pg_temp.mk('compC', 'cB', 'capB', 'scrap', null, '2026-11-07', null);
select pg_temp.mk('compD', 'cA', 'capA', 'scrap', null, '2026-11-07', 500);
select pg_temp.mk('big', 'cA', 'capA', 'scrap', 'INV-G', '2026-11-07', 9000);

create function pg_temp.sv(p_label text, p_over jsonb) returns text language sql as $$
    select pg_temp.dml_as(null, 'aal2', format('select gold.save_purchase(%L, %L, %L::jsonb, %L::jsonb, ''[]''::jsonb)',
        '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111',
        pg_temp.pj(p_label, p_over), pg_temp.ph(p_label)), 'service_role')
$$;
create function pg_temp.cp(p_label text, p_inv text, p_amount numeric default null) returns text language sql as $$
    select pg_temp.dml_as(null, 'aal2', format('select gold.complete_purchase(%L, %L, %L, %L, %L, ''[]''::jsonb)',
        '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', pg_temp.u(p_label), p_inv, p_amount),
        'service_role')
$$;

select plan(14);

-- Save: a reportable purchase cannot take an invoice used by a purchase that is not a same-day linked part.
select is(pg_temp.sv('r1', jsonb_build_object('erp_invoice_no', 'inv-d', 'cash_10k_or_more', true, 'cash_band', '10k_plus',
        'customer_id', pg_temp.u('cB'), 'main_id_verification_id', pg_temp.u('capB'))),
    'err:GD001', 'save: a reportable purchase of another customer on a used invoice is refused (case-insensitive)');
select is((select count(*)::int from gold.purchases where id = pg_temp.u('r1')), 0, '... and nothing is written');
select is((select count(*)::int from gold.goods_photos where purchase_id = pg_temp.u('r1')), 0, '... not even a photo row');
select is(pg_temp.sv('r2', jsonb_build_object('erp_invoice_no', 'INV-D', 'cash_10k_or_more', true, 'cash_band', '10k_plus')),
    'ok:1', 'save: the same customer, same day, is a linked part and is allowed');
select is(pg_temp.sv('r3', jsonb_build_object('erp_invoice_no', 'INV-D', 'sale_date', '2026-11-06', 'cash_10k_or_more', true, 'cash_band', '10k_plus')),
    'err:GD001', 'save: the same customer on another day is not a linked part');
select is(pg_temp.sv('r4', jsonb_build_object('erp_invoice_no', 'INV-D', 'customer_id', pg_temp.u('cB'), 'main_id_verification_id', pg_temp.u('capB'))),
    'ok:1', 'save: a non-reportable purchase on a used invoice is allowed (the edge function warns)');
select is(pg_temp.sv('r5', jsonb_build_object('erp_invoice_no', 'INV-C')), 'err:GD002',
    'save: a part of the same type on an invoice whose TTR is complete is refused');
select is(pg_temp.sv('r6', jsonb_build_object('erp_invoice_no', 'INV-C', 'purchase_type', 'bullion', 'cash_band', 'under_5k')), 'ok:1',
    'save: a bullion part on that invoice is allowed (the finished TTR is for scrap)');

-- Complete: the same two rules.
select is(pg_temp.cp('noinv', 'INV-D', null), 'ok:1', 'complete: a non-reportable purchase of the same customer links to the used invoice');
select is(pg_temp.cp('compB', 'INV-C', null), 'err:GD002', 'complete: a part of the same type on a finished-TTR invoice is refused');
select is((select erp_invoice_no from gold.purchases where id = pg_temp.u('compB')), null, '... and stays without an invoice');
-- compC (another customer, no amount saved) completed with 9500 on INV-G: the invoice total is not shared across customers
select is(pg_temp.cp('compC', 'INV-G', 9500), 'ok:1', 'complete: another customer''s parts do not count towards the total');
-- compD (500) on INV-G, which holds 9000 for the same customer on the same day: total 9500, not reportable, allowed
select is(pg_temp.cp('compD', 'INV-G', null), 'ok:1', 'complete: a linked total under $10,000 is not reportable');
select pg_temp.mk('big2', 'cA', 'capA', 'scrap', 'INV-H', '2026-11-07', 9000);
select pg_temp.mk('other', 'cB', 'capB', 'scrap', 'INV-H', '2026-11-06', 1);
select pg_temp.mk('pending', 'cA', 'capA', 'scrap', null, '2026-11-07', 2000);
select is(pg_temp.cp('pending', 'INV-H', null), 'err:GD001',
    'complete: a purchase made reportable by the linked total (9,000 + 2,000) is refused on an invoice used by another customer/day');
select * from finish();
rollback;
