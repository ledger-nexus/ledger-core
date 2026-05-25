// Smoke test: end-to-end resolution of the default tenant via the helpers.
// Runs in a real Node context (no vitest mocks) — uses the actual cookies()
// stub from Next, which throws outside a request scope. So we instead read
// the default tenant directly to confirm the migration produced sensible data.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

(async () => {
  const tenants = await prisma.tenant.findMany({
    include: { memberships: { include: { user: { select: { email: true } } } } },
  });
  for (const t of tenants) {
    console.log(`Tenant: ${t.slug} (${t.name})`);
    console.log(`  Owner UID: ${t.ownerUserId}`);
    console.log(`  Members:`);
    for (const m of t.memberships) {
      console.log(`    - ${m.user.email} (${m.role})`);
    }
  }
  await prisma.$disconnect();
})();
