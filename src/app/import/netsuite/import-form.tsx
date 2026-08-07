"use client";

// NS import form.
//
// Flow:
//   1. User picks an entity mode (Single vs Multi-sub).
//   2. Single mode: user picks an entity from the dropdown.
//      Multi-sub mode: user types a prefix (e.g. "ACME") which becomes
//      "ACME_NS1", "ACME_NS2", ... per NS Subsidiary internalid.
//   3. User picks a book mode (Single vs Multi-book).
//      Single mode: user picks one book (defaults to US_GAAP).
//      Multi-book mode (v0.9 Phase 5): the form pre-parses the pasted
//      JSON to extract the AccountingBook[] array, then renders one
//      dropdown per NS book mapping NS internalid → ledger-core book.
//      Pattern 2 multi-book posts one JE per (entity, book) pair.
//   4. User pastes the NS export JSON OR uploads a .json file.
//   5. Submit. The Server Action runs importFromNs; results panel
//      shows what was created + a link to the consolidated TB report.
//
// File upload is just sugar around the textarea — reading the file
// client-side and copying its content into the textarea. We never
// upload binary blobs; the server only sees the JSON string. Keeps
// the Server Action surface narrow.

import { useState, useRef, useTransition, useMemo, ChangeEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  importNsAction,
  type ImportNsActionState,
} from "@/app/actions/import-netsuite";

interface EntityOption {
  code: string;
  name: string;
}
interface BookOption {
  code: string;
  name: string;
}

const SAMPLE_HINT = `Paste the contents of a NetSuite SuiteAnalytics export here. Required top-level keys: _meta, Account. Optional: Subsidiary, Customer, Vendor, Item, Invoice, VendorBill, CustomerPayment, VendorPayment, JournalEntry, Class, Department, Location, CustomSegment, CustomFieldDefinition.`;

