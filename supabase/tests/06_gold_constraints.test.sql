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

-- Insert a purchase with some columns overridden; returns 'ok' or the SQLSTATE and constraint name.
create function pg_temp.try_ins(p_overrides jsonb) returns text language plpgsql as $$
declare
    v_row jsonb := jsonb_build_object(
        'id', gen_random_uuid(),
        'reporting_entity_id', '11111111-1111-1111-1111-111111111111',
        'customer_id', pg_temp.u('cA'),
        'main_id_verification_id', pg_temp.u('capA'),
        'purchase_type', 'scrap',
        'cash_band', 'under_10k',
        'cash_10k_or_more', false,
        'sale_date', '2026-10-01',
        'phone', '0412 345 678',
        'id_sighted', true,
        'created_by_staff_id', 'a1111111-1111-1111-1111-111111111111'
    ) || p_overrides;
    v_con text;
begin
    insert into gold.purchases
        (id, reporting_entity_id, customer_id, joint_customer_id, main_id_verification_id, joint_id_verification_id,
         purchase_type, cash_band, cash_10k_or_more, cash_amount, erp_invoice_no, sale_date, phone, id_sighted,
         completed_at, completed_by_staff_id, created_by_staff_id)
    select r.id, r.reporting_entity_id, r.customer_id, r.joint_customer_id, r.main_id_verification_id,
           r.joint_id_verification_id, r.purchase_type, r.cash_band, r.cash_10k_or_more, r.cash_amount,
           r.erp_invoice_no, r.sale_date, r.phone, r.id_sighted, r.completed_at, r.completed_by_staff_id,
           r.created_by_staff_id
    from jsonb_populate_record(null::gold.purchases, v_row) r;
    return 'ok';
exception when others then
    get stacked diagnostics v_con = constraint_name;
    return sqlstate || coalesce(':' || v_con, '');
end $$;

-- ─── Seed ────────────────────────────────────────────────────────────────────────────────
select pg_temp.mk_cust('cA', '11111111-1111-1111-1111-111111111111', 'Alice', 'Alpha');
select pg_temp.mk_cust('cJ', '11111111-1111-1111-1111-111111111111', 'Jo', 'Joint');
select pg_temp.mk_cust('cB', '22222222-2222-2222-2222-222222222222', 'Bob', 'Beta');
select pg_temp.mk_cap('capA', pg_temp.u('cA'));
select pg_temp.mk_cap('capJ', pg_temp.u('cJ'));
select pg_temp.mk_cap('capB', pg_temp.u('cB'), 'Passport', null, null, 'AU', '2026-03-01', 'a2222222-2222-2222-2222-222222222222');

select pg_temp.mk_purchase('pI', pg_temp.u('cA'), pg_temp.u('capA'));
select pg_temp.mk_purchase('pJ', pg_temp.u('cA'), pg_temp.u('capA'), p_joint => pg_temp.u('cJ'), p_joint_cap => pg_temp.u('capJ'));

select plan(70);

-- ─── CHECK constraints ───────────────────────────────────────────────────────────────────
select is(pg_temp.try_ins('{}'), 'ok', 'a valid purchase inserts');
select is(pg_temp.try_ins(jsonb_build_object('joint_customer_id', pg_temp.u('cJ'), 'joint_id_verification_id', pg_temp.u('capJ'))),
    'ok', 'a valid joint purchase inserts');
select is(pg_temp.try_ins(jsonb_build_object('joint_customer_id', pg_temp.u('cA'), 'joint_id_verification_id', pg_temp.u('capA'))),
    '23514:chk_gp_joint_differs', 'the joint seller cannot be the main seller');
select is(pg_temp.try_ins(jsonb_build_object('joint_customer_id', pg_temp.u('cJ'))),
    '23514:chk_gp_joint_id', 'a joint seller needs the ID used for them');
select is(pg_temp.try_ins(jsonb_build_object('joint_id_verification_id', pg_temp.u('capJ'))),
    '23514:chk_gp_joint_id', 'a joint ID needs a joint seller');
