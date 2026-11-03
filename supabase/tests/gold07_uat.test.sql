-- pgTAP, independent UAT for Gold Phase 7 (docs/uat-gold-07-purchase-writes.md): the table-level rows, run as the
-- real roles. 7.120 to 7.123 and 7.126 are the sheet's; 7.125 (the database half), 7.127, 7.128 and 7.129 were added
-- by UAT from spec 4.2, 4.3 and 4.5. Written from the spec, not from 10_gold_purchase_writes.test.sql.
--
-- Harness inlined, as in 05 and 06 (`supabase test db` runs every .sql here as its own test).

begin;
create extension if not exists pgtap with schema extensions;

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

create function pg_temp.u(p_label text) returns uuid language sql immutable as $$ select md5('g7uat-' || p_label)::uuid $$;

-- Two businesses, a staff member in each, and one inactive staff member in the first.
insert into public.reporting_entities (id, legal_name) values
    ('11111111-1111-1111-1111-111111111111', 'Entity One'),
    ('22222222-2222-2222-2222-222222222222', 'Entity Two');
insert into auth.users (id, email) values
    ('a1111111-1111-1111-1111-111111111111', 'g7-staff1@entity-one.test'),
    ('a1111111-1111-1111-1111-111111111119', 'g7-gone1@entity-one.test'),
    ('a2222222-2222-2222-2222-222222222222', 'g7-staff2@entity-two.test');
