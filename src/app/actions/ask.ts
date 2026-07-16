"use server";

// Server Action behind the /ask box.
//
// Scope is resolved SERVER-SIDE from the session (requireCurrentScope →
// tenant + entity + book) and handed to the assistant; the client sends only
// the question text, never a tenant/entity/book, so it can't widen the read.
// The action is read-only — it posts nothing and writes no audit row because
// it mutates nothing.

import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireCurrentScope } from "@/lib/scope";
import { askLedger, type AskResult } from "@/lib/assistant/ask";

const QuestionSchema = z
  .string()
  .trim()
  .min(1, "Ask a question first.")
  .max(500, "Keep the question under 500 characters.");

export async function askLedgerAction(rawQuestion: string): Promise<AskResult> {
  const parsed = QuestionSchema.safeParse(rawQuestion);
  if (!parsed.success) {
    return {
      configured: true,
      error: true,
      answer: parsed.error.issues[0]?.message ?? "Invalid question.",
      consulted: [],
    };
  }

  const scope = await requireCurrentScope();

  return askLedger({
    prisma,
    scope: {
      tenantId: scope.tenantId,
      entityCode: scope.entityCode,
      bookCode: scope.bookCode,
    },
    question: parsed.data,
    now: new Date(),
  });
}
