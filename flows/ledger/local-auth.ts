/**
 * LOCAL-ONLY auth for ledger-core tour captures.
 *
 * Mints a Playwright storage state carrying the dev-stub cookies:
 *   lc-user   = `${userId}.${hmacSha256(secret, userId).hex.slice(0,16)}`
 *               (mirrors sign() in src/lib/auth/current-user.ts)
 *   lc-tenant = tenant slug
 *
 * The stub only exists when Clerk is off, which is only ever local —
 * production middleware 503s without CLERK_SECRET_KEY, so this state
 * cannot work against any deployed environment even if leaked. Still:
 * the state file is written to a temp dir and NEVER committed.
 *
 * Capture preconditions (the flow refuses to run without them):
 *   - APP_URL is localhost (default http://localhost:3016)
 *   - the dev server was started with HIDE_DEV_CHROME=1 in .env, or
 *     every frame carries the DEV AUTH STUB card — the ledger-core
 *     equivalent of the dev N-badge that forced RevRec's full recapture
 *     (the flow can't see the env; the OCR pass is the backstop)
 */
import { createHmac } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const APP = process.env.APP_URL ?? "http://localhost:3016";

/**
 * The capture persona's user id, resolved OUTSIDE this flow (the flow
 * runs under tourkit's tsx, which has neither ledger-core's Prisma
 * client nor its .env). Resolve Carla Controller's id first:
 *
 *   cd <ledger-core> && npx tsx -e 'import { prisma } from "@/lib/db";
 *     prisma.user.findFirst({ where: { email: "controller@northwind.test" } })
 *       .then(u => { console.log(u!.id); return prisma.$disconnect(); })'
 *
 * then run the capture with CAPTURE_USER_ID=<uuid>.
 */
function captureUserId(): string {
  const id = process.env.CAPTURE_USER_ID;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new Error(
      "CAPTURE_USER_ID env var (uuid of the seeded capture persona) is required — see flows/ledger/local-auth.ts header"
    );
  }
  return id;
}

function stubSecret(): string {
  // Same resolution order as getSecret() in src/lib/auth/current-user.ts.
  const s = process.env.AUTH_STUB_SECRET;
  if (s && s.length >= 16) return s;
  return "dev-only-stub-secret-replace-with-real-auth";
}

function signUserId(userId: string): string {
  const h = createHmac("sha256", stubSecret());
  h.update(userId);
  return h.digest("hex").slice(0, 16);
}

export async function mintStorageState(): Promise<string> {
  if (!/^(https?:\/\/)?(127\.0\.0\.1|localhost)(:|\/|$)/.test(APP)) {
    throw new Error(`refusing non-local APP_URL: ${APP}`);
  }
  const userId = captureUserId();

  const host = new URL(APP).hostname;
  const cookie = (name: string, value: string) => ({
    name,
    value,
    domain: host,
    path: "/",
    expires: Math.floor(Date.now() / 1000) + 3600,
    httpOnly: false,
    secure: false,
    sameSite: "Lax" as const,
  });

  const state = {
    cookies: [
      cookie("lc-user", `${userId}.${signUserId(userId)}`),
      cookie("lc-tenant", "default"),
    ],
    origins: [],
  };

  const dir = await mkdtemp(path.join(tmpdir(), "lc-tour-"));
  const file = path.join(dir, "storage-state.json");
  await writeFile(file, JSON.stringify(state), "utf8");
  return file;
}


