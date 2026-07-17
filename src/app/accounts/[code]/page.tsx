// Per-account detail + edit page. Code-keyed URL because codes are
// what CPAs say out loud ("Edit 1500"); UUIDs are not.
//
// The centerpiece is the account register — the running-balance ledger of
// every posting that hit this account in the current (entity, book). It's
// the "checkbook register" every QuickBooks user reaches for: you open an
// account to see what happened and what the balance is. This page used to
// show only a count ("Posted lines: 42"), which answers neither question.

import { notFound } from "next/navigation";
import Link from "next/link";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import { getScope } from "@/lib/scope";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { getCurrentUser, isAdmin } from "@/lib/auth/current-user";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { SourceBadge } from "@/components/ui/source-badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatMoney, formatDate, moneyClass } from "@/lib/utils/format";
import EditAccountForm from "./edit-account-form";

// Registers get long; cap the rendered rows but keep the running balance
// honest by computing it over EVERY line first (the newest row's balance
// must equal the account's true balance, not the balance of a page).
const REGISTER_DISPLAY_LIMIT = 250;

export default async function AccountDetailPage({
  params,
}: {
  params: { code: string };
}) {
  const tenant = await getCurrentTenant();
  if (!tenant) return notFound();
  const user = await getCurrentUser();
  const scope = getScope();
  const canEdit = isAdmin(user);

  // Try entity-specific first, fall back to shared. Mirrors how the
  // chart of accounts dedups in reports.
  const account =
    (await prisma.account.findFirst({
      where: {
        tenantId: tenant.id,
        code: params.code,
        entity: { code: scope.entityCode },
      },
      include: {
        parent: { select: { code: true, name: true } },
        children: { orderBy: { code: "asc" }, select: { code: true, name: true } },
        entity: { select: { code: true } },
      },
    })) ??
    (await prisma.account.findFirst({
      where: {
        tenantId: tenant.id,
        code: params.code,
        entityId: null,
      },
      include: {
        parent: { select: { code: true, name: true } },
        children: { orderBy: { code: "asc" }, select: { code: true, name: true } },
        entity: { select: { code: true } },
      },
    }));

  if (!account) return notFound();

  // Candidate parents: same scope, same type, not the account itself.
  const candidates = await prisma.account.findMany({
    where: {
      tenantId: tenant.id,
      active: true,
      type: account.type,
      id: { not: account.id },
      OR: [{ entityId: null }, { entityId: account.entityId ?? undefined }],
    },
    orderBy: { code: "asc" },
    select: { code: true, name: true },
  });

  // Register: every posting to this account in the CURRENT (entity, book),
  // oldest first so the running balance accumulates in the order the
  // ledger actually posted. A shared account (entityId null) collects
  // lines from many entities/books, so the scope filter is what makes the
  // running balance match the scope the rest of the page is showing.
  const lines = await prisma.journalLine.findMany({
    where: {
      accountId: account.id,
      entry: {
        entity: { code: scope.entityCode },
        book: { code: scope.bookCode },
      },
    },
    orderBy: [
      { entry: { documentDate: "asc" } },
      { entry: { entryNumber: "asc" } },
      { lineNo: "asc" },
    ],
    select: {
      id: true,
      debit: true,
      credit: true,
      description: true,
      party: { select: { displayName: true } },
      entry: {
        select: {
          id: true,
          entryNumber: true,
          documentDate: true,
          memo: true,
          source: true,
        },
      },
    },
  });

  // Running balance on the account's NORMAL side, so a positive number
  // always reads as "more of what this account normally holds": for a
  // bank account (debit-normal) a deposit raises it; for a credit card
  // (credit-normal) a charge raises it. Accumulate oldest→newest, then
  // reverse for display so the newest posting — carrying the account's
  // current balance — sits at the top, the way a register reads.
  const normalIsDebit = account.normalBalance === "DEBIT";
  let running = new Decimal(0);
  const rows = lines.map((l) => {
    const debit = new Decimal(l.debit.toString());
    const credit = new Decimal(l.credit.toString());
    running = running.plus(normalIsDebit ? debit.minus(credit) : credit.minus(debit));
    return { line: l, debit, credit, balance: running };
  });
  const currentBalance = running; // balance after the last (newest) line
  const displayRows = rows.slice(-REGISTER_DISPLAY_LIMIT).reverse();
  const truncated = rows.length > REGISTER_DISPLAY_LIMIT;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm text-ink-500">
          <Link href="/accounts" className="text-link hover:underline">
            ← Chart of Accounts
          </Link>
        </p>
        <h2 className="mt-2 text-xl font-semibold text-ink-900">
          <span className="font-mono">{account.code}</span> — {account.name}
        </h2>
        <div className="mt-1 flex items-center gap-2 text-xs text-ink-500">
          <Badge tone="info">{account.type}</Badge>
          <Badge tone="neutral">{account.normalBalance}</Badge>
          {account.entityId === null ? (
            <Badge tone="neutral">shared</Badge>
          ) : (
            <Badge tone="neutral">{account.entity?.code ?? "entity"}</Badge>
          )}
          {!account.active && <Badge tone="warning">inactive</Badge>}
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-baseline gap-2">
            <CardTitle>Balance</CardTitle>
            <span className="text-xs text-ink-500">
              in {scope.entityCode} / {scope.bookCode}
            </span>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-ink-500">
                Current balance
              </div>
              <div
                className={`mt-0.5 font-mono text-xl font-semibold tabular-nums ${moneyClass(
                  currentBalance
                )}`}
              >
                {formatMoney(currentBalance)}
              </div>
            </div>
            <Stat label="Postings" value={rows.length.toString()} />
            <Stat
              label="Parent"
              value={
                account.parent ? `${account.parent.code} — ${account.parent.name}` : "—"
              }
            />
          </div>
          {account.children.length > 0 && (
            <div className="mt-4 text-xs text-ink-500">
              <span className="uppercase font-medium tracking-wider">Children:</span>{" "}
              {account.children.map((c, i) => (
                <span key={c.code}>
                  <Link href={`/accounts/${c.code}`} className="font-mono text-link hover:underline">
                    {c.code}
                  </Link>
                  {i < account.children.length - 1 ? ", " : ""}
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Register</CardTitle>
          {truncated && (
            <span className="text-xs text-ink-500">
              newest {REGISTER_DISPLAY_LIMIT} of {rows.length} — balance reflects all
            </span>
          )}
        </CardHeader>
        <CardContent>
          {displayRows.length === 0 ? (
            <EmptyState
              title="No activity in this account yet"
              description={`Nothing has posted to ${account.code} in ${scope.entityCode} / ${scope.bookCode}.`}
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Date</TH>
                  <TH>Entry</TH>
                  <TH>Description</TH>
                  <TH className="text-right">Debit</TH>
                  <TH className="text-right">Credit</TH>
                  <TH className="text-right">Balance</TH>
                </tr>
              </THead>
              <TBody>
                {displayRows.map(({ line, debit, credit, balance }) => (
                  <TR key={line.id}>
                    <TD className="whitespace-nowrap text-ink-500">
                      {formatDate(line.entry.documentDate)}
                    </TD>
                    <TD className="whitespace-nowrap font-mono text-xs">
                      <Link
                        href={`/journal-entries/${line.entry.id}`}
                        className="text-link hover:underline"
                      >
                        {line.entry.entryNumber}
                      </Link>
                    </TD>
                    <TD className="text-ink-800">
                      {line.description || line.entry.memo}
                      {line.party?.displayName && (
                        <span className="ml-1 text-ink-500">· {line.party.displayName}</span>
                      )}
                      {line.entry.source !== "MANUAL" && (
                        <span className="ml-2 inline-flex align-middle">
                          <SourceBadge source={line.entry.source} />
                        </span>
                      )}
                    </TD>
                    <TD className="amount-cell text-right">
                      {debit.isZero() ? "" : formatMoney(debit)}
                    </TD>
                    <TD className="amount-cell text-right">
                      {credit.isZero() ? "" : formatMoney(credit)}
                    </TD>
                    <TD className={`amount-cell text-right ${moneyClass(balance)}`}>
                      {formatMoney(balance)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {canEdit ? (
        <EditAccountForm
          accountId={account.id}
          initialName={account.name}
          initialSubtype={account.subtype ?? ""}
          initialParentCode={account.parent?.code ?? ""}
          initialIsContra={account.isContra}
          initialIsControlAccount={account.isControlAccount}
          initialIsBank={account.isBank}
          initialActive={account.active}
          candidates={candidates}
        />
      ) : (
        <EmptyState
          title="Read-only"
          description="Editing accounts requires admin permission."
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-ink-500">{label}</div>
      <div className="mt-0.5 text-ink-900">{value}</div>
    </div>
  );
}
