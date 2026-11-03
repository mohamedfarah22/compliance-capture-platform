// Helpers shared by gold-save-purchase, gold-complete-purchase and get-gold-photo-urls.
//
// Reads go through the CALLER's JWT client (ctx.userClient): the gold read RPCs and RLS
// identify the caller by auth.uid() and return nothing through the service-role client, which
// is exactly what makes a record of another entity indistinguishable from one that does not
// exist. Only the writes use the service-role client, after the rules have passed.
//
// Nothing here logs. Callers log error codes through codeOf(), never an error message, because
// a Postgres message can quote the row (names, phones, invoice numbers, amounts: spec 6.1).

import type { GoldContext } from "./goldAuth.ts";
import { parseAud } from "./goldRules.js";

export const GOLD_GOODS_BUCKET = "gold-goods";

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// deno-lint-ignore no-explicit-any
export type Row = Record<string, any>;

/** A failed database call. Carries only the function name and the Postgres / PostgREST code. */
export class DbError extends Error {
  constructor(public what: string, public code: string) {
    super(`${what}: ${code}`);
  }
}

/** The code to log for any thrown value: never the message. */
export function codeOf(e: unknown): string {
  return e instanceof DbError ? `${e.what}:${e.code}` : "unexpected";
}

function check<T>(what: string, res: { data: T; error: unknown }): T {
  if (res.error) throw new DbError(what, String((res.error as Row).code ?? "unknown"));
  return res.data;
}

/** The caller's entity's individual customers among `ids`, keyed by id. A missing id is not returned. */
export async function loadCustomers(ctx: GoldContext, ids: string[]): Promise<Map<string, Row>> {
  const rows = check(
    "customers",
    await ctx.userClient
      .from("customers")
      .select("id, first_name, middle_name, last_name, customer_type")
      .in("id", ids),
  ) as Row[] | null;
  return new Map((rows ?? []).filter((r) => r.customer_type === "individual").map((r) => [r.id as string, r]));
}

/** customer_current_id: the ID on file for a customer, or null. */
export async function loadCurrentId(ctx: GoldContext, customerId: string): Promise<Row | null> {
  const rows = check(
    "customer_current_id",
    await ctx.userClient.rpc("customer_current_id", { p_customer_id: customerId }),
  ) as Row[] | null;
  return rows?.[0] ?? null;
}

/** customer_ttr_ready: the list of missing fields, or null when the customer is not an individual of the entity. */
export async function loadReadiness(ctx: GoldContext, customerId: string): Promise<string[] | null> {
  return check(
    "customer_ttr_ready",
    await ctx.userClient.rpc("customer_ttr_ready", { p_customer_id: customerId }),
  ) as string[] | null;
}

/** The entity's re-verification window in days (undefined when the entity has none; the rules apply their default). */
export async function loadRelianceDays(ctx: GoldContext): Promise<number | undefined> {
  const row = check(
    "reporting_entities",
    await ctx.adminClient
      .from("reporting_entities")
      .select("idv_max_reliance_days")
      .eq("id", ctx.staff.reporting_entity_id)
      .single(),
  ) as Row | null;
  return row?.idv_max_reliance_days ?? undefined;
}

/**
 * Linked parts (same invoice, same sale date, the seller as main or joint) for each seller, merged and
 * de-duplicated, and every purchase using the invoice. Both are empty without an invoice number.
 * `excludeId` drops the purchase being completed, which is not a linked part of itself.
 */
export async function loadInvoiceContext(
  ctx: GoldContext,
  input: { sellerIds: string[]; invoice: string; saleDate: string; excludeId?: string },
): Promise<{ linked: Row[]; sameInvoice: Row[] }> {
  if (!input.invoice) return { linked: [], sameInvoice: [] };
  const gold = ctx.userClient.schema("gold");
  const byId = new Map<string, Row>();
  for (const sellerId of input.sellerIds) {
    const parts = check(
      "linked_parts",
      await gold.rpc("linked_parts", {
        p_customer_id: sellerId,
        p_invoice_norm: input.invoice,
        p_sale_date: input.saleDate,
      }),
    ) as Row[] | null;
    for (const part of parts ?? []) byId.set(part.id as string, part);
  }
  byId.delete(input.excludeId ?? "");
  const linked = [...byId.values()].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const sameInvoice = (check("invoice_purchases", await gold.rpc("invoice_purchases", { p_invoice: input.invoice })) ??
    []) as Row[];
  return { linked, sameInvoice };
}

/** Earlier linked parts that have no amount yet, with the amount the client gave for each (already validated). */
export function linkedFills(linked: Row[], linkedAmounts: Row): Row[] {
  return linked
    .filter((part) => part.cash_amount == null)
    .map((part) => ({ id: part.id, cash_amount: parseAud(linkedAmounts?.[part.id]) }));
}

/** Parses "true" / "false"; anything else (including absent) is undefined. */
export function parseBool(v: unknown): boolean | undefined {
  return v === "true" || v === true ? true : v === "false" || v === false ? false : undefined;
}

/**
 * The field error for a refusal raised inside the write transaction after the invoice lock (migration
 * 20261107000002): GD001 duplicate invoice on a reportable purchase, GD002 completed TTR. Same wording as the rules
 * module. Null for any other code.
 */
export function invoiceRaceError(code: string, invoice: string): string | null {
  if (code === "GD001") {
    return `The ERP invoice number ${invoice} is already used by another purchase. A reportable purchase needs its own invoice number.`;
  }
  if (code === "GD002") {
    return `The AUSTRAC report for ${invoice} is already finished. Use a new ERP invoice number for this purchase.`;
  }
  return null;
}
