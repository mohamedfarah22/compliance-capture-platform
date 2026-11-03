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

-- An earlier part on invoice INV-900, same day, no amount saved (for the cash fills).
insert into gold.purchases
    (id, reporting_entity_id, customer_id, main_id_verification_id, purchase_type, cash_band, cash_10k_or_more,
     erp_invoice_no, sale_date, phone, id_sighted, created_by_staff_id)
values
    (pg_temp.u('earlier'), '11111111-1111-1111-1111-111111111111', pg_temp.u('cA'), pg_temp.u('capA'),
     'scrap', 'under_10k', false, 'INV-900', '2026-11-07', '0412 345 678', true,
     'a1111111-1111-1111-1111-111111111111'),
    (pg_temp.u('otherday'), '11111111-1111-1111-1111-111111111111', pg_temp.u('cA'), pg_temp.u('capA'),
     'scrap', 'under_10k', false, 'INV-900', '2026-11-06', '0412 345 678', true,
     'a1111111-1111-1111-1111-111111111111'),
    (pg_temp.u('hasamount'), '11111111-1111-1111-1111-111111111111', pg_temp.u('cA'), pg_temp.u('capA'),
     'scrap', 'under_10k', false, 'INV-901', '2026-11-07', '0412 345 678', true,
     'a1111111-1111-1111-1111-111111111111');
update gold.purchases set cash_amount = 100 where id = pg_temp.u('hasamount');

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

select plan(77);

-- ─── Grants: service_role only ───────────────────────────────────────────────────────────
select is((select bool_and(has_function_privilege('service_role', f, 'execute')) from unnest(array[
    'gold.save_purchase(uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure,
    'gold.complete_purchase(uuid,uuid,uuid,text,numeric,jsonb)'::regprocedure,
    'gold._fill_linked_amounts(uuid,uuid,uuid,text,date,jsonb)'::regprocedure]) f), true,
    'service_role can execute the write functions');
select is((select bool_or(has_function_privilege('authenticated', f, 'execute')) from unnest(array[
    'gold.save_purchase(uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure,
    'gold.complete_purchase(uuid,uuid,uuid,text,numeric,jsonb)'::regprocedure,
    'gold._fill_linked_amounts(uuid,uuid,uuid,text,date,jsonb)'::regprocedure]) f), false,
    'authenticated cannot execute any of them');
select is((select bool_or(has_function_privilege('anon', f, 'execute')) from unnest(array[
    'gold.save_purchase(uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure,
    'gold.complete_purchase(uuid,uuid,uuid,text,numeric,jsonb)'::regprocedure,
    'gold._fill_linked_amounts(uuid,uuid,uuid,text,date,jsonb)'::regprocedure]) f), false,
    'anon cannot execute any of them');
select is((select count(*)::int from pg_proc p, aclexplode(p.proacl) a
           where p.oid in ('gold.save_purchase(uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure,
                           'gold.complete_purchase(uuid,uuid,uuid,text,numeric,jsonb)'::regprocedure,
                           'gold._fill_linked_amounts(uuid,uuid,uuid,text,date,jsonb)'::regprocedure)
             and a.grantee = 0), 0, 'PUBLIC has no EXECUTE on any of them');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        format('select gold.save_purchase(%L, %L, %L::jsonb, %L::jsonb, ''[]''::jsonb)',
            '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111',
            pg_temp.pj('browser'), pg_temp.ph('browser'))),
    'err:42501', 'a signed-in browser session cannot call save_purchase (aal2 and all)');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        format('select gold.complete_purchase(%L, %L, %L, ''INV-X'', null, ''[]''::jsonb)',
            '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', pg_temp.u('earlier'))),
    'err:42501', 'nor complete_purchase');
select is(pg_temp.dml_as(null, 'aal2',
        format('select gold.save_purchase(%L, %L, %L::jsonb, %L::jsonb, ''[]''::jsonb)',
            '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111',
            pg_temp.pj('anon'), pg_temp.ph('anon')), 'anon'),
    'err:42501', 'anon cannot call save_purchase');
select is(pg_temp.dml_as(null, 'aal2',
        format('select gold.complete_purchase(%L, %L, %L, ''INV-X'', null, ''[]''::jsonb)',
            '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', pg_temp.u('earlier')), 'anon'),
    'err:42501', 'nor complete_purchase');