select is(pg_temp.try_ins('{"cash_amount": -1}'), '23514:chk_gp_cash_amount', 'a negative cash amount is rejected');
select is(pg_temp.try_ins('{"cash_amount": 0}'), 'ok', 'a zero cash amount is allowed');
select is(pg_temp.try_ins('{"cash_amount": null}'), 'ok', 'and so is no cash amount');
select is(pg_temp.try_ins('{"id_sighted": false}'), '23514:chk_gp_id_sighted', 'id_sighted must be true');
select is(pg_temp.try_ins('{"id_sighted": null}'), '23502:', 'and cannot be null');
select is(pg_temp.try_ins('{"phone": "1234567"}'), '23514:chk_gp_phone', 'a phone with 7 digits is rejected');
select is(pg_temp.try_ins('{"phone": "+61 412 345 678"}'), 'ok', 'a formatted phone with 11 digits is accepted');
select is(pg_temp.try_ins('{"cash_band": "5k_to_10k"}'), '23514:chk_gp_cash_band', 'scrap has no $5,000 to $9,999 band');
select is(pg_temp.try_ins('{"purchase_type": "bullion", "cash_band": "under_10k"}'), '23514:chk_gp_cash_band', 'bullion has no under_10k band');
select is(pg_temp.try_ins('{"purchase_type": "bullion", "cash_band": "5k_to_10k"}'), 'ok', 'bullion takes the $5,000 to $9,999 band');
select is(pg_temp.try_ins('{"cash_band": "lots"}'), '23514:chk_gp_cash_band', 'an unknown band is rejected');
select is(pg_temp.try_ins('{"purchase_type": "jewellery"}'), '22P02:', 'an unknown purchase type is rejected');
select is(pg_temp.try_ins('{"erp_invoice_no": "   "}'), '23514:chk_gp_invoice_not_blank', 'a blank invoice number is rejected');
select is(pg_temp.try_ins('{"completed_at": "2026-10-02T00:00:00Z"}'), '23514:chk_gp_completed_pair', 'completed_at needs completed_by');

-- ─── Generated columns and defaults ──────────────────────────────────────────────────────
do $$ begin perform pg_temp.try_ins('{"id": "00000000-0000-0000-0000-0000000000e1", "erp_invoice_no": "  inv-9a "}'); end $$;
select is((select erp_invoice_norm from gold.purchases where id = '00000000-0000-0000-0000-0000000000e1'), 'INV-9A',
    'erp_invoice_norm is the upper-cased, trimmed invoice number');
insert into gold.purchases (id, reporting_entity_id, customer_id, main_id_verification_id, purchase_type, cash_band,
    cash_10k_or_more, phone, id_sighted, created_by_staff_id)
values ('00000000-0000-0000-0000-0000000000e2', '11111111-1111-1111-1111-111111111111', pg_temp.u('cA'), pg_temp.u('capA'),
    'scrap', 'under_10k', false, '0412345678', true, 'a1111111-1111-1111-1111-111111111111');
select is((select sale_date from gold.purchases where id = '00000000-0000-0000-0000-0000000000e2'),
    (now() at time zone 'Australia/Melbourne')::date, 'sale_date defaults to today in Melbourne');
select is((select erp_invoice_norm from gold.purchases where id = '00000000-0000-0000-0000-0000000000e2'), null,
    'and erp_invoice_norm is null without an invoice');

-- ─── Deleting the TTR clears the link ────────────────────────────────────────────────────
select pg_temp.mk_tx('t_draft', '11111111-1111-1111-1111-111111111111', 'draft');
select pg_temp.mk_purchase('pT', pg_temp.u('cA'), pg_temp.u('capA'), p_tx => pg_temp.u('t_draft'));
delete from ttr.transactions where id = pg_temp.u('t_draft');
select is((select ttr_transaction_id from gold.purchases where id = pg_temp.u('pT')), null,
    'deleting the draft TTR sets ttr_transaction_id to null');
select is((select count(*)::int from gold.purchases where id = pg_temp.u('pT')), 1, 'and keeps the purchase');

-- ─── Immutability, as the service role ───────────────────────────────────────────────────
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        format('update gold.purchases set %s where id = %L', v.set_clause, pg_temp.u('pI')), 'service_role'),
    'err:23001', 'the service role cannot change ' || v.what)
from (values
    ('the main seller',               format('customer_id = %L', pg_temp.u('cB'))),
    ('the entity',                    format('reporting_entity_id = %L', '22222222-2222-2222-2222-222222222222')),
    ('the joint seller',              format('joint_customer_id = %L, joint_id_verification_id = %L', pg_temp.u('cJ'), pg_temp.u('capJ'))),
    ('the purchase type',             $$purchase_type = 'bullion', cash_band = 'under_5k'$$),
    ('the main ID',                   format('main_id_verification_id = %L', pg_temp.u('capB'))),
    ('id_sighted',                    'id_sighted = false'),
    ('id_expired_at_time',            'id_expired_at_time = true'),
    ('id_outside_window_at_time',     'id_outside_window_at_time = true'),
    ('ttr_self_conducted',            'ttr_self_conducted = true'),
    ('ttr_details_confirmed',         'ttr_details_confirmed = true'),
    ('sale_date',                     $$sale_date = '2020-01-01'$$),
    ('created_at',                    $$created_at = '2020-01-01'$$),
    ('created_by_staff_id',           format('created_by_staff_id = %L', 'a1111111-1111-1111-1111-111111111112'))
) v(what, set_clause);

