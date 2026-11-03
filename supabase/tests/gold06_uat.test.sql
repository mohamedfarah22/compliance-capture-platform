-- Gold Phase 6 UAT (docs/uat-gold-06-customer-writes.md), database layer: grants on the write functions,
-- no direct browser writes, entity-scoped reads, append-only audit, no client update/delete of customer
-- ID captures and photos, and the current-ID rule. Run as the real roles with a JWT `aal` claim.
-- (The edge functions end to end are in app/e2e/gold06.)

begin;
create extension if not exists pgtap with schema extensions;

-- pg_temp.dml_as: run a statement as a role, return 'ok:<rows>' or 'err:<sqlstate>' (see 05_gold_rls.test.sql).
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

create function pg_temp.n_as(p_uid uuid, p_aal text, p_sql text, p_role text default 'authenticated')
returns int language plpgsql as $$
declare v int;
begin
    perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role, 'aal', p_aal)::text, true);
    execute format('set local role %I', p_role);
    begin
        execute 'select count(*)::int from (' || p_sql || ') t' into v;
    exception when others then
        reset role;
        perform set_config('request.jwt.claims', '', true);
        return -1;
    end;
    reset role;
    perform set_config('request.jwt.claims', '', true);
    return v;
end $$;

create function pg_temp.u(p_label text) returns uuid language sql immutable as $$ select md5(p_label)::uuid $$;

insert into public.reporting_entities (id, legal_name) values
    ('11111111-1111-1111-1111-111111111111', 'Entity One'),
    ('22222222-2222-2222-2222-222222222222', 'Entity Two');
insert into auth.users (id, email) values
    ('a1111111-1111-1111-1111-111111111111', 'staff1@entity-one.test'),
    ('a1111111-1111-1111-1111-111111111112', 'manager1@entity-one.test'),
    ('a2222222-2222-2222-2222-222222222223', 'manager2@entity-two.test');
