-- pgTAP: gold.start_ttr and the TTR hand-off pieces of Phase 9a (20261109000001-4): the widened
-- uq_tx_ref_per_entity, the counter confirmation on reliance rows, the draft join (spec 3.5), the stale-draft
-- helper and ON DELETE SET NULL.
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

-- Jane (cA) has every Party Details field: case A is possible for her. Joan (cB) does not.
update public.customers
set occupation = 'Jeweller', gender = 'F', citizenship_country_code = 'AU', tax_residency_country_code = 'AU',
    is_sole_trader = false
where id = pg_temp.u('cA');

-- A gold purchase row, as gold-save-purchase would have written it.
create function pg_temp.mk_p(p_label text, p_customer text, p_cap text, p_type text, p_band text, p_flag boolean,
    p_amount numeric, p_invoice text, p_self boolean default null, p_conf boolean default null,
    p_joint text default null, p_jointcap text default null, p_date date default '2026-11-07') returns uuid language plpgsql as $$
begin
    insert into gold.purchases
        (id, reporting_entity_id, customer_id, joint_customer_id, main_id_verification_id, joint_id_verification_id,
         purchase_type, cash_band, cash_10k_or_more, cash_amount, erp_invoice_no, sale_date, phone, id_sighted,
         ttr_self_conducted, ttr_details_confirmed, created_by_staff_id)
    values
        (pg_temp.u(p_label), '11111111-1111-1111-1111-111111111111', pg_temp.u(p_customer), pg_temp.u(p_joint),
         pg_temp.u(p_cap), pg_temp.u(p_jointcap), p_type::gold.purchase_type, p_band, p_flag, p_amount, p_invoice,
         p_date, '0412 345 678', true, p_self, p_conf, 'a1111111-1111-1111-1111-111111111111');
    return pg_temp.u(p_label);
end $$;

-- Call gold.start_ttr as the service role. Returns [{"r": [ttr, ...]}] or {error, sqlstate}.
create function pg_temp.start_as(p_purchase uuid, p_entity uuid default '11111111-1111-1111-1111-111111111111',
    p_staff uuid default 'a1111111-1111-1111-1111-111111111111') returns jsonb language sql as $$
    select pg_temp.q_as(null, 'aal2', format('select gold.start_ttr(%L, %L, %L, %L, %L::jsonb) as r',
        p_entity, p_staff, p_purchase, 'Coburg, VIC',
        '{"precious_metal_buy":"Purchase of precious metal for physical cash","bullion_buy":"Purchase of bullion for physical cash"}'),
        'service_role')
$$;

select plan(71);

-- ─── Grants ──────────────────────────────────────────────────────────────────────────────
select is((select bool_and(has_function_privilege('service_role', f, 'execute')) from unnest(array[
    'gold.start_ttr(uuid,uuid,uuid,text,jsonb)'::regprocedure,
    'gold._ttr_add_seller(uuid,uuid,uuid,uuid,boolean,timestamptz,uuid,text)'::regprocedure,
    'gold._sync_ttr_draft(uuid,uuid,uuid,text,date,text)'::regprocedure,
    'gold._ttr_type_cash(uuid,uuid,uuid,text,date,text)'::regprocedure]) f), true,
    'service_role can execute start_ttr and its helpers');
select is((select bool_or(has_function_privilege(r, f, 'execute')) from unnest(array['authenticated', 'anon']) r,
    unnest(array[
    'gold.start_ttr(uuid,uuid,uuid,text,jsonb)'::regprocedure,
    'gold._ttr_add_seller(uuid,uuid,uuid,uuid,boolean,timestamptz,uuid,text)'::regprocedure,
    'gold._sync_ttr_draft(uuid,uuid,uuid,text,date,text)'::regprocedure,
    'gold._ttr_type_cash(uuid,uuid,uuid,text,date,text)'::regprocedure]) f), false,
    'authenticated and anon cannot execute any of them');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        format('select gold.start_ttr(%L, %L, %L, ''x'', ''{}''::jsonb)', '11111111-1111-1111-1111-111111111111',
            'a1111111-1111-1111-1111-111111111111', pg_temp.u('x'))),
    'err:42501', 'a signed-in browser session cannot call start_ttr');

