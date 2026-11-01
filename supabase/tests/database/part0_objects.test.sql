-- UAT matrix R2: the objects the one-copy-of-ID and access-logging work depends on exist.
begin;
create extension if not exists pgtap with schema extensions;
select plan(5);

select has_index('ttr', 'id_verifications', 'uq_idv_doc_new_capture', 'R2: index ttr.uq_idv_doc_new_capture exists');
select has_function('public', 'get_verification_for_document', 'R2: lookup rpc public.get_verification_for_document exists');
select has_table('ttr', 'access_log', 'R2: table ttr.access_log exists');
select has_column('ttr', 'id_verifications', 'reporting_entity_id', 'R2: ttr.id_verifications.reporting_entity_id exists');
select has_trigger('ttr', 'id_verifications', 'trg_idv_recapture_link', 'R2: trigger trg_idv_recapture_link exists');

select * from finish();
rollback;
