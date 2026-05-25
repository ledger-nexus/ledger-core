// Next.js instrumentation hook.
//
// Runs once per process startup, before any route renders. We use it
// to validate that critical environment variables are set BEFORE the
// app starts serving requests — SOC 2 CC6/CC7 expectation that
// production deployments fail closed rather than serve broken routes
// with bypassed access controls.
//
// See src/lib/env.ts for the spec of required vs optional vars.

export async function register(): Promise<void> {
  // Only run in the Node.js runtime; the Edge runtime doesn't load
  // .env files the same way and skipping is safer than guessing.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { assertEnvValid } = await import("@/lib/env");
  assertEnvValid();
}
