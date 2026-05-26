// Provision a new TenantApiToken — used during deploy to give each
// companion repo (recon, revenue-rec, integrations, fa-amort) its
// own per-tenant token instead of sharing INTERNAL_API_TOKEN.
//
// Usage:
//   npx tsx scripts/provision-tenant-token.ts --tenant <slug> --label <label>
//
// Output: a plaintext 64-hex-char token, printed to stdout once.
// Capture it immediately — there's no way to retrieve it again. The
// hash is stored in TenantApiToken.tokenHash for future Bearer lookup.
//
// For the deploy script, run this once per (tenant, companion-repo) pair.

import { PrismaClient } from "@prisma/client";
import { provisionTenantApiToken } from "@/lib/auth/token";

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tenant || !args.label) {
    console.error("Usage: provision-tenant-token --tenant <slug> --label <label>");
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { slug: args.tenant },
      select: { id: true, slug: true, name: true },
    });
    if (!tenant) {
      console.error(`Tenant with slug '${args.tenant}' not found.`);
      process.exit(2);
    }
    const result = await provisionTenantApiToken({
      tenantId: tenant.id,
      label: args.label,
    });
    console.log(`# Tenant:  ${tenant.slug} (${tenant.name})`);
    console.log(`# Label:   ${args.label}`);
    console.log(`# Token ID: ${result.tokenId}`);
    console.log("");
    console.log("# Set this in the companion repo's Vercel env as INTERNAL_API_TOKEN:");
    console.log(result.plaintext);
  } finally {
    await prisma.$disconnect();
  }
})();

function parseArgs(argv: string[]): { tenant?: string; label?: string } {
  const out: { tenant?: string; label?: string } = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--tenant") out.tenant = v;
    else if (k === "--label") out.label = v;
  }
  return out;
}