insert into public.staff_members (id, reporting_entity_id, full_name, email, role) values
    ('a1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'Staff One',   'staff1@entity-one.test',   'staff'),
    ('a1111111-1111-1111-1111-111111111112', '11111111-1111-1111-1111-111111111111', 'Manager One', 'manager1@entity-one.test', 'manager'),
    ('a2222222-2222-2222-2222-222222222223', '22222222-2222-2222-2222-222222222222', 'Manager Two', 'manager2@entity-two.test', 'manager');

-- A customer of Entity One with two captures (the second newer) and a front photo each, plus an audit row.
insert into public.customers (id, reporting_entity_id, customer_type, source, first_name, last_name, date_of_birth, phone,
                              res_street, res_suburb, res_state, res_postcode)
values (pg_temp.u('c1'), '11111111-1111-1111-1111-111111111111', 'individual', 'gold', 'Ivy', 'Uatsix', '1980-01-01', '0400 000 001',
        '1 Test St', 'Coburg', 'VIC', '3058');
insert into ttr.stored_images (id, customer_id, object_path, content_hash_sha256, captured_by_staff_id) values
    (pg_temp.u('img1'), pg_temp.u('c1'), 'customers/' || pg_temp.u('c1') || '/v1/front-a.jpg', 'h1', 'a1111111-1111-1111-1111-111111111111'),
    (pg_temp.u('img2'), pg_temp.u('c1'), 'customers/' || pg_temp.u('c1') || '/v2/front-b.jpg', 'h2', 'a1111111-1111-1111-1111-111111111111');
insert into ttr.id_verifications (id, customer_id, verification_method, document_type, document_number, issuer, id_country_code,
                                  has_expiry, verification_description, is_complete, front_image_id, created_at)
values
    (pg_temp.u('v1'), pg_temp.u('c1'), 'Sighted original document', 'Passport', 'UAT6-OLD', 'AU', 'AU', false, 'x', true, pg_temp.u('img1'), '2026-01-01'),
    (pg_temp.u('v2'), pg_temp.u('c1'), 'Sighted original document', 'Passport', 'UAT6-NEW', 'AU', 'AU', false, 'x', true, pg_temp.u('img2'), '2026-02-01');
insert into public.customer_audit_log (customer_id, reporting_entity_id, changed_by, source, changes)
values (pg_temp.u('c1'), '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111112', 'gold_edit',
        '{"first_name":{"old":"A","new":"Ivy"}}');

select plan(32);

-- ─── 6.12 / 6.81 · the write functions are for the service role only ─────────────────────────
select is(
    (select count(*)::int from information_schema.routine_privileges
      where routine_schema = 'public'
        and routine_name in ('gold_create_customer', 'gold_update_customer_id', 'gold_update_customer', '_gold_assert_staff')
        and grantee in ('anon', 'authenticated', 'PUBLIC')),
    0, '6.81 no routine privilege on the write functions for anon, authenticated or PUBLIC');
select is(
    (select count(*)::int from information_schema.routine_privileges
      where routine_schema = 'public' and grantee = 'service_role'
        and routine_name in ('gold_create_customer', 'gold_update_customer_id', 'gold_update_customer', '_gold_assert_staff')),
    4, '6.81 the service role holds execute on all four');
select is(
    pg_temp.dml_as('a1111111-1111-1111-1111-111111111112', 'aal2',
        $$select public.gold_update_customer('11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111112',
            '$$ || pg_temp.u('c1') || $$', '{"first_name":"Hacked"}'::jsonb)$$),
    'err:42501', '6.12 a signed-in manager calling gold_update_customer is permission denied');
select is(
    pg_temp.dml_as('a1111111-1111-1111-1111-111111111112', 'aal2',
        $$select public._gold_assert_staff('11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111112')$$),
    'err:42501', '6.12 _gold_assert_staff is permission denied for a signed-in user');
select is(
    pg_temp.dml_as(null, 'aal1', $$select public.gold_update_customer('11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111112', '$$ || pg_temp.u('c1') || $$', '{}'::jsonb)$$, 'anon'),
    'err:42501', '6.12 anon calling gold_update_customer is permission denied');
select is((select first_name from public.customers where id = pg_temp.u('c1')), 'Ivy', '6.12 the customer was not changed');

-- The service role can run it (what the edge function does), and the audit trigger names the actor.
select is(
    pg_temp.dml_as(null, 'aal2',
        $$select public.gold_update_customer('11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111112',
            '$$ || pg_temp.u('c1') || $$', '{"first_name":"Ivana"}'::jsonb)$$, 'service_role'),
    'ok:1', '6.12 the service role may call gold_update_customer');
select is((select changed_by from public.customer_audit_log where customer_id = pg_temp.u('c1') and source = 'gold_edit' order by changed_at desc, id desc limit 1),
    'a1111111-1111-1111-1111-111111111112'::uuid, '6.102 the audit row names the staff member the function was given');
select throws_ok(
    $$select public.gold_update_customer('11111111-1111-1111-1111-111111111111', 'a2222222-2222-2222-2222-222222222223',
        '$$ || pg_temp.u('c1') || $$', '{"first_name":"Cross"}'::jsonb)$$,
    '42501', 'forbidden', '6.11 a staff member of another business, passed as the actor, is refused by the SQL function itself');

-- ─── 6.13 · no direct writes from the browser role ───────────────────────────────────────────
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111112', 'aal2',
    $$insert into public.customers (reporting_entity_id, customer_type, source, first_name, last_name) values ('11111111-1111-1111-1111-111111111111', 'individual', 'gold', 'Direct', 'Uatsix')$$),
    'err:42501', '6.13 manager cannot insert a customer');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111112', 'aal2',
    $$update public.customers set first_name = 'Direct' where id = '$$ || pg_temp.u('c1') || $$'$$),
    'err:42501', '6.13 manager cannot update a customer');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111112', 'aal2',
    $$delete from public.customers where id = '$$ || pg_temp.u('c1') || $$'$$),
    'err:42501', '6.13 manager cannot delete a customer');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111112', 'aal2',
    $$insert into public.customer_aliases (customer_id, alias) values ('$$ || pg_temp.u('c1') || $$', 'Direct')$$),
    'err:42501', '6.13 manager cannot insert an alias');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111112', 'aal2',
    $$insert into public.customer_audit_log (customer_id, reporting_entity_id, source, changes) values ('$$ || pg_temp.u('c1') || $$', '11111111-1111-1111-1111-111111111111', 'gold_edit', '{}')$$),
    'err:42501', '6.13 manager cannot insert an audit row');

