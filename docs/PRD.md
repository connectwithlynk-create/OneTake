# OneTake (working title) - Product Requirements Document

Status: Draft v1
Last updated: 2026-05-17
Owner: Rahul

---

## 1. Summary

OneTake is a mobile app that makes short-form content creation fast by collapsing
filming, reviewing, and editing into one loop. The creator records clips; the app
gives an instant verdict on each take (dud / keep / perfect) and auto-tags it
(talking vs b-roll). When the creator marks a project finished, the app
auto-edits a publish-ready vertical video: bad takes and dead air removed,
captions burned in, and relevant b-roll cut in automatically. A separate
prompt mode generates a video from the existing footage library on request. An
Inspiration section lets the creator swipe-collect reels/TikToks into named
collections and later choose a collection as the editing-style reference for a
finished video.

The core bet ("the moat") is the auto-edit of a talking-head project. Everything
else exists to feed or frame that output.

## 2. Problem

Creators spend far more time reviewing footage and editing than filming. Three
specific pains:

1. Reviewing every take to find usable ones is tedious and happens after the
   shoot, when context is lost.
2. Editing talking-head + b-roll is repetitive manual labor (cut silences,
   remove fumbles, add captions, find and place b-roll).
3. Maintaining a consistent style across videos requires re-deriving editing
   choices each time.

## 3. Goals and non-goals

### Goals
- Tell the creator within ~1s of stopping a take whether it is usable.
- Eliminate manual cutting of silences, filler, and bad takes for talking-head
  projects.
- Produce a publish-ready vertical video with captions and auto-placed b-roll in
  one tap.
- Make collecting and reusing inspiration frictionless.

### Non-goals (explicitly out of scope for the product, not just MVP)
- A full manual timeline editor competing with CapCut/Premiere. Manual override
  is for corrections, not as the primary workflow.
- Long-form / horizontal / multi-speaker production.
- Music licensing marketplace.
- Social feed or in-app distribution. Export to the OS share sheet is the
  publishing path.

## 4. Target users

- **Primary:** solo short-form creators (TikTok / Reels / Shorts) who film
  talking-head content with b-roll and edit on their phone.
- **Secondary:** founders / marketers producing regular talking-head clips who
  want consistency without an editor.

Persona traits that drive requirements: films in bursts, redoes lines multiple
times, has limited patience for editing, judges quality by "would I post this".

## 5. Platform and key technical constraints (verified)

- **App:** Expo with prebuild (dev client + EAS Build). Not Expo Go, because the
  camera library below requires native modules.
- **Camera:** react-native-vision-camera. Works with Expo via its config plugin
  and a dev client, but is **not supported in Expo Go**; requires prebuild / EAS.
- **No on-device video compositing path:** FFmpegKit (the main React Native
  FFmpeg binding) was retired on 2025-01-06 and its native binaries were removed
  from npm / CocoaPods / Maven on 2025-04-01, with no maintained successor.
  Therefore all editing and rendering happens server-side. The app produces a
  manifest; the backend produces the final video.

These constraints are load-bearing for the architecture in section 9.

## 6. User journeys

### 6.1 Talking-head project (primary)
1. Creator starts a Talking-Head project.
2. Camera screen. Creator records a clip, stops.
3. Within ~1s: verdict chip (dud / keep / perfect) + tag (talking / b-roll),
   both overridable by tap.
4. Creator re-records lines as needed; duds are de-emphasized automatically.
5. Creator taps Finish.
6. App uploads kept clips + manifest; backend transcribes, computes the edit,
   renders.
7. Creator lands on a preview screen with the finished vertical video, can
   re-render with a chosen inspiration collection's style, then export/share.

### 6.2 Prompt project
1. Creator starts a Prompt project, types a prompt
   (e.g. "30s energetic intro about our launch using the office clips").
2. Backend semantically selects and orders clips from the footage library that
   match the prompt, assembles, captions, renders.
3. Same preview/export screen as 6.1.

