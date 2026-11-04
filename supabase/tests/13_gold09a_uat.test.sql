-- Gold Phase 9a UAT (docs/uat-gold-09a-ttr-handoff.md), written independently of 12_gold_start_ttr.test.sql:
--   9.28  only service_role can execute gold.start_ttr and its helpers
--   9.29  uq_tx_ref_per_entity is (reporting_entity_id, transaction_ref, scenario)
--   9.37  the counter confirmation lives only on reliance rows, in a pair, and goes with the record relied on
--   9.58  the gold read RPCs show the TTR started from a purchase
-- Harness inlined (`supabase test db` runs every .sql here as its own test).

begin;
create extension if not exists pgtap with schema extensions;

create function pg_temp.q_as(p_uid uuid, p_aal text, p_sql text, p_role text default 'authenticated')
returns jsonb language plpgsql as $$
declare v jsonb;
begin
    perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role, 'aal', p_aal)::text, true);
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
    perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role, 'aal', p_aal)::text, true);
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

-- Fixtures: two businesses, a staff member in each, and Jane with two ID captures.
insert into public.reporting_entities (id, legal_name, idv_max_reliance_days) values
    ('91111111-1111-4111-8111-111111111111', 'UAT Nine One', 730),
    ('92222222-2222-4222-8222-222222222222', 'UAT Nine Two', 730);
insert into auth.users (id, email) values
    ('9a111111-1111-4111-8111-111111111111', 'nine-staff1@example.test'),
    ('9a222222-2222-4222-8222-222222222222', 'nine-staff2@example.test');
insert into public.staff_members (id, reporting_entity_id, full_name, email, role) values
    ('9a111111-1111-4111-8111-111111111111', '91111111-1111-4111-8111-111111111111', 'Nine Staff One', 'nine-staff1@example.test', 'staff'),
    ('9a222222-2222-4222-8222-222222222222', '92222222-2222-4222-8222-222222222222', 'Nine Staff Two', 'nine-staff2@example.test', 'staff');

insert into public.customers (id, reporting_entity_id, customer_type, source, first_name, last_name, date_of_birth, phone,
    res_street, res_suburb, res_state, res_postcode, res_country, occupation, gender, citizenship_country_code,
    tax_residency_country_code, is_sole_trader)
values ('9c111111-1111-4111-8111-111111111111', '91111111-1111-4111-8111-111111111111', 'individual', 'gold', 'Jane', 'Citizen',
    '1980-01-01', '0411 111 111', '1 Test St', 'Coburg', 'VIC', '3058', 'AU', 'Jeweller', 'F', 'AU', 'AU', false);

insert into ttr.stored_images (id, customer_id, object_path, content_hash_sha256, captured_by_staff_id) values
    ('91a00000-0000-4000-8000-000000000001', '9c111111-1111-4111-8111-111111111111', 'customers/9c111111-1111-4111-8111-111111111111/91b1/front.jpg', 'uat9-hash-1', '9a111111-1111-4111-8111-111111111111'),
    ('91a00000-0000-4000-8000-000000000002', '9c111111-1111-4111-8111-111111111111', 'customers/9c111111-1111-4111-8111-111111111111/91b2/front.jpg', 'uat9-hash-2', '9a111111-1111-4111-8111-111111111111');
insert into ttr.id_verifications (id, customer_id, verification_method, document_type, document_number, issuer, id_country_code,
    has_expiry, expiry_date, verification_description, is_complete, front_image_id, created_at, new_capture_reason)
values
    ('91b00000-0000-4000-8000-000000000001', '9c111111-1111-4111-8111-111111111111', 'Sighted original document', 'Driver licence',
     'UAT9-LIC-1', 'VIC', 'AU', true, '2031-01-01', 'Sighted in person', true, '91a00000-0000-4000-8000-000000000001', now() - interval '20 days', null),
    ('91b00000-0000-4000-8000-000000000002', '9c111111-1111-4111-8111-111111111111', 'Sighted original document', 'Passport',
     'UAT9-PASS-2', 'Australian Passport Office', 'AU', true, '2031-01-01', 'Sighted in person', true, '91a00000-0000-4000-8000-000000000002', now() - interval '10 days', 'different_document');

