"use client";

// Onboarding form — client-side so we can surface validation errors
// inline + auto-derive the slug from the name. The Server Action
// (createMyFirstTenantAction) returns { ok, message?, tenantSlug? }
// and we route based on the result.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createMyFirstTenantAction } from "@/app/actions/set-tenant";
import { Input, Label } from "@/components/ui/input";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

export function OnboardingForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  // Whether the user has manually edited the slug. Once edited, stop
  // auto-deriving from the name — respects intent.
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onNameChange(next: string) {
    setName(next);
    if (!slugTouched) setSlug(slugify(next));
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createMyFirstTenantAction({
        slug: slug.trim(),
        name: name.trim(),
      });
      if (!result.ok) {
        setError(result.message ?? "Could not create workspace");
        return;
      }
      // Tenant created + cookie set by the Server Action. Send the
      // user to step 2 (entity + chart setup), where the dashboard
      // gets its first real data. The setup page itself checks for
      // entity-count > 0 and bounces to / if already done.
      router.refresh();
      router.push("/onboarding/setup");
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div>
        <Label htmlFor="name">Workspace name</Label>
        <Input
          id="name"
          name="name"
          required
          autoFocus
          maxLength={100}
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Acme, Inc."
        />
      </div>
      <div>
        <Label htmlFor="slug">URL slug</Label>
        <Input
          id="slug"
          name="slug"
          required
          minLength={3}
          maxLength={40}
          value={slug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value.toLowerCase());
          }}
          pattern="[a-z0-9](?:[a-z0-9]|-[a-z0-9])*"
          placeholder="acme-inc"
        />
        <p className="mt-1 text-[11px] text-ink-500">
          3-40 chars; lowercase letters, numbers, single hyphens. Permanent —
          used in URLs and audit logs.
        </p>
      </div>
      {error && (
        <div className="rounded-md border border-negative-300 bg-negative-50 px-3 py-2 text-xs text-negative-800">
          {error}
        </div>
      )}
      <button
        type="submit"
        disabled={pending || !name || !slug}
        className="h-9 rounded-md bg-ink-900 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-40"
      >
        {pending ? "Creating…" : "Create workspace"}
      </button>
    </form>
  );
}