### 6.3 Inspiration
1. Creator opens Inspiration, pastes/imports reels/TikToks (URL or share-sheet
   into the app).
2. Swipes: right = save into a chosen collection, left = discard.
3. Collections are named (e.g. "punchy hooks", "calm vlog").
4. On any finished video, creator can pick a collection so the re-render
   approximates that style.

## 7. Functional requirements

IDs are stable references for tracking.

### Capture
- FR-CAP-1: Record multiple discrete clips within one project, in order.
- FR-CAP-2: Front/back camera, tap-to-focus, exposure lock, basic timer.
- FR-CAP-3: Each clip stored locally with metadata (project id, order index,
  duration, created at, device orientation, resolution).
- FR-CAP-4: Vertical 1080x1920 capture target.

### Instant rating
- FR-RATE-1: On stop, produce a verdict in {dud, keep, perfect} within ~1s of
  recording end (analysis of the just-recorded file, not required to be live
  during recording).
- FR-RATE-2: Verdict inputs: face presence/centering and eyes-open
  (talking clips), blur (Laplacian variance), audio level + clipping, clip
  length sanity, speech presence.
- FR-RATE-3: Verdict is overridable by the creator and the override is stored.
- FR-RATE-4: Duds are excluded from auto-edit by default but retained on device
  until the creator deletes them.

### Auto-tagging
- FR-TAG-1: Auto-classify each clip as talking or b-roll (speech + talking-face
  present => talking; else b-roll).
- FR-TAG-2: Tags overridable and stored.
- FR-TAG-3: (v2) free-form / additional tags on clips.

### b-roll library
- FR-BROLL-1: Ship a bundled, pre-tagged b-roll set in the app.
- FR-BROLL-2: Each b-roll item has a text description used for matching.
- FR-BROLL-3: (v2) creator can add own b-roll; description auto-generated by a
  vision model, editable.

### Auto-edit (talking-head)
- FR-EDIT-1: Concatenate kept clips in record order.
- FR-EDIT-2: Transcribe with word-level timestamps.
- FR-EDIT-3: Remove silences over a configurable threshold and filler words
  from a maintained list.
- FR-EDIT-4: Generate a caption track from word timings (highlight style).
- FR-EDIT-5: Match transcript spans to b-roll by embedding similarity; overlay
  matched b-roll as a cutaway while keeping the talking audio.
- FR-EDIT-6: Render vertical 1080x1920 H.264 MP4.
- FR-EDIT-7: (v2) retake dedup: when a line is repeated, an LLM selects the best
  take and drops the rest.
- FR-EDIT-8: Manual corrections on the result: toggle a cut, remove a b-roll
  overlay, edit a caption. Re-render applies them. (Correction, not a timeline.)

### Prompt mode
- FR-PROMPT-1: Free-text prompt input on a Prompt project.
- FR-PROMPT-2: Semantic selection and ordering of library clips matching the
  prompt (transcript + tag + description embeddings).
- FR-PROMPT-3: Same caption + render pipeline as auto-edit.
- FR-PROMPT-4: Scope guard: prompt mode selects/orders/edits existing footage;
  it does not generate footage that does not exist.

### Inspiration
- FR-INSP-1: Add reels/TikToks by URL or OS share sheet.
- FR-INSP-2: Swipe right to file into a chosen named collection, left to
  discard.
- FR-INSP-3: Create/rename/delete collections.
- FR-INSP-4: View a collection as a moodboard grid.
- FR-INSP-5: (v3) Style-match: derive measurable traits from a collection
  (mean shot length, caption density, music energy, hook pattern) and apply
  them as render parameters for a re-render of a finished video.

### Library and projects
- FR-LIB-1: List projects with status (recording, processing, ready).
- FR-LIB-2: Per project: clips with verdict/tag, finished video(s).
- FR-LIB-3: Delete clips/projects; deleting reclaims local storage.

### Export
- FR-EXP-1: Export the finished MP4 via the OS share sheet and save to camera
  roll.

## 8. Non-functional requirements

