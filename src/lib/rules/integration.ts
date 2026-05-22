// Rules engine ↔ record-lifecycle integration.
//
// The engine in src/lib/rules/executor.ts decides; this module connects it
// to actual record events. A Server Action or sub-ledger helper that creates
// or updates a record calls into this module to fire the appropriate rules
// and apply any reassignment that results.
//
// Pattern:
//
//   1. The caller creates/updates the record normally.
//   2. The caller passes the resulting record + trigger context to
//      `fireRulesForRecord()`.
//   3. This module: loads active rules for that recordType + trigger,
//      runs the executor, and if a rule matches, calls `reassignRecord`
//      with lockFromRules=false (rule-fired reassignments don't lock).
//   4. Returns a small result so the caller can log + surface failures.
//
// This module ALSO handles loading rules from the DB and converting the
// stored shape (with criteriaJson as Json) into the typed Rule shape the
// executor expects.

import { PrismaClient } from "@prisma/client";
import { execute, type ExecutionResult } from "./executor";
import {
  type Rule,
  type Clause,
  type RecordLike,
  type TriggerContext,
  type TriggerType,
  type Target,
} from "./types";
import {
  reassignRecord,
  ReassignError,
  type ReassignableRecordType,
} from "../ownership/reassign";

export interface FireRulesInput {
  recordType: ReassignableRecordType;
  recordId: string;
  /** The resolved record + any joined parent objects the rules reference. */
  record: RecordLike;
  triggerContext: TriggerContext;
  /** Acting user — "system" for engine-fired (most common here). */
  actorUserId: string;
}

export interface FireRulesResult {
  /** ExecutionResult from the executor — for diagnostics. */
  execution: ExecutionResult;
  /** Whether reassignment actually happened. */
  reassigned: boolean;
  /** New owner, if reassigned. */
  newOwner?: Target;
  /** Reassignment failure, if any — non-fatal; logged. */
  reassignError?: { code: string; message: string };
}

export async function fireRulesForRecord(
  prisma: PrismaClient,
  input: FireRulesInput
): Promise<FireRulesResult> {
  // Load active rules for this recordType+trigger, sorted by priority.
  const rules = await loadActiveRules(prisma, input.recordType, input.triggerContext.type);
  const execution = execute(input.record, input.triggerContext, rules);

  if (!execution.result || !execution.result.target) {
    return { execution, reassigned: false };
  }

  // A rule matched. Apply the reassignment.
  try {
    await reassignRecord(prisma, {
      recordType: input.recordType,
      recordId: input.recordId,
      newOwner: execution.result.target,
      actorUserId: input.actorUserId,
      reason: `rule:${execution.result.ruleId}:v${execution.result.ruleVersion}`,
      // Rule-fired reassignments DO NOT lock the record. Only manual
      // reassignments lock — otherwise rules couldn't refine assignment
      // as a record moves through workflow states.
      lockFromRules: false,
    });
    return {
      execution,
      reassigned: true,
      newOwner: execution.result.target,
    };
  } catch (e) {
    if (e instanceof ReassignError) {
      return {
        execution,
        reassigned: false,
        reassignError: { code: e.code, message: e.message },
      };
    }
    return {
      execution,
      reassigned: false,
      reassignError: {
        code: "UNKNOWN",
        message: e instanceof Error ? e.message : "Unknown error",
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule loading from the DB
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Loads the active rule set for a (recordType, trigger) tuple, ordered by
 * priority ASC. Converts the stored Json criteria/triggerFields into the
 * typed Rule shape the executor expects.
 *
 * Cached by application convention; for v1 we re-query per fire. Move to
 * a per-process cache (invalidated on rule writes) when the firing rate
 * justifies it.
 */
export async function loadActiveRules(
  prisma: PrismaClient,
  recordType: string,
  trigger: TriggerType
): Promise<Rule[]> {
  const rows = await prisma.reassignmentRule.findMany({
    where: { recordType, trigger, isActive: true },
    orderBy: { priority: "asc" },
  });

  const rules: Rule[] = [];
  for (const row of rows) {
    if (row.ruleType === "DECLARATIVE") {
      if (!row.criteriaJson || !row.targetType || !row.targetId) {
        // Malformed declarative rule — skip with a console warn. Validator
        // should have caught this at write time; defensive in case of
        // direct DB edits.
        console.warn(
          `Skipping malformed declarative rule ${row.ruleId} v${row.ruleVersion}`
        );
        continue;
      }
      rules.push({
        ruleType: "DECLARATIVE",
        ruleId: row.ruleId,
        ruleVersion: row.ruleVersion,
        recordType: row.recordType,
        trigger: row.trigger as TriggerType,
        triggerFields: row.triggerFields,
        triggerStateFrom: row.triggerStateFrom ?? undefined,
        triggerStateTo: row.triggerStateTo ?? undefined,
        triggerLifecycleEvent:
          (row.triggerLifecycleEvent as TriggerContext["lifecycleEvent"]) ?? undefined,
        triggerSchedule: row.triggerSchedule ?? undefined,
        priority: row.priority,
        criteria: row.criteriaJson as unknown as Clause,
        target: { type: row.targetType, id: row.targetId },
        isActive: row.isActive,
      });
    } else if (row.ruleType === "CODE") {
      if (!row.codeImplementation) {
        console.warn(`Skipping malformed code rule ${row.ruleId} v${row.ruleVersion}`);
        continue;
      }
      rules.push({
        ruleType: "CODE",
        ruleId: row.ruleId,
        ruleVersion: row.ruleVersion,
        recordType: row.recordType,
        trigger: row.trigger as TriggerType,
        triggerFields: row.triggerFields,
        triggerStateFrom: row.triggerStateFrom ?? undefined,
        triggerStateTo: row.triggerStateTo ?? undefined,
        triggerLifecycleEvent:
          (row.triggerLifecycleEvent as TriggerContext["lifecycleEvent"]) ?? undefined,
        triggerSchedule: row.triggerSchedule ?? undefined,
        priority: row.priority,
        codeImplementation: row.codeImplementation,
        isActive: row.isActive,
      });
    }
  }
  return rules;
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience wrapper for ON_INSERT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Helper for the common case: a record was just inserted, fire ON_INSERT
 * rules against it. The caller passes the freshly-created record (already
 * loaded with whatever parent joins the rules might reference).
 */
export async function fireInsertRules(
  prisma: PrismaClient,
  recordType: ReassignableRecordType,
  recordId: string,
  record: RecordLike,
  actorUserId: string
): Promise<FireRulesResult> {
  return fireRulesForRecord(prisma, {
    recordType,
    recordId,
    record,
    triggerContext: { type: "ON_INSERT" },
    actorUserId,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience wrapper for ON_UPDATE
// ─────────────────────────────────────────────────────────────────────────────

export async function fireUpdateRules(
  prisma: PrismaClient,
  recordType: ReassignableRecordType,
  recordId: string,
  record: RecordLike,
  changedFields: string[],
  actorUserId: string
): Promise<FireRulesResult> {
  return fireRulesForRecord(prisma, {
    recordType,
    recordId,
    record,
    triggerContext: { type: "ON_UPDATE", changedFields },
    actorUserId,
  });
}
