#!/usr/bin/env bash
# THROWAWAY SPIKE — not shipped code, not the worker. Delete after the
# decision it informs. Purpose (design doc, Next Steps step 4): prove the
# FFmpeg filtergraph that trims N source clips per their EDL [inMs,outMs)
# and concats them into ONE 1080x1920 H.264 + AAC faststart MP4 — before
# any timeline UI is wired to a renderer.
#
# v1 EDL semantics only: trim + concat. No speed, transitions, overlays,
# or music (those are v1.1 and would extend this graph, not replace it).
#
# Runs with zero external footage: synthesizes 3 clips via lavfi so the
# graph is verifiable on any machine with ffmpeg. Pass 3 real clip paths
# as args to render those instead.
#
#   bash scripts/spike-render.sh                 # synthetic
#   bash scripts/spike-render.sh a.mov b.mov c.mov
set -euo pipefail

command -v ffmpeg >/dev/null || { echo "ffmpeg not found"; exit 1; }
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
OUT="${SPIKE_OUT:-$PWD/spike-out.mp4}"

# (clipId, inMs, outMs) — stands in for edl.tracks.video[]
IN_MS=(0    500  1000)
OUT_MS=(1500 2500 1800)   # expected total ≈ 1.5 + 2.0 + 0.8 = 4.3s

if [ "$#" -eq 3 ]; then
  C0="$1"; C1="$2"; C2="$3"
else
  echo "→ synthesizing 3 test clips (5s each, distinct color + tone)"
  ffmpeg -hide_banner -loglevel error \
    -f lavfi -i "color=c=red:s=1280x720:d=5:r=30" \
    -f lavfi -i "sine=frequency=440:duration=5" \
    -shortest -pix_fmt yuv420p "$WORK/c0.mp4"
  ffmpeg -hide_banner -loglevel error \
    -f lavfi -i "color=c=green:s=1280x720:d=5:r=30" \
    -f lavfi -i "sine=frequency=660:duration=5" \
    -shortest -pix_fmt yuv420p "$WORK/c1.mp4"
  ffmpeg -hide_banner -loglevel error \
    -f lavfi -i "color=c=blue:s=1280x720:d=5:r=30" \
    -f lavfi -i "sine=frequency=880:duration=5" \
    -shortest -pix_fmt yuv420p "$WORK/c2.mp4"
  C0="$WORK/c0.mp4"; C1="$WORK/c1.mp4"; C2="$WORK/c2.mp4"
fi

# Per-clip: trim to [in,out), reset PTS, normalize to a 1080x1920 vertical
# frame (fit + pad, square pixels, 30fps), trim+reset audio. Then concat.
to_s() { awk "BEGIN{printf \"%.3f\", $1/1000}"; }
S0=$(to_s "${IN_MS[0]}"); E0=$(to_s "${OUT_MS[0]}")
S1=$(to_s "${IN_MS[1]}"); E1=$(to_s "${OUT_MS[1]}")
S2=$(to_s "${IN_MS[2]}"); E2=$(to_s "${OUT_MS[2]}")

VF='scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30'

echo "→ rendering filtergraph: 3x (trim → normalize) → concat"
ffmpeg -hide_banner -loglevel error -y \
  -i "$C0" -i "$C1" -i "$C2" \
  -filter_complex "\
[0:v]trim=start=$S0:end=$E0,setpts=PTS-STARTPTS,$VF[v0]; \
[0:a]atrim=start=$S0:end=$E0,asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo[a0]; \
[1:v]trim=start=$S1:end=$E1,setpts=PTS-STARTPTS,$VF[v1]; \
[1:a]atrim=start=$S1:end=$E1,asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo[a1]; \
[2:v]trim=start=$S2:end=$E2,setpts=PTS-STARTPTS,$VF[v2]; \
[2:a]atrim=start=$S2:end=$E2,asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo[a2]; \
[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[vout][aout]" \
  -map "[vout]" -map "[aout]" \
  -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p \
  -c:a aac -b:a 128k -movflags +faststart \
  "$OUT"

echo "→ done: $OUT"
ffprobe -hide_banner -v error \
  -show_entries format=duration,size:stream=codec_name,width,height \
  -of default=noprint_wrappers=1 "$OUT"