- NFR-PERF-1: Verdict latency target ~1s after stop (P50), 2s P95.
- NFR-PERF-2: Auto-edit round trip (upload + transcribe + edit + render):
  target under 1.5x the source footage duration for MVP-capped projects.
- NFR-LIMIT-1: MVP caps a talking-head project at ~2 minutes total footage to
  bound latency and cost.
- NFR-OFFLINE-1: Capture, rating, tagging, and library work fully offline.
  Auto-edit and prompt mode require connectivity.
- NFR-PRIV-1: Clips leave the device only on Finish (auto-edit/prompt). State
  this clearly in UI. Provide a way to delete server-side copies after render.
- NFR-COST-1: Track per-render cost (transcription + render compute) as a
  product KPI; it gates pricing.
- NFR-PLAT-1: iOS first. Codebase stays cross-platform; Android is a later
  hardening pass, not a rewrite.

## 9. System architecture

```
APP (Expo prebuild, TypeScript)
  react-native-vision-camera        capture
  on-device analysis                verdict + tag (within ~1s of stop)
  expo-sqlite                       projects, clips, tags, ratings, collections
  expo-file-system                  local clip storage
        | on Finish: upload kept clips + project manifest (JSON)
        v
BACKEND (TypeScript service + job queue)
  1. Transcribe (Deepgram or Whisper API) -> word-level timestamps
  2. Build EDL (Edit Decision List) from manifest + transcript:
       - drop dud clips
       - cut silences + filler from word timings
       - (v2) retake dedup via LLM over transcript
       - match transcript spans -> b-roll via embedding similarity
       - generate caption track
  3. Render EDL via Remotion (captions / b-roll / transitions as components);
     FFmpeg (server-side static binary) used only for concat/normalize pre-step
  4. Return final MP4 -> app preview / export
```

Rationale for server-side rendering: no maintained on-device RN compositing
path exists post-FFmpegKit retirement (section 5), and rendering quality plus
caption/b-roll flexibility matter to the moat. Remotion chosen because the EDL
maps directly to React component props and it is the same language as the app.
Tradeoff accepted: render latency roughly proportional to video length and
per-render compute cost (tracked via NFR-COST-1).

### 9.1 The EDL (core data structure)

The Edit Decision List is the contract between "what to edit" and "how to
render". It is JSON, renderer-agnostic, and independently testable:

```
EDL {
  output: { width, height, fps }
  tracks: [
    { type: "video", segments: [ { clipId, sourceIn, sourceOut, timelineStart } ] }
    { type: "broll",  overlays: [ { brollId, timelineStart, timelineEnd } ] }
    { type: "captions", cues: [ { text, start, end, words:[{w,start,end}] } ] }
  ]
  style?: { meanShotLen, captionStyle, musicEnergy }   // v3 from Inspiration
}
```

The app never edits video. It emits a manifest (clips + verdicts + tags). The
backend turns manifest + transcript into an EDL. The renderer turns the EDL into
a file. This isolation is what makes the moat testable before any UI exists.

## 10. Data model (app, SQLite)

- project(id, type[talkinghead|prompt], status, prompt?, created_at)
- clip(id, project_id, order_index, file_uri, duration_ms, verdict
  [dud|keep|perfect], verdict_overridden, tag[talking|broll],
  tag_overridden, created_at)
- collection(id, name, created_at)
- inspiration(id, collection_id, source_url, thumb_uri, added_at)
- render(id, project_id, status, output_uri, style_collection_id?, created_at)

## 11. AI / ML components

- On-device verdict/tag: face + eyes (MLKit via Vision Camera frame data),
  blur (Laplacian variance), audio RMS/clipping from the file, speech presence.
  Heuristic scoring for MVP; learnable later from override data.
- Transcription: Deepgram or OpenAI Whisper API, word-level timestamps required.
- Embeddings: transcript spans and b-roll descriptions for matching; reused for
  prompt-mode semantic selection.