-- ─── save_purchase: one transaction for the purchase, its photos and the fills ───────────
select is((pg_temp.save_as('service_role', pg_temp.pj('s1'), pg_temp.ph('s1', 2)) -> 0 ->> 'id')::uuid, pg_temp.u('s1'),
    'service_role saves a purchase and gets its id back');
select is((select count(*)::int from gold.purchases where id = pg_temp.u('s1')), 1, 'the purchase exists');
select is((select created_by_staff_id from gold.purchases where id = pg_temp.u('s1')),
    'a1111111-1111-1111-1111-111111111111'::uuid, 'created_by_staff_id is the staff member passed from the session');
select is((select reporting_entity_id from gold.purchases where id = pg_temp.u('s1')),
    '11111111-1111-1111-1111-111111111111'::uuid, 'and the entity is the one passed, not a client value');
select is((select jsonb_agg(jsonb_build_array(object_path = pg_temp.u('s1')::text || '/goods-' || (sort_order + 1) || '.jpg', sort_order,
                                              storage_bucket, content_type) order by sort_order)
           from gold.goods_photos where purchase_id = pg_temp.u('s1')),
    '[[true, 0, "gold-goods", "image/jpeg"], [true, 1, "gold-goods", "image/jpeg"]]'::jsonb,
    'two goods photo rows, in order, {purchase}/goods-{n}.jpg in the gold-goods bucket');
select is((select jsonb_agg(content_hash_sha256 || ':' || byte_size order by sort_order)
           from gold.goods_photos where purchase_id = pg_temp.u('s1')),
    '["hash1:100", "hash2:200"]'::jsonb, 'hash and size are stored');
select is((select jsonb_agg(captured_by_staff_id::text) from gold.goods_photos where purchase_id = pg_temp.u('s1')),
    '["a1111111-1111-1111-1111-111111111111", "a1111111-1111-1111-1111-111111111111"]'::jsonb,
    'photos record who captured them');
select is((select count(*)::int from gold.purchase_audit_log where purchase_id = pg_temp.u('s1')), 0,
    'a plain save writes no audit row (audit is for changes)');

select is((select jsonb_build_array(erp_invoice_no, erp_invoice_norm, ttr_self_conducted, joint_customer_id)
           from gold.purchases where id = pg_temp.u('s1')),
    '[null, null, null, null]'::jsonb, 'optional values the server leaves out are null');
select is((pg_temp.save_as('service_role',
        pg_temp.pj('s2', jsonb_build_object('erp_invoice_no', '  inv-s2 ', 'cash_amount', 12500.5, 'invoice_cash_total', 12500.5,
            'cash_band', '10k_plus', 'cash_10k_or_more', true, 'ttr_self_conducted', true, 'ttr_details_confirmed', false,
            'id_expired_at_time', true, 'id_outside_window_at_time', true)),
        pg_temp.ph('s2')) -> 0 ->> 'id')::uuid, pg_temp.u('s2'), 'a purchase with every optional value saves');
select is((select jsonb_build_array(erp_invoice_no, erp_invoice_norm, cash_amount, invoice_cash_total, cash_band, cash_10k_or_more,
                                    ttr_self_conducted, ttr_details_confirmed, id_expired_at_time, id_outside_window_at_time,
                                    completed_at)
           from gold.purchases where id = pg_temp.u('s2')),
    '["inv-s2", "INV-S2", 12500.50, 12500.50, "10k_plus", true, true, false, true, true, null]'::jsonb,
    'the invoice is trimmed and normalised, values stored as computed, and the purchase is not marked completed');

select is((pg_temp.save_as('service_role',
        pg_temp.pj('s3', jsonb_build_object('joint_customer_id', pg_temp.u('cB'), 'joint_id_verification_id', pg_temp.u('capB'))),
        pg_temp.ph('s3')) -> 0 ->> 'id')::uuid, pg_temp.u('s3'), 'a joint sale saves with the joint seller and their own ID');

-- cash fills on earlier linked parts
select is((pg_temp.save_as('service_role',
        pg_temp.pj('s4', jsonb_build_object('erp_invoice_no', 'inv-900', 'cash_amount', 6000, 'invoice_cash_total', 12000)),
        pg_temp.ph('s4'),
        jsonb_build_array(jsonb_build_object('id', pg_temp.u('earlier'), 'cash_amount', 6000))) -> 0 ->> 'id')::uuid,
    pg_temp.u('s4'), 'a purchase saves together with the cash fill on an earlier linked part');
