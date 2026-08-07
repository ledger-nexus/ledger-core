"use client";

// Record a balance assertion. Calls createBalanceAssertionAction, which is the
// gated + audited entry point — this form supplies input, it does not write.
//
// Entity and book come from the active scope rather than form fields: an
// assertion filed against a different (entity, book) than the one on screen
// would silently never appear in the table above it.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createBalanceAssertionAction } from "@/app/actions/create-balance-assertion";

const today = () => new Date().toISOString().slice(0, 10);

export default function AssertionForm({
  entityCode,
  bookCode,
}: {
  entityCode: string;
  bookCode: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [accountCode, setAccountCode] = useState("");
  const [asOf, setAsOf] = useState(today());
  const [expectedAmount, setExpectedAmount] = useState("");
  const [tolerance, setTolerance] = useState("");

  function submit() {
    setError(null);
    setSuccess(null);
    startTransition(async () => {
      const res = await createBalanceAssertionAction({
        entityCode,
        bookCode,
        accountCode,
        asOf,
        expectedAmount,
        tolerance: tolerance.trim() === "" ? undefined : tolerance,
      });
      if (!res.ok) {
        // Surface the action's own message — "Unknown account 1234",
        // "already exists on that date" — rather than a generic failure.
        setError(res.message ?? "Could not record the assertion.");
        return;
      }
      setSuccess(`Assertion recorded for ${accountCode} as of ${asOf}.`);
      setAccountCode("");
      setExpectedAmount("");
      setTolerance("");
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Assert a balance</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-4 text-sm text-ink-500">
          State what {entityCode} · {bookCode} held on a date. Enter the amount
          on the account&rsquo;s normal side — a positive figure for a cash
          balance, a positive figure for a loan you owe. The date is inclusive:
          everything posted on or before it counts.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="assert-account">Account code</Label>
            <Input
              id="assert-account"
              value={accountCode}
              onChange={(e) => setAccountCode(e.target.value)}
              placeholder="1000"
            />
          </div>
          <div>
            <Label htmlFor="assert-asof">As of</Label>
            <Input
              id="assert-asof"
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="assert-amount">Expected balance</Label>
            <Input
              id="assert-amount"
              value={expectedAmount}
              onChange={(e) => setExpectedAmount(e.target.value)}
              placeholder="12500.00"
            />
          </div>
          <div>
            <Label htmlFor="assert-tolerance">Tolerance (optional)</Label>
            <Input
              id="assert-tolerance"
              value={tolerance}
              onChange={(e) => setTolerance(e.target.value)}
              placeholder="0.01"
            />
          </div>
        </div>

        {error && <p className="mt-4 text-sm text-negative">{error}</p>}
        {success && <p className="mt-4 text-sm text-positive">{success}</p>}

        <div className="mt-4">
          <Button onClick={submit} disabled={pending}>
            {pending ? "Recording…" : "Record assertion"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
