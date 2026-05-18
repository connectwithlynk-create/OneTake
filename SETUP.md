# OneTake backend setup (Clerk + Supabase)

The app runs fully local with **no setup** (capture, ephemeral takes, library,
inspiration all work offline). Setup below only enables the Memories layer:
accounts, cloud backup, and cross-device restore.

Supabase is already provisioned (project `arkzlehcpbzohmxwpntl`): tables
`projects` / `clips` / `collections` / `inspiration` with owner-scoped RLS,
and a private `clips` storage bucket. SQL of record: `supabase/migrations/0001_init.sql`.

You do three things: create a Clerk app, connect Clerk and Supabase, fill `.env`.

## 1. Clerk app (~3 min)

1. Create an application at https://dashboard.clerk.com.
2. **User & Authentication → Email, Phone, Username**: enable **Email address**
   with **Email verification code**, and enable **Password**.
3. **SSO Connections / Social**: enable **Apple** (needed for the
   "Continue with Apple" button; on a real Apple Developer account for
   production, Clerk's shared credentials are fine for dev).
4. **API keys**: copy the **Publishable key** (`pk_test_...`).

## 2. Connect Clerk ↔ Supabase (third-party auth)

This makes Supabase trust Clerk-issued session tokens; RLS then resolves the
Clerk user id from `auth.jwt()->>'sub'`.

1. **Clerk dashboard → Integrations → Supabase** → enable it. Clerk shows a
   **Clerk domain** (e.g. `your-app.clerk.accounts.dev`). Copy it.
2. **Supabase dashboard → Authentication → Sign In / Up → Third-Party Auth →
   Add provider → Clerk** → paste the Clerk domain. Save.

No JWT template / secret is needed - this is the modern native integration.

## 3. Fill `.env`

`.env` already has the Supabase URL + publishable key filled in. Add the Clerk
key:

```
EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_xxxxxxxxxxxxxxxxxxxx
```

(`.env` is gitignored. `.env.example` is the committed template. The Supabase
publishable key and anon JWT key are both safe in a client; swap to the anon
key in `.env` only if your supabase-js build rejects `sb_publishable_`.)

## 4. Run

Auth + Supabase pulled in **native** modules (`@clerk/expo`,
`expo-secure-store`), so a dev build is required - Expo Go will not work:

```
npx expo run:ios      # rebuilds with the new native deps (first run is slow)
```

After that, JS-only iterations are just `npx expo start --dev-client` + `i`.

## What happens once configured

- Launch → if signed out, you land on the sign-in screen (Apple, or
  email + password with a verification code).
- Signed in → a Memories sync runs: local rows marked `local` are pushed,
  **saved clips** (kept/perfect, no expiry) upload their video to the `clips`
  bucket; remote rows pull down, restoring metadata and downloading clip
  videos on a fresh device.
- **Ephemeral takes (duds) never upload** - they expire and are GC'd locally
  by design.
- Without the Clerk key the app skips all of this and runs local-only.

## Known limitations (MVP)

- Deletions don't propagate yet (no tombstone push); the `deleted` column
  exists for when they do.
- Sync runs on sign-in and app launch, not continuously/in background.
- Email *sign-in* for returning users uses Clerk's password flow; if you only
  ever signed up with Apple, use Apple to return.
