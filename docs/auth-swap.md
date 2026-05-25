# Replacing the auth stub with real auth

The HMAC-signed dev cookie in `src/lib/auth/current-user.ts` is sufficient for a demo but should not host real client data. This doc covers the swap to Clerk, NextAuth, or WorkOS — depending on what fits your operating context.

The auth-stub's exported API stays stable across swaps:
- `getCurrentUser()` returns the current user or null
- `requireCurrentUser()` throws `NotAuthenticatedError` if no user
- `isAdmin(user)` returns boolean
- `requireAdmin()` throws `NotAuthorizedError` if not admin

Every Server Action that uses these exports keeps working as long as the new implementation returns the same `CurrentUser` shape (`{id, email, displayName}`).

---

## Path A — Clerk (fastest, ~30 min)

Best fit when: you want managed email/Google/SAML login, a hosted user dashboard, and don't want to manage password hashes or session tables. Free tier: 10K monthly active users.

### Install + provider

```bash
npm install @clerk/nextjs
```

Wrap the app in `<ClerkProvider>` in `src/app/layout.tsx`. Add Clerk's middleware in `src/middleware.ts`:

```ts
import { clerkMiddleware } from "@clerk/nextjs/server";
export default clerkMiddleware();
export const config = {
  matcher: ["/((?!_next|.*\\..*).*)", "/(api|trpc)(.*)"],
};
```

### Replace getCurrentUser

```ts
// src/lib/auth/current-user.ts — Clerk version
import { auth, currentUser } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const { userId } = await auth();
  if (!userId) return null;
  // Clerk identifies users by Clerk's own ID; our DB User table keys
  // on email. Look up + JIT-create on first auth.
  const clerkUser = await currentUser();
  if (!clerkUser) return null;
  const email = clerkUser.primaryEmailAddress?.emailAddress ?? "";
  if (!email) return null;
  const dbUser = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      displayName: clerkUser.firstName
        ? `${clerkUser.firstName} ${clerkUser.lastName ?? ""}`.trim()
        : email,
      isActive: true,
    },
    update: { isActive: true },
  });
  return { id: dbUser.id, email: dbUser.email, displayName: dbUser.displayName };
}

export class NotAuthenticatedError extends Error { /* unchanged */ }
export class NotAuthorizedError extends Error { /* unchanged */ }

export async function requireCurrentUser(): Promise<CurrentUser> {
  const u = await getCurrentUser();
  if (!u) throw new NotAuthenticatedError();
  return u;
}

const ADMIN_EMAILS = new Set([
  "controller@northwind.test",
  // Add real admin emails here, or move to a DB-backed role table
]);

export function isAdmin(user: CurrentUser | null): boolean {
  if (!user) return false;
  return ADMIN_EMAILS.has(user.email);
}

export async function requireAdmin(): Promise<CurrentUser> {
  const u = await requireCurrentUser();
  if (!isAdmin(u)) throw new NotAuthorizedError();
  return u;
}

// _internal helpers from the stub are no longer needed — delete them
// and any imports of them (the set-current-user Server Action goes away).
```

### Env vars (per Vercel project)

```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY  = pk_test_... or pk_live_...
CLERK_SECRET_KEY                   = sk_test_... or sk_live_...
NEXT_PUBLIC_CLERK_SIGN_IN_URL      = /sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL      = /sign-up
```

Remove `AUTH_STUB_SECRET` once Clerk is wired — nothing reads it.

### Sidebar / sign-in UI

Add `<SignedIn>`, `<SignedOut>`, `<UserButton>` from `@clerk/nextjs` to the sidebar:

```tsx
import { SignedIn, SignedOut, UserButton, SignInButton } from "@clerk/nextjs";

export function Sidebar() {
  return (
    <aside>
      {/* existing nav */}
      <SignedOut>
        <SignInButton />
      </SignedOut>
      <SignedIn>
        <UserButton afterSignOutUrl="/" />
      </SignedIn>
    </aside>
  );
}
```

### Cross-repo session