-- ─── uq_tx_ref_per_entity is per scenario ────────────────────────────────────────────────
select is((select pg_get_constraintdef(oid) from pg_constraint where conname = 'uq_tx_ref_per_entity'),
    'UNIQUE (reporting_entity_id, transaction_ref, scenario)', 'the reference is unique per business and scenario');
create function pg_temp.mk_tx(p_ref text, p_scenario text) returns text language plpgsql as $$
begin
    insert into ttr.transactions (reporting_entity_id, scenario, transaction_ref, transaction_datetime,
        designated_service, location_snapshot, staff_member_name, staff_member_email, cash_currency, cash_amount, aud_value)
    values ('11111111-1111-1111-1111-111111111111', p_scenario, p_ref, now(), 'svc', 'Coburg, VIC', 'S', 's@x.test', 'AUD', 5, 5);
    return 'ok';
exception when others then return sqlstate;
end $$;
select is(pg_temp.mk_tx('REF-1', 'bullion_buy'), 'ok', 'a first report with a reference');
select is(pg_temp.mk_tx('REF-1', 'precious_metal_buy'), 'ok', 'the same reference on the other scenario is allowed');
select is(pg_temp.mk_tx('REF-1', 'bullion_buy'), '23505', 'the same reference and scenario is refused');

-- ─── Case A, single type ─────────────────────────────────────────────────────────────────
select pg_temp.mk_p('pA', 'cA', 'capA', 'scrap', '10k_plus', true, 12000, 'INV-A1', true, true);
create temp table res_a as select pg_temp.start_as(pg_temp.u('pA')) as r;
select is(jsonb_array_length((select r -> 0 -> 'r' from res_a)), 1, 'case A single type: one TTR');
select is((select r -> 0 -> 'r' -> 0 ->> 'scenario' from res_a), 'precious_metal_buy', 'scrap becomes precious_metal_buy');
select is((select r -> 0 -> 'r' -> 0 ->> 'case' from res_a), 'A', 'decided as case A');
select is((select count(*)::int from ttr.transactions where transaction_ref = 'INV-A1'), 1, 'one draft with reference = the invoice');
select is((select t.cash_amount from ttr.transactions t where transaction_ref = 'INV-A1'), 12000.00, 'cash = the type''s cash');
select is((select t.status::text from ttr.transactions t where transaction_ref = 'INV-A1'), 'draft', 'a draft');
select is((select t.transaction_datetime = p.created_at from ttr.transactions t, gold.purchases p
           where t.transaction_ref = 'INV-A1' and p.id = pg_temp.u('pA')), true, 'transaction_datetime = the purchase created_at');
select results_eq($$ select staff_member_name, staff_member_email, location_snapshot, designated_service, created_by_staff_id
                     from ttr.transactions where transaction_ref = 'INV-A1' $$,
    $$ values ('Staff One'::text, 'staff1@entity-one.test'::text, 'Coburg, VIC'::text,
               'Purchase of precious metal for physical cash'::text, 'a1111111-1111-1111-1111-111111111111'::uuid) $$,
    'staff snapshot, location and designated service');
select is((select ttr_transaction_id from gold.purchases where id = pg_temp.u('pA')),
    (select id from ttr.transactions where transaction_ref = 'INV-A1'), 'the purchase links to the TTR');
select results_eq($$ select p.full_name, p.customer_id, p.is_complete, p.occupation, p.date_of_birth::text
                     from ttr.parties p join ttr.transactions t on t.id = p.transaction_id where t.transaction_ref = 'INV-A1' $$,
    $$ values ('Jane Citizen'::text, pg_temp.u('cA'), true, 'Jeweller'::text, '1980-01-01'::text) $$,
    'a complete party copied from the customer, customer_id set');
select results_eq($$ select v.verification_basis::text, v.reliance_reason, v.is_complete, v.prior_verification_id,
                            v.front_image_id is null and v.back_image_id is null, v.document_number, v.issuer, v.id_country_code,
                            v.has_expiry, v.expiry_date::text
                     from ttr.id_verifications v join ttr.transactions t on t.id = v.transaction_id where t.transaction_ref = 'INV-A1' $$,
    $$ values ('relied_on_prior_identification'::text, 'customer_confirmed_details_unchanged'::text, true,
               pg_temp.u('capA'), true, 'NUM-capA'::text, 'VIC'::text, 'AU'::bpchar, true, '2030-01-01'::text) $$,
    'a reliance row on the capture: document fields copied, no photos, case A reason');
