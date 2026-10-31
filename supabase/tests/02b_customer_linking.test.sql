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

select plan(32);

-- Completing a TTR links its parties to customers inside ttr.complete_transaction, so these
-- tests drive the real completion function rather than the link helper alone.
-- (Two completions racing for the same new person need two sessions, which pgTAP cannot
-- open; the advisory lock is checked below and the race itself in the UAT sheet / QA notes.)

-- ── L1: a new person ──────────────────────────────────────────────────────────────────
select pg_temp.mk_tx('l1', '11111111-1111-1111-1111-111111111111', 'draft', 'a1111111-1111-1111-1111-111111111111');
select pg_temp.mk_ind('p_l1', 'l1', 'Newbie', 'Person', '1992-02-02', '2026-01-01', true, 'Nick', '0400 000 001',
    'Welder', 'Sole trader', 'PO Box 9');
select ttr.complete_transaction(pg_temp.u('l1'), 'a1111111-1111-1111-1111-111111111111');

select is((select count(*) from public.customers where last_name = 'Person'), 1::bigint,
    'a new person creates a customer on completion');
select is((select source || '/' || created_by_staff_id::text || '/' || occupation || '/' || is_sole_trader::text
            from public.customers where last_name = 'Person'),
    'ttr/a1111111-1111-1111-1111-111111111111/Welder/true',
    'the customer carries the party''s details, source ttr, and the completing staff member');
select is((select post_street from public.customers where last_name = 'Person'), 'PO Box 9',
    'including the postal address');
select is((select array_agg(alias) from public.customer_aliases ca join public.customers c on c.id = ca.customer_id
            where c.last_name = 'Person'),
    array['Nick'], 'and the aliases');
select isnt((select customer_id from ttr.parties where id = pg_temp.u('p_l1')), null,
    'and the party is linked');
select is((select status::text from ttr.transactions where id = pg_temp.u('l1')), 'complete',
    'the transaction is complete');
select is((select count(*) from public.customer_audit_log), 0::bigint,
    'creating a customer writes no audit row (only updates are audited)');

-- ── L2: the same person again (case differs) links to the existing customer ───────────
select pg_temp.mk_tx('l2', '11111111-1111-1111-1111-111111111111', 'draft', 'a1111111-1111-1111-1111-111111111111');
select pg_temp.mk_ind('p_l2', 'l2', 'newbie', 'PERSON', '1992-02-02');
select ttr.complete_transaction(pg_temp.u('l2'), 'a1111111-1111-1111-1111-111111111111');

select is((select count(*) from public.customers where last_name = 'Person'), 1::bigint,
    'a matching key links to the existing customer, creating no duplicate');
select is((select customer_id from ttr.parties where id = pg_temp.u('p_l2')),
    (select customer_id from ttr.parties where id = pg_temp.u('p_l1')),
    'both parties point at the same customer');
select is((select occupation from public.customers where last_name = 'Person'), 'Welder',
    'a blank party field does not erase the customer''s value');
select is((select array_agg(alias) from public.customer_aliases ca join public.customers c on c.id = ca.customer_id
            where c.last_name = 'Person'),
    array['Nick'], 'a party with no aliases leaves the customer''s aliases alone');
select is((select is_sole_trader::text || '/' || has_postal_address::text || '/' || coalesce(post_street, 'null')
            from public.customers where last_name = 'Person'),
    'false/false/null', 'the party''s explicit answers (not a sole trader, no postal address) are applied');

-- ── L3: returning person, changed address and aliases ─────────────────────────────────
select pg_temp.mk_tx('l3', '11111111-1111-1111-1111-111111111111', 'draft', 'a1111111-1111-1111-1111-111111111111');
select pg_temp.mk_ind('p_l3', 'l3', 'Newbie', 'Person', '1992-02-02', '2026-01-01', true, 'Nicky', '0400 000 003');
update ttr.parties set res_street = '99 New Rd' where id = pg_temp.u('p_l3');
insert into ttr.party_aliases (party_id, alias, sort_order) values (pg_temp.u('p_l3'), 'Nic', 1);
select ttr.complete_transaction(pg_temp.u('l3'), 'a1111111-1111-1111-1111-111111111111');

select is((select res_street from public.customers where last_name = 'Person'), '99 New Rd',
    'a changed address updates the customer');
select is((select changes #>> '{res_street,old}' || ' -> ' || (changes #>> '{res_street,new}')
            from public.customer_audit_log where changes ? 'res_street'),
    '1 Test St -> 99 New Rd', 'and the audit row holds old and new');
select is((select source || '/' || changed_by::text from public.customer_audit_log where changes ? 'res_street'),
    'ttr_completion/a1111111-1111-1111-1111-111111111111', 'with source ttr_completion and the completing staff member');
select is((select res_street from ttr.parties where id = pg_temp.u('p_l1')), '1 Test St',
    'the earlier party copy is unchanged');
select is((select array_agg(alias order by sort_order) from public.customer_aliases ca
            join public.customers c on c.id = ca.customer_id where c.last_name = 'Person'),
    array['Nicky', 'Nic'], 'aliases are replaced when the party has any');
