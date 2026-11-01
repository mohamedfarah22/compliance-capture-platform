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

-- "First Last, First Last" in the order search_customers returned them, for staff one (aal2).
create function pg_temp.names(p_term text) returns text language sql as $$
    select coalesce(string_agg(x.v ->> 'first_name' || ' ' || (x.v ->> 'last_name'), ', ' order by x.ord), '')
    from jsonb_array_elements(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        format('select first_name, last_name from public.search_customers(%L)', p_term))) with ordinality x(v, ord)
$$;

create function pg_temp.explain_text(p_sql text) returns text language plpgsql as $$
declare r text; o text := '';
begin
    for r in execute 'explain ' || p_sql loop o := o || r || E'\n'; end loop;
    return o;
end $$;

-- ─── Seed: entity one ────────────────────────────────────────────────────────────────────
select pg_temp.mk_cust('alice', '11111111-1111-1111-1111-111111111111', 'Alice', 'Smith', '1980-01-01', '+61 412 345 678', 'Marie');
select pg_temp.mk_cust('bob',   '11111111-1111-1111-1111-111111111111', 'Bob', 'Smith', '1975-05-05', '0499 111 222');
select pg_temp.mk_cust('carol', '11111111-1111-1111-1111-111111111111', 'Carol', 'Jones', '1990-02-02', '0455 000 999');
select pg_temp.mk_cust('dan',   '11111111-1111-1111-1111-111111111111', 'Dan', 'Brown', '1985-03-03', '0412 000 111');
select pg_temp.mk_cust('eve',   '11111111-1111-1111-1111-111111111111', 'Eve', 'Adams', '1995-04-04', '0499 111 2223');
select pg_temp.mk_cust('xav',   '11111111-1111-1111-1111-111111111111', 'Xavier', 'Young', '1970-01-01', '0400 111 000');
select pg_temp.mk_cust('yol',   '11111111-1111-1111-1111-111111111111', 'Yolanda', 'Abbott', '1971-01-01', '0400 222 000');
insert into public.customer_aliases (customer_id, alias) values (pg_temp.u('carol'), 'Caz Smythe');
insert into public.customers (id, reporting_entity_id, customer_type, source, entity_name, reg_identifier, reg_id_type)
values (pg_temp.u('co'), '11111111-1111-1111-1111-111111111111', 'company', 'gold', 'Smith Pty Ltd', '12345678901', 'ABN');

select pg_temp.mk_cap('capAlice', pg_temp.u('alice'), 'Driver licence', 'AB-1234');
select pg_temp.mk_cap('capXav', pg_temp.u('xav'), 'Driver licence', 'ZZ99');
select pg_temp.mk_cap('capYol', pg_temp.u('yol'), 'Driver licence', 'ZZ991');

-- Entity two has its own Alice Smith, with the same phone and the same licence number.
select pg_temp.mk_cust('alice2', '22222222-2222-2222-2222-222222222222', 'Alice', 'Smith', '1980-01-01', '+61 412 345 678');
select pg_temp.mk_cap('capAlice2', pg_temp.u('alice2'), 'Driver licence', 'AB-1234', 'VIC', 'AU', '2026-03-01', 'a2222222-2222-2222-2222-222222222222');

-- 25 customers named Zebra, to check the limit of 20.
insert into public.customers (reporting_entity_id, customer_type, source, first_name, last_name, date_of_birth)
select '11111111-1111-1111-1111-111111111111', 'individual', 'gold', 'Zed', 'Zebra' || lpad(i::text, 2, '0'), '1980-01-01'
from generate_series(1, 25) i;

-- 10,000 customers in a third entity, for the index check.
insert into public.reporting_entities (id, legal_name) values ('33333333-3333-3333-3333-333333333333', 'Entity Three');
insert into auth.users (id, email) values ('a3333333-3333-3333-3333-333333333333', 'staff3@entity-three.test');
insert into public.staff_members (id, reporting_entity_id, full_name, email) values
    ('a3333333-3333-3333-3333-333333333333', '33333333-3333-3333-3333-333333333333', 'Staff Three', 'staff3@entity-three.test');
