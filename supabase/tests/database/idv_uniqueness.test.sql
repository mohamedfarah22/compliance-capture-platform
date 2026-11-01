-- UAT matrix Part 1C database-level checks (K-1–K-11): one copy of a document on file,
-- enforced by uq_idv_doc_new_capture and chk_idv_reliance_reason regardless of the UI.
-- Each rejection is matched on the index or constraint that must raise it, so a row
-- refused for some other reason cannot pass. K-4 and K-11's 'other' is now refused
-- before either rule runs: 20260727000004 dropped it from the permitted reasons.
begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

insert into public.reporting_entities (id, legal_name)
values ('00000000-0000-0000-0000-0000000000e1', 'pgTAP Entity');
insert into ttr.transactions (id, reporting_entity_id, scenario, transaction_ref, transaction_datetime,
    designated_service, location_snapshot, staff_member_name, staff_member_email,
    cash_currency, cash_amount, aud_value)
select id::uuid, '00000000-0000-0000-0000-0000000000e1', 'bullion_buy', ref, now(),
    'Bullion', 'pgTAP', 'pgTAP Staff', 'pgtap-staff@example.test', 'AUD', 11000, 11000
from (values ('00000000-0000-0000-0000-0000000000f1', 'PGTAP-001'),
             ('00000000-0000-0000-0000-0000000000f2', 'PGTAP-002')) v(id, ref);

-- Grace on both transactions, Jane on the first, and a different person on the second.
insert into ttr.parties (id, transaction_id, party_type, first_name, last_name, date_of_birth) values
    ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000f1', 'individual', 'Grace', 'Harbour', '1988-08-08'),
    ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000f2', 'individual', 'Grace', 'Harbour', '1988-08-08'),
    ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000f2', 'individual', 'Other', 'Person', '1970-01-01'),
    ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-0000000000f1', 'individual', 'Jane', 'Citizen', '1985-06-15');

-- Tom conducts both transactions.
insert into ttr.conducting_persons (id, transaction_id, full_name, dob_known, date_of_birth,
    res_street, res_suburb, res_state, res_postcode, relationship, authority_to_act)
select id::uuid, tx::uuid, 'Tom Employee', true, '1995-09-09', '8 Staff St', 'Dandenong', 'VIC', '3175',
    'Employee', 'pgTAP'
from (values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1'),
             ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000f2')) v(id, tx);

-- The copies on file: Grace's card, Tom's card (as a conducting person) and Jane's passport.
insert into ttr.id_verifications (id, transaction_id, party_id, conducting_person_id, verification_method,
    document_type, document_number, verification_description)
values
    ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', null,
     'Sighted original document', 'National identity card', 'NIC-334455', 'pgTAP'),
    ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000f1', null, '00000000-0000-0000-0000-0000000000d1',
     'Sighted original document', 'Proof of age card', 'POA-11223', 'pgTAP'),
    ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b4', null,
     'Sighted original document', 'Passport', 'PA1234567', 'pgTAP');