select is((select cash_amount from gold.purchases where id = pg_temp.u('earlier')), 6000.00, 'the earlier part now has its amount');
select is((select count(*)::int from gold.purchase_audit_log where purchase_id = pg_temp.u('earlier')), 1,
    'the fill is audited');
select is((select jsonb_build_array(source, changed_by::text, changes -> 'cash_amount')
           from gold.purchase_audit_log where purchase_id = pg_temp.u('earlier')),
    '["save_purchase", "a1111111-1111-1111-1111-111111111111", {"old": null, "new": 6000.00}]'::jsonb,
    'with who, the source and old to new');
select is((select count(*)::int from gold.purchase_audit_log where purchase_id = pg_temp.u('earlier')
           and (select count(*) from jsonb_object_keys(changes)) = 1), 1, 'and nothing else about the earlier part changed');

-- ─── Atomicity: a failure anywhere leaves nothing behind ─────────────────────────────────
select throws_ok(
    format($q$select gold.save_purchase(%L, %L, %L::jsonb, %L::jsonb, %L::jsonb)$q$,
        '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111',
        pg_temp.pj('a1', jsonb_build_object('erp_invoice_no', 'INV-900')), pg_temp.ph('a1', 2),
        jsonb_build_array(jsonb_build_object('id', pg_temp.u('hasamount'), 'cash_amount', 5))),
    '40001', null, 'a fill on a part that already has an amount fails (it is never overwritten)');
select is((select count(*)::int from gold.purchases where id = pg_temp.u('a1')), 0, '... and the purchase is not saved');
select is((select count(*)::int from gold.goods_photos where purchase_id = pg_temp.u('a1')), 0, '... nor its photo rows');
select is((select cash_amount from gold.purchases where id = pg_temp.u('hasamount')), 100.00, '... and the part keeps its amount');

select throws_ok(
    format($q$select gold.save_purchase(%L, %L, %L::jsonb, %L::jsonb, %L::jsonb)$q$,
        '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111',
        pg_temp.pj('a2', jsonb_build_object('erp_invoice_no', 'INV-900')), pg_temp.ph('a2'),
        jsonb_build_array(jsonb_build_object('id', pg_temp.u('otherday'), 'cash_amount', 5))),
    '40001', null, 'a fill on a part from another day is not a linked part');
select is((select count(*)::int from gold.purchases where id = pg_temp.u('a2')), 0, '... and nothing is saved');
select is((select cash_amount from gold.purchases where id = pg_temp.u('otherday')), null, '... and that part is untouched');

select throws_ok(
    format($q$select gold.save_purchase(%L, %L, %L::jsonb, %L::jsonb, %L::jsonb)$q$,
        '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111',
        pg_temp.pj('a3', jsonb_build_object('erp_invoice_no', 'INV-OTHER')), pg_temp.ph('a3'),
        jsonb_build_array(jsonb_build_object('id', pg_temp.u('otherday'), 'cash_amount', 5))),
    '40001', null, 'a fill on a part under a different invoice is refused');
select throws_ok(
    format($q$select gold.save_purchase(%L, %L, %L::jsonb, %L::jsonb, '[]'::jsonb)$q$,
        '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111',
        pg_temp.pj('a4'), jsonb_build_array(jsonb_build_object(
            'object_path', 'not-this-purchase/goods-1.jpg', 'content_hash_sha256', 'h', 'byte_size', 1))),
    '23514', null, 'a photo path outside {purchase}/goods-... fails after the purchase row was inserted');
select is((select count(*)::int from gold.purchases where id = pg_temp.u('a4')), 0, '... and the purchase row is rolled back with it');
select throws_ok(
    format($q$select gold.save_purchase(%L, %L, %L::jsonb, '[]'::jsonb, '[]'::jsonb)$q$,
        '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', pg_temp.pj('a5')),
    '23514', null, 'a purchase with no photo is refused');
select throws_ok(
    format($q$select gold.save_purchase(%L, %L, %L::jsonb, %L::jsonb, '[]'::jsonb)$q$,
        '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111',
        pg_temp.pj('a6', jsonb_build_object('phone', '1234')), pg_temp.ph('a6')),
    '23514', null, 'the table constraints still apply (phone of 8+ digits)');
select throws_ok(
    format($q$select gold.save_purchase(%L, %L, %L::jsonb, %L::jsonb, '[]'::jsonb)$q$,
        '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111',
        pg_temp.pj('a7', jsonb_build_object('id_sighted', false)), pg_temp.ph('a7')),
    '23514', null, 'and so does id_sighted = true');
