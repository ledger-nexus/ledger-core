// Environment-variable validation at startup.
//
// SOC 2 CC6/CC7 expectation: production deployments must fail closed
// when critical secrets are missing rather than running in a degraded
// mode that silently bypasses controls. This module runs at module-
// load time of any caller — when imported in a Server Component or
// Server Action, it executes during Next.js's first request to that
// route, and crashes the process before serving a broken endpoint.
//
// Three categories of vars:
//
//   - REQUIRED_IN_PRODUCTION: the app cannot serve safely without these.
//     Missing → throw. Crashes the build/runtime. Examples: DATABASE_URL,
//     AUTH_STUB_SECRET (until real auth lands).
//
//   - REQUIRED_FOR_FEATURE: a specific feature won't work but the rest
//     of the app is fine. Missing → log a warning, feature disables
//     itself at use-time. Examples: INTERNAL_API_TOKEN (companion-repo
//     bridge endpoints return 503), ANTHROPIC_API_KEY (AI surfaces
//     return "key not set" errors).
//
//   - DEV_DEFAULTS: env vars with safe development fallbacks. Examples:
//     LEDGER_CORE_URL (defaults to http://localhost:3000).
//
// This file SHOULD be imported from src/instrumentation.ts so it runs
// on every Next.js startup, prod or dev. The instrumentation hook is
// the standard Next.js mechanism for boot-time work.

interface EnvSpec {
  name: string;
  requiredInProduction: boolean;
  minLength?: number;
  description: string;
}

const ENV_SPECS: EnvSpec[] = [
  {
    name: "DATABASE_URL",
    requiredInProduction: true,
    description: "Postgres connection string. Pooled URL required for Vercel deploys.",
  },
  {
    name: "AUTH_STUB_SECRET",
    requiredInProduction: true,
    minLength: 16,
    description:
      "HMAC secret for the dev-only auth cookie. Min 16 chars. " +
      "v0.4: will be removed when Clerk/NextAuth replaces the stub.",
  },
  {
    name: "INTERNAL_API_TOKEN",
    requiredInProduction: false, // endpoint disables itself if unset
    minLength: 32,
    description:
      "Gates POST /api/internal/* endpoints. If unset, those endpoints " +
      "return 503 (fail-closed); the rest of the app still works.",
  },
  {
    name: "ADMIN_TOKEN",
    requiredInProduction: false,
    minLength: 32,
    description:
      "Gates POST /api/admin/reset. If unset, the reset endpoint returns 503.",
  },
  // Clerk auth — when both keys are present, the Clerk path activates
  // (see src/lib/auth/clerk.ts isClerkEnabled). When either is missing,
  // we fall back to the dev cookie stub. Marked REQUIRED_FOR_FEATURE
  // (not REQUIRED_IN_PRODUCTION) until SOC2_ROADMAP Phase 1 lands —
  // at that point this becomes a production-required pair.
  {
    name: "CLERK_SECRET_KEY",
    requiredInProduction: false,
    minLength: 32,
    description:
      "Clerk server-side secret key (sk_test_... or sk_live_...). Enables " +
      "real auth when set. Pair with NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY.",
  },
  {
    name: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    requiredInProduction: false,
    minLength: 16,
    description:
      "Clerk client-side publishable key (pk_test_... or pk_live_...). " +
      "Required whenever CLERK_SECRET_KEY is set.",
  },
  {
    name: "FIELD_ENCRYPTION_KEY",
    requiredInProduction: false, // until columns are encrypted; flip on rollout
    minLength: 64, // 32 bytes hex = 64 chars
    description:
      "AES-256-GCM key for field-level encryption (Confidentiality TSC). " +
      "Generate via `openssl rand -hex 32`. Required when any column uses " +
      "encryptField from @/lib/soc2/field-encryption.",
  },
];

export interface EnvValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate the current process.env against ENV_SPECS. Returns a result
 * for callers that want to handle failures gracefully. Use
 * `assertEnvValid()` from instrumentation.ts if you want the throw-on-
 * fail behavior.
 */
export function validateEnv(): EnvValidationResult {
  const isProd = process.env.NODE_ENV === "production";
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const spec of ENV_SPECS) {
    const value = process.env[spec.name];
    const present = value != null && value.length > 0;

    if (!present) {
      const msg = `${spec.name} is not set. ${spec.description}`;
      if (spec.requiredInProduction && isProd) {
        errors.push(msg);
      } else {
        warnings.push(msg);
      }
      continue;
    }

    if (spec.minLength != null && value.length < spec.minLength) {
      const msg = `${spec.name} is too short (${value.length} chars; need ≥${spec.minLength}).`;
      if (spec.requiredInProduction && isProd) {
        errors.push(msg);
      } else {
        warnings.push(msg);
      }
    }
  }

  // Paired-presence check: Clerk requires BOTH keys to function. If only
  // one is set, the runtime will silently fail (currentUser() returns
  // null even after sign-in). Catch the half-configured state.
  const secret = process.env.CLERK_SECRET_KEY;
  const pub = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const secretSet = secret != null && secret.length > 0;
  const pubSet = pub != null && pub.length > 0;
  if (secretSet !== pubSet) {
    const msg =
      "Clerk is half-configured: " +
      `CLERK_SECRET_KEY=${secretSet ? "set" : "unset"}, ` +
      `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${pubSet ? "set" : "unset"}. ` +
      "Both must be set together; otherwise unset both to use the dev stub.";
    if (isProd) errors.push(msg);
    else warnings.push(msg);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Run validation at boot. Throws if production-required vars are
 * missing or invalid. Logs warnings for non-fatal misses.
 *
 * Called from src/instrumentation.ts.
 */
export function assertEnvValid(): void {
  const result = validateEnv();
  for (const w of result.warnings) {
    console.warn(`[env] WARN: ${w}`);
  }
  if (!result.ok) {
    const msg = [
      "Environment validation failed. Refusing to start in production with missing required secrets.",
      "",
      ...result.errors.map((e) => `  - ${e}`),
      "",
      "Set the missing vars in your deployment env (Vercel: Settings → Environment Variables).",
      "For local dev, copy .env.example to .env and fill in.",
    ].join("\n");
    throw new Error(msg);
  }
}