-- A reportable case A purchase, then its TTR through gold.start_ttr (the function under test elsewhere).
insert into gold.purchases (id, reporting_entity_id, customer_id, main_id_verification_id, purchase_type, cash_band, cash_10k_or_more,
    cash_amount, erp_invoice_no, sale_date, phone, id_sighted, ttr_self_conducted, ttr_details_confirmed, created_by_staff_id)
values ('9b000000-0000-4000-8000-000000000001', '91111111-1111-4111-8111-111111111111', '9c111111-1111-4111-8111-111111111111',
    '91b00000-0000-4000-8000-000000000001', 'scrap', '10k_plus', true, 12000, 'UAT9-INV-1',
    (now() at time zone 'Australia/Melbourne')::date, '0411 111 111', true, true, true, '9a111111-1111-4111-8111-111111111111');

create temp table started as
select gold.start_ttr('91111111-1111-4111-8111-111111111111', '9a111111-1111-4111-8111-111111111111',
    '9b000000-0000-4000-8000-000000000001', 'Coburg, VIC', '{"precious_metal_buy": "Purchase of precious metal for physical cash"}'::jsonb) as r;

select plan(28);

-- ─── 9.28 · grants ────────────────────────────────────────────────────────────────────────
create temp table helpers as
select unnest(array[
    'gold.start_ttr(uuid,uuid,uuid,text,jsonb)'::regprocedure,
    'gold._party_complete(public.customers)'::regprocedure,
    'gold._ttr_add_seller(uuid,uuid,uuid,uuid,boolean,timestamptz,uuid,text)'::regprocedure,
    'gold._ttr_placeholder_cash()'::regprocedure,
    'gold._ttr_type_cash(uuid,uuid,uuid,text,date,text)'::regprocedure,
    'gold._sync_ttr_draft(uuid,uuid,uuid,text,date,text)'::regprocedure
]) as f;

select is((select count(*)::int from helpers where has_function_privilege('authenticated', f, 'EXECUTE')), 0,
    '9.28 authenticated can execute none of start_ttr and its five helpers');
select is((select count(*)::int from helpers where has_function_privilege('anon', f, 'EXECUTE')), 0,
    '9.28 anon can execute none of start_ttr and its five helpers');
select is((select count(*)::int from helpers where has_function_privilege('service_role', f, 'EXECUTE')), 6,
    '9.28 service_role can execute all six');
select is(pg_temp.dml_as('9a111111-1111-4111-8111-111111111111', 'aal2',
    $$select gold.start_ttr('91111111-1111-4111-8111-111111111111','9a111111-1111-4111-8111-111111111111','9b000000-0000-4000-8000-000000000001','x','{}'::jsonb)$$),
    'err:42501', '9.28 a signed-in staff member (aal2) calling gold.start_ttr is refused with 42501');
select is(pg_temp.dml_as('9a111111-1111-4111-8111-111111111111', 'aal2',
    $$select gold._ttr_type_cash('91111111-1111-4111-8111-111111111111', null, null, 'UAT9-INV-1', current_date, 'scrap')$$),
    'err:42501', '9.28 a signed-in staff member calling a helper (_ttr_type_cash) is refused with 42501');
select is(pg_temp.dml_as('00000000-0000-0000-0000-000000000000', 'aal1',
    $$select gold.start_ttr('91111111-1111-4111-8111-111111111111','9a111111-1111-4111-8111-111111111111','9b000000-0000-4000-8000-000000000001','x','{}'::jsonb)$$, 'anon'),
    'err:42501', '9.28 anon calling gold.start_ttr is refused with 42501');
select is(pg_temp.dml_as('00000000-0000-0000-0000-000000000000', 'aal1',
    $$select gold._sync_ttr_draft('91111111-1111-4111-8111-111111111111', null, null, 'UAT9-INV-1', current_date, 'scrap')$$, 'anon'),
    'err:42501', '9.28 anon calling a helper (_sync_ttr_draft) is refused with 42501');