select throws_ok(
    format($q$select gold.save_purchase(%L, %L, %L::jsonb, %L::jsonb, '[]'::jsonb)$q$,
        '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111',
        pg_temp.pj('s1'), pg_temp.ph('s1')),
    '23505', null, 'saving the same purchase id twice fails and leaves the first intact');
select is((select count(*)::int from gold.goods_photos where purchase_id = pg_temp.u('s1')), 2, '... with its two photos');

-- ─── Entity scoping: the service role must not act on a client-supplied id alone ─────────
select throws_ok(
    format($q$select gold.save_purchase(%L, %L, %L::jsonb, %L::jsonb, '[]'::jsonb)$q$,
        '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111',
        pg_temp.pj('e1', jsonb_build_object('customer_id', pg_temp.u('cC'), 'main_id_verification_id', pg_temp.u('capC'))),
        pg_temp.ph('e1')),
    '22023', null, 'another entity''s customer cannot be a seller');
select throws_ok(
    format($q$select gold.save_purchase(%L, %L, %L::jsonb, %L::jsonb, '[]'::jsonb)$q$,
        '22222222-2222-2222-2222-222222222222', 'a2222222-2222-2222-2222-222222222222',
        pg_temp.pj('e2'), pg_temp.ph('e2')),
    '22023', null, 'a customer of entity one cannot be saved by entity two''s staff');
select throws_ok(
    format($q$select gold.save_purchase(%L, %L, %L::jsonb, %L::jsonb, '[]'::jsonb)$q$,
        '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111',
        pg_temp.pj('e3', jsonb_build_object('main_id_verification_id', pg_temp.u('capB'))), pg_temp.ph('e3')),
    '22023', null, 'an ID capture that belongs to another customer is refused');
select throws_ok(
    format($q$select gold.save_purchase(%L, %L, %L::jsonb, %L::jsonb, '[]'::jsonb)$q$,
        '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111',
        pg_temp.pj('e4', jsonb_build_object('joint_customer_id', pg_temp.u('cC'), 'joint_id_verification_id', pg_temp.u('capC'))),
        pg_temp.ph('e4')),
    '22023', null, 'another entity''s customer cannot be a joint seller');
select throws_ok(
    format($q$select gold.save_purchase(%L, %L, %L::jsonb, %L::jsonb, '[]'::jsonb)$q$,
        '11111111-1111-1111-1111-111111111111', 'a2222222-2222-2222-2222-222222222222',
        pg_temp.pj('e5'), pg_temp.ph('e5')),
    '22023', null, 'a staff member of another entity cannot save into this one');
select throws_ok(
    format($q$select gold.save_purchase(%L, %L, %L::jsonb, %L::jsonb, '[]'::jsonb)$q$,
        '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111119',
        pg_temp.pj('e6'), pg_temp.ph('e6')),
    '22023', null, 'an inactive staff member cannot save');
select throws_ok(
    format($q$select gold.save_purchase(%L, %L, %L::jsonb, %L::jsonb, '[]'::jsonb)$q$,
        '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111',
        pg_temp.pj('e7', jsonb_build_object('joint_customer_id', pg_temp.u('cB'))), pg_temp.ph('e7')),
    '22023', null, 'a joint seller without their ID is refused');
select is((select count(*)::int from gold.purchases where id in
           (pg_temp.u('e1'), pg_temp.u('e2'), pg_temp.u('e3'), pg_temp.u('e4'), pg_temp.u('e5'), pg_temp.u('e6'), pg_temp.u('e7'))),
    0, 'none of those left a purchase behind');
select is((select count(*)::int from gold.goods_photos where purchase_id in
           (pg_temp.u('e1'), pg_temp.u('e2'), pg_temp.u('e3'), pg_temp.u('e4'), pg_temp.u('e5'), pg_temp.u('e6'), pg_temp.u('e7'))),
    0, 'or a photo row');
select throws_ok(
    format($q$select gold.save_purchase(%L, %L, %L::jsonb, %L::jsonb, '[]'::jsonb)$q$,
        '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111',
        pg_temp.pj('e8', jsonb_build_object('joint_customer_id', pg_temp.u('cA'), 'joint_id_verification_id', pg_temp.u('capA'))),
        pg_temp.ph('e8')),
    '23514', null, 'the same person as joint seller is refused (the check constraint)');

