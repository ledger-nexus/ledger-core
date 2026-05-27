// Pen-test pass 4 follow-up: middleware fails closed in production
// when CLERK_SECRET_KEY is unset.
//
// Behavior matrix:
//   NODE_ENV=production + Clerk unset + non-public route → 503
//   NODE_ENV=production + Clerk unset + public route    → pass-through
//   NODE_ENV!=production + Clerk unset                  → pass-through (dev convenience)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import middleware, { _internal } from "../src/middleware";

const origClerk = process.env.CLERK_SECRET_KEY;
const origNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  delete process.env.CLERK_SECRET_KEY;
  Object.assign(process.env, { NODE_ENV: "development" });
});
afterEach(() => {
  if (origClerk != null) process.env.CLERK_SECRET_KEY = origClerk;
  else delete process.env.CLERK_SECRET_KEY;
  if (origNodeEnv != null) Object.assign(process.env, { NODE_ENV: origNodeEnv });
});

function reqFor(pathname: string): NextRequest {
  return new NextRequest(`http://localhost${pathname}`);
}

describe("ledger-core middleware fail-closed", () => {
  it("development without Clerk: lets non-public routes through (dev cookie auth)", async () => {
    Object.assign(process.env, { NODE_ENV: "development" });
    const res = await middleware(reqFor("/journal-entries"));
    expect(res!.status).toBe(200);
  });

  it("production without Clerk: REFUSES non-public routes with 503", async () => {
    Object.assign(process.env, { NODE_ENV: "production" });
    const res = await middleware(reqFor("/journal-entries"));
    expect(res!.status).toBe(503);
    const body = await res!.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/CLERK_SECRET_KEY/);
  });

  it("production without Clerk: REFUSES the user-switcher Server Action route", async () => {
    // The Server Action behind setCurrentUserAction posts to whatever
    // page hosts the UserSwitcher (the layout / root). Without the gate,
    // an attacker could call it to impersonate any user. The 503 closes
    // that path.
    Object.assign(process.env, { NODE_ENV: "production" });
    const res = await middleware(reqFor("/"));
    expect(res!.status).toBe(503);
  });

  it("production without Clerk: STILL serves public routes", async () => {
    Object.assign(process.env, { NODE_ENV: "production" });
    expect((await middleware(reqFor("/sign-in")))!.status).toBe(200);
    expect((await middleware(reqFor("/api/health")))!.status).toBe(200);
    expect((await middleware(reqFor("/api/internal/journal-entries")))!.status).toBe(200);
  });

  it("isPublic matcher covers expected paths", () => {
    expect(_internal.isPublic("/sign-in")).toBe(true);
    expect(_internal.isPublic("/sign-up")).toBe(true);
    expect(_internal.isPublic("/api/internal/journal-entries")).toBe(true);
    expect(_internal.isPublic("/api/health")).toBe(true);
    expect(_internal.isPublic("/favicon.ico")).toBe(true);
    expect(_internal.isPublic("/")).toBe(false);
    expect(_internal.isPublic("/journal-entries")).toBe(false);
    expect(_internal.isPublic("/admin/audit-log")).toBe(false);
    expect(_internal.isPublic("/api/reports/trial-balance/csv")).toBe(false);
  });
});
