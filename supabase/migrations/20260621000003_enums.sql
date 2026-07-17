-- All enum types for the compliance platform.
-- Stable categoricals only. Extensible lists use reference tables (e.g. ttr.scenario_types).

CREATE TYPE transaction_status  AS ENUM ('draft', 'complete');
CREATE TYPE cash_currency_type  AS ENUM ('AUD', 'other');
CREATE TYPE fx_rate_src         AS ENUM ('Internal POS rate', 'Treasury rate', 'Daily branch rate', 'Market rate');
CREATE TYPE party_kind          AS ENUM ('individual', 'company');
CREATE TYPE co_legal_form       AS ENUM ('Company', 'Partnership', 'Trust', 'Sole trader', 'Association', 'Other');
CREATE TYPE reg_id_kind         AS ENUM ('ABN', 'ACN', 'ARBN', 'Other');
CREATE TYPE cp_relationship     AS ENUM ('Self', 'Employee', 'Director', 'Authorised representative', 'Agent', 'Family member', 'Trustee', 'Partner', 'Other');
CREATE TYPE cp_employee_status  AS ENUM ('yes', 'no', 'unknown');
CREATE TYPE id_verify_method    AS ENUM ('Sighted original document', 'Sighted certified copy', 'Electronic data source', 'Other');
CREATE TYPE id_doc_type         AS ENUM ('Driver licence', 'Passport', 'Proof of age card', 'National identity card', 'Medicare card', 'Other government document', 'Electronic verification source', 'Other');
CREATE TYPE handover_method     AS ENUM ('Collected', 'Shipped', 'Courier', 'Other');
CREATE TYPE bullion_metal       AS ENUM ('Gold', 'Silver', 'Platinum', 'Palladium', 'Other');
CREATE TYPE bullion_product     AS ENUM ('Bar', 'Coin', 'Wafer', 'Cast bar', 'Minted bar', 'Other');
CREATE TYPE bullion_weight_unit AS ENUM ('grams', 'kilograms', 'ounces', 'tolas', 'other');
CREATE TYPE bullion_dir         AS ENUM ('Provided to customer', 'Received from customer');
CREATE TYPE aus_state           AS ENUM ('VIC', 'NSW', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT');