-- ─── 9.29 · one reference per business and scenario ───────────────────────────────────────
select is((select pg_get_constraintdef(oid) from pg_constraint
           where conname = 'uq_tx_ref_per_entity' and conrelid = 'ttr.transactions'::regclass),
    'UNIQUE (reporting_entity_id, transaction_ref, scenario)',
    '9.29 uq_tx_ref_per_entity is (reporting_entity_id, transaction_ref, scenario)');

create function pg_temp.tx(p_entity uuid, p_staff uuid, p_ref text, p_scenario text) returns void language sql as $$
    insert into ttr.transactions (reporting_entity_id, created_by_staff_id, scenario, transaction_ref, transaction_datetime,
        designated_service, location_snapshot, staff_member_name, staff_member_email, staff_member_role, cash_currency, cash_amount, aud_value)
    values (p_entity, p_staff, p_scenario, p_ref, now(), 'Purchase of bullion for physical cash', 'Coburg, VIC', 'Nine', 'nine@example.test', 'staff', 'AUD', 500, 500)
$$;

select lives_ok($$select pg_temp.tx('91111111-1111-4111-8111-111111111111','9a111111-1111-4111-8111-111111111111','UAT9-REF','bullion_buy')$$,
    '9.29 the first report on UAT9-REF (bullion_buy) is accepted');
select lives_ok($$select pg_temp.tx('91111111-1111-4111-8111-111111111111','9a111111-1111-4111-8111-111111111111','UAT9-REF','precious_metal_buy')$$,
    '9.29 the same reference in the other scenario is accepted');
select throws_ok($$select pg_temp.tx('91111111-1111-4111-8111-111111111111','9a111111-1111-4111-8111-111111111111','UAT9-REF','bullion_buy')$$,
    '23505', null, '9.29 the same reference and scenario in the same business fails with 23505');
select lives_ok($$select pg_temp.tx('92222222-2222-4222-8222-222222222222','9a222222-2222-4222-8222-222222222222','UAT9-REF','bullion_buy')$$,
    '9.29 the same reference and scenario in another business is accepted');

-- ─── 9.37 · the counter confirmation ──────────────────────────────────────────────────────
select is((select counter_confirmed_by_staff_id from ttr.id_verifications
           where transaction_id = (select (r -> 0 ->> 'id')::uuid from started)), '9a111111-1111-4111-8111-111111111111'::uuid,
    '9.37 setup: the started TTR has a reliance row with the confirmation');

select throws_ok($$update ttr.id_verifications set counter_confirmed_at = now(), counter_confirmed_by_staff_id = '9a111111-1111-4111-8111-111111111111'
                   where id = '91b00000-0000-4000-8000-000000000002'$$,
    '23514', null, '9.37 a counter confirmation on a customer-level ID row is refused (23514)');
select throws_ok($$update ttr.id_verifications set counter_confirmed_by_staff_id = null
                   where transaction_id = (select (r -> 0 ->> 'id')::uuid from started)$$,
    '23514', null, '9.37 a confirmation time without the staff member is refused (23514)');
select throws_ok($$update ttr.id_verifications set counter_confirmed_at = null
                   where transaction_id = (select (r -> 0 ->> 'id')::uuid from started)$$,
    '23514', null, '9.37 a staff member without the confirmation time is refused (23514)');

update ttr.id_verifications set prior_verification_id = '91b00000-0000-4000-8000-000000000002'
 where transaction_id = (select (r -> 0 ->> 'id')::uuid from started);
select is((select (counter_confirmed_at is null and counter_confirmed_by_staff_id is null) from ttr.id_verifications
           where transaction_id = (select (r -> 0 ->> 'id')::uuid from started)), true,
    '9.37 pointing the reliance row at another record clears both confirmation columns');

update ttr.id_verifications set counter_confirmed_at = now(), counter_confirmed_by_staff_id = '9a111111-1111-4111-8111-111111111111'
 where transaction_id = (select (r -> 0 ->> 'id')::uuid from started);
select is((select counter_confirmed_by_staff_id from ttr.id_verifications
           where transaction_id = (select (r -> 0 ->> 'id')::uuid from started)), '9a111111-1111-4111-8111-111111111111'::uuid,
    '9.37 a reliance row can carry a confirmation again once set directly');
