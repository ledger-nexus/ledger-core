"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { SCOPE_COOKIE_NAME } from "@/lib/scope";

// Server Action invoked by the BookSwitcher form. Sets the scope cookie
// (entityCode + bookCode) and revalidates the root path so any cached
// Server Component data fetches against the new scope.
export async function setScopeAction(formData: FormData): Promise<void> {
  const entityCode = String(formData.get("entityCode") ?? "NORTHWIND");
  const bookCode = String(formData.get("bookCode") ?? "US_GAAP");

  cookies().set(SCOPE_COOKIE_NAME, JSON.stringify({ entityCode, bookCode }), {
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
    sameSite: "lax",
  });

  revalidatePath("/", "layout");
}
