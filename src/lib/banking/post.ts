// Turn a reviewed bank line + a chosen category into the two balanced
// journal lines that post it.
//
// The bank line's sign convention is "positive = the bank/card account's
// balance went UP on its normal side" (see ParsedBankRow.amount). So:
//
//   - money the account gained (amount > 0) posts to the bank account's
//     NORMAL side; the category takes the opposite side.
//   - money the account lost (amount < 0) posts to the OPPOSITE side; the
//     category takes the normal side.
//
// Worked, with the category the user picked:
//   Checking (debit-normal), +1000 salary   → Dr Checking 1000 / Cr Salary
//   Checking, -50 groceries                  → Dr Groceries 50 / Cr Checking
//   Credit Card (credit-normal), +50 charge  → Dr Groceries 50 / Cr Card
//   Credit Card, -200 categorized to Checking→ Dr Card 200 / Cr Checking  (a transfer)
//
// Every case balances, and the category always moves in the direction that
// makes accounting sense (an expense goes up when you spend, income up when
// you're paid).

import { Decimal } from "@/lib/utils/decimal";

export interface CategorizationLine {
  accountCode: string;
  debit?: string;
  credit?: string;
  description?: string;
}

export function deriveCategorizationLines(input: {
  bankAccountCode: string;
  bankNormalIsDebit: boolean;
  categoryAccountCode: string;
  /** Signed on the bank account's normal side (positive = balance up). */
  amount: Decimal;
  description?: string;
}): [CategorizationLine, CategorizationLine] {
  const mag = input.amount.abs().toFixed(4);
  const up = input.amount.isPositive();

  // Which side the BANK line lands on.
  const bankOnNormalSide = up; // balance-up posts to the normal side
  const bankIsDebit = input.bankNormalIsDebit ? bankOnNormalSide : !bankOnNormalSide;

  const bankLine: CategorizationLine = {
    accountCode: input.bankAccountCode,
    ...(bankIsDebit ? { debit: mag } : { credit: mag }),
    description: input.description,
  };
  const categoryLine: CategorizationLine = {
    accountCode: input.categoryAccountCode,
    // Opposite side of the bank line, same magnitude — the entry balances.
    ...(bankIsDebit ? { credit: mag } : { debit: mag }),
    description: input.description,
  };
  return [bankLine, categoryLine];
}
