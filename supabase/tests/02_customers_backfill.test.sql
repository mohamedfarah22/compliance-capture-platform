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

select plan(29);

-- ── Seeded history ─────────────────────────────────────────────────────────────────────
-- Entity one: Jane Citizen across 3 TTRs. The copy with an alias is the OLDEST, so the
-- result only comes out right if the alias tiebreak beats "newest updated_at".
select pg_temp.mk_tx('t1', '11111111-1111-1111-1111-111111111111', 'complete', 'a1111111-1111-1111-1111-111111111111');
select pg_temp.mk_tx('t2', '11111111-1111-1111-1111-111111111111', 'complete', 'a1111111-1111-1111-1111-111111111111');
select pg_temp.mk_tx('t3', '11111111-1111-1111-1111-111111111111', 'complete', 'a1111111-1111-1111-1111-111111111111');
select pg_temp.mk_ind('jane1', 't1', 'Jane', 'Citizen', '1985-06-15', '2026-01-01', true, 'Janey', '0411 111 111',
    'Aliased occ', 'Sole trader', 'PO Box 1');
select pg_temp.mk_ind('jane2', 't2', 'jane', 'CITIZEN', '1985-06-15', '2026-02-01', true, null, '0422 222 222', 'Newer occ');
select pg_temp.mk_ind('jane3', 't3', 'Jane', 'Citizen', '1985-06-15', '2026-03-01', true, null, '0433 333 333', 'Newest occ');

-- Same name, different date of birth: two people.
select pg_temp.mk_tx('t4', '11111111-1111-1111-1111-111111111111');
select pg_temp.mk_tx('t5', '11111111-1111-1111-1111-111111111111');
select pg_temp.mk_ind('john1', 't4', 'John', 'Smith', '1980-01-01');
select pg_temp.mk_ind('john2', 't5', 'John', 'Smith', '1981-01-01');

-- Same name and DOB as Jane, in another entity: a separate customer.
select pg_temp.mk_tx('t6', '22222222-2222-2222-2222-222222222222');
select pg_temp.mk_ind('janeE2', 't6', 'Jane', 'Citizen', '1985-06-15');

-- A company written two ways: the ABN with and without spaces.
select pg_temp.mk_tx('t7', '11111111-1111-1111-1111-111111111111');
select pg_temp.mk_tx('t8', '11111111-1111-1111-1111-111111111111');
select pg_temp.mk_co('acme1', 't7', 'ACME Pty Ltd', '12 345 678 901', '2026-01-01');
select pg_temp.mk_co('acme2', 't8', 'Acme Pty Ltd', '12345678901', '2026-02-01');

-- Not linked: a party that is not complete, and a complete party on a draft.
select pg_temp.mk_tx('t9', '11111111-1111-1111-1111-111111111111');
select pg_temp.mk_ind('inc1', 't9', 'Ina', 'Incomplete', '1990-01-01', '2026-01-01', false);
select pg_temp.mk_tx('d1', '11111111-1111-1111-1111-111111111111', 'draft', 'a1111111-1111-1111-1111-111111111111');
select pg_temp.mk_ind('draft1', 'd1', 'Dora', 'Draft', '1990-01-01');

-- No date of birth: grouped together, as search groups them today.
select pg_temp.mk_tx('t10', '11111111-1111-1111-1111-111111111111');
select pg_temp.mk_tx('t11', '11111111-1111-1111-1111-111111111111');
select pg_temp.mk_ind('nodob1', 't10', 'Pat', 'Nodob', null);
select pg_temp.mk_ind('nodob2', 't11', 'Pat', 'Nodob', null);

-- ── Run ────────────────────────────────────────────────────────────────────────────────
select is(public._backfill_customers(), 6,
    'creates one customer per search key: Jane (x2 entities), John (x2 DOBs), ACME, Pat');

-- one person across 3 TTRs
select is((select count(*) from public.customers
            where reporting_entity_id = '11111111-1111-1111-1111-111111111111' and last_name = 'Citizen'),
    1::bigint, 'one person across 3 TTRs (names differing in case) becomes 1 customer');
select is((select phone from public.customers where reporting_entity_id = '11111111-1111-1111-1111-111111111111' and last_name = 'Citizen'),
    '0411 111 111', 'the customer takes its phone from the aliased copy, though it is the oldest');
select is((select occupation from public.customers where reporting_entity_id = '11111111-1111-1111-1111-111111111111' and last_name = 'Citizen'),
    'Aliased occ', 'and its occupation');
select is((select array_agg(ca.alias) from public.customer_aliases ca
            join public.customers c on c.id = ca.customer_id
            where c.reporting_entity_id = '11111111-1111-1111-1111-111111111111' and c.last_name = 'Citizen'),
    array['Janey'], 'aliases are copied');
select is((select is_sole_trader from public.customers where reporting_entity_id = '11111111-1111-1111-1111-111111111111' and last_name = 'Citizen'),
    true, 'a Sole trader legal form becomes is_sole_trader');
select is((select post_street from public.customers where reporting_entity_id = '11111111-1111-1111-1111-111111111111' and last_name = 'Citizen'),
    'PO Box 1', 'the postal address is copied');
