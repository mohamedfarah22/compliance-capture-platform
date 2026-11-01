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

select plan(26);

-- The OLD search functions, copied verbatim into pg_temp (individual: 20260715000001,
-- company: 20260717000001) under new names. The test builds party history, runs the
-- backfill, then asks old and new the same questions and expects the same people.
create function pg_temp.old_search_individual(
  p_first_name text DEFAULT NULL,
  p_last_name  text DEFAULT NULL,
  p_dob        date DEFAULT NULL
)
RETURNS TABLE (
  party_id      uuid,
  first_name    text,
  middle_name   text,
  last_name     text,
  date_of_birth date,
  gender        text,
  phone         text,
  email         text,
  occupation    text,
  res_street    text,
  res_suburb    text,
  res_state     text,
  res_postcode  text,
  res_country   text,
  aliases       text[]
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    m.id,
    m.first_name,
    m.middle_name,
    m.last_name,
    m.date_of_birth,
    m.gender,
    m.phone,
    m.email,
    m.occupation,
    m.res_street,
    m.res_suburb,
    m.res_state,
    m.res_postcode,
    m.res_country,
    COALESCE(
      (SELECT array_agg(pa.alias ORDER BY pa.sort_order) FROM ttr.party_aliases pa WHERE pa.party_id = m.id),
      ARRAY[]::text[]
    )
  FROM (
    SELECT DISTINCT ON (lower(p.last_name), lower(p.first_name), p.date_of_birth)
      p.id,
      p.first_name,
      p.middle_name,
      p.last_name,
      p.date_of_birth,
      p.gender,
      p.phone,
      p.email,
      p.occupation,
      p.res_street,
      p.res_suburb,
      p.res_state::text AS res_state,
      p.res_postcode,
      p.res_country
    FROM ttr.parties p
    JOIN ttr.transactions t ON t.id = p.transaction_id
    WHERE t.reporting_entity_id = public.reporting_entity_id()
      AND p.is_complete          = true
      AND p.party_type           = 'individual'
      AND (p_last_name  IS NULL OR p.last_name  ILIKE p_last_name  || '%')
      AND (p_first_name IS NULL OR p.first_name ILIKE p_first_name || '%')
      AND (p_dob        IS NULL OR p.date_of_birth = p_dob)
    ORDER BY lower(p.last_name), lower(p.first_name), p.date_of_birth,
      EXISTS (SELECT 1 FROM ttr.party_aliases pa WHERE pa.party_id = p.id) DESC,
      p.updated_at DESC,
      p.id
    LIMIT 20
  ) m;
$$;

create function pg_temp.old_search_company(
  p_entity_name    text DEFAULT NULL,
  p_reg_identifier text DEFAULT NULL,
  p_suburb         text DEFAULT NULL
)
RETURNS TABLE (
  party_id             uuid,
  entity_name          text,
  company_trading_name text,
  legal_form           text,
  reg_id_type          text,
  reg_identifier       text,
  company_phone        text,
  biz_street           text,
  biz_suburb           text,
  biz_state            text,
  biz_postcode         text,
  biz_country          text,
  aliases              text[],
  principal_activity   text,
  is_express_trust     boolean,
  trust_type_other     text,
  trust_name           text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    m.id,
    m.entity_name,
    m.company_trading_name,
    m.legal_form,
    m.reg_id_type,
    m.reg_identifier,
    m.company_phone,
    m.biz_street,
    m.biz_suburb,
    m.biz_state,
    m.biz_postcode,
    m.biz_country,
    COALESCE(
      (SELECT array_agg(pa.alias ORDER BY pa.sort_order) FROM ttr.party_aliases pa WHERE pa.party_id = m.id),
      ARRAY[]::text[]
    ),
    m.principal_activity,
    m.is_express_trust,
    m.trust_type_other,
    m.trust_name
  FROM (
    SELECT DISTINCT ON (lower(p.entity_name), replace(coalesce(p.reg_identifier, ''), ' ', ''))
      p.id,
      p.entity_name,
      p.company_trading_name,
      p.legal_form::text,
      p.reg_id_type::text,
      p.reg_identifier,
      p.company_phone,
      p.biz_street,
      p.biz_suburb,
      p.biz_state::text AS biz_state,
      p.biz_postcode,
      p.biz_country,
      p.principal_activity,
      p.is_express_trust,
      p.trust_type_other,
      p.trust_name
    FROM ttr.parties p
    JOIN ttr.transactions t ON t.id = p.transaction_id
    WHERE t.reporting_entity_id = public.reporting_entity_id()
      AND p.is_complete          = true
      AND p.party_type           = 'company'
      AND (
        p_entity_name IS NULL
        OR p.entity_name ILIKE p_entity_name || '%'
      )
      AND (
        p_reg_identifier IS NULL
        OR replace(coalesce(p.reg_identifier, ''), ' ', '') ILIKE replace(p_reg_identifier, ' ', '') || '%'
      )
      AND (
        p_suburb IS NULL
        OR p.biz_suburb   ILIKE p_suburb || '%'
        OR p.biz_postcode ILIKE p_suburb || '%'
      )
    ORDER BY lower(p.entity_name), replace(coalesce(p.reg_identifier, ''), ' ', ''),
      EXISTS (SELECT 1 FROM ttr.party_aliases pa WHERE pa.party_id = p.id) DESC,
      p.updated_at DESC,
      p.id
    LIMIT 20
  ) m;
$$;

-- Old and new results as jsonb. The new functions' extra columns are stripped so what is
-- left is exactly the old contract: same people, same fields, same order.
create function pg_temp.old_ind(f text, l text, d date) returns jsonb language sql as $$
    select coalesce(jsonb_agg(to_jsonb(o)), '[]'::jsonb) from pg_temp.old_search_individual(f, l, d) o $$;
create function pg_temp.new_ind(f text, l text, d date) returns jsonb language sql as $$
    select coalesce(jsonb_agg(to_jsonb(n) - array['customer_id', 'citizenship_country_code',
        'tax_residency_country_code', 'is_sole_trader', 'abn', 'business_trading_name', 'has_postal_address',
        'post_street', 'post_suburb', 'post_state', 'post_postcode', 'post_country']), '[]'::jsonb)
    from public.search_individual_customers(f, l, d) n $$;
create function pg_temp.old_co(n text, r text, s text) returns jsonb language sql as $$
    select coalesce(jsonb_agg(to_jsonb(o)), '[]'::jsonb) from pg_temp.old_search_company(n, r, s) o $$;
create function pg_temp.new_co(n text, r text, s text) returns jsonb language sql as $$
    select coalesce(jsonb_agg(to_jsonb(x) - array['customer_id', 'has_company_postal_address',
        'co_post_street', 'co_post_suburb', 'co_post_state', 'co_post_postcode', 'co_post_country']), '[]'::jsonb)
    from public.search_company_customers(n, r, s) x $$;

-- ── History for entity one (and one person in entity two) ─────────────────────────────
select pg_temp.mk_tx('s1', '11111111-1111-1111-1111-111111111111');
select pg_temp.mk_tx('s2', '11111111-1111-1111-1111-111111111111');
select pg_temp.mk_tx('s3', '11111111-1111-1111-1111-111111111111');
select pg_temp.mk_tx('s4', '11111111-1111-1111-1111-111111111111');
select pg_temp.mk_tx('s5', '11111111-1111-1111-1111-111111111111');
select pg_temp.mk_tx('s6', '11111111-1111-1111-1111-111111111111');
select pg_temp.mk_tx('s7', '11111111-1111-1111-1111-111111111111');
select pg_temp.mk_tx('s8', '11111111-1111-1111-1111-111111111111');
select pg_temp.mk_tx('s9', '11111111-1111-1111-1111-111111111111');
select pg_temp.mk_tx('sa', '11111111-1111-1111-1111-111111111111');
select pg_temp.mk_tx('sb', '11111111-1111-1111-1111-111111111111');
select pg_temp.mk_tx('sc', '11111111-1111-1111-1111-111111111111');
select pg_temp.mk_tx('se2', '22222222-2222-2222-2222-222222222222');

-- Jane Citizen: aliased copy is the oldest
select pg_temp.mk_ind('i1', 's1', 'Jane', 'Citizen', '1985-06-15', '2026-01-01', true, 'Janey', '0411 111 111', 'Aliased');
select pg_temp.mk_ind('i2', 's2', 'Jane', 'Citizen', '1985-06-15', '2026-02-01', true, null, '0422 222 222', 'Newer');
select pg_temp.mk_ind('i3', 's3', 'JANE', 'CITIZEN', '1985-06-15', '2026-03-01', true, null, '0433 333 333', 'Newest');
select pg_temp.mk_ind('i4', 's4', 'Jane', 'Citizenson', '1970-05-05', '2026-01-01');
select pg_temp.mk_ind('i5', 's5', 'Janet', 'Smith', '1990-09-09', '2026-01-01', true, null, '0455 555 555');
select pg_temp.mk_ind('i6', 's6', 'John', 'Smith', '1980-01-01', '2026-01-01');
select pg_temp.mk_ind('i7', 's7', 'John', 'Smith', '1981-01-01', '2026-01-01');
select pg_temp.mk_ind('i8', 's8', 'Zoe', 'Zander', null, '2026-01-01');
select pg_temp.mk_ind('i9', 's9', 'Sean', 'O''Brien', '1975-07-07', '2026-01-01');
select pg_temp.mk_ind('i10', 'sa', 'Same', 'Stamp', '1960-01-01', '2026-01-01', true, null, '0400 000 001');
select pg_temp.mk_ind('i11', 'sb', 'Same', 'Stamp', '1960-01-01', '2026-01-01', true, null, '0400 000 002');  -- identical updated_at: id breaks the tie
select pg_temp.mk_ind('iE2', 'se2', 'Jane', 'Citizen', '1985-06-15', '2026-01-01', true, null, '0499 999 999');

select pg_temp.mk_co('c1', 's1', 'ACME Pty Ltd', '12 345 678 901', '2026-01-01');
select pg_temp.mk_co('c2', 's2', 'Acme Pty Ltd', '12345678901', '2026-02-01');
select pg_temp.mk_co('c3', 's3', 'Acme Holdings', '98 765 432 109', '2026-01-01');
select pg_temp.mk_co('c4', 's4', 'Beta Trust', '55 555 555 555', '2026-01-01');
update ttr.parties set legal_form = 'Trust', is_express_trust = true, trust_name = 'Beta Family Trust',
    principal_activity = 'Trading' where id = pg_temp.u('c4');
select pg_temp.mk_co('c5', 's5', 'Gamma Pty Ltd', '11 111 111 111', '2026-01-01');
insert into ttr.party_aliases (party_id, alias) values (pg_temp.u('c5'), 'Gamma Trading');

do $$ begin
    perform public._backfill_customers();
    perform set_config('request.jwt.claims', '{"sub":"a1111111-1111-1111-1111-111111111111","aal":"aal2"}', true);
end $$;

-- ── Old vs new: 12 queries ─────────────────────────────────────────────────────────────
select is(pg_temp.new_ind(null, 'Citizen', null), pg_temp.old_ind(null, 'Citizen', null),
    'q1 individual by last name (3 copies, aliased one oldest)');
select is(pg_temp.new_ind('jan', 'cit', null), pg_temp.old_ind('jan', 'cit', null),
    'q2 individual by first + last prefix, mixed case');
select is(pg_temp.new_ind(null, 'Smith', null), pg_temp.old_ind(null, 'Smith', null),
    'q3 individual by last name, two DOBs');
select is(pg_temp.new_ind(null, 'Smith', '1981-01-01'), pg_temp.old_ind(null, 'Smith', '1981-01-01'),
    'q4 individual by last name + DOB');
select is(pg_temp.new_ind(null, null, '1980-01-01'), pg_temp.old_ind(null, null, '1980-01-01'),
    'q5 individual by DOB alone');
select is(pg_temp.new_ind('zoe', 'zander', null), pg_temp.old_ind('zoe', 'zander', null),
    'q6 individual with no DOB');
select is(pg_temp.new_ind(null, null, null), pg_temp.old_ind(null, null, null),
    'q7 individual, no filters (everyone, ordered)');
select is(pg_temp.new_ind(null, 'Sm%', null), pg_temp.old_ind(null, 'Sm%', null),
    'q8 individual with a wildcard in the term');
select is(pg_temp.new_ind('Sean', 'O''Brien', null), pg_temp.old_ind('Sean', 'O''Brien', null),
    'q9 individual with an apostrophe');
select is(pg_temp.new_ind('Same', 'Stamp', null), pg_temp.old_ind('Same', 'Stamp', null),
    'q10 two copies with identical updated_at resolve to the same one (id tiebreak)');
select is(pg_temp.new_ind('Nobody', 'Here', null), pg_temp.old_ind('Nobody', 'Here', null),
    'q11 individual with no match');
select is(pg_temp.new_co('acme', null, null), pg_temp.old_co('acme', null, null),
    'q12 company by name prefix');
select is(pg_temp.new_co(null, '12 345', null), pg_temp.old_co(null, '12 345', null),
    'q13 company by ABN with spaces');
select is(pg_temp.new_co(null, null, 'Bizville'), pg_temp.old_co(null, null, 'Bizville'),
    'q14 company by suburb');
select is(pg_temp.new_co(null, null, null), pg_temp.old_co(null, null, null),
    'q15 company, no filters (trust fields and aliases included)');
select is(pg_temp.new_co('Acme', '98765', '3000'), pg_temp.old_co('Acme', '98765', '3000'),
    'q16 company by name + ABN + postcode');

-- ── What the new functions add ─────────────────────────────────────────────────────────
select is((select count(*) from public.search_individual_customers('Jane', 'Citizen', '1985-06-15')), 1::bigint,
    'Jane Citizen is one result, not three');
select is((select r.customer_id from public.search_individual_customers('Jane', 'Citizen', '1985-06-15') r),
    (select customer_id from ttr.parties where id = pg_temp.u('i3')), 'customer_id is the linked customer');

-- A gold-created customer has no party: TTR search must still find it.
insert into public.customers (id, reporting_entity_id, customer_type, source, first_name, last_name, date_of_birth, phone)
values ('c9000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'individual', 'gold',
        'Gwen', 'Goldonly', '1999-09-09', '0412 000 000');
insert into public.customers (id, reporting_entity_id, customer_type, source, entity_name, reg_identifier, reg_id_type, biz_suburb)
values ('c9000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'company', 'gold',
        'Goldonly Pty Ltd', '77 777 777 777', 'ABN', 'Goldville');
select is((select r.customer_id::text || '/' || coalesce(r.party_id::text, 'no party')
            from public.search_individual_customers('Gwen', 'Goldonly', null) r),
    'c9000000-0000-0000-0000-000000000001/no party', 'TTR search finds a gold-created customer that has no party');
select is((select r.customer_id::text || '/' || coalesce(r.party_id::text, 'no party')
            from public.search_company_customers('Goldonly', '77777', null) r),
    'c9000000-0000-0000-0000-000000000002/no party', 'and a gold-created company');

-- new fields round-trip
update public.customers set citizenship_country_code = 'NZ', tax_residency_country_code = 'AU', is_sole_trader = true,
    abn = '11223344556', has_postal_address = true, post_street = '5 Post St', post_suburb = 'Postville',
    post_state = 'NSW', post_postcode = '2000', post_country = 'Australia'
 where id = 'c9000000-0000-0000-0000-000000000001';
select is((select jsonb_build_array(citizenship_country_code, tax_residency_country_code, is_sole_trader, abn,
                has_postal_address, post_street, post_suburb, post_state, post_postcode, post_country)
            from public.search_individual_customers('Gwen', 'Goldonly', null)),
    '["NZ", "AU", true, "11223344556", true, "5 Post St", "Postville", "NSW", "2000", "Australia"]'::jsonb,
    'citizenship, tax residency, sole trader / ABN and postal address come back');

-- tenancy and grants
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        $$select count(*) as n from public.search_individual_customers('Jane', 'Citizen', '1985-06-15')$$)->0->>'n', '1',
    'a signed-in staff member can call the individual search');
select is(pg_temp.q_as('a2222222-2222-2222-2222-222222222222', 'aal2',
        $$select phone from public.search_individual_customers('Jane', 'Citizen', '1985-06-15')$$)::text,
    '[{"phone": "0499 999 999"}]', 'entity two sees only its own Jane, never entity one''s');
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal1',
        $$select count(*) as n from public.search_individual_customers(null, null, null)$$)->0->>'n', '0',
    'a password-only (aal1) session finds nobody');
select is(pg_temp.q_as(null, 'aal2', 'select * from public.search_individual_customers()', 'anon')->>'sqlstate',
    '42501', 'anon cannot call the individual search');
select is(pg_temp.q_as(null, 'aal2', 'select * from public.search_company_customers()', 'anon')->>'sqlstate',
    '42501', 'anon cannot call the company search');

select * from finish();
rollback;