select throws_like(
    $$ insert into ttr.id_verifications (transaction_id, party_id, verification_method, document_type,
           document_number, verification_description)
       values ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b2',
           'Sighted original document', 'National identity card', 'NIC-334455', 'pgTAP') $$,
    '%"uq_idv_doc_new_capture"%',
    'K-1: a second unlinked capture of the same document is rejected'
);
select throws_like(
    $$ insert into ttr.id_verifications (transaction_id, party_id, verification_method, document_type,
           document_number, verification_description)
       values ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b2',
           'Sighted original document', 'National identity card', ' nic-334455 ', 'pgTAP') $$,
    '%"uq_idv_doc_new_capture"%',
    'K-2: case and whitespace are not an escape'
);
select throws_like(
    $$ insert into ttr.id_verifications (transaction_id, party_id, verification_method, document_type,
           document_number, verification_description, new_capture_reason, prior_verification_id)
       values ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b2',
           'Sighted original document', 'National identity card', 'NIC-999999', 'pgTAP',
           'stored_copy_unclear', '00000000-0000-0000-0000-0000000000c1') $$,
    '%re-capture must reference the prior verification of the same document%',
    'K-3: a re-capture cannot link to a different document'
);
select throws_like(
    $$ insert into ttr.id_verifications (transaction_id, party_id, verification_method, document_type,
           document_number, verification_description, new_capture_reason, prior_verification_id)
       values ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b2',
           'Sighted original document', 'National identity card', 'NIC-334455', 'pgTAP',
           'other', '00000000-0000-0000-0000-0000000000c1') $$,
    '%"chk_idv_new_capture_reason_values"%',
    'K-4: other cannot link (20260727000004 removed it as a reason altogether)'
);
select throws_like(
    $$ insert into ttr.id_verifications (transaction_id, party_id, verification_method, document_type,
           document_number, verification_description, prior_verification_id)
       values ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b2',
           'Sighted original document', 'National identity card', 'NIC-334455', 'pgTAP',
           '00000000-0000-0000-0000-0000000000c1') $$,
    '%"chk_idv_reliance_reason"%',
    'K-5: a link with no reason is rejected (the coalesce case)'
);
select throws_like(
    $$ insert into ttr.id_verifications (transaction_id, party_id, verification_method, document_type,
           document_number, verification_description, verification_basis, reliance_reason,
           new_capture_reason, prior_verification_id)
       values ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b2',
           'Relied on prior identification', 'National identity card', 'NIC-334455', 'pgTAP',
           'relied_on_prior_identification', 'prior_id_reviewed_still_valid',
           'stored_copy_unclear', '00000000-0000-0000-0000-0000000000c1') $$,
    '%"chk_idv_reliance_reason"%',
    'K-6: a reliance row cannot also carry a capture reason'
);
select throws_like(
    $$ insert into ttr.id_verifications (transaction_id, conducting_person_id, verification_method, document_type,
           document_number, verification_description)
       values ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000d2',
           'Sighted original document', 'Proof of age card', 'POA-11223', 'pgTAP') $$,
    '%"uq_idv_doc_new_capture"%',
    'K-7: the rule covers conducting persons'
);
select throws_like(
    $$ insert into ttr.id_verifications (transaction_id, conducting_person_id, verification_method, document_type,
           document_number, verification_description)
       values ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000d2',
           'Sighted original document', 'Passport', 'PA1234567', 'pgTAP') $$,
    '%"uq_idv_doc_new_capture"%',
    'K-8: one copy per document whichever role it was captured in'
);
select lives_ok(
    $$ insert into ttr.id_verifications (transaction_id, party_id, verification_method, document_type,
           document_number, verification_description, new_capture_reason, prior_verification_id)
       values ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b2',
           'Sighted original document', 'National identity card', 'NIC-334455', 'pgTAP',
           'id_changed', '00000000-0000-0000-0000-0000000000c1') $$,
    'K-9: a renewed card with an unchanged number links (id_changed)'
);
select lives_ok(
    $$ insert into ttr.id_verifications (transaction_id, party_id, verification_method, document_type,
           document_number, verification_description, new_capture_reason)
       values ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b3',
           'Sighted original document', 'National identity card', 'NIC-334455', 'pgTAP', 'different_person') $$,
    'K-10: different_person is exempt from the index'
);
select throws_like(
    $$ insert into ttr.id_verifications (transaction_id, party_id, verification_method, document_type,
           document_number, verification_description, new_capture_reason)
       values ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b3',
           'Sighted original document', 'National identity card', 'NIC-334455', 'pgTAP', 'other') $$,
    '%"chk_idv_new_capture_reason_values"%',
    'K-11: other cannot wave the rule away (20260727000004 removed it as a reason altogether)'
);

select * from finish();
rollback;