export default function ImportForm({
  entities,
  books,
}: {
  entities: EntityOption[];
  books: BookOption[];
}) {
  const [mode, setMode] = useState<"single" | "multi">("multi");
  const [entityCode, setEntityCode] = useState(entities[0]?.code ?? "");
  const [entityCodePrefix, setEntityCodePrefix] = useState("");
  const [bookCode, setBookCode] = useState(
    books.find((b) => b.code === "US_GAAP")?.code ?? books[0]?.code ?? "US_GAAP"
  );
  // v0.9 Phase 5 — book mode + per-NS-book mapping. Default "single"
  // keeps the v0.6/v0.7/v0.8 UX unchanged for operators not using
  // multi-book NS imports.
  const [bookMode, setBookMode] = useState<"single" | "multi">("single");
  const [bookMapping, setBookMapping] = useState<Record<string, string>>({});
  const [exportJson, setExportJson] = useState("");
  const [result, setResult] = useState<ImportNsActionState | null>(null);
  const [importing, startImport] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // v0.9 Phase 5 — pre-parse the pasted JSON to extract the
  // AccountingBook[] array so we can render one mapping row per NS
  // book. The parse is best-effort: if the JSON is invalid or has no
  // AccountingBook, we return an empty array and the multi-book card
  // shows an explainer. Wrapped in useMemo so we don't re-parse on
  // every render — only when exportJson changes.
  const parsedNsBooks = useMemo((): Array<{
    internalid: string;
    name: string;
  }> => {
    if (exportJson.trim().length === 0) return [];
    try {
      const p = JSON.parse(exportJson) as { AccountingBook?: unknown };
      if (!Array.isArray(p.AccountingBook)) return [];
      return p.AccountingBook.filter(
        (b): b is { internalid: string; name: string } =>
          typeof b === "object" &&
          b !== null &&
          typeof (b as { internalid?: unknown }).internalid === "string" &&
          typeof (b as { name?: unknown }).name === "string"
      ).map((b) => ({ internalid: b.internalid, name: b.name }));
    } catch {
      return [];
    }
  }, [exportJson]);

  // Read a chosen file into the textarea. We never POST the file
  // directly — it's just a convenience over paste.
  function onFileChange(e: ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result;
      if (typeof text === "string") setExportJson(text);
    };
    reader.readAsText(file);
  }

  // Multi-sub prefix validation. Letters/digits/underscore only;
  // the resulting LegalEntity.code goes into a [tenantId, code] unique
  // constraint, so disallow spaces + slashes that would break the
  // composite key + URL routing later.
  const prefixValid = /^[A-Z0-9_]{1,16}$/i.test(entityCodePrefix);
  // v0.9 Phase 5 — multi-book is submittable when every parsed NS book
  // has a non-empty mapping value. The Server Action does shape +
  // existence validation; the UI guards against the "I forgot to map
  // one" case so the form doesn't bounce off the action.
  const bookMappingComplete =
    bookMode === "single"
      ? true
      : parsedNsBooks.length > 0 &&
        parsedNsBooks.every(
          (b) => (bookMapping[b.internalid] ?? "").length > 0
        );
  const canSubmit =
    !importing &&
    exportJson.trim().length > 0 &&
    (bookMode === "single" ? bookCode.length > 0 : bookMappingComplete) &&
    (mode === "single"
      ? entityCode.length > 0
      : prefixValid);

  function onSubmit(): void {
    setResult(null);
    startImport(async () => {
      const r = await importNsAction({
        exportJson,
        mode,
        entityCode: mode === "single" ? entityCode : undefined,
        entityCodePrefix: mode === "multi" ? entityCodePrefix : undefined,
        // Single-book mode: send the picked book code. Multi-book mode:
        // send the discriminator + the mapping. The action's input type
        // accepts both shapes; only one is read per bookMode.
        bookMode,
        bookCode: bookMode === "single" ? bookCode : undefined,
        bookMapping: bookMode === "multi" ? bookMapping : undefined,
      });
      setResult(r);
      if (r.ok) {
        // Force a re-fetch on the next page navigation so the new
        // entities show up in the scope switcher and the consolidation
        // page sees them.
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Entity resolution</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setMode("multi")}
                className={
                  "rounded-md border px-3 py-2 text-sm transition-colors " +
                  (mode === "multi"
                    ? "border-ink-900 bg-ink-900 text-white"
                    : "border-ink-200 bg-white text-ink-700 hover:border-ink-400")
                }
              >
                Multi-subsidiary
                <span className="ml-2 text-[11px] uppercase opacity-70">
                  one entity per NS sub
                </span>
              </button>
              <button
                type="button"
                onClick={() => setMode("single")}
                className={
                  "rounded-md border px-3 py-2 text-sm transition-colors " +
                  (mode === "single"
                    ? "border-ink-900 bg-ink-900 text-white"
                    : "border-ink-200 bg-white text-ink-700 hover:border-ink-400")
                }
              >
                Single entity
                <span className="ml-2 text-[11px] uppercase opacity-70">
                  collapse subs
                </span>
              </button>
            </div>
            {mode === "single" ? (
              <div className="max-w-sm">
                <Label htmlFor="entity-code">Destination entity</Label>
                <Select
                  id="entity-code"
                  value={entityCode}
                  onChange={(e) => setEntityCode(e.target.value)}
                >
                  {entities.map((e) => (
                    <option key={e.code} value={e.code}>
                      {e.code} — {e.name}
                    </option>
                  ))}
                </Select>
                <p className="mt-1 text-xs text-ink-500">
                  Every NS transaction will land in this entity. Use this
                  when you don't care about per-sub reporting.
                </p>
              </div>
            ) : (
              <div className="max-w-sm">
                <Label htmlFor="entity-prefix">Entity code prefix</Label>
                <Input
                  id="entity-prefix"
                  value={entityCodePrefix}
                  onChange={(e) =>
                    setEntityCodePrefix(e.target.value.toUpperCase())
                  }
                  placeholder="ACME"
                  maxLength={16}
                />
                <p className="mt-1 text-xs text-ink-500">
                  Each NS Subsidiary becomes a LegalEntity with code{" "}
                  <code className="rounded bg-ink-100 px-1">
                    {entityCodePrefix || "ACME"}_NS&lt;internalid&gt;
                  </code>
                  . Letters, digits, underscores; max 16 chars.
                </p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Book strategy</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setBookMode("single")}
                className={
                  "rounded-md border px-3 py-2 text-sm transition-colors " +
                  (bookMode === "single"
                    ? "border-ink-900 bg-ink-900 text-white"
                    : "border-ink-200 bg-white text-ink-700 hover:border-ink-400")
                }
              >
                Single book
                <span className="ml-2 text-[11px] uppercase opacity-70">
                  collapse to one
                </span>
              </button>
              <button
                type="button"
                onClick={() => setBookMode("multi")}
                className={
                  "rounded-md border px-3 py-2 text-sm transition-colors " +
                  (bookMode === "multi"
                    ? "border-ink-900 bg-ink-900 text-white"
                    : "border-ink-200 bg-white text-ink-700 hover:border-ink-400")
                }
              >
                Multi-book
                <span className="ml-2 text-[11px] uppercase opacity-70">
                  per NS AccountingBook
                </span>
              </button>
            </div>
            {bookMode === "single" ? (
              <div className="max-w-sm">
                <Label htmlFor="book-code">Book</Label>
                <Select
                  id="book-code"
                  value={bookCode}
                  onChange={(e) => setBookCode(e.target.value)}
                >
                  {books.map((b) => (
                    <option key={b.code} value={b.code}>
                      {b.code} — {b.name}
                    </option>
                  ))}
                </Select>
                <p className="mt-1 text-xs text-ink-500">
                  Every NS transaction posts to this one book. If the NS
                  export has multiple AccountingBook entries, they collapse
                  into this book (you lose per-book divergence).
                </p>
              </div>
            ) : (
              <BookMappingEditor
                parsedNsBooks={parsedNsBooks}
                bookMapping={bookMapping}
                setBookMapping={setBookMapping}
                books={books}
                exportJsonEmpty={exportJson.trim().length === 0}
              />
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>NS export</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                onChange={onFileChange}
                className="text-xs file:mr-3 file:rounded-md file:border-0 file:bg-ink-100 file:px-3 file:py-1.5 file:text-sm hover:file:bg-ink-200"
              />
              <span className="text-xs text-ink-500">
                or paste below
              </span>
            </div>
            <textarea
              value={exportJson}
              onChange={(e) => setExportJson(e.target.value)}
              placeholder={SAMPLE_HINT}
              rows={12}
              className="w-full rounded-md border border-ink-200 bg-white p-3 font-mono text-xs text-ink-900 placeholder:text-ink-500 focus:border-ink-400 focus:outline-none"
            />
            <div className="text-xs text-ink-500">
              {(exportJson.length / 1024).toFixed(1)} KB
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={onSubmit} disabled={!canSubmit}>
          {importing ? "Importing…" : "Run import"}
        </Button>
        {!canSubmit && !importing && (
          <span className="text-xs text-ink-500">
            {mode === "multi" && !prefixValid && entityCodePrefix.length > 0
              ? "Prefix must be 1–16 letters/digits/underscores."
              : exportJson.trim().length === 0
                ? "Paste or upload an NS export first."
                : bookMode === "multi" && parsedNsBooks.length === 0
                  ? "Multi-book mode needs an AccountingBook[] in the JSON."
                  : bookMode === "multi" && !bookMappingComplete
                    ? "Map every NS book to a ledger-core book first."
                    : "Fill in the required fields above."}
          </span>
        )}
      </div>

      {result && <ResultPanel result={result} mode={mode} />}
    </div>
  );
}

function ResultPanel({
  result,
  mode,
}: {
  result: ImportNsActionState;
  mode: "single" | "multi";
}) {
  if (result.ok === false) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            <Badge tone="negative">Import failed</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-ink-900">{result.error}</p>
          {result.warnings && result.warnings.length > 0 && (
              <div className="mt-3">
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-500">
                  Warnings
                </div>
                <ul className="list-disc pl-5 text-xs text-ink-700">
                  {result.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
        </CardContent>
      </Card>
    );
  }
  if (!result.ok) return null;

  const consolidationHref =
    mode === "multi" && result.entityCodes.length > 0
      ? `/reports/consolidation?root=${result.entityCodes[0]}&asOf=${new Date()
          .toISOString()
          .slice(0, 10)}`
      : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Badge tone="positive">Import complete</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-3">
          <Stat label="Subsidiaries upserted" value={result.subsidiariesUpserted} />
          <Stat
            label="Accounts"
            value={`${result.accountsImported} new / ${result.accountsSkipped} reused`}
          />
          <Stat
            label="Parties"
            value={`${result.partiesImported} new / ${result.partiesSkipped} reused`}
          />
          <Stat
            label="Items"
            value={`${result.itemsImported} new / ${result.itemsSkipped} reused`}
          />
          <Stat
            label="Journal entries"
            value={`${result.journalEntriesImported} new / ${result.journalEntriesSkipped} reused`}
          />
          <Stat label="AR open items" value={result.arOpenItemsOpened} />
          <Stat label="AP open items" value={result.apOpenItemsOpened} />
          <Stat label="Payments applied" value={result.paymentsApplied} />
          <Stat label="Dimensions created" value={result.dimensionsCreated} />
          <Stat
            label="Custom fields"
            value={result.customFieldsRegistered}
          />
        </div>

        {result.entityCodes.length > 0 && (
          <div className="mt-4">
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-500">
              Entities created / updated
            </div>
            <div className="flex flex-wrap gap-1.5">
              {result.entityCodes.map((c) => (
                <code
                  key={c}
                  className="rounded bg-white px-2 py-0.5 text-xs text-ink-900 ring-1 ring-ink-200"
                >
                  {c}
                </code>
              ))}
            </div>
          </div>
        )}

        {result.warnings.length > 0 && (
          <div className="mt-4">
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-500">
              Warnings ({result.warnings.length})
            </div>
            <ul className="list-disc pl-5 text-xs text-ink-700">
              {result.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        {consolidationHref && (
          <div className="mt-5">
            <Link
              href={consolidationHref}
              className="inline-flex items-center gap-1.5 rounded-md bg-ink-900 px-3 py-1.5 text-sm text-white transition-colors hover:bg-ink-700"
            >
              Open consolidated TB →
            </Link>
            <span className="ml-2 text-xs text-ink-500">
              Walks the {result.entityCodes.length}-entity hierarchy with
              intercompany elimination subtypes.
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-ink-500">
        {label}
      </div>
      <div className="text-sm font-medium text-ink-900">{value}</div>
    </div>
  );
}

// v0.9 Phase 5 — multi-book mapping editor. Renders one row per parsed
// NS AccountingBook with a dropdown to pick the destination ledger-core
// Book. Pure presentational; all state lives in the parent.
function BookMappingEditor({
  parsedNsBooks,
  bookMapping,
  setBookMapping,
  books,
  exportJsonEmpty,
}: {
  parsedNsBooks: Array<{ internalid: string; name: string }>;
  bookMapping: Record<string, string>;
  setBookMapping: (m: Record<string, string>) => void;
  books: BookOption[];
  exportJsonEmpty: boolean;
}) {
  if (exportJsonEmpty) {
    return (
      <p className="text-xs text-ink-500">
        Paste an NS export below; the AccountingBook[] entries will
        appear here so you can map each one to a ledger-core book.
      </p>
    );
  }
  if (parsedNsBooks.length === 0) {
    return (
      <p className="text-xs text-amber-700">
        No <code className="rounded bg-ink-100 px-1">AccountingBook</code>{" "}
        array found in the pasted JSON. Either re-export from NS with
        AccountingBook included, or switch to single-book mode.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-ink-500">
        {parsedNsBooks.length} NS book{parsedNsBooks.length === 1 ? "" : "s"}{" "}
        found. Map each to a ledger-core book. Multiple NS books may fold
        into one ledger-core book (e.g. an NS adjustment book folded into
        the parent).
      </p>
      <div className="flex flex-col gap-1.5">
        {parsedNsBooks.map((b) => (
          <div
            key={b.internalid}
            className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-md border border-ink-100 bg-white px-2 py-1.5"
          >
            <div className="min-w-0">
              <div className="truncate text-sm text-ink-900">{b.name}</div>
              <div className="text-[11px] uppercase tracking-wide text-ink-500">
                NS internalid {b.internalid}
              </div>
            </div>
            <div className="text-ink-500">→</div>
            <div>
              <Select
                value={bookMapping[b.internalid] ?? ""}
                onChange={(e) =>
                  setBookMapping({
                    ...bookMapping,
                    [b.internalid]: e.target.value,
                  })
                }
              >
                <option value="">— pick a book —</option>
                {books.map((opt) => (
                  <option key={opt.code} value={opt.code}>
                    {opt.code} — {opt.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