select results_eq($$ select v.counter_confirmed_at = p.created_at, v.counter_confirmed_by_staff_id
                     from ttr.id_verifications v join ttr.transactions t on t.id = v.transaction_id, gold.purchases p
                     where t.transaction_ref = 'INV-A1' and p.id = pg_temp.u('pA') $$,
    $$ values (true, 'a1111111-1111-1111-1111-111111111111'::uuid) $$,
    'the counter confirmation (staff and time) is copied onto the row');
select is((select count(*)::int from gold.purchase_audit_log where purchase_id = pg_temp.u('pA') and source = 'start_ttr'), 1,
    'the link is audited with source start_ttr');

-- Idempotent: a second call reuses the TTR.
create temp table res_a2 as select pg_temp.start_as(pg_temp.u('pA')) as r;
select is((select r -> 0 -> 'r' -> 0 ->> 'created' from res_a2), 'false', 'a second call reuses the TTR (created = false)');
select is((select count(*)::int from ttr.transactions where transaction_ref = 'INV-A1'), 1, 'still one TTR');
select is((select count(*)::int from ttr.parties p join ttr.transactions t on t.id = p.transaction_id where t.transaction_ref = 'INV-A1'), 1,
    'and still one party');

-- ─── Case B: the customer is not ready; counter answers No ───────────────────────────────
select pg_temp.mk_p('pB', 'cB', 'capB', 'scrap', '10k_plus', true, 12000, 'INV-B1', true, true);
select pg_temp.start_as(pg_temp.u('pB'));
select results_eq($$ select p.is_complete, v.is_complete, v.reliance_reason, v.counter_confirmed_at is not null
                     from ttr.parties p join ttr.transactions t on t.id = p.transaction_id
                     join ttr.id_verifications v on v.party_id = p.id where t.transaction_ref = 'INV-B1' $$,
    $$ values (false, false, 'prior_id_reviewed_still_valid'::text, true) $$,
    'a customer missing fields: incomplete party and row (case B), counter confirmation still copied');
select pg_temp.mk_p('pN', 'cA', 'capA', 'scrap', '10k_plus', true, 12000, 'INV-N1', true, false);
select pg_temp.start_as(pg_temp.u('pN'));
select is((select v.reliance_reason from ttr.id_verifications v join ttr.transactions t on t.id = v.transaction_id
           where t.transaction_ref = 'INV-N1'), 'prior_id_reviewed_still_valid', 'a No to the details question is case B');
select pg_temp.mk_p('pJ', 'cA', 'capA', 'scrap', '10k_plus', true, 12000, 'INV-J1', true, true, 'cB', 'capB');
select pg_temp.start_as(pg_temp.u('pJ'));
select results_eq($$ select p.customer_id, v.is_complete, v.reliance_reason
                     from ttr.parties p join ttr.transactions t on t.id = p.transaction_id
                     join ttr.id_verifications v on v.party_id = p.id where t.transaction_ref = 'INV-J1' order by p.customer_id $$,
    $$ select c, false, 'prior_id_reviewed_still_valid'::text from unnest(array[pg_temp.u('cA'), pg_temp.u('cB')]) c order by c $$,
    'a joint sale: a party and a reliance row for each seller, always case B');

-- ─── Mixed invoice: one TTR per type, each with its own cash ─────────────────────────────
select pg_temp.mk_p('m1', 'cA', 'capA', 'scrap', 'under_10k', false, 6000, 'INV-900', true, true);
select pg_temp.mk_p('m2', 'cA', 'capA', 'bullion', '5k_to_10k', false, 6000, 'INV-900', true, true);
create temp table res_m as select pg_temp.start_as(pg_temp.u('m2')) as r;
select is(jsonb_array_length((select r -> 0 -> 'r' from res_m)), 2, 'a mixed invoice gives two TTRs');
select is((select r -> 0 -> 'r' -> 0 ->> 'type' from res_m), 'bullion', 'the called purchase''s type comes first');
select results_eq($$ select scenario, transaction_ref, cash_amount, aud_value from ttr.transactions
                     where transaction_ref = 'INV-900' order by scenario $$,
    $$ values ('bullion_buy'::text, 'INV-900'::text, 6000.00::numeric, 6000.00::numeric),
              ('precious_metal_buy'::text, 'INV-900'::text, 6000.00::numeric, 6000.00::numeric) $$,
    'both reports carry exactly INV-900 and their own type''s cash');
