"use client";

// Paste-from-Excel JE form.
//
// Flow:
//   1. User sets entity / book / date / memo.
//   2. User pastes tab-separated lines into the textarea.
//   3. The parse runs CLIENT-SIDE (via a debounced call to the
//      previewPastedEntryAction Server Action) so the preview updates
//      live without a button press. Pure parse, no DB hit.
//   4. Preview shows: every line, running debit/credit totals, balance
//      badge, any per-row warnings/errors.
//   5. Post button enables only when (a) preview is clean and (b) all
//      header fields are filled. POST re-parses on the server (don't
//      trust the client) and routes through postJournalEntry.

import { useState, useEffect, useMemo, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Input, Label, Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  previewPastedEntryAction,
  postPastedEntryAction,
  type PreviewPastedEntryState,
} from "@/app/actions/paste-journal-entry";

interface EntityOption { code: string; name: string; }
interface BookOption { code: string; name: string; }

const EXAMPLE = `account	debit	credit	description
6000	80000		Gross salaries
6100	6400		Employer payroll taxes
6200	8000		Health & benefits
2100		10000	Withheld income tax
1010		84400	Net cash out`;

export default function PasteForm({
  entities,
  books,
  defaultEntityCode,
  defaultBookCode,
}: {
  entities: EntityOption[];
  books: BookOption[];
  defaultEntityCode: string;
  defaultBookCode: string;
}) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [entityCode, setEntityCode] = useState(defaultEntityCode);
  const [bookCode, setBookCode] = useState(defaultBookCode);
  const [documentDate, setDocumentDate] = useState(today);
  const [memo, setMemo] = useState("");
  const [pastedText, setPastedText] = useState("");
  const [preview, setPreview] = useState<PreviewPastedEntryState | null>(null);
  const [previewing, startPreview] = useTransition();
  const [posting, startPost] = useTransition();
  const [postError, setPostError] = useState<string | null>(null);
  const router = useRouter();

  // Debounce the preview by 200ms so each keystroke doesn't fire a
  // round-trip. The parser is cheap; the round-trip is what costs.
  useEffect(() => {
    if (!pastedText.trim()) {
      setPreview(null);
      return;
    }
    const timer = setTimeout(() => {
      startPreview(async () => {
        const r = await previewPastedEntryAction({ pastedText });
        setPreview(r);
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [pastedText]);

  const canPost =
    preview?.ok &&
    !!entityCode &&
    !!bookCode &&
    !!documentDate &&
    memo.trim().length > 0;

  function handlePost() {
    setPostError(null);
    startPost(async () => {
      const r = await postPastedEntryAction({
        pastedText,
        entityCode,
        bookCode,
        documentDate,
        memo: memo.trim(),
      });
      if (!r.ok) {
        setPostError(r.message ?? "Post failed.");
      } else if (r.entryId) {
        router.push(`/journal-entries/${r.entryId}`);
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Header</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <Label htmlFor="entity">Entity</Label>
              <Select
                id="entity"
                value={entityCode}
                onChange={(e) => setEntityCode(e.target.value)}
                required
              >
                {entities.map((e) => (
                  <option key={e.code} value={e.code}>
                    {e.code} — {e.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="book">Book</Label>
              <Select
                id="book"
                value={bookCode}
                onChange={(e) => setBookCode(e.target.value)}
                required
              >
                {books.map((b) => (
                  <option key={b.code} value={b.code}>
                    {b.code} — {b.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="documentDate">Document date</Label>
              <Input
                id="documentDate"
                type="date"
                value={documentDate}
                onChange={(e) => setDocumentDate(e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="memo">Memo</Label>
              <Input
                id="memo"
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                placeholder="May 2026 payroll"
                required
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Paste lines</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="text-xs text-ink-500 space-y-1">
            <p>
              Tab-separated, one line per row. Columns (header row optional):{" "}
              <code className="font-mono">account · debit · credit · description · party · item</code>.
              Negative numbers and (parens) are rejected — put the value on the
              other side instead. $1,234.56 and 1234.56 both work.
            </p>
            <p>
              <button
                type="button"
                className="text-link hover:underline"
                onClick={() => setPastedText(EXAMPLE)}
              >
                Load example payroll JE
              </button>
            </p>
          </div>
          <textarea
            value={pastedText}
            onChange={(e) => setPastedText(e.target.value)}
            className="w-full h-48 rounded-md border border-ink-200 bg-white p-3 font-mono text-xs focus:border-ink-300 focus:outline-none focus:ring-1 focus:ring-ink-300"
            placeholder="account&#9;debit&#9;credit&#9;description&#10;1000&#9;500&#9;&#9;Cash received&#10;4000&#9;&#9;500&#9;Revenue earned"
            spellCheck={false}
          />
        </CardContent>
      </Card>

      {preview && pastedText.trim() && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Preview
              {previewing ? (
                <Badge tone="neutral">Parsing…</Badge>
              ) : preview.isBalanced ? (
                <Badge tone="positive">Balanced</Badge>
              ) : (
                <Badge tone="negative">Not balanced</Badge>
              )}
              {preview.hadHeader && <Badge tone="info">Header detected</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {preview.errors && preview.errors.length > 0 && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3">
                <p className="text-sm font-medium text-red-700 mb-1">
                  {preview.errors.length} error{preview.errors.length === 1 ? "" : "s"}:
                </p>
                <ul className="text-xs text-red-700 list-disc list-inside space-y-0.5">
                  {preview.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            )}
            {preview.warnings && preview.warnings.length > 0 && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
                <p className="text-sm font-medium text-amber-700 mb-1">
                  {preview.warnings.length} warning{preview.warnings.length === 1 ? "" : "s"}:
                </p>
                <ul className="text-xs text-amber-700 list-disc list-inside space-y-0.5">
                  {preview.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
            {preview.lines && preview.lines.length > 0 && (
              <>
                <Table>
                  <THead>
                    <TR>
                      <TH>#</TH>
                      <TH>Account</TH>
                      <TH>Description</TH>
                      <TH>Party</TH>
                      <TH className="text-right">Debit</TH>
                      <TH className="text-right">Credit</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {preview.lines.map((l) => (
                      <TR key={l.rowNumber}>
                        <TD className="tabular-nums text-ink-500">{l.rowNumber}</TD>
                        <TD className="font-mono text-xs">{l.accountCode}</TD>
                        <TD className="max-w-xs truncate" title={l.description}>
                          {l.description || "—"}
                        </TD>
                        <TD className="font-mono text-xs">{l.partyCode || "—"}</TD>
                        <TD className="text-right font-mono">
                          {Number(l.debit) > 0 ? `$${l.debit}` : ""}
                        </TD>
                        <TD className="text-right font-mono">
                          {Number(l.credit) > 0 ? `$${l.credit}` : ""}
                        </TD>
                      </TR>
                    ))}
                    <TR className="border-t-2 border-ink-200 font-medium">
                      <TD colSpan={4}>
                        Total ({preview.lines.length} line
                        {preview.lines.length === 1 ? "" : "s"})
                      </TD>
                      <TD className="text-right font-mono">
                        ${preview.debitTotal}
                      </TD>
                      <TD className="text-right font-mono">
                        ${preview.creditTotal}
                      </TD>
                    </TR>
                  </TBody>
                </Table>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {postError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {postError}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button onClick={handlePost} disabled={!canPost || posting}>
          {posting ? "Posting…" : "Post journal entry"}
        </Button>
      </div>
    </div>
  );
}
