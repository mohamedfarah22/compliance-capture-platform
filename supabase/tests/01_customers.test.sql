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

select plan(34);

-- ── Customers fixture (inserted as the table owner, as service-role code would) ───────
insert into public.customers
    (id, reporting_entity_id, customer_type, source, first_name, middle_name, last_name, date_of_birth, phone)
values
    ('c1000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'individual', 'ttr',
        'JANE', 'Mary  Ann', 'Citizen', '1985-06-15', '+61 412 345 678'),
    ('c1000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'individual', 'gold',
        'Bob', '', 'Builder', '1970-01-01', null),
    ('c1000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'individual', 'ttr',
        'Sam', null, 'Landline', '1980-03-03', '(03) 9123 4567'),
    ('c2000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'individual', 'ttr',
        'Eve', null, 'Other', '1990-02-02', '0499 111 222');

insert into public.customer_aliases (customer_id, alias) values
    ('c1000000-0000-0000-0000-000000000001', 'Janey'),
    ('c2000000-0000-0000-0000-000000000001', 'Evie');

-- ── Generated search columns ──────────────────────────────────────────────────────────
select is((select name_search from public.customers where id = 'c1000000-0000-0000-0000-000000000001'),
    'jane mary ann citizen', 'name_search is lower case and collapses repeated spaces');
select is((select name_search from public.customers where id = 'c1000000-0000-0000-0000-000000000002'),
    'bob builder', 'name_search has no gap for an empty middle name');
select is((select name_search from public.customers where id = 'c1000000-0000-0000-0000-000000000003'),
    'sam landline', 'name_search has no gap for a null middle name');
select is((select phone_digits from public.customers where id = 'c1000000-0000-0000-0000-000000000001'),
    '0412345678', 'phone_digits: +61 412 345 678 becomes 0412345678');
select is((select phone_digits from public.customers where id = 'c1000000-0000-0000-0000-000000000003'),
    '0391234567', 'phone_digits: (03) 9123 4567 keeps its leading 0');
select is((select phone_digits from public.customers where id = 'c1000000-0000-0000-0000-000000000002'),
    null, 'phone_digits is null when there is no phone');
select has_index('public', 'customers', 'idx_customers_name_trgm', 'trigram index on name_search exists');

-- ── Constraints ───────────────────────────────────────────────────────────────────────
select throws_ok(
    $$insert into public.customers (reporting_entity_id, customer_type, source, first_name)
      values ('11111111-1111-1111-1111-111111111111', 'individual', 'ttr', 'NoLast')$$,
    '23514', null, 'an individual customer needs first and last name');
select throws_ok(
    $$insert into public.customers (reporting_entity_id, customer_type, source, entity_name)
      values ('11111111-1111-1111-1111-111111111111', 'company', 'ttr', 'No Reg Pty Ltd')$$,
    '23514', null, 'a company customer needs a registration identifier');
select throws_ok(
    $$insert into public.customers (reporting_entity_id, customer_type, source, first_name, last_name)
      values ('11111111-1111-1111-1111-111111111111', 'individual', 'import', 'A', 'B')$$,
    '23514', null, 'source must be gold or ttr');

-- ── RLS: the browser reads its own entity and nothing else ────────────────────────────
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        'select count(*) as n from public.customers')->0->>'n',
    '3', 'staff in entity one see the 3 customers of entity one');
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        $$select count(*) as n from public.customers where reporting_entity_id <> '11111111-1111-1111-1111-111111111111'$$)->0->>'n',
    '0', 'another entity''s customers are invisible');
select is(pg_temp.q_as('a2222222-2222-2222-2222-222222222222', 'aal2',
        'select count(*) as n from public.customers')->0->>'n',
    '1', 'staff in entity two see only entity two''s customer');
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal1',
        'select count(*) as n from public.customers')->0->>'n',
    '0', 'a password-only (aal1) session sees no customers');
select is(pg_temp.q_as(null, 'aal2', 'select 1 from public.customers', 'anon')->>'sqlstate',
    '42501', 'anon has no access to customers');

