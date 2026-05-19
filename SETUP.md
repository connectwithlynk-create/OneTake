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

## 5. Transcription (Deepgram) - real talking/b-roll + spoken-words titles

Provisioned: Supabase Edge Function `transcribe` (deployed) + a
`clips.transcript` column. The function is a thin Deepgram proxy that holds
the API key as a secret so it never ships in the app.

You provide a Deepgram key:

1. Create an account at https://deepgram.com (free credits). Copy an API key.
2. Set it as a Supabase secret for the function:
   - Supabase dashboard -> Edge Functions -> `transcribe` -> Secrets ->
     add `DEEPGRAM_API_KEY = <your key>`
   - or CLI: `supabase secrets set DEEPGRAM_API_KEY=<your key>`

### What it does

After a clip is recorded or imported, the app (best-effort, in the
background) uploads it to the `clips` bucket, gets a short-lived signed URL,
and the Edge Function transcribes it via Deepgram. The transcript then sets:

- **tag**: speech present => `talking`, otherwise `b-roll` (lens-independent
  - fixes imports and someone-else-filming-you cases)
- **name**: the project's first take => "Intro"; otherwise the opening
  spoken words (rule-based, no LLM)

### Requirements / limits

- Only runs when: Supabase configured, signed in (Clerk), and the
  Clerk<->Supabase third-party integration (step 2) is set up. Otherwise it
  silently no-ops and the on-device lens/audio heuristic stands.
- Costs Deepgram credits per minute of audio (your account).
- Title is rule-based from the transcript (first phrase / "Intro"), not an
  LLM summary - it reflects the actual spoken words, not a smart topic.
- The Edge Function has `verify_jwt=false` (it only proxies to Deepgram a
  signed URL the caller already had RLS-gated access to create); the secret,
  not the data, is the protected thing. Tighten before production.