insert into public.customers (reporting_entity_id, customer_type, source, first_name, last_name, date_of_birth, phone)
select '33333333-3333-3333-3333-333333333333', 'individual', 'gold',
       'f' || left(md5(i::text), 6), 'l' || left(md5((i * 7)::text), 8), date '1970-01-01' + (i % 20000),
       '04' || lpad((10000000 + i)::text, 8, '0')
from generate_series(1, 10000) i;
analyze public.customers;

select plan(36);

-- ─── Name, alias ─────────────────────────────────────────────────────────────────────────
select is(pg_temp.names('mari'), 'Alice Smith', 'part of the middle name finds the customer');
select is(pg_temp.names('SMITH'), 'Alice Smith, Bob Smith',
    'a surname finds every individual in the entity (not the company, not entity two), ordered by last then first name');
select is(pg_temp.names('alice smith'), 'Alice Smith', 'first and last name together');
select is(pg_temp.names('smith alice'), 'Alice Smith', 'in either order');
select is(pg_temp.names('marie smith'), 'Alice Smith', 'middle and last name, which are not adjacent in the name');
select is(pg_temp.names('caz'), 'Carol Jones', 'an alias finds the customer');
select is(pg_temp.names('smythe'), 'Carol Jones', 'any part of an alias');
select is(pg_temp.names('caz smythe'), 'Carol Jones', 'and the whole alias');
select is(pg_temp.names('smi'), 'Alice Smith, Bob Smith', 'a prefix is enough');

-- ─── Phone ───────────────────────────────────────────────────────────────────────────────
select is(pg_temp.names('+61 412 345 678'), 'Alice Smith', '+61 412 345 678 finds the customer stored as +61 412 345 678');
select is(pg_temp.names('0412 345 678'), 'Alice Smith', 'and as 0412 345 678 (a leading 61 reads as 0)');
select is(pg_temp.names('61412345678'), 'Alice Smith', 'and as 61412345678');
select is(pg_temp.names('0412'), 'Dan Brown, Alice Smith', 'four digits is enough to match a phone, ordered by last name');
select is(pg_temp.names('041'), '', 'three digits do not match a phone');
select is(pg_temp.names('0499111222'), 'Bob Smith, Eve Adams', 'an exact phone match ranks before a partial one');

-- ─── ID number ───────────────────────────────────────────────────────────────────────────
select is(pg_temp.names('ab-12 34'), 'Alice Smith', '"ab-12 34" finds licence AB-1234');
select is(pg_temp.names('ab1234'), 'Alice Smith', 'so does "ab1234"');
select is(pg_temp.names('AB 1234'), 'Alice Smith', 'and "AB 1234"');
select is(pg_temp.names('zz99'), 'Xavier Young, Yolanda Abbott',
    'an exact ID number ranks before a longer one that contains it, even against last-name order');
select is((select (x ->> 'customer_id')::uuid from jsonb_array_elements(pg_temp.q_as('a2222222-2222-2222-2222-222222222222', 'aal2',
        'select customer_id from public.search_customers(''ab1234'')')) x),
    pg_temp.u('alice2'), 'the same licence number in entity two finds only entity two''s customer');

-- ─── Limits and refusals ─────────────────────────────────────────────────────────────────
select is(pg_temp.n_as('a1111111-1111-1111-1111-111111111111', 'aal2', 'select * from public.search_customers(''zebra'')'), 20,
    'at most 20 rows');