-- ─── Immutability still holds on a saved purchase (Phase 5 trigger) ──────────────────────
select is(pg_temp.dml_as(null, 'aal2',
        format($q$update gold.purchases set customer_id = %L where id = %L$q$, pg_temp.u('cB'), pg_temp.u('s1')), 'service_role'),
    'err:23001', 'the seller cannot be changed after save');
select is(pg_temp.dml_as(null, 'aal2',
        format($q$update gold.purchases set id_sighted = false, id_expired_at_time = true where id = %L$q$, pg_temp.u('s1')), 'service_role'),
    'err:23001', 'nor the ID flags');
select is(pg_temp.dml_as(null, 'aal2',
        format($q$update gold.purchases set erp_invoice_no = 'other' where id = %L$q$, pg_temp.u('s2')), 'service_role'),
    'err:23001', 'an invoice number set at save cannot be changed');
select is(pg_temp.dml_as(null, 'aal2',
        format($q$update gold.purchases set completed_at = now(), completed_by_staff_id = %L where id = %L$q$,
            'a1111111-1111-1111-1111-111111111111', pg_temp.u('s1')), 'service_role'),
    'err:23001', 'completed_at cannot be set without the update that adds the invoice');
select is(pg_temp.dml_as(null, 'aal2',
        format($q$update gold.goods_photos set sort_order = 9 where purchase_id = %L$q$, pg_temp.u('s1')), 'service_role'),
    'err:P0001', 'goods photo rows stay append-only');

-- ─── complete_purchase ───────────────────────────────────────────────────────────────────
select is(pg_temp.dml_as(null, 'aal2',
        format($q$select gold.complete_purchase(%L, %L, %L, '  inv-s1 ', null, '[]'::jsonb)$q$,
            '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111112', pg_temp.u('s1')), 'service_role'),
    'ok:1', 'service_role completes a purchase');
select is((select jsonb_build_array(erp_invoice_no, erp_invoice_norm, completed_by_staff_id::text, completed_at is not null)
           from gold.purchases where id = pg_temp.u('s1')),
    '["inv-s1", "INV-S1", "a1111111-1111-1111-1111-111111111112", true]'::jsonb,
    'invoice (trimmed) and completed_by / completed_at are set together');
select is((select count(*)::int from gold.purchase_audit_log where purchase_id = pg_temp.u('s1')), 1,
    'one audit row for the completion');
select is((select jsonb_build_array(source, changed_by::text, (select jsonb_agg(k order by k) from jsonb_object_keys(changes) k))
           from gold.purchase_audit_log where purchase_id = pg_temp.u('s1')),
    '["complete_purchase", "a1111111-1111-1111-1111-111111111112", ["completed_at", "completed_by_staff_id", "erp_invoice_no"]]'::jsonb,
    'with the completing staff member, source complete_purchase, and exactly those three columns');
select is((select changes -> 'erp_invoice_no' from gold.purchase_audit_log where purchase_id = pg_temp.u('s1')),
    '{"old": null, "new": "inv-s1"}'::jsonb, 'old to new');
select is(pg_temp.dml_as(null, 'aal2',
        format($q$select gold.complete_purchase(%L, %L, %L, 'INV-AGAIN', null, '[]'::jsonb)$q$,
            '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', pg_temp.u('s1')), 'service_role'),
    'err:23001', 'a second completion is refused: the invoice is set once');
select is(pg_temp.dml_as(null, 'aal2',
        format($q$select gold.complete_purchase(%L, %L, %L, 'INV-LATE', null, '[]'::jsonb)$q$,
            '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', pg_temp.u('s2')), 'service_role'),
    'err:23001', 'so is completing a purchase that already got its invoice at the counter');
select is((select erp_invoice_no from gold.purchases where id = pg_temp.u('s1')), 'inv-s1', 'and the invoice number is unchanged');

select is(pg_temp.dml_as(null, 'aal2',
        format($q$select gold.complete_purchase(%L, %L, %L, 'INV-X', null, '[]'::jsonb)$q$,
            '22222222-2222-2222-2222-222222222222', 'a2222222-2222-2222-2222-222222222222', pg_temp.u('s3')), 'service_role'),
    'err:P0002', 'another entity''s purchase is not found');
select is(pg_temp.dml_as(null, 'aal2',
        format($q$select gold.complete_purchase(%L, %L, %L, 'INV-X', null, '[]'::jsonb)$q$,
            '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', md5('missing')::uuid), 'service_role'),
    'err:P0002', 'nor is a purchase that does not exist');