- LLM (Claude, latest capable model): v2 retake dedup and v3 prompt
  understanding; transcript-level reasoning, not video.

## 12. Phased roadmap

Ordering follows easiest-to-hardest, with the editor last, per product
direction. A short throwaway editor spike is recommended (not required) before
heavy investment, because Phases 1-3 represent several weeks and the premium
thesis rests entirely on Phase 4. Phases 1-3 are not wasted if the editor
underdelivers: they constitute a viable standalone "smart capture + organizer +
moodboard" product.

- **Phase 0 (recommended, ~2-3 days, throwaway):** backend-only spike, hardcoded
  input clips, no app/UI. Output one auto-edited video to judge whether the moat
  lands. Go/no-go gate on the premium thesis.

- **Phase 1: Foundation + easy wins.** Expo prebuild scaffold, navigation,
  SQLite schema. Inspiration swipe + collections as a pure moodboard
  (FR-INSP-1..4). Easiest meaningful feature; teaches gesture UX cheaply.

- **Phase 2: Capture.** Vision Camera multi-clip recorder, talking-head project
  flow, local clip library, project management (FR-CAP-*, FR-LIB-*).

- **Phase 3: On-device intelligence.** Instant rating + auto-tag with override
  (FR-RATE-*, FR-TAG-1..2). End state: a shippable standalone v1 (smart capture
  + organizer + moodboard), no backend required.

- **Phase 4: The editor (the moat).** Backend: upload, transcribe, EDL, Remotion
  render. One-tap talking-head auto-edit with captions + bundled b-roll
  (FR-EDIT-1..6), correction re-render (FR-EDIT-8). This is the premium product.

- **Phase 5 (v2):** retake dedup (FR-EDIT-7), user-added b-roll with auto
  description (FR-BROLL-3), extra clip tags (FR-TAG-3).

- **Phase 6 (v3):** prompt mode (FR-PROMPT-*), inspiration style-matching
  (FR-INSP-5).

## 13. Release / MVP definition

MVP = end of Phase 4: talking-head record, instant rating, auto-tag, bundled
b-roll, one-tap server auto-edit (cut + captions + b-roll), preview, export,
iOS only. Out of MVP: prompt mode, style-matching, user b-roll, retake dedup,
Android polish.

## 14. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Auto-edit output quality is subjective and may not impress | Fatal to premium thesis | Phase 0 spike gates it; Phases 1-3 are a standalone fallback product |
| Round-trip latency (upload+transcribe+render) feels slow | Churn | NFR-LIMIT-1 caps footage; progress UI; revisit on-device transcription only if needed |
| "Instant" expectation = truly live rating | UX disappointment | Define UX as verdict within ~1s of stop, not live overlay |
| Render cost at scale | Margin | NFR-COST-1 tracks per-render cost; informs pricing/limits |
| Vision Camera + Expo prebuild setup friction | Schedule | Known constraint; budget setup in Phase 1; no Expo Go |
| Privacy concern: footage uploaded for editing | Trust | NFR-PRIV-1: explicit UI, server-side delete control |

## 15. Success metrics

- Activation: % of new users who complete one finished auto-edited video.
- Moat quality: % of finished videos exported without manual correction.
- Capture-loop value: verdict override rate (lower = trustworthy ratings).
- Latency: P50/P95 verdict and round-trip times vs NFR targets.
- Retention: weekly returning creators; videos finished per active creator.
- Unit economics: per-render cost vs plan price.

## 16. Open questions

- Retake grouping: explicit ("re-record this line" button) vs inferred from
  transcript similarity? Affects Phase 5 design.
- Music: none, royalty-free pack, or beat-synced? Currently out of scope; revisit
  for style-matching realism in v3.
- Server-side footage retention window and exact delete UX.
- Pricing model and where the free/paid line sits (capture loop free, auto-edit
  paid is a candidate).
- Inspiration import: many platforms restrict programmatic reel access; confirm
  what "import a TikTok/Reel" can legally and technically mean (URL + thumbnail
  + manual reference vs full video download).
