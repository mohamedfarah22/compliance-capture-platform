-- Precious metal type for the Precious metal designated service (PRECIOUS / <pmi>/<pmo>),
-- distinct from bullion (BULSER / <bui>/<buo>). TTR-1-0 PreciousMetalType allows more
-- values than BullionType, including Alloy and Other.

CREATE TYPE precious_metal_type AS ENUM (
    'Gold', 'Iridium', 'Osmium', 'Palladium', 'Platinum',
    'Rhodium', 'Ruthenium', 'Silver', 'Alloy', 'Other'
);
