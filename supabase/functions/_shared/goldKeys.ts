// Server-only match keys. Each one must give exactly the same value as the SQL that builds the
// matching generated column in the database (customers.name_search, customers.phone_digits,
// id_verifications.number_norm). If you change one side, change the other and the shared fixtures
// in goldKeys.test.ts and the pgTAP tests.

/**
 * SQL: btrim(regexp_replace(lower(coalesce(first,'') || ' ' || coalesce(middle,'') || ' ' || coalesce(last,'')), '\s+', ' ', 'g'))
 */
export function nameKey(
  first: string | null | undefined,
  middle: string | null | undefined,
  last: string | null | undefined,
): string {
  return `${first ?? ""} ${middle ?? ""} ${last ?? ""}`.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * SQL: regexp_replace(regexp_replace(coalesce(phone,''), '\D', '', 'g'), '^61', '0')
 * An empty result is null here.
 */
export function phoneKey(phone: string | null | undefined): string | null {
  const key = (phone ?? "").replace(/\D/g, "").replace(/^61/, "0");
  return key === "" ? null : key;
}

/**
 * SQL: upper(regexp_replace(number, '[\s-]', '', 'g'))
 */
export function idKey(number: string | null | undefined): string {
  return (number ?? "").replace(/[\s-]/g, "").toUpperCase();
}
