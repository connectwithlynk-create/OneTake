# OneTake

Mobile app that collapses filming, reviewing, and editing of short-form video
into one loop. Record takes, get an instant verdict on each (dud / keep /
perfect), auto-tag talking vs b-roll, organize projects, and collect
inspiration reels into swipeable collections.

Full spec: [`docs/PRD.md`](docs/PRD.md) and a visual version at
[`docs/PRD.html`](docs/PRD.html).

## Scope of this build

Everything except the auto-edit is built (PRD roadmap Phases 1-3):

- Projects: create talking-head or prompt projects, list, detail, delete.
- Capture: multi-clip recorder (`expo-camera`), front/back, default tag toggle.
- Instant rating + tagging: on-device verdict and talking/b-roll tag right
  after each take, with manual override in the capture overlay and in clip
  review.
- Library: per-project clip review with verdict filters and overrides.
- Inspiration: add reels by URL, organize into collections, gesture swipe
  deck to file unfiled reels (right = save, left = discard), moodboard grid.

Intentionally NOT built (PRD Phase 4, the moat): the one-tap auto-edit
pipeline. `app/preview/[projectId]` is a stub that explains what Phase 4 will
do. The capture, rating, tagging, and library work that feeds it is complete.

### On-device rating is a heuristic stub

`src/lib/rating.ts` is a deterministic placeholder. The real implementation
(PRD FR-RATE-2) needs native analysis (face/eyes, blur, audio levels, speech
presence). Swap that one module out; its callers do not change.

### Camera note

This uses `expo-camera` for the recorder so the basic build runs without a
custom native pipeline. The PRD targets `react-native-vision-camera` (PRD
section 5/11) for production-grade capture and frame processors. That swap is
isolated to the capture screen.

## Stack

Expo SDK 55, expo-router (file-based, native tabs), React 19 / React Native
0.83, TypeScript (strict), expo-sqlite (local data), expo-file-system (clip
storage), react-native-reanimated 4 + gesture-handler (swipe deck).

## Run

```sh
npm install
npx expo start
```

Camera and microphone require a real device or a dev build (not Expo Go for
full native behavior). Press `i` / `a` for a simulator, or scan the QR with a
dev build.

```sh
npm run ios       # iOS
npm run android   # Android
npx tsc --noEmit  # typecheck
```

## Structure

```
src/
  app/                    expo-router routes
    (tabs)/               Projects + Inspiration tabs
    project/[id]          clip review
    capture/[projectId]   camera + instant verdict overlay
    prompt/[projectId]    prompt input (prompt projects)
    preview/[projectId]   auto-edit stub (Phase 4)
    collection/[id]       moodboard
    swipe/[collectionId]  inspiration swipe deck
    new-project           mode picker
    inspiration-add       add reel (modal)
  components/ui.tsx        playful dark design system
  lib/                     db, repo, store, rating, filestore, types
  theme/                   palette and tokens
```

## Theme

Mostly-dark, playful. Limited bright palette: purple (brand), yellow (punch /
best), blue (secondary), red (destructive / dud). Verdicts map to color:
perfect = yellow, keep = blue, dud = red.
