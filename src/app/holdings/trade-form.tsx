"use client";

// Record a securities trade. Calls recordCommodityTradeAction, which is the
// gated + audited entry point — this form supplies input, it does not post.
//
// The gain/loss account fields only appear for a SELL: a purchase has no
// realized result to book, and asking for accounts you don't need is noise.
// A failed trade shows the substrate's own message (insufficient units, closed
// period, unknown account) rather than a generic error — those messages are
// the useful part.

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select, Label } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  recordCommodityTradeAction,
  type RecordCommodityTradeInput,
} from "@/app/actions/record-commodity-trade";

const today = () => new Date().toISOString().slice(0, 10);

export default function TradeForm() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [symbol, setSymbol] = useState("");
  const [units, setUnits] = useState("");
  const [price, setPrice] = useState("");
  const [currencyCode, setCurrencyCode] = useState("USD");
  const [tradeDate, setTradeDate] = useState(today());
  const [investmentAccountCode, setInvestmentAccountCode] = useState("");
  const [cashAccountCode, setCashAccountCode] = useState("");
  const [gainAccountCode, setGainAccountCode] = useState("");
  const [lossAccountCode, setLossAccountCode] = useState("");
  const [method, setMethod] = useState<"FIFO" | "LIFO" | "STRICT">("FIFO");

  function submit() {
    setError(null);
    setSuccess(null);
    const input: RecordCommodityTradeInput = {
      side,
      commoditySymbol: symbol,
      units,
      price,
      currencyCode,
      tradeDate,
      investmentAccountCode,
      cashAccountCode,
      ...(side === "SELL"
        ? { gainAccountCode, lossAccountCode, method }
        : {}),
    };
    startTransition(async () => {
      const r = await recordCommodityTradeAction(input);
      if (r.ok) {
        setSuccess(r.message ?? "Trade recorded.");
        setUnits("");
        setPrice("");
      } else {
        setError(r.message ?? "Trade failed");
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Record a trade</CardTitle>
        <span className="text-xs text-ink-500">
          Posts through the ledger and opens or draws down cost-basis lots.
        </span>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <Label htmlFor="side">Side</Label>
            <Select id="side" value={side} onChange={(e) => setSide(e.target.value as "BUY" | "SELL")}>
              <option value="BUY">Buy</option>
              <option value="SELL">Sell</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="symbol">Symbol</Label>
            <Input id="symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="AAPL" />
          </div>
          <div>
            <Label htmlFor="units">Units</Label>
            <Input id="units" value={units} onChange={(e) => setUnits(e.target.value)} placeholder="10" inputMode="decimal" />
          </div>
          <div>
            <Label htmlFor="price">{side === "BUY" ? "Cost / unit" : "Sale price / unit"}</Label>
            <Input id="price" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="100.00" inputMode="decimal" />
          </div>
          <div>
            <Label htmlFor="tradeDate">Trade date</Label>
            <Input id="tradeDate" type="date" value={tradeDate} onChange={(e) => setTradeDate(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="currencyCode">Currency</Label>
            <Input id="currencyCode" value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="investmentAccountCode">Investment account</Label>
            <Input
              id="investmentAccountCode"
              value={investmentAccountCode}
              onChange={(e) => setInvestmentAccountCode(e.target.value)}
              placeholder="1500"
            />
          </div>
          <div>
            <Label htmlFor="cashAccountCode">Cash account</Label>
            <Input
              id="cashAccountCode"
              value={cashAccountCode}
              onChange={(e) => setCashAccountCode(e.target.value)}
              placeholder="1000"
            />
          </div>

          {side === "SELL" && (
            <>
              <div>
                <Label htmlFor="gainAccountCode">Gain account</Label>
                <Input id="gainAccountCode" value={gainAccountCode} onChange={(e) => setGainAccountCode(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="lossAccountCode">Loss account</Label>
                <Input id="lossAccountCode" value={lossAccountCode} onChange={(e) => setLossAccountCode(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="method">Lot method</Label>
                <Select
                  id="method"
                  value={method}
                  onChange={(e) => setMethod(e.target.value as "FIFO" | "LIFO" | "STRICT")}
                >
                  <option value="FIFO">FIFO</option>
                  <option value="LIFO">LIFO</option>
                  <option value="STRICT">Strict</option>
                </Select>
              </div>
            </>
          )}
        </div>

        <div className="mt-4 flex items-center gap-3">
          <Button onClick={submit} disabled={pending}>
            {pending ? "Recording…" : side === "BUY" ? "Record purchase" : "Record sale"}
          </Button>
          {error ? <span className="text-xs text-negative">{error}</span> : null}
          {success ? <span className="text-xs text-positive">{success}</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}
