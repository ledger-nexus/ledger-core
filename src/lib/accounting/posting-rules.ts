// Posting-rules engine.
//
// Spec: "A single source event maps to N sets of GL lines via a posting
// rules engine: posting_rule table keyed by (source_event_type, book_id)
// producing a GL-line template."
//
// v0.4-alpha implementation: minimal template DSL that's enough to drive
// Northwind's common events (invoice posted, bill received, asset acquired)
// without baking the line-by-line in seed code. The DSL supports JSONPath-
// style lookups into the event payload and string interpolation in memos.
//
// Template shape (stored as JSON in PostingRule.template):
// {
//   "memo": "Invoice ${$.invoiceNumber} — ${$.customerCode}",
//   "lines": [
//     {
//       "accountCode": "1200",
//       "side": "DEBIT",
//       "amountExpr": "$.amount",
//       "description": "AR — ${$.customerCode}",
//       "partyCodeExpr": "$.customerCode"
//     },
//     {
//       "accountCode": "4000",
//       "side": "CREDIT",
//       "amountExpr": "$.amount",
//       "description": "Subscription revenue"
//     }
//   ]
// }
//
// Expression syntax (minimal by design — keep this auditable):
//   "$.path"              → payload[path], with dotted segments allowed
//   "${$.path}"           → string interpolation inside memo / description
//   literal               → used as-is (number for amounts, string for accounts)
//
// Arithmetic and conditionals are intentionally OUT of scope. If a rule
// needs them, author it in TS via postJournalEntry directly. The rules
// engine is for declarative ERP-event → GL mapping, not for general
// computation.

import { PrismaClient } from "@prisma/client";
import { Decimal } from "@/lib/utils/decimal";
import { postJournalEntry } from "./post-journal";

// ---- Template types ---------------------------------------------------

export interface RuleLineTemplate {
  accountCode: string;
  side: "DEBIT" | "CREDIT";
  amountExpr: string;            // "$.amount" or "5000" or "$.lines.0.qty"
  description?: string;          // can include ${$.path} interpolations
  partyCodeExpr?: string;        // "$.customerCode" or literal
  itemCodeExpr?: string;
}

export interface RuleTemplate {
  memo: string;                  // can include ${$.path}
  lines: RuleLineTemplate[];
}

// ---- Expression interpreter -------------------------------------------

function lookupPath(expr: string, payload: Record<string, unknown>): unknown {
  if (!expr.startsWith("$.")) return expr;
  const segments = expr.slice(2).split(".");
  let val: any = payload;
  for (const seg of segments) {
    if (val === undefined || val === null) return undefined;
    val = val[seg];
  }
  return val;
}

function evaluateAmount(expr: string, payload: Record<string, unknown>): Decimal {
  if (expr.startsWith("$.")) {
    const v = lookupPath(expr, payload);
    if (v === undefined || v === null) {
      throw new Error(`Posting rule amount expression "${expr}" resolved to null`);
    }
    return new Decimal(v as any);
  }
  return new Decimal(expr);
}

function evaluateString(expr: string | undefined, payload: Record<string, unknown>): string | undefined {
  if (!expr) return undefined;
  if (expr.startsWith("$.")) {
    const v = lookupPath(expr, payload);
    return v === undefined || v === null ? undefined : String(v);
  }
  return expr;
}

function interpolate(template: string, payload: Record<string, unknown>): string {
  return template.replace(/\$\{(\$\.[a-zA-Z0-9_.]+)\}/g, (_, expr) => {
    const v = lookupPath(expr, payload);
    return v === undefined || v === null ? "" : String(v);
  });
}

// ---- Rule registration ------------------------------------------------

export interface RegisterPostingRuleInput {
  sourceEventType: string;       // e.g. "INVOICE_POSTED"
  bookCode: string;
  template: RuleTemplate;
  ruleVersion?: number;          // default 1
  /**
   * Tenant the rule belongs to. Optional during the migration window —
   * resolves to the default tenant when omitted. New callers should pass
   * explicitly so cross-tenant misregistration is caught at write time.
   */
  tenantId?: string;
}

export async function registerPostingRule(
  prisma: PrismaClient,
  input: RegisterPostingRuleInput
): Promise<{ id: string }> {
  const book = await prisma.book.findUniqueOrThrow({
    where: { code: input.bookCode },
    select: { id: true },
  });
  const tenantId = input.tenantId ?? (await (await import("@/lib/seed/default-tenant")).getDefaultTenantId(prisma));
  const version = input.ruleVersion ?? 1;
  return await prisma.postingRule.upsert({
    where: {
      sourceEventType_bookId_ruleVersion: {
        sourceEventType: input.sourceEventType,
        bookId: book.id,
        ruleVersion: version,
      },
    },
    create: {
      tenantId,
      sourceEventType: input.sourceEventType,
      bookId: book.id,
      ruleVersion: version,
      template: input.template as unknown as any,
      isActive: true,
    },
    update: {
      tenantId,
      template: input.template as unknown as any,
      isActive: true,
    },
    select: { id: true },
  });
}