select is((select changes #> '{aliases,old}' from public.customer_audit_log where changes ? 'aliases')::text,
    '["Nick"]', 'and the alias change is audited');
select is((select count(*) from public.customer_audit_log), 3::bigint,
    'three audit rows in all: L2''s applied answers, L3''s column changes, and L3''s alias replacement');
select is((select first_name || ' ' || last_name from public.customers where last_name ilike 'person' and reporting_entity_id = '11111111-1111-1111-1111-111111111111'),
    'Newbie Person', 'a name differing only in case keeps the customer''s spelling (L2 typed "newbie PERSON")');

-- ── L4: a customer picked from search is already linked ───────────────────────────────
select pg_temp.mk_tx('l4', '11111111-1111-1111-1111-111111111111', 'draft', 'a1111111-1111-1111-1111-111111111111');
select pg_temp.mk_ind('p_l4', 'l4', 'Newbie', 'Person', '1992-02-02');
update ttr.parties set customer_id = (select id from public.customers where last_name = 'Person'), occupation = 'Baker'
 where id = pg_temp.u('p_l4');
select ttr.complete_transaction(pg_temp.u('l4'), 'a1111111-1111-1111-1111-111111111111');
select is((select occupation from public.customers where last_name = 'Person'), 'Baker',
    'a party picked from search updates its customer on completion');

-- ── Companies ─────────────────────────────────────────────────────────────────────────
select pg_temp.mk_tx('l5', '11111111-1111-1111-1111-111111111111', 'draft', 'a1111111-1111-1111-1111-111111111111');
select pg_temp.mk_co('p_l5', 'l5', 'Zed Corp', '99 999 999 999');
select ttr.complete_transaction(pg_temp.u('l5'), 'a1111111-1111-1111-1111-111111111111');
select pg_temp.mk_tx('l6', '11111111-1111-1111-1111-111111111111', 'draft', 'a1111111-1111-1111-1111-111111111111');
select pg_temp.mk_co('p_l6', 'l6', 'ZED CORP', '99999999999');
select ttr.complete_transaction(pg_temp.u('l6'), 'a1111111-1111-1111-1111-111111111111');
select is((select count(*) from public.customers where customer_type = 'company'), 1::bigint,
    'a company party creates a company customer, and the same ABN (spaces differ) links to it');
select is((select count(distinct customer_id) || '/' || count(customer_id) from ttr.parties
            where id in (pg_temp.u('p_l5'), pg_temp.u('p_l6'))), '1/2', 'both company copies are linked');

-- ── Another entity gets its own customer ──────────────────────────────────────────────
select pg_temp.mk_tx('l7', '22222222-2222-2222-2222-222222222222', 'draft', 'a2222222-2222-2222-2222-222222222222');
select pg_temp.mk_ind('p_l7', 'l7', 'Newbie', 'Person', '1992-02-02');
select ttr.complete_transaction(pg_temp.u('l7'), 'a2222222-2222-2222-2222-222222222222');
select is((select count(*) from public.customers where last_name = 'Person'), 2::bigint,
    'the same name + DOB in another entity is a separate customer');
select is((select reporting_entity_id from public.customers c join ttr.parties p on p.customer_id = c.id
            where p.id = pg_temp.u('p_l7')), '22222222-2222-2222-2222-222222222222'::uuid,
    'owned by that entity');

-- ── A linking failure stops the completion ────────────────────────────────────────────
create function public.test_boom() returns trigger language plpgsql as $$
begin raise exception 'boom: customer insert refused' using errcode = 'P0001'; end $$;
create trigger trg_test_boom before insert on public.customers
    for each row when (new.last_name = 'Boom') execute function public.test_boom();

select pg_temp.mk_tx('l8', '11111111-1111-1111-1111-111111111111', 'draft', 'a1111111-1111-1111-1111-111111111111');
select pg_temp.mk_ind('p_l8', 'l8', 'Bad', 'Boom', '1990-01-01');
select throws_ok(
    $$select ttr.complete_transaction(pg_temp.u('l8'), 'a1111111-1111-1111-1111-111111111111')$$,
    'P0001', 'boom: customer insert refused', 'if linking fails, completion fails');
select is((select status::text from ttr.transactions where id = pg_temp.u('l8')), 'draft',
    'and the transaction stays a draft');
select is((select count(*) from ttr.transaction_audit_log where transaction_id = pg_temp.u('l8')), 0::bigint,
    'with no completion audit row');

-- ── Locking, grants ───────────────────────────────────────────────────────────────────
select cmp_ok((select count(*) from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()),
    '>', 0::bigint, 'linking takes advisory locks (held to the end of the completing transaction)');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        $$select public._link_transaction_customers(md5('l1')::uuid, null)$$),
    'err:42501', 'the browser cannot call the link function');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2', 'select public._backfill_customers()'),
    'err:42501', 'the browser cannot call the backfill');
select is(pg_temp.dml_as(null, 'aal2', 'select public._backfill_customers()', 'anon'),
    'err:42501', 'anon cannot call the backfill');

select * from finish();
rollback;
