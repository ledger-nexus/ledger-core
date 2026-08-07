"use client";

// Add a commodity; record a price. Both call gated + audited server actions —
// these forms supply input, they do not write.
//
// Kept side by side because the order matters and the UI should make that
// obvious: the symbol has to exist before a price (or a trade) can reference
// it. The price form's symbol field is a datalist of what's actually on file,
// so the "not on file" error is hard to reach by accident.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Select, Label } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  createCommodityAction,
  recordCommodityPriceAction,
} from "@/app/actions/manage-commodities";

const today = () => new Date().toISOString().slice(0, 10);

export default function CommodityForms({
  currencyCodes,
  knownSymbols,
}: {
  currencyCodes: string[];
  knownSymbols: string[];
}) {
  const router = useRouter();

  const [addPending, startAdd] = useTransition();
  const [addError, setAddError] = useState<string | null>(null);
  const [addOk, setAddOk] = useState<string | null>(null);
  const [symbol, setSymbol] = useState("");
  const [name, setName] = useState("");
  const [assetClass, setAssetClass] = useState("");

  const [pricePending, startPrice] = useTransition();
  const [priceError, setPriceError] = useState<string | null>(null);
  const [priceOk, setPriceOk] = useState<string | null>(null);
  const [priceSymbol, setPriceSymbol] = useState("");
  const [currencyCode, setCurrencyCode] = useState(
    currencyCodes.includes("USD") ? "USD" : (currencyCodes[0] ?? "USD")
  );
  const [asOf, setAsOf] = useState(today());
  const [price, setPrice] = useState("");

  function submitAdd() {
    setAddError(null);
    setAddOk(null);
    startAdd(async () => {
      const res = await createCommodityAction({ symbol, name, assetClass });
      if (!res.ok) {
        setAddError(res.message ?? "Could not add the commodity.");
        return;
      }
      setAddOk(`${symbol.trim().toUpperCase()} added.`);
      setSymbol("");
      setName("");
      setAssetClass("");
      router.refresh();
    });
  }

  function submitPrice() {
    setPriceError(null);
    setPriceOk(null);
    startPrice(async () => {
      const res = await recordCommodityPriceAction({
        symbol: priceSymbol,
        currencyCode,
        asOf,
        price,
      });
      if (!res.ok) {
        setPriceError(res.message ?? "Could not record the price.");
        return;
      }
      setPriceOk(
        `${priceSymbol.trim().toUpperCase()} marked at ${price} ${currencyCode} on ${asOf}.`
      );
      setPrice("");
      router.refresh();
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Add a commodity</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-ink-500">
            A symbol has to be on file before a trade can reference it. Symbols
            are stored uppercase, so <span className="font-mono">aapl</span> and{" "}
            <span className="font-mono">AAPL</span> are the same security rather
            than two half-positions.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="c-symbol">Symbol</Label>
              <Input
                id="c-symbol"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                placeholder="AAPL"
              />
            </div>
            <div>
              <Label htmlFor="c-name">Name</Label>
              <Input
                id="c-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Apple Inc."
              />
            </div>
            <div>
              <Label htmlFor="c-class">Asset class (optional)</Label>
              <Input
                id="c-class"
                value={assetClass}
                onChange={(e) => setAssetClass(e.target.value)}
                placeholder="EQUITY"
              />
            </div>
          </div>
          {addError && <p className="mt-4 text-sm text-negative">{addError}</p>}
          {addOk && <p className="mt-4 text-sm text-positive">{addOk}</p>}
          <div className="mt-4">
            <Button onClick={submitAdd} disabled={addPending}>
              {addPending ? "Adding…" : "Add commodity"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Record a price</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-ink-500">
            The price of one unit. Holdings marks a position on the latest price
            at or before the valuation date — until one exists, the position is
            reported at cost.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="p-symbol">Symbol</Label>
              <Input
                id="p-symbol"
                value={priceSymbol}
                onChange={(e) => setPriceSymbol(e.target.value)}
                placeholder="AAPL"
                list="known-symbols"
              />
              <datalist id="known-symbols">
                {knownSymbols.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </div>
            <div>
              <Label htmlFor="p-currency">Currency</Label>
              <Select
                id="p-currency"
                value={currencyCode}
                onChange={(e) => setCurrencyCode(e.target.value)}
              >
                {currencyCodes.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="p-asof">As of</Label>
              <Input
                id="p-asof"
                type="date"
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="p-price">Price per unit</Label>
              <Input
                id="p-price"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="187.4200"
              />
            </div>
          </div>
          {priceError && <p className="mt-4 text-sm text-negative">{priceError}</p>}
          {priceOk && <p className="mt-4 text-sm text-positive">{priceOk}</p>}
          <div className="mt-4">
            <Button onClick={submitPrice} disabled={pricePending}>
              {pricePending ? "Recording…" : "Record price"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