select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        $$insert into public.customers (reporting_entity_id, customer_type, source, first_name, last_name)
          values ('11111111-1111-1111-1111-111111111111', 'individual', 'gold', 'New', 'Person')$$),
    'err:42501', 'the browser cannot insert a customer');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        $$update public.customers set occupation = 'Hacker' where reporting_entity_id = '11111111-1111-1111-1111-111111111111'$$),
    'err:42501', 'the browser cannot update a customer');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        'delete from public.customers'),
    'err:42501', 'the browser cannot delete a customer');

select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        'select alias from public.customer_aliases order by alias')::text,
    '[{"alias": "Janey"}]', 'staff see their own entity''s aliases only');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        $$insert into public.customer_aliases (customer_id, alias) values ('c1000000-0000-0000-0000-000000000001', 'X')$$),
    'err:42501', 'the browser cannot insert an alias');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        $$update public.customer_aliases set alias = 'X'$$),
    'err:42501', 'the browser cannot update an alias');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        'delete from public.customer_aliases'),
    'err:42501', 'the browser cannot delete an alias');

-- ── Audit log ─────────────────────────────────────────────────────────────────────────
do $$ begin
    perform set_config('app.actor_staff_id', 'a1111111-1111-1111-1111-111111111111', true);
    perform set_config('app.change_source', 'gold_edit', true);
end $$;
update public.customers set occupation = 'Welder', phone = '0400 000 000'
 where id = 'c1000000-0000-0000-0000-000000000001';

select is((select changed_by from public.customer_audit_log where customer_id = 'c1000000-0000-0000-0000-000000000001'),
    'a1111111-1111-1111-1111-111111111111'::uuid, 'the audit row records app.actor_staff_id');
select is((select source from public.customer_audit_log where customer_id = 'c1000000-0000-0000-0000-000000000001'),
    'gold_edit', 'the audit row records app.change_source');
select is((select changes from public.customer_audit_log where customer_id = 'c1000000-0000-0000-0000-000000000001')
        #>> '{occupation,new}',
    'Welder', 'the audit row holds old and new values (new)');
select ok((select changes from public.customer_audit_log where customer_id = 'c1000000-0000-0000-0000-000000000001')
        -> 'occupation' ? 'old'
    and not ((select changes from public.customer_audit_log where customer_id = 'c1000000-0000-0000-0000-000000000001')
        ?| array['updated_at', 'name_search', 'phone_digits']),
    'old is present, and generated or bookkeeping columns are not logged');

-- no actor setting and no source: falls back to auth.uid(), and records a NULL source
do $$ begin
    perform set_config('app.actor_staff_id', '', true);
    perform set_config('app.change_source', '', true);
    perform set_config('request.jwt.claims', '{"sub":"a2222222-2222-2222-2222-222222222222","aal":"aal2"}', true);
end $$;
update public.customers set occupation = 'Painter' where id = 'c2000000-0000-0000-0000-000000000001';
do $$ begin perform set_config('request.jwt.claims', '', true); end $$;

select is((select changed_by from public.customer_audit_log where customer_id = 'c2000000-0000-0000-0000-000000000001'),
    'a2222222-2222-2222-2222-222222222222'::uuid, 'without app.actor_staff_id the actor is the staff member for auth.uid()');
select is((select source from public.customer_audit_log where customer_id = 'c2000000-0000-0000-0000-000000000001'),
    null, 'an unlabelled update is logged with a NULL source rather than blocked');

update public.customers set first_name = first_name where id = 'c1000000-0000-0000-0000-000000000002';
select is((select count(*) from public.customer_audit_log where customer_id = 'c1000000-0000-0000-0000-000000000002'),
    0::bigint, 'a no-op update writes no audit row');

select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        'select count(*) as n from public.customer_audit_log')->0->>'n',
    '1', 'staff see only their own entity''s audit rows');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        $$insert into public.customer_audit_log (customer_id, reporting_entity_id, changes)
          values ('c1000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '{}')$$),
    'err:42501', 'the browser cannot write audit rows');

select throws_like(
    $$update public.customer_audit_log set source = null$$,
    'Audit log is append-only%', 'audit rows cannot be updated');
select throws_like(
    $$delete from public.customer_audit_log$$,
    'Audit log is append-only%', 'audit rows cannot be deleted');
select is(pg_temp.dml_as(null, 'aal2', 'update public.customer_audit_log set source = null', 'service_role'),
    'err:P0001', 'audit rows cannot be updated even by the service role');

select * from finish();
rollback;
