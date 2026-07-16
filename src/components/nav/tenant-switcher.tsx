// Tenant switcher for users with multiple TenantMemberships.
//
// Mirrors the BookSwitcher pattern: Server Component, posts to the
// setTenantAction Server Action, which validates membership before
// writing the lc-tenant cookie.
//
// Renders nothing for:
//   - Signed-out users (no current tenant to switch from)
//   - Users with exactly 1 membership (auto-resolved; no choice to make)
//   - Users with 0 memberships (layout redirects to /onboarding before
//     this component renders)
//
// When N >= 2, renders a select with all the user's tenants. The
// currently-selected tenant is the cookie value (or the user's single
// membership if no cookie is set yet).

import { Card, CardContent } from "@/components/ui/card";
import { Label, Select } from "@/components/ui/input";
import { setTenantAction } from "@/app/actions/set-tenant";
import {
  getCurrentTenant,
  listMyTenants,
  type CurrentTenant,
} from "@/lib/auth/tenant";

export async function TenantSwitcher() {
  const [current, all] = await Promise.all([
    getCurrentTenant(),
    listMyTenants(),
  ]);

  // Hide entirely when there's nothing to switch. The Card chrome lives
  // inside this component so it leaves with the content — the layout used
  // to wrap the switcher in a fixed-width Card unconditionally, so every
  // single-tenant user (i.e. nearly all of them) got an empty white box
  // parked in the header.
  if (!current || all.length < 2) return null;

  return (
    <div className="w-48">
      <Card className="shadow-none">
        <CardContent className="px-3 py-2">
    <form action={setTenantAction} className="flex flex-col gap-2">
      <div>
        <Label htmlFor="tenantSlug">Tenant</Label>
        <Select id="tenantSlug" name="tenantSlug" defaultValue={current.slug}>
          {all.map((t: CurrentTenant) => (
            <option key={t.slug} value={t.slug}>
              {t.name} ({t.role.toLowerCase()})
            </option>
          ))}
        </Select>
      </div>
      <button
        type="submit"
        className="h-7 rounded-md bg-ink-900 px-2 text-[11px] font-medium text-white hover:bg-ink-800"
      >
        Switch tenant
      </button>
        </form>
        </CardContent>
      </Card>
    </div>
  );
}
