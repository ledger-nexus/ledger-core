// Account-hierarchy helper. Pure functions — no DB.
//
// Charts of accounts are naturally hierarchical: 1000-1999 Current
// Assets contains 1000 Cash, 1200 AR, etc.; 1500-1599 Fixed Assets
// contains 1500 Equipment, 1510 Accumulated Depreciation. CPAs expect
// reports to render with hierarchical sub-totals — flat-listing every
// account looks like a spreadsheet, not a GL.
//
// The substrate's Account.parentAccountId column has always existed
// (since Phase 0) but was unused. This module turns a flat list of
// accounts-with-balances into a tree where each node knows its own
// balance, its children, and its recursive subtotal.
//
// Design notes:
//   - "Group" / "parent" accounts in real charts of accounts are
//     usually account-numbered (e.g. "1000-Current Assets"). They have
//     no journal-entry lines posted to them directly; their balance
//     comes purely from their children. We don't enforce that — a
//     parent CAN have its own lines, and the recursive total includes
//     both its own balance + every descendant.
//   - Cycles: the helper detects and refuses A → B → A loops. The
//     schema doesn't enforce DAG-ness; this is the defensive check.
//   - Orphans: an account whose parentAccountId points to a non-
//     existent or out-of-scope account becomes a root. Better than
//     silently dropping it from the tree.

import { Decimal } from "@/lib/utils/decimal";

export interface FlatAccountRow {
  /** Account.code, e.g. "1000". Used as the dedup + identity key. */
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  /** Parent's code (NOT id) — the helper resolves by code so it works
   *  cleanly with the dedup-by-code pattern reports already use. */
  parentCode: string | null;
  /** Account's own balance (already sign-normalized to the normal side). */
  balance: Decimal;
  /** Carried for downstream rendering (TB shows separate Dr / Cr cols). */
  debit: Decimal;
  credit: Decimal;
  isContra: boolean;
}

export interface HierarchyNode {
  code: string;
  name: string;
  type: FlatAccountRow["type"];
  /** Depth from root, 0-indexed. Root accounts have depth 0. */
  depth: number;
  /** This account's OWN balance, before adding children. */
  ownBalance: Decimal;
  ownDebit: Decimal;
  ownCredit: Decimal;
  isContra: boolean;
  /** Recursive subtotal: own + sum of every descendant's subtotal. */
  subtotalBalance: Decimal;
  subtotalDebit: Decimal;
  subtotalCredit: Decimal;
  /** Direct children. Sorted by code ascending. */
  children: HierarchyNode[];
  /** True iff the account has at least one descendant. Useful for the
   *  UI to decide between rendering as a leaf row vs a group header. */
  hasChildren: boolean;
}

/**
 * Build a hierarchical tree from a flat list of accounts. Returns the
 * root nodes (depth 0) in code-ascending order. Orphans (whose
 * parentCode references something not in the input) become roots.
 */
export function buildHierarchy(rows: FlatAccountRow[]): HierarchyNode[] {
  if (rows.length === 0) return [];

  // Cycle detection: BFS from each potential root and refuse any node
  // that references an ancestor of itself.
  detectCycles(rows);

  // 1. Materialize every row as a node with empty children + initial
  //    subtotal = own balance.
  const nodeByCode = new Map<string, HierarchyNode>();
  for (const row of rows) {
    nodeByCode.set(row.code, {
      code: row.code,
      name: row.name,
      type: row.type,
      depth: 0,
      ownBalance: row.balance,
      ownDebit: row.debit,
      ownCredit: row.credit,
      isContra: row.isContra,
      subtotalBalance: row.balance,
      subtotalDebit: row.debit,
      subtotalCredit: row.credit,
      children: [],
      hasChildren: false,
    });
  }

  // 2. Wire parent → child links. Track which nodes are NOT roots so we
  //    can identify the root set in step 3.
  const isChild = new Set<string>();
  for (const row of rows) {
    if (!row.parentCode) continue;
    const parent = nodeByCode.get(row.parentCode);
    const node = nodeByCode.get(row.code)!;
    if (!parent) {
      // Orphan — parent not in scope. Skip the link; the node becomes
      // a root in step 3.
      continue;
    }
    parent.children.push(node);
    parent.hasChildren = true;
    isChild.add(row.code);
  }

  // 3. The roots are nodes that nobody claimed as a child.
  const roots: HierarchyNode[] = [];
  for (const node of nodeByCode.values()) {
    if (!isChild.has(node.code)) roots.push(node);
  }

  // 4. Sort children at every level + compute depths.
  for (const root of roots) {
    assignDepthAndSort(root, 0);
  }
  roots.sort((a, b) => a.code.localeCompare(b.code));

  // 5. Recursive subtotal pass (post-order: children before parent).
  for (const root of roots) {
    rollUpSubtotals(root);
  }

  return roots;
}

function assignDepthAndSort(node: HierarchyNode, depth: number): void {
  node.depth = depth;
  node.children.sort((a, b) => a.code.localeCompare(b.code));
  for (const child of node.children) {
    assignDepthAndSort(child, depth + 1);
  }
}

function rollUpSubtotals(node: HierarchyNode): void {
  // Reset to own values, then add each child's recursive subtotal.
  node.subtotalBalance = node.ownBalance;
  node.subtotalDebit = node.ownDebit;
  node.subtotalCredit = node.ownCredit;
  for (const child of node.children) {
    rollUpSubtotals(child);
    node.subtotalBalance = node.subtotalBalance.plus(child.subtotalBalance);
    node.subtotalDebit = node.subtotalDebit.plus(child.subtotalDebit);
    node.subtotalCredit = node.subtotalCredit.plus(child.subtotalCredit);
  }
}

function detectCycles(rows: FlatAccountRow[]): void {
  const parentOf = new Map<string, string>();
  for (const row of rows) {
    if (row.parentCode) parentOf.set(row.code, row.parentCode);
  }
  for (const start of parentOf.keys()) {
    const seen = new Set<string>([start]);
    let cursor = parentOf.get(start);
    while (cursor) {
      if (seen.has(cursor)) {
        throw new Error(
          `Account hierarchy cycle detected involving "${cursor}". ` +
            "Fix the parentAccountId chain before generating reports."
        );
      }
      seen.add(cursor);
      cursor = parentOf.get(cursor);
    }
  }
}

/**
 * Flatten a hierarchy tree back into a depth-first row list, in the
 * order they should render: each group header, then its children
 * (recursively), then the next sibling. This is the shape report
 * tables iterate over.
 */
export function flattenForDisplay(roots: HierarchyNode[]): HierarchyNode[] {
  const out: HierarchyNode[] = [];
  const walk = (node: HierarchyNode): void => {
    out.push(node);
    for (const child of node.children) walk(child);
  };
  for (const root of roots) walk(root);
  return out;
}