// ---- Engine ----------------------------------------------------------

export interface PostWithRulesInput {
  entityCode: string;
  sourceEventType: string;
  payload: Record<string, unknown>;
  documentDate: Date;
  books?: string[];                          // default: all active books
  currencyCode?: string;                     // default: entity functional
  fxRate?: Decimal | string | number;
  source?: "MANUAL" | "SEED" | "SYSTEM" | "AI_APPROVED" | "IMPORT";
  sourceRecordId?: string;
  sourcePayload?: unknown;
  mappingVersion?: string;
}

export interface PostWithRulesResult {
  bookCode: string;
  ruleId: string;
  ruleVersion: number;
  id: string;
  entryNumber: string;
}

export async function postWithRules(
  prisma: PrismaClient,
  input: PostWithRulesInput
): Promise<PostWithRulesResult[]> {
  // Determine target books. If caller didn't specify, use every active book.
  const targetBookCodes =
    input.books ??
    (await prisma.book.findMany({
      where: { isActive: true },
      select: { code: true },
    })).map((b) => b.code);

  const results: PostWithRulesResult[] = [];

  for (const bookCode of targetBookCodes) {
    const book = await prisma.book.findUnique({
      where: { code: bookCode },
      select: { id: true },
    });
    if (!book) {
      throw new Error(`Unknown book ${bookCode}`);
    }

    // Latest active rule version for this (event, book).
    const rule = await prisma.postingRule.findFirst({
      where: {
        sourceEventType: input.sourceEventType,
        bookId: book.id,
        isActive: true,
      },
      orderBy: { ruleVersion: "desc" },
    });
    if (!rule) {
      throw new Error(
        `No active posting rule for event "${input.sourceEventType}" in book "${bookCode}"`
      );
    }

    const template = rule.template as unknown as RuleTemplate;
    if (!template?.lines || template.lines.length < 2) {
      throw new Error(
        `Rule ${rule.id} template must have at least 2 lines (got ${template?.lines?.length ?? 0})`
      );
    }

    const lines = template.lines.map((l) => {
      const amount = evaluateAmount(l.amountExpr, input.payload);
      return {
        accountCode: l.accountCode,
        debit: l.side === "DEBIT" ? amount.toFixed(4) : undefined,
        credit: l.side === "CREDIT" ? amount.toFixed(4) : undefined,
        description: l.description ? interpolate(l.description, input.payload) : undefined,
        partyCode: evaluateString(l.partyCodeExpr, input.payload),
        itemCode: evaluateString(l.itemCodeExpr, input.payload),
      };
    });

    const memo = interpolate(template.memo, input.payload);

    const result = await postJournalEntry(prisma, {
      entityCode: input.entityCode,
      bookCode,
      currencyCode: input.currencyCode,
      fxRate: input.fxRate,
      documentDate: input.documentDate,
      memo,
      source: input.source ?? "SYSTEM",
      sourceRecordType: input.sourceEventType,
      sourceRecordId: input.sourceRecordId,
      sourcePayload: input.sourcePayload,
      mappingVersion: input.mappingVersion,
      extensions: {
        rule: { id: rule.id, version: rule.ruleVersion },
      },
      lines,
    });

    results.push({
      bookCode,
      ruleId: rule.id,
      ruleVersion: rule.ruleVersion,
      id: result.id,
      entryNumber: result.entryNumber,
    });
  }

  return results;
}

// ---- Convenience: register a uniform rule across many books -----------
// Common case: an event posts identically to every book (revenue, expense,
// AR collection). Helper avoids repeating the registration boilerplate.

export async function registerUniformRule(
  prisma: PrismaClient,
  input: { sourceEventType: string; books: string[]; template: RuleTemplate; ruleVersion?: number }
): Promise<{ id: string; bookCode: string }[]> {
  const results: { id: string; bookCode: string }[] = [];
  for (const bookCode of input.books) {
    const r = await registerPostingRule(prisma, {
      sourceEventType: input.sourceEventType,
      bookCode,
      template: input.template,
      ruleVersion: input.ruleVersion,
    });
    results.push({ id: r.id, bookCode });
  }
  return results;
}