select is((select count(distinct customer_id) || '/' || count(customer_id) from ttr.parties
            where id in (pg_temp.u('jane1'), pg_temp.u('jane2'), pg_temp.u('jane3'))),
    '1/3', 'all three party copies point at the same customer');
select is((select source || '/' || created_by_staff_id::text from public.customers
            where reporting_entity_id = '11111111-1111-1111-1111-111111111111' and last_name = 'Citizen'),
    'ttr/a1111111-1111-1111-1111-111111111111', 'source is ttr and the creator is the TTR''s staff member');

-- same name, different DOB
select is((select count(*) from public.customers where last_name = 'Smith'),
    2::bigint, 'same name with a different DOB gives 2 customers');

-- same name + DOB in two entities
select is((select count(distinct reporting_entity_id) from public.customers where last_name = 'Citizen'),
    2::bigint, 'the same name + DOB in two entities gives 2 customers');
select is((select c.reporting_entity_id from ttr.parties p join public.customers c on c.id = p.customer_id
            where p.id = pg_temp.u('janeE2')),
    '22222222-2222-2222-2222-222222222222'::uuid, 'a party is linked to a customer of its own entity');

-- company key
select is((select count(*) from public.customers where customer_type = 'company'),
    1::bigint, 'ACME with ABN "12 345 678 901" and "12345678901" is 1 customer');
select is((select count(distinct customer_id) || '/' || count(customer_id) from ttr.parties
            where id in (pg_temp.u('acme1'), pg_temp.u('acme2'))),
    '1/2', 'both ACME copies are linked');
select is((select entity_name || '/' || reg_identifier from public.customers where customer_type = 'company'),
    'Acme Pty Ltd/12345678901', 'the company takes its fields from the newest copy (neither has aliases)');

-- not linked
select is((select customer_id from ttr.parties where id = pg_temp.u('inc1')),
    null, 'an incomplete party is not linked');
select is((select customer_id from ttr.parties where id = pg_temp.u('draft1')),
    null, 'a party on a draft transaction is not linked');
select is((select count(*) from public.customers where last_name in ('Incomplete', 'Draft')),
    0::bigint, 'and neither creates a customer');

-- no date of birth
select is((select count(*) from public.customers where last_name = 'Nodob'),
    1::bigint, 'parties with no DOB and the same name are one customer');

-- coverage
select is((select count(*) from ttr.parties p join ttr.transactions t on t.id = p.transaction_id
            where t.status = 'complete' and p.is_complete and p.customer_id is null),
    0::bigint, 'afterwards 0 completed parties have a null customer_id');

-- re-run
select is(public._backfill_customers(), 0, 'running it again creates nothing');
select is((select count(*) from public.customers), 6::bigint, 'and the customer count is unchanged');

select pg_temp.mk_tx('t12', '11111111-1111-1111-1111-111111111111');
select pg_temp.mk_ind('jane4', 't12', 'JANE', 'citizen', '1985-06-15', '2026-04-01');
select is(public._backfill_customers(), 0, 'a later unlinked copy of a known person creates no customer');
select is((select c.last_name from ttr.parties p join public.customers c on c.id = p.customer_id where p.id = pg_temp.u('jane4')),
    'Citizen', 'it is linked to the existing customer');

-- ── Cross-tenant guard on ttr.parties.customer_id ─────────────────────────────────────
select throws_ok(
    $$insert into ttr.parties (transaction_id, party_type, first_name, last_name, customer_id)
      values (pg_temp.u('t1'), 'individual', 'X', 'Y',
              (select id from public.customers where reporting_entity_id = '22222222-2222-2222-2222-222222222222'))$$,
    '23514', null, 'a party cannot be inserted with another entity''s customer_id');
select throws_ok(
    $$update ttr.parties set customer_id =
        (select id from public.customers where reporting_entity_id = '22222222-2222-2222-2222-222222222222')
      where id = pg_temp.u('jane2')$$,
    '23514', null, 'a party cannot be updated to another entity''s customer_id');
select lives_ok(
    $$update ttr.parties set customer_id =
        (select id from public.customers where reporting_entity_id = '11111111-1111-1111-1111-111111111111' and last_name = 'Smith' and date_of_birth = '1980-01-01')
      where id = pg_temp.u('john2')$$,
    'a party can be linked to a customer of its own entity');
-- The id is spliced in as a literal: the browser cannot SELECT the other entity's customer,
-- but it can still guess or leak an id and send it.
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        format($$insert into ttr.parties (transaction_id, party_type, first_name, last_name, customer_id)
          values (md5('d1')::uuid, 'individual', 'Browser', 'Link', %L)$$,
          (select id from public.customers where reporting_entity_id = '22222222-2222-2222-2222-222222222222'))),
    'err:23514', 'the browser cannot link its draft party to another entity''s customer');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        $$insert into ttr.parties (transaction_id, party_type, first_name, last_name, customer_id)
          values (md5('d1')::uuid, 'individual', 'Browser', 'Link',
                  (select id from public.customers where reporting_entity_id = '11111111-1111-1111-1111-111111111111' and last_name = 'Smith' limit 1))$$),
    'ok:1', 'the browser can link its draft party to its own entity''s customer');

select * from finish();
rollback;