select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        format('update gold.purchases set joint_customer_id = null, joint_id_verification_id = null where id = %L', pg_temp.u('pJ')), 'service_role'),
    'err:23001', 'the service role cannot remove a joint seller');

select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        format($q$update gold.purchases set cash_amount = 250, cash_band = '10k_plus', cash_10k_or_more = true,
                  phone = '0499 888 777', invoice_cash_total = 250 where id = %L$q$, pg_temp.u('pI')), 'service_role'),
    'ok:1', 'cash, phone and the invoice snapshot can still be updated');

-- ─── The invoice number ──────────────────────────────────────────────────────────────────
select pg_temp.mk_purchase('pN', pg_temp.u('cA'), pg_temp.u('capA'));
select set_config('app.actor_staff_id', 'a1111111-1111-1111-1111-111111111112', true);
select set_config('app.change_source', 'complete_purchase', true);
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        format($q$update gold.purchases set erp_invoice_no = 'inv-n1', completed_at = now(),
                  completed_by_staff_id = %L where id = %L$q$, 'a1111111-1111-1111-1111-111111111112', pg_temp.u('pN')), 'service_role'),
    'ok:1', 'adding the invoice and completed_* together is allowed');
select set_config('app.actor_staff_id', '', true);
select set_config('app.change_source', '', true);

select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        format($q$update gold.purchases set erp_invoice_no = 'inv-other' where id = %L$q$, pg_temp.u('pN')), 'service_role'),
    'err:23001', 'a set invoice number cannot be changed');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        format($q$update gold.purchases set erp_invoice_no = null where id = %L$q$, pg_temp.u('pN')), 'service_role'),
    'err:23001', 'or removed');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        format($q$update gold.purchases set erp_invoice_no = 'inv-n1' where id = %L$q$, pg_temp.u('pN')), 'service_role'),
    'ok:1', 'writing the same invoice number again is harmless');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        format($q$update gold.purchases set completed_at = now() + interval '1 day' where id = %L$q$, pg_temp.u('pN')), 'service_role'),
    'err:23001', 'completed_at cannot change once set');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        format($q$update gold.purchases set completed_at = null, completed_by_staff_id = null where id = %L$q$, pg_temp.u('pN')), 'service_role'),
    'err:23001', 'or be cleared');

select pg_temp.mk_purchase('pM', pg_temp.u('cA'), pg_temp.u('capA'));
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        format($q$update gold.purchases set completed_at = now(), completed_by_staff_id = %L where id = %L$q$,
               'a1111111-1111-1111-1111-111111111112', pg_temp.u('pM')), 'service_role'),
    'err:23001', 'completed_* without the invoice update is rejected');

select pg_temp.mk_purchase('pK', pg_temp.u('cA'), pg_temp.u('capA'), p_invoice => 'KK-1');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        format($q$update gold.purchases set completed_at = now(), completed_by_staff_id = %L where id = %L$q$,
               'a1111111-1111-1111-1111-111111111112', pg_temp.u('pK')), 'service_role'),
    'err:23001', 'a purchase saved with its invoice is never "completed"');

select pg_temp.mk_purchase('pL', pg_temp.u('cA'), pg_temp.u('capA'));
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        format($q$update gold.purchases set erp_invoice_no = 'LL-1' where id = %L$q$, pg_temp.u('pL')), 'service_role'),
    'ok:1', 'the invoice can be added on its own');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        format($q$update gold.purchases set completed_at = now(), completed_by_staff_id = %L where id = %L$q$,
               'a1111111-1111-1111-1111-111111111112', pg_temp.u('pL')), 'service_role'),
    'err:23001', 'but completed_* has to come with that same update');

-- ─── Audit ───────────────────────────────────────────────────────────────────────────────
select is((select count(*)::int from gold.purchase_audit_log where purchase_id = pg_temp.u('pN')), 1,
    'completing a purchase writes one audit row');
select is((select changed_by from gold.purchase_audit_log where purchase_id = pg_temp.u('pN')),
    'a1111111-1111-1111-1111-111111111112'::uuid, 'attributed to app.actor_staff_id');
select is((select source from gold.purchase_audit_log where purchase_id = pg_temp.u('pN')), 'complete_purchase',
    'with the change source');
select is((select changes -> 'erp_invoice_no' from gold.purchase_audit_log where purchase_id = pg_temp.u('pN')),
    '{"old": null, "new": "inv-n1"}'::jsonb, 'recording old and new for the invoice');
