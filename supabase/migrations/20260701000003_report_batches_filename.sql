-- TTR-1-0: store the generated file name so admins can download with the correct name
ALTER TABLE ttr.report_batches
  ADD COLUMN file_name TEXT;

COMMENT ON COLUMN ttr.report_batches.file_name IS
  'TTR-1-0 file name: TTRyyyymmddssssssss.xml';
