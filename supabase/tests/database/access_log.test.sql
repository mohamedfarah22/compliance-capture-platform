-- UAT matrix R16 (the access log cannot be rewritten) and R17 (ordinary staff cannot read it).
begin;
create extension if not exists pgtap with schema extensions;
select plan(4);

insert into public.reporting_entities (id, legal_name)
values ('00000000-0000-0000-0000-0000000000e1', 'pgTAP Entity');

insert into auth.users (id, email, aud, role) values
    ('00000000-0000-0000-0000-0000000000a1', 'pgtap-admin@example.test', 'authenticated', 'authenticated'),
    ('00000000-0000-0000-0000-0000000000a2', 'pgtap-staff@example.test', 'authenticated', 'authenticated');

insert into public.staff_members (id, reporting_entity_id, full_name, email, role) values
    ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e1', 'pgTAP Admin', 'pgtap-admin@example.test', 'admin'),
    ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000e1', 'pgTAP Staff', 'pgtap-staff@example.test', 'staff');

-- A view by the plain staff member: the row they must not be able to read back.
-- The table is empty after a reset, so without this row the UPDATE/DELETE below would
-- match nothing, the row-level trigger would never fire, and R16 would pass vacuously.
insert into ttr.access_log (reporting_entity_id, staff_member_id, action, resource_type)
values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a2', 'view', 'stored_images');

-- R16
select throws_ok(
    $$ update ttr.access_log set action = 'export' $$,
    'P0001', 'Audit log is append-only — UPDATE is not permitted',
    'R16: UPDATE on ttr.access_log is rejected'
);
select throws_ok(
    $$ delete from ttr.access_log $$,
    'P0001', 'Audit log is append-only — DELETE is not permitted',
    'R16: DELETE on ttr.access_log is rejected'
);

-- R17, as an MFA-complete (aal2) session for each account.
set local role authenticated;

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated","aal":"aal2"}';
select is((select count(*) from ttr.access_log), 0::bigint,
    'R17: plain staff see 0 rows, even of their own views');

-- Control: without it, an RLS policy that hid everything from everyone would also pass R17.
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal2"}';
select is((select count(*) from ttr.access_log), 1::bigint,
    'R17 control: an admin of the same entity can read the log');

reset role;
select * from finish();
rollback;