select ok((select (changes ? 'completed_at') and (changes ? 'completed_by_staff_id')
                  and not (changes ? 'erp_invoice_norm') and not (changes ? 'updated_at')
           from gold.purchase_audit_log where purchase_id = pg_temp.u('pN')),
    'and for completed_*, but not for updated_at or the generated norm');
select is((select changes -> 'cash_amount' from gold.purchase_audit_log where purchase_id = pg_temp.u('pI')),
    '{"old": null, "new": 250.00}'::jsonb, 'a cash update is audited old to new');

select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        format('update gold.purchases set phone = phone where id = %L', pg_temp.u('pI')), 'service_role'),
    'ok:1', 'a no-op update goes through');
select is((select count(*)::int from gold.purchase_audit_log where purchase_id = pg_temp.u('pI')), 1,
    'and writes no audit row');

select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        format('update gold.purchases set cash_amount = 300 where id = %L', pg_temp.u('pI')), 'service_role'),
    'ok:1', 'an update with no actor set');
select is((select changed_by from gold.purchase_audit_log where purchase_id = pg_temp.u('pI') order by changed_at desc, id limit 1),
    'a1111111-1111-1111-1111-111111111111'::uuid, 'is attributed to the signed-in staff member (auth.uid())');

-- ─── Append-only tables ──────────────────────────────────────────────────────────────────
insert into gold.goods_photos (id, purchase_id, reporting_entity_id, object_path, content_hash_sha256, captured_by_staff_id)
values (pg_temp.u('ph1'), pg_temp.u('pI'), '11111111-1111-1111-1111-111111111111', pg_temp.u('pI') || '/goods-1.jpg', 'h',
        'a1111111-1111-1111-1111-111111111111');
insert into gold.export_audit_log (id, reporting_entity_id, staff_member_id, kind)
values (pg_temp.u('ex1'), '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111112', 'zip');

select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2', 'update gold.purchase_audit_log set source = ''x''', 'service_role'),
    'err:P0001', 'the purchase audit log rejects an update, even from the service role');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2', 'delete from gold.purchase_audit_log', 'service_role'),
    'err:P0001', 'and a delete');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2', 'update gold.goods_photos set sort_order = 3', 'service_role'),
    'err:P0001', 'goods photos reject an update');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2', 'delete from gold.goods_photos', 'service_role'),
    'err:P0001', 'and a delete');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2', 'update gold.export_audit_log set kind = ''record''', 'service_role'),
    'err:P0001', 'the export audit log rejects an update');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2', 'delete from gold.export_audit_log', 'service_role'),
    'err:P0001', 'and a delete');

-- ─── Goods photo and export constraints ──────────────────────────────────────────────────
select throws_ok(
    format($q$insert into gold.goods_photos (purchase_id, reporting_entity_id, object_path, content_hash_sha256, captured_by_staff_id, sort_order)
        values (%L, %L, 'wrong/goods-2.jpg', 'h', %L, 2)$q$, pg_temp.u('pI'), '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111'),
    '23514', null, 'a goods photo path must start with the purchase id');
select throws_ok(
    format($q$insert into gold.goods_photos (purchase_id, reporting_entity_id, object_path, content_hash_sha256, captured_by_staff_id, sort_order)
        values (%L, %L, %L, 'h', %L, 0)$q$, pg_temp.u('pI'), '11111111-1111-1111-1111-111111111111', pg_temp.u('pI') || '/goods-7.jpg',
        'a1111111-1111-1111-1111-111111111111'),
    '23505', null, 'two photos cannot share a sort order');
select throws_ok(
    format($q$insert into gold.goods_photos (purchase_id, reporting_entity_id, storage_bucket, object_path, content_hash_sha256, captured_by_staff_id, sort_order)
        values (%L, %L, 'compliance-media', %L, 'h', %L, 3)$q$, pg_temp.u('pI'), '11111111-1111-1111-1111-111111111111', pg_temp.u('pI') || '/goods-3.jpg',
        'a1111111-1111-1111-1111-111111111111'),
    '23514', null, 'goods photos live only in the gold-goods bucket');
select throws_ok(
    format($q$delete from gold.purchases where id = %L$q$, pg_temp.u('pI')),
    '23503', null, 'a purchase with photos cannot be deleted');
select throws_ok(
    format($q$insert into gold.export_audit_log (reporting_entity_id, staff_member_id, kind)
        values (%L, %L, 'pdf')$q$, '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111112'),
    '23514', null, 'an export is a zip or a record');

select * from finish();
rollback;