select is(pg_temp.n_as('a1111111-1111-1111-1111-111111111111', 'aal2', 'select * from public.search_customers(''z'')'), 0, 'one character finds nothing');
select is(pg_temp.n_as('a1111111-1111-1111-1111-111111111111', 'aal2', 'select * from public.search_customers('' a '')'), 0, 'nor does one character with spaces');
select is(pg_temp.n_as('a1111111-1111-1111-1111-111111111111', 'aal2', 'select * from public.search_customers('''')'), 0, 'nor does an empty term');
select is(pg_temp.n_as('a1111111-1111-1111-1111-111111111111', 'aal2', 'select * from public.search_customers(null)'), 0, 'nor null');
select is(pg_temp.n_as('a1111111-1111-1111-1111-111111111111', 'aal2', 'select * from public.search_customers(''%%'')'), 0,
    'LIKE wildcards are matched literally');
select is(pg_temp.n_as('a1111111-1111-1111-1111-111111111111', 'aal2', 'select * from public.search_customers(''s_ith'')'), 0,
    'including the underscore');
select is(pg_temp.n_as('a1111111-1111-1111-1111-111111111111', 'aal1', 'select * from public.search_customers(''smith'')'), 0,
    'a password-only (aal1) session finds nothing');
select is(pg_temp.n_as(null, 'aal2', 'select * from public.search_customers(''smith'')', 'service_role'), 0,
    'and neither does the service role, which has no staff identity');
select is(pg_temp.n_as('a2222222-2222-2222-2222-222222222222', 'aal2', 'select * from public.search_customers(''smith'')'), 1,
    'entity two finds only its own Smith');

-- ─── What a row carries ──────────────────────────────────────────────────────────────────
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        'select current_id_verification_id, current_id_document_type, current_id_document_number, current_id_expiry_date, current_id_has_expiry, current_id_captured_at
         from public.search_customers(''marie'')'),
    jsonb_build_array(jsonb_build_object(
        'current_id_verification_id', pg_temp.u('capAlice'), 'current_id_document_type', 'Driver licence',
        'current_id_document_number', 'AB-1234', 'current_id_expiry_date', '2030-01-01',
        'current_id_has_expiry', true, 'current_id_captured_at', '2026-03-01T00:00:00+00:00')),
    'a row carries the current ID');
select is(pg_temp.q_as('a1111111-1111-1111-1111-111111111111', 'aal2',
        'select current_id_verification_id, current_id_document_type from public.search_customers(''bob'')'),
    jsonb_build_array(jsonb_build_object('current_id_verification_id', null, 'current_id_document_type', null)),
    'a customer with no ID on file has null ID columns');
select is((select proargnames::text from pg_proc where oid = 'public.search_customers(text)'::regprocedure),
    '{p_q,customer_id,first_name,middle_name,last_name,date_of_birth,phone,current_id_verification_id,current_id_document_type,current_id_document_number,current_id_expiry_date,current_id_has_expiry,current_id_captured_at}',
    'search_customers has the agreed signature');

-- ─── The trigram index ───────────────────────────────────────────────────────────────────
select is((select count(*)::int
           from jsonb_array_elements(pg_temp.q_as('a3333333-3333-3333-3333-333333333333', 'aal2',
               format('select customer_id from public.search_customers(%L)',
                      (select last_name from public.customers where first_name = 'f' || left(md5('4242'), 6))))) x
           where (x ->> 'customer_id')::uuid = (select id from public.customers where first_name = 'f' || left(md5('4242'), 6))), 1,
    'a search over 10,000 customers finds the customer by surname');
-- On 10,000 rows a sequential scan (cost ~400) is cheaper than any GIN scan, so the planner
-- would not choose the index here by itself; at 100,000 rows it does (checked by hand). To prove
-- the name predicate can use idx_customers_name_trgm, switch off the other ways in.
set local enable_seqscan = off;
set local enable_indexscan = off;
select matches(pg_temp.explain_text(
        $q$select c.id from public.customers c
           where c.reporting_entity_id = '33333333-3333-3333-3333-333333333333' and c.customer_type = 'individual'
             and c.name_search like '%a1b2c%'$q$),
    'Bitmap Index Scan on idx_customers_name_trgm', 'the name predicate can use the trigram index on 10,000 customers');
select matches(pg_temp.explain_text(
        $q$select c.id from public.customer_aliases a join public.customers c on c.id = a.customer_id
           where a.alias ilike '%a1b2c%'$q$),
    'idx_customer_alias_trgm', 'and the alias predicate can use the alias trigram index');
reset enable_seqscan;
reset enable_indexscan;

select * from finish();
rollback;
