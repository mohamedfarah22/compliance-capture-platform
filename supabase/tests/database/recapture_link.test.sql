-- UAT matrix F4 (finding #8): the database itself refuses a re-capture link to a record
-- belonging to a different person, independently of the UI.
begin;
create extension if not exists pgtap with schema extensions;
select plan(3);

insert into public.reporting_entities (id, legal_name)
values ('00000000-0000-0000-0000-0000000000e1', 'pgTAP Entity');

insert into ttr.transactions (id, reporting_entity_id, scenario, transaction_ref, transaction_datetime,
    designated_service, location_snapshot, staff_member_name, staff_member_email,
    cash_currency, cash_amount, aud_value)
select id::uuid, '00000000-0000-0000-0000-0000000000e1', 'bullion_buy', ref, now(),
    'Bullion', 'pgTAP', 'pgTAP Staff', 'pgtap-staff@example.test', 'AUD', 11000, 11000
from (values ('00000000-0000-0000-0000-0000000000f1', 'PGTAP-001'),
             ('00000000-0000-0000-0000-0000000000f2', 'PGTAP-002')) v(id, ref);

-- Regina holds the licence; Barry, a second Regina row and an unknown-DOB person try to link to it.
insert into ttr.parties (id, transaction_id, party_type, first_name, last_name, date_of_birth) values
    ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000f1', 'individual', 'Regina', 'Testworth', '1983-05-12'),
    ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000f2', 'individual', 'Barry', 'Doubleton', '1979-09-30'),
    ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000f2', 'individual', 'Regina', 'Testworth', '1983-05-12'),
    ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-0000000000f2', 'individual', 'Unknown', 'Dob', null);

-- The original capture, then three unlinked different_person rows (exempt from
-- uq_idv_doc_new_capture) that each test tries to re-point at the original.
insert into ttr.id_verifications (id, transaction_id, party_id, verification_method, document_type,
    document_number, verification_description, new_capture_reason)
select v.id::uuid, v.tx::uuid, v.party::uuid, 'Sighted original document', 'Driver licence',
    'RGN-111222', 'pgTAP', v.reason
from (values
    ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', null),
    ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b2', 'different_person'),
    ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b3', 'different_person'),
    ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b4', 'different_person')
) v(id, tx, party, reason);

select throws_like(
    $$ update ttr.id_verifications
          set new_capture_reason = 'id_changed', prior_verification_id = '00000000-0000-0000-0000-0000000000c1'
        where id = '00000000-0000-0000-0000-0000000000c2' $$,
    '%re-capture links to a record for a different person%',
    'F4: linking Barry''s capture to Regina''s licence is rejected (both DOBs known, different)'
);

-- Controls: without these, a trigger that rejected every link would also pass F4.
select lives_ok(
    $$ update ttr.id_verifications
          set new_capture_reason = 'id_changed', prior_verification_id = '00000000-0000-0000-0000-0000000000c1'
        where id = '00000000-0000-0000-0000-0000000000c3' $$,
    'F4 control: the same person (same DOB) can link'
);
select lives_ok(
    $$ update ttr.id_verifications
          set new_capture_reason = 'id_changed', prior_verification_id = '00000000-0000-0000-0000-0000000000c1'
        where id = '00000000-0000-0000-0000-0000000000c4' $$,
    'F4 control: an unknown DOB cannot trigger the check, so the link is allowed'
);

select * from finish();
rollback;