select is((select count(distinct ttr_transaction_id)::int from gold.purchases where id in (pg_temp.u('m1'), pg_temp.u('m2'))), 2,
    'each part links to its own type''s TTR');
select is((select count(*)::int from ttr.parties p join ttr.transactions t on t.id = p.transaction_id where t.transaction_ref = 'INV-900'), 2,
    'each report has its own party');

-- Scrap paid in cash, bullion by bank transfer (a known 0): one TTR only.
select pg_temp.mk_p('x1', 'cA', 'capA', 'scrap', '10k_plus', true, 12000, 'INV-X1', true, true);
select pg_temp.mk_p('x2', 'cA', 'capA', 'bullion', 'under_5k', false, 0, 'INV-X1', true, true);
select is(jsonb_array_length((select r -> 0 -> 'r' from (select pg_temp.start_as(pg_temp.u('x2')) as r) z)), 1,
    'a type paid only by bank transfer gets no TTR');
select is((select scenario from ttr.transactions where transaction_ref = 'INV-X1'), 'precious_metal_buy', 'only the scrap report exists');

-- No amount entered: the placeholder.
select pg_temp.mk_p('ph1', 'cA', 'capA', 'bullion', '10k_plus', true, null, 'INV-PH', true, true);
select pg_temp.start_as(pg_temp.u('ph1'));
select is((select cash_amount from ttr.transactions where transaction_ref = 'INV-PH'), 1.00, 'no amount entered: the placeholder of 1');

-- ─── Refusals ────────────────────────────────────────────────────────────────────────────
select pg_temp.mk_p('noinv', 'cA', 'capA', 'scrap', '10k_plus', true, 12000, null);
select is(pg_temp.start_as(pg_temp.u('noinv')) ->> 'sqlstate', 'GD003', 'no ERP invoice: GD003');
select pg_temp.mk_p('small', 'cA', 'capA', 'scrap', 'under_10k', false, 5000, 'INV-S1');
select is(pg_temp.start_as(pg_temp.u('small')) ->> 'sqlstate', 'GD004', 'not reportable: GD004');
select pg_temp.mk_p('zero', 'cA', 'capA', 'scrap', '10k_plus', true, 0, 'INV-Z1');
select is(pg_temp.start_as(pg_temp.u('zero')) ->> 'sqlstate', 'GD005', 'no cash paid: GD005');
select is(pg_temp.start_as(pg_temp.u('pA'), '22222222-2222-2222-2222-222222222222', 'a2222222-2222-2222-2222-222222222222') ->> 'sqlstate',
    'P0002', 'another business''s purchase is not found');
select is(pg_temp.start_as(pg_temp.u('pA'), p_staff => 'a1111111-1111-1111-1111-111111111119') ->> 'sqlstate',
    '22023', 'an inactive staff member is refused');
select is(pg_temp.mk_tx('INV-CLASH', 'precious_metal_buy'), 'ok', 'another TTR already holds the reference');
select pg_temp.mk_p('clash', 'cA', 'capA', 'scrap', '10k_plus', true, 12000, 'INV-CLASH');
select is(pg_temp.start_as(pg_temp.u('clash')) ->> 'sqlstate', '23505', 'a reference already used by another TTR on that scenario: 23505');
select is((select count(*)::int from ttr.parties p join ttr.transactions t on t.id = p.transaction_id
           where t.transaction_ref = 'INV-CLASH'), 0, 'and nothing else was written (atomic)');

create function pg_temp.save_part(p_label text, p_invoice text, p_amount numeric, p_type text default 'scrap') returns jsonb language sql as $$
    select pg_temp.q_as(null, 'aal2', format('select gold.save_purchase(%L, %L, %L::jsonb, %L::jsonb, ''[]''::jsonb) as id',
        '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111',
        jsonb_build_object('id', pg_temp.u(p_label), 'customer_id', pg_temp.u('cA'), 'main_id_verification_id', pg_temp.u('capA'),
            'purchase_type', p_type, 'cash_band', case p_type when 'scrap' then 'under_10k' else 'under_5k' end,
            'cash_10k_or_more', false, 'cash_amount', p_amount, 'erp_invoice_no', p_invoice, 'sale_date', '2026-11-07',
            'phone', '0412 345 678', 'id_sighted', true, 'id_expired_at_time', false, 'id_outside_window_at_time', false),
        jsonb_build_array(jsonb_build_object('object_path', pg_temp.u(p_label)::text || '/goods-1.jpg',
            'content_hash_sha256', 'h-' || p_label, 'byte_size', 100))),
        'service_role')