Each repo has its own Clerk app (its own `CLERK_SECRET_KEY`) UNLESS you set up Clerk's shared-session feature. For the portfolio, treat each repo as its own Clerk tenant — users sign in per repo. v1.x can revisit a shared-session setup if needed.

---

## Path B — NextAuth (no per-user pricing, ~2 hr)

Best fit when: you want OAuth + email magic links without per-user pricing, and don't mind managing the user/session tables yourself. Free, but more configuration.

### Install + adapter

```bash
npm install next-auth @auth/prisma-adapter
```

Add NextAuth's Prisma adapter against your existing Postgres. Requires four NextAuth tables (`Account`, `Session`, `User`, `VerificationToken`) — add them to `prisma/schema.prisma`:

```prisma
model Account {
  id                String   @id @default(cuid())
  userId            String
  type              String
  provider          String
  providerAccountId String
  refresh_token     String?  @db.Text
  access_token      String?  @db.Text
  expires_at        Int?
  token_type        String?
  scope             String?
  id_token          String?  @db.Text
  session_state     String?
  user              User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([provider, providerAccountId])
}

model Session {
  id           String   @id @default(cuid())
  sessionToken String   @unique
  userId       String
  expires      DateTime
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}

// Extend the existing User model with the NextAuth columns
model User {
  id            String    @id @default(cuid())
  // ... existing columns ...
  emailVerified DateTime?
  image         String?
  accounts      Account[]
  sessions      Session[]
}

model VerificationToken {
  identifier String
  token      String   @unique
  expires    DateTime
  @@unique([identifier, token])
}
```

Then `pnpm db:push` to apply.

### App config

```ts
// src/lib/auth/config.ts
import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import Google from "next-auth/providers/google";
import { prisma } from "@/lib/db";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
    // Add Email provider for magic links
    // Add Credentials provider for username/password (not recommended)
  ],
  session: { strategy: "database" },
});
```

### Replace getCurrentUser

```ts
// src/lib/auth/current-user.ts — NextAuth version
import { auth } from "@/lib/auth/config";
import { prisma } from "@/lib/db";

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await auth();
  if (!session?.user?.email) return null;
  const dbUser = await prisma.user.findUnique({
    where: { email: session.user.email },
    select: { id: true, email: true, displayName: true, isActive: true },
  });
  if (!dbUser || !dbUser.isActive) return null;
  return { id: dbUser.id, email: dbUser.email, displayName: dbUser.displayName };
}
// requireCurrentUser, isAdmin, requireAdmin unchanged
```

### Env vars

```
AUTH_SECRET            = <openssl rand -hex 32>
AUTH_URL               = <your deployment URL>
GOOGLE_CLIENT_ID       = <from Google Cloud Console>
GOOGLE_CLIENT_SECRET   = <from Google Cloud Console>
```

---

## Path C — WorkOS (enterprise SSO, ~half day)

Best fit when: you're selling to companies that demand SAML SSO + SCIM provisioning + audit log retention. Free for the first 1M MAU on email/Google; paid for SSO. Their SDK is `@workos-inc/authkit-nextjs`.

Setup is similar to Clerk's, but plug AuthKit's middleware + provider instead. The `getCurrentUser` replacement uses `workosClient.userManagement.getUser(session.userId)`.

This is overkill for a demo or a single-firm deployment. Useful when the buyer's IT department gates the deal on "SSO required."

---

## After the swap

1. Delete `src/lib/auth/current-user.ts`'s `_internal` block — set-current-user Server Action, the HMAC sign/verify helpers, all go away.
2. Delete `src/app/actions/set-current-user.ts` — no longer needed.
3. Remove `AUTH_STUB_SECRET` from all `.env.example` and Vercel project envs.
4. Run the test suite. The 6 auth-tests in `tests/auth-current-user.test.ts` will fail — they reference the HMAC behavior. Either delete them or rewrite against your new auth path's mockable boundary.

The substrate Server Actions don't change — they keep calling `getCurrentUser()` and `requireAdmin()`. That's the whole point of the stable interface.