select is(pg_temp.dml_as(null, 'aal2',
        format($q$select gold.complete_purchase(%L, %L, %L, 'INV-X', null, '[]'::jsonb)$q$,
            '11111111-1111-1111-1111-111111111111', 'a2222222-2222-2222-2222-222222222222', pg_temp.u('s3')), 'service_role'),
    'err:22023', 'a staff member of another entity cannot complete');
select is(pg_temp.dml_as(null, 'aal2',
        format($q$select gold.complete_purchase(%L, %L, %L, '   ', null, '[]'::jsonb)$q$,
            '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', pg_temp.u('s3')), 'service_role'),
    'err:23514', 'a blank invoice is refused');
select is((select erp_invoice_no from gold.purchases where id = pg_temp.u('s3')), null, 'and the purchase is still without one');

-- amounts on completion, and atomicity of the invoice with the fills
insert into gold.purchases
    (id, reporting_entity_id, customer_id, main_id_verification_id, purchase_type, cash_band, cash_10k_or_more,
     sale_date, phone, id_sighted, created_by_staff_id)
values
    (pg_temp.u('c1'), '11111111-1111-1111-1111-111111111111', pg_temp.u('cA'), pg_temp.u('capA'),
     'bullion', 'under_5k', false, '2026-11-07', '0412 345 678', true, 'a1111111-1111-1111-1111-111111111111');
insert into gold.purchases
    (id, reporting_entity_id, customer_id, main_id_verification_id, purchase_type, cash_band, cash_10k_or_more,
     erp_invoice_no, sale_date, phone, id_sighted, created_by_staff_id)
values
    (pg_temp.u('part2'), '11111111-1111-1111-1111-111111111111', pg_temp.u('cA'), pg_temp.u('capA'),
     'scrap', 'under_10k', false, 'INV-C1', '2026-11-07', '0412 345 678', true, 'a1111111-1111-1111-1111-111111111111');

select is(pg_temp.dml_as(null, 'aal2',
        format($q$select gold.complete_purchase(%L, %L, %L, 'INV-C1', 6000, %L::jsonb)$q$,
            '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', pg_temp.u('c1'),
            jsonb_build_array(jsonb_build_object('id', pg_temp.u('hasamount'), 'cash_amount', 1))), 'service_role'),
    'err:40001', 'a fill that is not a linked part fails the whole completion');
select is((select jsonb_build_array(erp_invoice_no, completed_at, cash_amount) from gold.purchases where id = pg_temp.u('c1')),
    '[null, null, null]'::jsonb, '... so the invoice, completion and amount are all rolled back');
select is(pg_temp.dml_as(null, 'aal2',
        format($q$select gold.complete_purchase(%L, %L, %L, 'INV-C1', 6000, %L::jsonb)$q$,
            '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', pg_temp.u('c1'),
            jsonb_build_array(jsonb_build_object('id', pg_temp.u('part2'), 'cash_amount', 4500))), 'service_role'),
    'ok:1', 'with a real linked part it completes');
select is((select jsonb_build_array(erp_invoice_no, cash_amount) from gold.purchases where id = pg_temp.u('c1')),
    '["INV-C1", 6000.00]'::jsonb, 'this purchase got its own amount with the invoice');
select is((select cash_amount from gold.purchases where id = pg_temp.u('part2')), 4500.00, 'and the earlier part got its amount');
select is((select count(*)::int from gold.purchase_audit_log where purchase_id = pg_temp.u('c1')), 1,
    'one audit row for the purchase: invoice, completion and amount in the same update');
select is((select jsonb_agg(source order by source) from gold.purchase_audit_log where purchase_id = pg_temp.u('part2')),
    '["complete_purchase"]'::jsonb, 'and the earlier part''s fill is audited with the same source');

-- no browser write path appeared
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        format($q$update gold.purchases set phone = '0499 999 999' where id = %L$q$, pg_temp.u('s1'))),
    'err:42501', 'the browser still cannot update gold.purchases');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        format($q$insert into gold.goods_photos (purchase_id, reporting_entity_id, object_path, content_hash_sha256, captured_by_staff_id)
            values (%L, %L, %L, 'h', %L)$q$, pg_temp.u('s1'), '11111111-1111-1111-1111-111111111111',
            pg_temp.u('s1')::text || '/goods-9.jpg', 'a1111111-1111-1111-1111-111111111111')),
    'err:42501', 'nor insert a goods photo row');

select * from finish();
rollback;