$$;

-- Saving a later $3,000 scrap part on INV-A1 while its TTR is still a draft: it joins and the cash is updated.
select is(pg_temp.save_part('later', 'INV-A1', 3000) -> 0 ->> 'id', pg_temp.u('later')::text, 'a later part saves on an invoice with a draft TTR');
select is((select ttr_transaction_id from gold.purchases where id = pg_temp.u('later')),
    (select id from ttr.transactions where transaction_ref = 'INV-A1'), 'the later part joins the draft TTR');
select is((select cash_amount from ttr.transactions where transaction_ref = 'INV-A1'), 15000.00, 'and the draft''s cash is updated to the type total');
select is((select aud_value from ttr.transactions where transaction_ref = 'INV-A1'), 15000.00, 'aud_value too');
-- A part of the OTHER type does not join, and does not touch this TTR's cash.
select pg_temp.save_part('otherType', 'INV-A1', 500, 'bullion');
select is((select ttr_transaction_id from gold.purchases where id = pg_temp.u('otherType')), null::uuid, 'a part of the other type does not join the scrap TTR');
select is((select cash_amount from ttr.transactions where transaction_ref = 'INV-A1'), 15000.00, 'the scrap TTR''s cash is unchanged by it');

-- Adding the invoice to an earlier part (complete_purchase) joins a draft TTR the same way.
select pg_temp.mk_p('lc', 'cA', 'capA', 'scrap', 'under_10k', false, 2000, null);
select is(pg_temp.q_as(null, 'aal2', format('select gold.complete_purchase(%L, %L, %L, ''INV-N1'', null, ''[]''::jsonb)',
    '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', pg_temp.u('lc')), 'service_role') -> 0 ->> 'complete_purchase', '',
    'complete_purchase adds the invoice');
select is((select ttr_transaction_id from gold.purchases where id = pg_temp.u('lc')),
    (select id from ttr.transactions where transaction_ref = 'INV-N1'), 'the completed part joins the draft TTR');
select is((select cash_amount from ttr.transactions where transaction_ref = 'INV-N1'), 14000.00, 'cash = 12,000 + 2,000');

-- Once the TTR is complete, a new part on the invoice is blocked (GD002); the draft is untouched.
update ttr.transactions set status = 'complete', completed_at = now() where transaction_ref = 'INV-A1';
select is(pg_temp.save_part('blocked', 'INV-A1', 100) ->> 'sqlstate', 'GD002', 'a completed TTR blocks a new part (GD002)');
select is((select count(*)::int from gold.purchases where id = pg_temp.u('blocked')), 0, 'and nothing was saved');
select pg_temp.mk_p('lc2', 'cA', 'capA', 'scrap', 'under_10k', false, 100, null);
select is(pg_temp.q_as(null, 'aal2', format('select gold.complete_purchase(%L, %L, %L, ''INV-A1'', null, ''[]''::jsonb)',
    '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', pg_temp.u('lc2')), 'service_role') ->> 'sqlstate', 'GD002',
    'adding a completed TTR''s invoice number on Complete purchase is blocked too');
select is((select cash_amount from ttr.transactions where transaction_ref = 'INV-A1'), 15000.00, 'the completed TTR''s cash is untouched');

-- ─── Deleting a draft TTR clears the gold link; Start TTR works again ────────────────────
delete from ttr.transactions where transaction_ref = 'INV-N1';
select is((select count(*)::int from gold.purchases where id in (pg_temp.u('pN'), pg_temp.u('lc')) and ttr_transaction_id is not null), 0,
    'deleting the draft clears ttr_transaction_id on every linked part (ON DELETE SET NULL)');
select is((select count(*)::int from gold.purchases where id in (pg_temp.u('pN'), pg_temp.u('lc'))), 2, 'the purchases remain');
select is(pg_temp.start_as(pg_temp.u('pN')) -> 0 -> 'r' -> 0 ->> 'created', 'true', 'Start TTR then creates a fresh draft');