select lives_ok($$update ttr.id_verifications set verification_basis = 'new_capture', prior_verification_id = null, reliance_reason = null, document_number = 'UAT9-NEW-3'
                   where transaction_id = (select (r -> 0 ->> 'id')::uuid from started)$$,
    '9.37 changing the reliance row to a new capture is accepted');
select is((select (counter_confirmed_at is null and counter_confirmed_by_staff_id is null) from ttr.id_verifications
           where transaction_id = (select (r -> 0 ->> 'id')::uuid from started)), true,
    '9.37 after the change to a new capture both confirmation columns are empty');

-- ─── 9.58 · the gold read RPCs ────────────────────────────────────────────────────────────
select is((pg_temp.q_as('9a111111-1111-4111-8111-111111111111', 'aal2',
    $$select ttr_transaction_id, ttr_status, ttr_transaction_ref from gold.list_incomplete_purchases()
      where id = '9b000000-0000-4000-8000-000000000001'$$) -> 0 ->> 'ttr_status'), 'draft',
    '9.58 list_incomplete_purchases shows the purchase with ttr_status draft while the TTR is a draft');
select is((pg_temp.q_as('9a111111-1111-4111-8111-111111111111', 'aal2',
    $$select ttr_transaction_id, ttr_status, ttr_transaction_ref from gold.list_incomplete_purchases()
      where id = '9b000000-0000-4000-8000-000000000001'$$) -> 0 ->> 'ttr_transaction_ref'), 'UAT9-INV-1',
    '9.58 ...with ttr_transaction_ref equal to the invoice');
select is((pg_temp.q_as('9a111111-1111-4111-8111-111111111111', 'aal2',
    $$select ttr_transaction_id from gold.search_gold_purchases('{"status":"austrac_pending"}'::jsonb, 1, 25)
      where id = '9b000000-0000-4000-8000-000000000001'$$) -> 0 ->> 'ttr_transaction_id')::uuid,
    (select (r -> 0 ->> 'id')::uuid from started),
    '9.58 search_gold_purchases (AUSTRAC pending) returns the purchase with ttr_transaction_id the new TTR');

update ttr.transactions set status = 'complete', completed_at = now() where id = (select (r -> 0 ->> 'id')::uuid from started);

select is((pg_temp.q_as('9a111111-1111-4111-8111-111111111111', 'aal2',
    $$select ttr_status from gold.search_gold_purchases('{"status":"austrac"}'::jsonb, 1, 25)
      where id = '9b000000-0000-4000-8000-000000000001'$$) -> 0 ->> 'ttr_status'), 'complete',
    '9.58 after the TTR completes, search (AUSTRAC) shows ttr_status complete');
select is(jsonb_array_length(pg_temp.q_as('9a111111-1111-4111-8111-111111111111', 'aal2',
    $$select 1 from gold.search_gold_purchases('{"status":"austrac_pending"}'::jsonb, 1, 25)
      where id = '9b000000-0000-4000-8000-000000000001'$$)), 0,
    '9.58 ...and it is no longer AUSTRAC pending');
select is(jsonb_array_length(pg_temp.q_as('9a111111-1111-4111-8111-111111111111', 'aal2',
    $$select 1 from gold.list_incomplete_purchases() where id = '9b000000-0000-4000-8000-000000000001'$$)), 0,
    '9.58 ...and it drops out of the incomplete list');
select is(jsonb_array_length(pg_temp.q_as('9a222222-2222-4222-8222-222222222222', 'aal2',
    $$select 1 from gold.search_gold_purchases('{}'::jsonb, 1, 25) where id = '9b000000-0000-4000-8000-000000000001'$$)), 0,
    '9.58 another business cannot see the purchase or its TTR link');
select is(jsonb_array_length(pg_temp.q_as('9a111111-1111-4111-8111-111111111111', 'aal1',
    $$select 1 from gold.search_gold_purchases('{}'::jsonb, 1, 25)$$)), 0,
    '9.58 a password-only (aal1) session sees nothing');

select * from finish();
rollback;
