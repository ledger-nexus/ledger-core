// "Ask your ledger" — the conversation layer over the read-only GL tools.
//
// The model's job is narrow: turn a plain-English question into calls to the
// deterministic tools in tools.ts, then phrase the answer using ONLY what
// those tools returned. It never sees the database and never computes a
// figure — the ledger is the source of every number, exactly as it is for
// the report pages. That mirrors the house rule one level up ("AI suggests;
// the system is the source of truth") applied to reads instead of posts.
//
// Degrades gracefully: with no ANTHROPIC_API_KEY the feature reports itself
// unconfigured instead of throwing, so the page renders fine on an instance
// that hasn't wired a key (e.g. a fresh personal install).

import Anthropic from "@anthropic-ai/sdk";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  TOOL_DEFS,
  executeTool,
  type AssistantScope,
} from "./tools";
import { readOnlyDb } from "./read-only-db";

const MODEL = "claude-opus-4-8";
// Each tool round-trip is one step; a handful is plenty for "look up the
// account, then read its balance". The cap is a runaway guard, not a budget.
const MAX_STEPS = 6;

export interface AskResult {
  /** False when no API key is set — the caller shows a "not configured" note. */
  configured: boolean;
  /** The natural-language answer, or an explanatory message when unavailable. */
  answer: string;
  /** Tool names the model consulted, for a "grounded in:" line in the UI. */
  consulted: string[];
  /** True when the model or API declined / errored (answer explains). */
  error?: boolean;
}

const NOT_CONFIGURED =
  "The assistant isn't set up on this instance yet — it needs an ANTHROPIC_API_KEY in the app's environment. Everything else in your ledger works without it; this is the only feature that calls out to Claude.";

function systemPrompt(scope: AssistantScope, today: string): string {
  return [
    "You are a careful, read-only assistant embedded in the user's own accounting ledger.",
    `You are answering about the books for entity ${scope.entityCode}, book ${scope.bookCode}. All amounts are in USD. Today is ${today}.`,
    "",
    "You have tools that read the ledger. Every number you state MUST come from a tool result — never estimate, infer, or carry a figure over from general knowledge. If you don't have a number, call a tool to get it.",
    "Balances are stated on each account's normal side: a positive number means more of what the account normally holds (a positive checking balance is cash on hand; a positive credit-card balance is money owed).",
    "If a tool returns an error or nothing relevant, say so plainly rather than guessing. If a question isn't about these books, say it's outside what you can see.",
    "Keep answers short and direct — lead with the figure or the direct answer, then at most a sentence of context. Format money with commas and a $ sign. You cannot change anything; you only read.",
  ].join("\n");
}

export async function askLedger(args: {
  prisma: PrismaClient | Prisma.TransactionClient;
  scope: AssistantScope;
  question: string;
  now: Date;
}): Promise<AskResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { configured: false, answer: NOT_CONFIGURED, consulted: [] };
  }

  const client = new Anthropic();
  const today = args.now.toISOString().slice(0, 10);
  const consulted = new Set<string>();

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: args.question },
  ];

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 2048,
        thinking: { type: "adaptive" },
        system: systemPrompt(args.scope, today),
        tools: TOOL_DEFS as unknown as Anthropic.Tool[],
        messages,
      });

      if (response.stop_reason === "refusal") {
        return {
          configured: true,
          error: true,
          answer:
            "I can't answer that one. Try rephrasing it as a question about your accounts, balances, or activity.",
          consulted: [...consulted],
        };
      }

      // Preserve the full assistant turn (including thinking blocks) — the
      // manual tool-use loop requires echoing content back verbatim.
      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason !== "tool_use") {
        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        return {
          configured: true,
          answer: text || "I don't have an answer for that.",
          consulted: [...consulted],
        };
      }

      // Execute every requested tool through a READ-ONLY view of the DB, so
      // the assistant's read-only contract is enforced by capability, not
      // convention — a tool that attempted a write would throw, never post.
      const roDb = readOnlyDb(args.prisma);
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        consulted.add(block.name);
        const result = await executeTool(
          roDb,
          args.scope,
          block.name,
          (block.input ?? {}) as Record<string, unknown>,
          args.now
        );
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
          is_error: "error" in result,
        });
      }
      messages.push({ role: "user", content: toolResults });
    }

    // Ran out of steps — the model kept reaching for tools without concluding.
    return {
      configured: true,
      error: true,
      answer:
        "That took more digging than I could finish in one pass. Try narrowing it — a specific account, or a specific month.",
      consulted: [...consulted],
    };
  } catch {
    // Never surface the raw error (it can carry request detail); never log the
    // question or any tool output (financial content).
    return {
      configured: true,
      error: true,
      answer: "I couldn't reach the assistant just now. Please try again.",
      consulted: [...consulted],
    };
  }
}