-- ─── cleanup-stale-drafts skips drafts linked to a gold purchase ─────────────────────────
update ttr.transactions set created_at = now() - interval '60 days' where transaction_ref in ('INV-B1', 'REF-1');
select is((select count(*)::int from ttr.get_stale_draft_ids(30) s join ttr.transactions t on t.id = s.transaction_id
           where t.transaction_ref = 'INV-B1'), 0, 'an old draft linked to a gold purchase is not stale');
select ok((select count(*) from ttr.get_stale_draft_ids(30) s join ttr.transactions t on t.id = s.transaction_id
           where t.transaction_ref = 'REF-1') > 0, 'an old unlinked draft still is');

-- ─── Counter confirmation lives only on reliance rows, and goes with the record relied on ─
select is(pg_temp.dml_as(null, 'aal2', format('update ttr.id_verifications set counter_confirmed_at = now() where id = %L', pg_temp.u('capA')), 'postgres'),
    'err:23514', 'a customer-level capture cannot carry a counter confirmation');
select is(pg_temp.dml_as(null, 'aal2', format('update ttr.id_verifications v set counter_confirmed_by_staff_id = null where v.transaction_id = (select id from ttr.transactions where transaction_ref = %L)', 'INV-B1'), 'postgres'),
    'err:23514', 'staff and time come as a pair');
update ttr.id_verifications set verification_basis = 'new_capture', prior_verification_id = null, reliance_reason = null,
    new_capture_reason = 'different_person'
where transaction_id = (select id from ttr.transactions where transaction_ref = 'INV-B1');
select is((select counter_confirmed_at from ttr.id_verifications
           where transaction_id = (select id from ttr.transactions where transaction_ref = 'INV-B1')), null::timestamptz,
    'switching away from reliance clears the counter confirmation');

-- ─── gold.ttr_linked_cash: the sale's cash across all types (the $10,000-per-report exemption, spec 3.4) ───────
select pg_temp.mk_p('mxS', 'cA', 'capA', 'scrap',   'under_10k', false, 6000, 'INV-MX');
select pg_temp.mk_p('mxB', 'cA', 'capA', 'bullion', '5k_to_10k', false, 6000, 'INV-MX');
select is(jsonb_array_length(pg_temp.start_as(pg_temp.u('mxS')) -> 0 -> 'r'), 2, 'a $6,000 + $6,000 invoice starts two TTRs');
select is((select cash_amount from ttr.transactions where id = (select ttr_transaction_id from gold.purchases where id = pg_temp.u('mxS'))), 6000.00,
    'each TTR keeps its own type''s cash');
select is(gold._ttr_linked_cash('11111111-1111-1111-1111-111111111111',
        (select ttr_transaction_id from gold.purchases where id = pg_temp.u('mxS'))), 12000.00,
    'the scrap TTR''s linked cash is the whole sale: 6,000 + 6,000');
select is(gold._ttr_linked_cash('11111111-1111-1111-1111-111111111111',
        (select ttr_transaction_id from gold.purchases where id = pg_temp.u('mxB'))), 12000.00,
    'and so is the bullion TTR''s');
select is(gold._ttr_linked_cash('22222222-2222-2222-2222-222222222222',
        (select ttr_transaction_id from gold.purchases where id = pg_temp.u('mxS'))), null::numeric,
    'another business gets nothing for it');
select is(gold._ttr_linked_cash('11111111-1111-1111-1111-111111111111', pg_temp.u('no-such-ttr')), null::numeric,
    'a TTR no gold purchase points at (a wizard-started report) gets NULL, so the plain $10,000 rule applies');
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2', format('select gold.ttr_linked_cash(%L) as v',
        (select ttr_transaction_id from gold.purchases where id = pg_temp.u('mxB')))) -> 0 ->> 'v', '12000.00',
    'a staff member at aal2 reads it for their own business');
select is(pg_temp.q_as('a2222222-2222-2222-2222-222222222222', 'aal2', format('select gold.ttr_linked_cash(%L) as v',
        (select ttr_transaction_id from gold.purchases where id = pg_temp.u('mxB')))) -> 0 -> 'v', 'null'::jsonb,
    'staff of another business read NULL');

select * from finish();
rollback;