-- ─── 6.14 / 6.157 · reads are scoped to the business, and to aal2 ───────────────────────────
select is(pg_temp.n_as('a1111111-1111-1111-1111-111111111111', 'aal2', $$select 1 from public.customers where last_name = 'Uatsix'$$), 1, '6.14 staff of Entity One see their customer');
select is(pg_temp.n_as('a2222222-2222-2222-2222-222222222223', 'aal2', $$select 1 from public.customers where last_name = 'Uatsix'$$), 0, '6.14 a manager of Entity Two sees none');
select is(pg_temp.n_as('a1111111-1111-1111-1111-111111111111', 'aal2', $$select 1 from ttr.stored_images where customer_id = '$$ || pg_temp.u('c1') || $$'$$), 2, '6.157 staff of Entity One read their customer’s photo rows');
select is(pg_temp.n_as('a2222222-2222-2222-2222-222222222223', 'aal2', $$select 1 from ttr.stored_images where customer_id = '$$ || pg_temp.u('c1') || $$'$$), 0, '6.157 Entity Two reads none of them');
select is(pg_temp.n_as('a1111111-1111-1111-1111-111111111111', 'aal1', $$select 1 from ttr.stored_images where customer_id = '$$ || pg_temp.u('c1') || $$'$$), 0, '6.157 a password-only session reads none of them');
select is(pg_temp.n_as('a2222222-2222-2222-2222-222222222223', 'aal2', $$select 1 from ttr.id_verifications where customer_id = '$$ || pg_temp.u('c1') || $$'$$), 0, '6.157 Entity Two reads none of the captures');
select is(pg_temp.n_as('a2222222-2222-2222-2222-222222222223', 'aal2', $$select 1 from public.customer_audit_log where customer_id = '$$ || pg_temp.u('c1') || $$'$$), 0, '6.157 Entity Two reads none of the audit rows');

-- ─── 6.155 · the customer audit log is append-only ──────────────────────────────────────────
select throws_ok($$update public.customer_audit_log set source = 'gold_create'$$, 'P0001', null, '6.155 an update of the audit log is refused even for the owner role');
select throws_ok($$delete from public.customer_audit_log$$, 'P0001', null, '6.155 a delete from the audit log is refused even for the owner role');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111112', 'aal2', $$update public.customer_audit_log set source = 'gold_create'$$), 'err:42501', '6.155 a manager cannot update the audit log');
select is(pg_temp.dml_as('a1111111-1111-1111-1111-111111111112', 'aal2', $$delete from public.customer_audit_log$$), 'err:42501', '6.155 a manager cannot delete from the audit log');

-- ─── 6.156 · no client update or delete of customer photos and captures ─────────────────────
select isnt(pg_temp.dml_as('a1111111-1111-1111-1111-111111111112', 'aal2', $$update ttr.stored_images set content_hash_sha256 = 'x' where customer_id = '$$ || pg_temp.u('c1') || $$'$$), 'ok:1', '6.156 a manager cannot update a customer photo row');
select isnt(pg_temp.dml_as('a1111111-1111-1111-1111-111111111112', 'aal2', $$delete from ttr.stored_images where customer_id = '$$ || pg_temp.u('c1') || $$'$$), 'ok:1', '6.156 a manager cannot delete a customer photo row');
select isnt(pg_temp.dml_as('a1111111-1111-1111-1111-111111111112', 'aal2', $$update ttr.id_verifications set document_number = 'X' where customer_id = '$$ || pg_temp.u('c1') || $$'$$), 'ok:1', '6.156 a manager cannot update a customer capture');
select isnt(pg_temp.dml_as('a1111111-1111-1111-1111-111111111112', 'aal2', $$delete from ttr.id_verifications where customer_id = '$$ || pg_temp.u('c1') || $$'$$), 'ok:1', '6.156 a manager cannot delete a customer capture');
select is((select count(*)::int from ttr.stored_images where customer_id = pg_temp.u('c1') and content_hash_sha256 in ('h1', 'h2')), 2, '6.156 the photo rows are as they were');
select is((select count(*)::int from ttr.id_verifications where customer_id = pg_temp.u('c1') and document_number in ('UAT6-OLD', 'UAT6-NEW')), 2, '6.156 the captures are as they were');

-- ─── 6.98 · the current ID is the newest capture ────────────────────────────────────────────
select is(
    pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2', $$select * from public.customer_current_id('$$ || pg_temp.u('c1') || $$')$$) -> 0 ->> 'document_number',
    'UAT6-NEW', '6.98 customer_current_id returns the newest capture');

select * from finish();
rollback;