insert into public.staff_members (id, reporting_entity_id, full_name, email, role, is_active) values
    ('a1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'Staff One', 'g7-staff1@entity-one.test', 'staff', true),
    ('a1111111-1111-1111-1111-111111111119', '11111111-1111-1111-1111-111111111111', 'Gone One',  'g7-gone1@entity-one.test',  'staff', false),
    ('a2222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'Staff Two', 'g7-staff2@entity-two.test', 'staff', true);

create function pg_temp.mk_cust(p_label text, p_entity uuid) returns uuid language plpgsql as $$
begin
    insert into public.customers
        (id, reporting_entity_id, customer_type, source, first_name, last_name, date_of_birth, phone,
         res_street, res_suburb, res_state, res_postcode)
    values (pg_temp.u(p_label), p_entity, 'individual', 'gold', 'Cust', p_label, '1980-01-01', '0400 000 000',
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
    values (pg_temp.u(p_label), p_customer, 'Sighted original document', 'Driver licence'::id_doc_type,
         'NUM-' || p_label, 'VIC', 'AU', true, '2030-01-01', 'Sighted in person', true,
         pg_temp.u('img_' || p_label), now() - interval '10 days');
    return pg_temp.u(p_label);
end $$;

select pg_temp.mk_cust('main',  '11111111-1111-1111-1111-111111111111');
select pg_temp.mk_cust('joint', '11111111-1111-1111-1111-111111111111');
select pg_temp.mk_cust('other', '22222222-2222-2222-2222-222222222222');
select pg_temp.mk_cap('main',  pg_temp.u('main'));
select pg_temp.mk_cap('joint', pg_temp.u('joint'));
select pg_temp.mk_cap('other', pg_temp.u('other'));

-- P: a purchase with an invoice, completed, with a goods photo. Q: no invoice yet.
insert into gold.purchases
    (id, reporting_entity_id, customer_id, main_id_verification_id, purchase_type, cash_band, cash_10k_or_more,
     erp_invoice_no, sale_date, phone, id_sighted, created_by_staff_id, completed_at, completed_by_staff_id)
values
    (pg_temp.u('P'), '11111111-1111-1111-1111-111111111111', pg_temp.u('main'), pg_temp.u('main'),
     'scrap', 'under_10k', false, 'G7-INV-P', '2026-11-07', '0412 345 678', true,
     'a1111111-1111-1111-1111-111111111111', now(), 'a1111111-1111-1111-1111-111111111111'),
    (pg_temp.u('Q'), '11111111-1111-1111-1111-111111111111', pg_temp.u('main'), pg_temp.u('main'),
     'scrap', 'under_10k', false, null, '2026-11-07', '0412 345 678', true,
     'a1111111-1111-1111-1111-111111111111', null, null);
insert into gold.goods_photos (purchase_id, reporting_entity_id, object_path, content_hash_sha256, byte_size, captured_by_staff_id, sort_order)
values (pg_temp.u('P'), '11111111-1111-1111-1111-111111111111', pg_temp.u('P')::text || '/goods-1.jpg', 'h1', 10,
        'a1111111-1111-1111-1111-111111111111', 0);
insert into gold.purchase_audit_log (purchase_id, reporting_entity_id, changed_by, source, changes)
values (pg_temp.u('P'), '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'x',
        '{"phone":{"old":"a","new":"b"}}');

-- A purchase row as gold-save-purchase builds it, with some keys overridden.
create function pg_temp.pj(p_label text, p_over jsonb default '{}') returns jsonb language sql as $$
    select jsonb_build_object(
        'id', pg_temp.u(p_label), 'customer_id', pg_temp.u('main'), 'main_id_verification_id', pg_temp.u('main'),
        'purchase_type', 'scrap', 'cash_band', 'under_10k', 'cash_10k_or_more', false,
        'sale_date', '2026-11-07', 'phone', '0412 345 678', 'id_sighted', true,
        'id_expired_at_time', false, 'id_outside_window_at_time', false
    ) || p_over
$$;
create function pg_temp.one_photo(p_label text) returns jsonb language sql as $$
    select jsonb_build_array(jsonb_build_object(
        'object_path', pg_temp.u(p_label)::text || '/goods-1.jpg', 'content_hash_sha256', 'h', 'byte_size', 1))
$$;
-- gold.save_purchase as service_role: 'ok' or the SQLSTATE.
create function pg_temp.save_as_service(p_purchase jsonb, p_photos jsonb, p_fills jsonb default '[]',
    p_entity uuid default '11111111-1111-1111-1111-111111111111',
    p_staff uuid default 'a1111111-1111-1111-1111-111111111111') returns text language sql as $$
    select pg_temp.dml_as(null, 'aal2', format('select gold.save_purchase(%L, %L, %L::jsonb, %L::jsonb, %L::jsonb)',
        p_entity, p_staff, p_purchase, p_photos, p_fills), 'service_role')
$$;

create function pg_temp.fingerprint(p_label text) returns text language sql as $$
    select md5(to_jsonb(p)::text) from gold.purchases p where id = pg_temp.u(p_label)
$$;

select plan(64);

-- ─── 7.120 immutable after capture (4.3) ─────────────────────────────────────────────────
create temp table fp as select pg_temp.fingerprint('P') as p;

select is(pg_temp.dml_as(null, 'aal2', format('update gold.purchases set %s where id = %L', x.set_clause, pg_temp.u('P')), 'service_role'),
          'err:23001', '7.120 ⚠ — ' || x.label || ' is refused after capture (restrict_violation)')
from (values
    ('customer_id',                format('customer_id = %L', pg_temp.u('joint'))),
    ('joint_customer_id',          format('joint_customer_id = %L', pg_temp.u('joint'))),
    ('purchase_type',              'purchase_type = ''bullion'''),
    ('main_id_verification_id',    format('main_id_verification_id = %L', pg_temp.u('joint'))),
    ('joint_id_verification_id',   format('joint_id_verification_id = %L', pg_temp.u('joint'))),
    ('id_sighted',                 'id_sighted = false'),
    ('id_expired_at_time',         'id_expired_at_time = true'),
    ('id_outside_window_at_time',  'id_outside_window_at_time = true'),
    ('ttr_self_conducted',         'ttr_self_conducted = true'),
    ('ttr_details_confirmed',      'ttr_details_confirmed = true'),
    ('sale_date',                  'sale_date = ''2001-01-01'''),
    ('created_by_staff_id',        'created_by_staff_id = ''a2222222-2222-2222-2222-222222222222'''),
    ('created_at',                 'created_at = now() - interval ''1 day'''),
    ('reporting_entity_id',        'reporting_entity_id = ''22222222-2222-2222-2222-222222222222''')
) as x(label, set_clause)
order by x.label;

select is(pg_temp.fingerprint('P'), (select p from fp), '7.120 ⚠ — the purchase row is unchanged after all of those attempts');

-- ─── 7.121 the invoice is never changed or removed; completed_* only with the invoice (4.3) ─────────
select is(pg_temp.dml_as(null, 'aal2', format('update gold.purchases set erp_invoice_no = ''OTHER'' where id = %L', pg_temp.u('P')), 'service_role'),
          'err:23001', '7.121 ⚠ — an invoice already set cannot be changed');
select is(pg_temp.dml_as(null, 'aal2', format('update gold.purchases set erp_invoice_no = null where id = %L', pg_temp.u('P')), 'service_role'),
          'err:23001', '7.121 ⚠ — an invoice already set cannot be removed');
select is(pg_temp.dml_as(null, 'aal2', format('update gold.purchases set completed_at = now(), completed_by_staff_id = %L where id = %L',
          'a1111111-1111-1111-1111-111111111111', pg_temp.u('Q')), 'service_role'),
          'err:23001', '7.121 ⚠ — completed_* cannot be set without adding the invoice in the same update');
select is(pg_temp.dml_as(null, 'aal2', format('update gold.purchases set completed_at = now() - interval ''1 day'' where id = %L', pg_temp.u('P')), 'service_role'),
          'err:23001', '7.121 ⚠ — completed_at, once set, cannot change');
select is(pg_temp.dml_as(null, 'aal2', format('update gold.purchases set cash_amount = 50 where id = %L', pg_temp.u('Q')), 'service_role'),
          'ok:1', '7.121 — the allowed change: a missing cash amount can be filled');
select is(pg_temp.dml_as(null, 'aal2', format('update gold.purchases set erp_invoice_no = %L, completed_at = now(), completed_by_staff_id = %L where id = %L',
          'G7-INV-Q', 'a1111111-1111-1111-1111-111111111111', pg_temp.u('Q')), 'service_role'),
          'ok:1', '7.121 — the allowed change: invoice plus completed_* in one update');
select is(pg_temp.dml_as(null, 'aal2', format('update gold.purchases set completed_by_staff_id = null, completed_at = null where id = %L', pg_temp.u('Q')), 'service_role'),
          'err:23001', '7.121 — and completed_* cannot then be cleared');

-- ─── 7.122 goods photos are append-only (4.2) ────────────────────────────────────────────
select is(pg_temp.dml_as(null, 'aal2', format('update gold.goods_photos set sort_order = 9 where purchase_id = %L', pg_temp.u('P')), 'service_role'),
          'err:P0001', '7.122 — a goods photo row cannot be updated (service role)');
select is(pg_temp.dml_as(null, 'aal2', format('delete from gold.goods_photos where purchase_id = %L', pg_temp.u('P')), 'service_role'),
          'err:P0001', '7.122 — a goods photo row cannot be deleted (service role)');
select throws_ok(format('update gold.goods_photos set sort_order = 9 where purchase_id = %L', pg_temp.u('P')),
          'P0001', null, '7.122 — nor by the database owner');
select throws_ok(format('delete from gold.purchases where id = %L', pg_temp.u('P')),
          '23503', null, '7.122 — a purchase with photos cannot be deleted (foreign key)');
select is((select count(*)::int from gold.goods_photos where purchase_id = pg_temp.u('P')), 1, '7.122 — the photo row is still there');

-- ─── 7.123 the audit log is append-only (4.2) ────────────────────────────────────────────
select is(pg_temp.dml_as(null, 'aal2', 'update gold.purchase_audit_log set source = ''x2''', 'service_role'),
          'err:P0001', '7.123 ⚠ — an audit row cannot be updated (service role)');
select is(pg_temp.dml_as(null, 'aal2', 'delete from gold.purchase_audit_log', 'service_role'),
          'err:P0001', '7.123 ⚠ — an audit row cannot be deleted (service role)');
select throws_ok('update gold.purchase_audit_log set source = ''x3''', 'P0001', null, '7.123 ⚠ — nor by the database owner');
select throws_ok('delete from gold.purchase_audit_log', 'P0001', null, '7.123 ⚠ — nor deleted by the database owner');

-- ─── 7.125 (database half) the browser roles cannot write gold ───────────────────────────
select ok(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2', format('insert into gold.purchases (id) values (%L)', gen_random_uuid()))
          in ('err:42501'), '7.125 ⚠ — a signed-in staff member cannot insert a purchase');
select ok(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2', format('update gold.purchases set phone = ''0400000000'' where id = %L', pg_temp.u('Q')))
          in ('err:42501', 'ok:0'), '7.125 ⚠ — a signed-in staff member cannot update a purchase');
select ok(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2', format('delete from gold.purchases where id = %L', pg_temp.u('Q')))
          in ('err:42501', 'ok:0'), '7.125 ⚠ — a signed-in staff member cannot delete a purchase');
select ok(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2', format('insert into gold.goods_photos (purchase_id) values (%L)', pg_temp.u('Q')))
          in ('err:42501'), '7.125 ⚠ — a signed-in staff member cannot insert a goods photo');
select is(pg_temp.dml_as(null, 'aal2', format('insert into gold.purchases (id) values (%L)', gen_random_uuid()), 'anon'),
          'err:42501', '7.125 — anon cannot insert a purchase');
select is((select phone from gold.purchases where id = pg_temp.u('Q')), '0412 345 678', '7.125 — the purchase is unchanged');

-- ─── 7.126 only service_role can run the write functions (4.5) ───────────────────────────
select is(array[has_function_privilege('anon', 'gold.save_purchase(uuid,uuid,jsonb,jsonb,jsonb)', 'execute'),
                has_function_privilege('authenticated', 'gold.save_purchase(uuid,uuid,jsonb,jsonb,jsonb)', 'execute'),
                has_function_privilege('service_role', 'gold.save_purchase(uuid,uuid,jsonb,jsonb,jsonb)', 'execute')],
          array[false, false, true], '7.126 — gold.save_purchase: anon f, authenticated f, service_role t');
select is(array[has_function_privilege('anon', 'gold.complete_purchase(uuid,uuid,uuid,text,numeric,jsonb)', 'execute'),
                has_function_privilege('authenticated', 'gold.complete_purchase(uuid,uuid,uuid,text,numeric,jsonb)', 'execute'),
                has_function_privilege('service_role', 'gold.complete_purchase(uuid,uuid,uuid,text,numeric,jsonb)', 'execute')],
          array[false, false, true], '7.126 — gold.complete_purchase: anon f, authenticated f, service_role t');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
          format('select gold.save_purchase(%L, %L, %L::jsonb, %L::jsonb, ''[]''::jsonb)', '11111111-1111-1111-1111-111111111111',
                 'a1111111-1111-1111-1111-111111111111', pg_temp.pj('byauth'), pg_temp.one_photo('byauth'))),
          'err:42501', '7.126 — calling gold.save_purchase as a signed-in staff member is permission denied');

-- ─── 7.127 (added) the database's own checks (4.2, 4.3) ──────────────────────────────────
select is(pg_temp.dml_as(null, 'aal2', format('insert into gold.purchases (id, reporting_entity_id, customer_id, joint_customer_id, main_id_verification_id, joint_id_verification_id, purchase_type, cash_band, cash_10k_or_more, sale_date, phone, id_sighted, created_by_staff_id) values (%L, %L, %L, %L, %L, %L, ''scrap'', ''under_10k'', false, ''2026-11-07'', ''0412 345 678'', true, %L)',
          gen_random_uuid(), '11111111-1111-1111-1111-111111111111', pg_temp.u('main'), pg_temp.u('main'), pg_temp.u('main'), pg_temp.u('main'), 'a1111111-1111-1111-1111-111111111111'), 'service_role'),
          'err:23514', '7.127 — a joint seller equal to the main seller is refused (CHECK joint <> customer)');
select is(pg_temp.dml_as(null, 'aal2', format('insert into gold.purchases (id, reporting_entity_id, customer_id, joint_customer_id, main_id_verification_id, purchase_type, cash_band, cash_10k_or_more, sale_date, phone, id_sighted, created_by_staff_id) values (%L, %L, %L, %L, %L, ''scrap'', ''under_10k'', false, ''2026-11-07'', ''0412 345 678'', true, %L)',
          gen_random_uuid(), '11111111-1111-1111-1111-111111111111', pg_temp.u('main'), pg_temp.u('joint'), pg_temp.u('main'), 'a1111111-1111-1111-1111-111111111111'), 'service_role'),
          'err:23514', '7.127 — a joint seller without the joint ID is refused');
select is(pg_temp.dml_as(null, 'aal2', format('insert into gold.purchases (id, reporting_entity_id, customer_id, main_id_verification_id, purchase_type, cash_band, cash_10k_or_more, cash_amount, sale_date, phone, id_sighted, created_by_staff_id) values (%L, %L, %L, %L, ''scrap'', ''under_10k'', false, -1, ''2026-11-07'', ''0412 345 678'', true, %L)',
          gen_random_uuid(), '11111111-1111-1111-1111-111111111111', pg_temp.u('main'), pg_temp.u('main'), 'a1111111-1111-1111-1111-111111111111'), 'service_role'),
          'err:23514', '7.127 — a negative cash amount is refused');
select is(pg_temp.dml_as(null, 'aal2', format('insert into gold.purchases (id, reporting_entity_id, customer_id, main_id_verification_id, purchase_type, cash_band, cash_10k_or_more, cash_amount, sale_date, phone, id_sighted, created_by_staff_id) values (%L, %L, %L, %L, ''scrap'', ''under_10k'', false, 0, ''2026-11-07'', ''0412 345 678'', true, %L)',
          gen_random_uuid(), '11111111-1111-1111-1111-111111111111', pg_temp.u('main'), pg_temp.u('main'), 'a1111111-1111-1111-1111-111111111111'), 'service_role'),
          'ok:1', '7.127 — a cash amount of exactly 0 is accepted');
select is(pg_temp.dml_as(null, 'aal2', format('insert into gold.purchases (id, reporting_entity_id, customer_id, main_id_verification_id, purchase_type, cash_band, cash_10k_or_more, sale_date, phone, id_sighted, created_by_staff_id) values (%L, %L, %L, %L, ''scrap'', ''under_10k'', false, ''2026-11-07'', ''0412 345 678'', false, %L)',
          gen_random_uuid(), '11111111-1111-1111-1111-111111111111', pg_temp.u('main'), pg_temp.u('main'), 'a1111111-1111-1111-1111-111111111111'), 'service_role'),
          'err:23514', '7.127 — id_sighted false is refused');
select is(pg_temp.dml_as(null, 'aal2', format('insert into gold.purchases (id, reporting_entity_id, customer_id, main_id_verification_id, purchase_type, cash_band, cash_10k_or_more, sale_date, phone, id_sighted, created_by_staff_id) values (%L, %L, %L, %L, ''scrap'', ''under_10k'', false, ''2026-11-07'', ''0412 345'', true, %L)',
          gen_random_uuid(), '11111111-1111-1111-1111-111111111111', pg_temp.u('main'), pg_temp.u('main'), 'a1111111-1111-1111-1111-111111111111'), 'service_role'),
          'err:23514', '7.127 — a phone with 7 digits is refused');
select is(pg_temp.dml_as(null, 'aal2', format('insert into gold.purchases (id, reporting_entity_id, customer_id, main_id_verification_id, purchase_type, cash_band, cash_10k_or_more, sale_date, phone, id_sighted, created_by_staff_id) values (%L, %L, %L, %L, ''scrap'', ''under_10k'', false, ''2026-11-07'', ''(04) 1234-5678'', true, %L)',
          gen_random_uuid(), '11111111-1111-1111-1111-111111111111', pg_temp.u('main'), pg_temp.u('main'), 'a1111111-1111-1111-1111-111111111111'), 'service_role'),
          'ok:1', '7.127 — a phone with 8 digits among punctuation is accepted');
select is(pg_temp.dml_as(null, 'aal2', format('insert into gold.purchases (id, reporting_entity_id, customer_id, main_id_verification_id, purchase_type, cash_band, cash_10k_or_more, erp_invoice_no, sale_date, phone, id_sighted, created_by_staff_id) values (%L, %L, %L, %L, ''scrap'', ''under_10k'', false, ''   '', ''2026-11-07'', ''0412 345 678'', true, %L)',
          gen_random_uuid(), '11111111-1111-1111-1111-111111111111', pg_temp.u('main'), pg_temp.u('main'), 'a1111111-1111-1111-1111-111111111111'), 'service_role'),
          'err:23514', '7.127 — a blank invoice number is refused (null until added)');
select is((select erp_invoice_norm from gold.purchases where id = pg_temp.u('Q')), 'G7-INV-Q', '7.127 — erp_invoice_norm is upper(btrim(erp_invoice_no)), generated');
select is(pg_temp.dml_as(null, 'aal2', format('update gold.purchases set erp_invoice_norm = ''X'' where id = %L', pg_temp.u('Q')), 'service_role'),
          'err:428C9', '7.127 — erp_invoice_norm cannot be written (generated column)');

-- ─── 7.128 (added) gold.save_purchase re-checks the business itself (migration contract, 6.1) ──
select is(pg_temp.save_as_service(pg_temp.pj('s1'), pg_temp.one_photo('s1')), 'ok:1', '7.128 — a valid call saves');
select is(pg_temp.save_as_service(pg_temp.pj('s2'), pg_temp.one_photo('s2'), '[]', '11111111-1111-1111-1111-111111111111', 'a2222222-2222-2222-2222-222222222222'),
          'err:22023', '7.128 ⚠ — a staff member of another business is refused');
select is(pg_temp.save_as_service(pg_temp.pj('s3'), pg_temp.one_photo('s3'), '[]', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111119'),
          'err:22023', '7.128 — a deactivated staff member is refused');
select is(pg_temp.save_as_service(pg_temp.pj('s4', jsonb_build_object('customer_id', pg_temp.u('other'), 'main_id_verification_id', pg_temp.u('other'))), pg_temp.one_photo('s4')),
          'err:22023', '7.128 ⚠ — a customer of another business is refused');
select is(pg_temp.save_as_service(pg_temp.pj('s5', jsonb_build_object('main_id_verification_id', pg_temp.u('joint'))), pg_temp.one_photo('s5')),
          'err:22023', '7.128 ⚠ — an ID capture that belongs to another customer is refused');
select is(pg_temp.save_as_service(pg_temp.pj('s6'), '[]'::jsonb), 'err:23514', '7.128 — no photos is refused');
select is((select count(*)::int from gold.purchases where id in (pg_temp.u('s2'), pg_temp.u('s3'), pg_temp.u('s4'), pg_temp.u('s5'), pg_temp.u('s6'))),
          0, '7.128 — none of the refused calls left a purchase behind');

-- ─── 7.129 (added) one transaction: a bad fill rolls the whole save back (4.5) ───────────
insert into gold.purchases
    (id, reporting_entity_id, customer_id, main_id_verification_id, purchase_type, cash_band, cash_10k_or_more,
     erp_invoice_no, sale_date, phone, id_sighted, created_by_staff_id, cash_amount)
values
    (pg_temp.u('hasamt'), '11111111-1111-1111-1111-111111111111', pg_temp.u('main'), pg_temp.u('main'),
     'scrap', 'under_10k', false, 'G7-INV-FILL', '2026-11-07', '0412 345 678', true,
     'a1111111-1111-1111-1111-111111111111', 100),
    (pg_temp.u('noamt'), '11111111-1111-1111-1111-111111111111', pg_temp.u('main'), pg_temp.u('main'),
     'scrap', 'under_10k', false, 'G7-INV-FILL', '2026-11-07', '0412 345 678', true,
     'a1111111-1111-1111-1111-111111111111', null);
select is(pg_temp.save_as_service(pg_temp.pj('f1', '{"erp_invoice_no":"G7-INV-FILL"}'), pg_temp.one_photo('f1'),
          jsonb_build_array(jsonb_build_object('id', pg_temp.u('noamt'), 'cash_amount', 700),
                            jsonb_build_object('id', pg_temp.u('hasamt'), 'cash_amount', 999))),
          'err:40001', '7.129 ⚠ — a fill on a part that already has an amount fails the whole call (serialization_failure)');
select is((select count(*)::int from gold.purchases where id = pg_temp.u('f1')), 0, '7.129 ⚠ — the purchase was not written');
select is((select count(*)::int from gold.goods_photos where purchase_id = pg_temp.u('f1')), 0, '7.129 — no photo row was written');
select is((select cash_amount from gold.purchases where id = pg_temp.u('noamt')), null, '7.129 ⚠ — the earlier fill in the same call was rolled back');
select is((select cash_amount from gold.purchases where id = pg_temp.u('hasamt')), 100::numeric, '7.129 ⚠ — an amount already saved is never overwritten');
select is(pg_temp.save_as_service(pg_temp.pj('f2', '{"erp_invoice_no":"G7-INV-FILL"}'), pg_temp.one_photo('f2'),
          jsonb_build_array(jsonb_build_object('id', pg_temp.u('noamt'), 'cash_amount', 700))),
          'ok:1', '7.129 — the same save with a valid fill succeeds');
select is((select cash_amount from gold.purchases where id = pg_temp.u('noamt')), 700::numeric, '7.129 — and the fill is written');

select * from finish();
rollback;
