// Recurring entry detail — shows the template + every JE produced by it
// (looked up by the lineage triple). Admin-only "Run through [date]"
// gives a one-off way to catch a single template up without firing the
// global runner.

import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { getViewerRole } from "@/lib/auth/authorize";
import { canManageRecurringEntries } from "@/lib/auth/policy";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Decimal } from "@/lib/utils/decimal";
import { formatDate, formatMoney } from "@/lib/utils/format";
import { enumerateDueDates } from "@/lib/accounting/recurring";

export default async function RecurringDetail({
  params,
}: {
  params: { id: string };
}) {
  const tenant = await getCurrentTenant();
  if (!tenant) return notFound();
  const admin = canManageRecurringEntries(await getViewerRole());

  const t = await prisma.recurringEntry.findFirst({
    where: { id: params.id, tenantId: tenant.id },
    include: {
      entity: { select: { code: true, name: true } },
      book: { select: { code: true, name: true } },
      lines: { orderBy: { lineNo: "asc" } },
    },
  });
  if (!t) return notFound();

  // Every JE this template has produced. Lineage triple lookup —
  // sourceRecordId starts with "<templateId>:".
  const producedEntries = await prisma.journalEntry.findMany({
    where: {
      sourceSystem: "SUBSTRATE",
      sourceRecordType: "RecurringEntry",
      sourceRecordId: { startsWith: `${t.id}:` },
    },
    orderBy: { documentDate: "desc" },
    select: {
      id: true,
      entryNumber: true,
      documentDate: true,
      memo: true,
      status: true,
    },
  });

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const due = t.isActive
    ? enumerateDueDates({
        cadence: t.cadence,
        startDate: t.startDate,
        lastPostedDate: t.lastPostedDate,
        endDate: t.endDate,
        throughDate: today,
        snapToMonthEnd: t.kind === "ALLOCATION",
      })
    : [];

  const debitTotal = t.lines.reduce(
    (s, l) => s.plus(new Decimal(l.debit.toString())),
    new Decimal(0)
  );
  const creditTotal = t.lines.reduce(
    (s, l) => s.plus(new Decimal(l.credit.toString())),
    new Decimal(0)
  );

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-ink-500">
            <Link href="/recurring-entries" className="text-link hover:underline">
              ← Recurring entries
            </Link>
          </p>
          <h1 className="text-xl font-semibold text-ink-900 font-mono mt-1">{t.code}</h1>
          <p className="text-sm text-ink-500 mt-1">{t.memo}</p>
        </div>
        <div className="flex flex-col items-end gap-1 text-xs text-ink-500">
          {t.isActive ? (
            <Badge tone="positive">Active</Badge>
          ) : (
            <Badge tone="neutral">Paused</Badge>
          )}
          <span className="font-mono">
            {t.entity.code} · {t.book.code}
          </span>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Schedule</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <Field label="Cadence">
              <Badge tone="info">{t.cadence}</Badge>
            </Field>
            <Field label="Start">{formatDate(t.startDate)}</Field>
            <Field label="End">{t.endDate ? formatDate(t.endDate) : "—"}</Field>
            <Field label="Last posted">
              {t.lastPostedDate ? formatDate(t.lastPostedDate) : "—"}
            </Field>
            <Field label="Currency">{t.currencyId}</Field>
            <Field label="Entries produced">{producedEntries.length}</Field>
            <Field label="Periods due">
              {due.length > 0 ? (
                <span className="text-warning">{due.length}</span>
              ) : (
                <span className="text-ink-500">0</span>
              )}
            </Field>
            <Field label="Created by">{t.createdBy ?? "—"}</Field>
          </dl>
          {due.length > 0 && admin && (
            <p className="text-xs text-warning mt-3">
              Next {due.length} due date{due.length === 1 ? "" : "s"}:{" "}
              {due
                .slice(0, 6)
                .map((d) => d.toISOString().slice(0, 10))
                .join(", ")}
              {due.length > 6 ? "…" : ""}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Template lines ({t.lines.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <THead>
              <TR>
                <TH className="text-right">Line</TH>
                <TH>Account</TH>
                <TH>Description</TH>
                <TH className="text-right">Debit</TH>
                <TH className="text-right">Credit</TH>
              </TR>
            </THead>
            <TBody>
              {t.lines.map((l) => (
                <TR key={l.id}>
                  <TD className="text-right tabular-nums">{l.lineNo}</TD>
                  <TD className="font-mono text-xs">{l.accountCode}</TD>
                  <TD>{l.description ?? "—"}</TD>
                  <TD className="text-right font-mono">
                    {new Decimal(l.debit.toString()).greaterThan(0)
                      ? formatMoney(new Decimal(l.debit.toString()))
                      : ""}
                  </TD>
                  <TD className="text-right font-mono">
                    {new Decimal(l.credit.toString()).greaterThan(0)
                      ? formatMoney(new Decimal(l.credit.toString()))
                      : ""}
                  </TD>
                </TR>
              ))}
              <TR className="border-t-2 border-ink-200 font-medium">
                <TD colSpan={3}>Total</TD>
                <TD className="text-right font-mono">{formatMoney(debitTotal)}</TD>
                <TD className="text-right font-mono">{formatMoney(creditTotal)}</TD>
              </TR>
            </TBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Produced entries ({producedEntries.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {producedEntries.length === 0 ? (
            <p className="text-sm text-ink-500">
              No journal entries yet — none have fired against this template.
            </p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Entry #</TH>
                  <TH>Doc date</TH>
                  <TH>Memo</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {producedEntries.map((e) => (
                  <TR key={e.id}>
                    <TD className="font-mono text-xs">
                      <Link
                        href={`/journal-entries/${e.id}`}
                        className="text-link hover:underline"
                      >
                        {e.entryNumber}
                      </Link>
                    </TD>
                    <TD>{formatDate(e.documentDate)}</TD>
                    <TD className="max-w-md truncate" title={e.memo}>
                      {e.memo}
                    </TD>
                    <TD>
                      <Badge tone={e.status === "POSTED" ? "positive" : "neutral"}>
                        {e.status}
                      </Badge>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-ink-500">{label}</dt>
      <dd className="mt-0.5 text-ink-900">{children}</dd>
    </div>
  );
}
