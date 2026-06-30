# Ceiling test: does removing the voiceover (demucs source separation) let
# PANNs recover sensible SFX labels at the detected onsets? Compares tagging
# the RAW MIX vs the NO-VOCALS stem at each onset. All in-memory (no wav
# save -> avoids torchaudio/TorchCodec). If the stem doesn't help, the model
# approach is hopeless for buried SFX and we stop.
#
# Run from desktop/:  python scripts/sfx-demucs-experiment.py /tmp/reel-sfx-test.wav
import sys
import json
import numpy as np

# Onset times (s) from the TS eval run on this reel (detectSfxOnsets).
ONSETS = [1.95, 3.71, 3.87, 4.06, 4.70, 5.06, 5.18, 6.85, 6.94, 7.20, 8.74,
          8.90, 9.44, 11.04, 11.23, 11.55, 11.71, 12.10, 13.63, 14.02, 15.26,
          16.13, 16.32]

RATE = 32000
WIN_S = 1.0
SUPPRESS = ['speech', 'narration', 'monologue', 'conversation', 'babbling',
            'whispering', 'music', 'musical instrument', 'silence',
            'inside,', 'outside,']


def tag(session, labels, supp_idx, wave, center_s):
    c = int(center_s * RATE)
    half = int(WIN_S * RATE / 2)
    seg = wave[max(0, c - half): c + half]
    if len(seg) < 1024:
        return []
    x = seg[np.newaxis, :].astype(np.float32)
    out = session.run(None, {session.get_inputs()[0].name: x})[0][0]
    res = []
    for i in np.argsort(out)[::-1]:
        if i in supp_idx:
            continue
        res.append((labels[i], float(out[i])))
        if len(res) >= 3:
            break
    return res


def main():
    import librosa
    import torch
    from demucs.pretrained import get_model
    from demucs.apply import apply_model

    inp = sys.argv[1] if len(sys.argv) > 1 else '/tmp/reel-sfx-test.wav'

    print('separating with demucs (in-memory)...', flush=True)
    model = get_model('htdemucs')
    model.eval()
    sr = model.samplerate  # 44100
    y = librosa.load(inp, sr=sr, mono=True)[0].astype(np.float32)
    stereo = np.stack([y, y])  # (2, n)
    wav = torch.from_numpy(stereo)[None]  # (1, 2, n)
    ref = wav.mean(0)
    wav = (wav - ref.mean()) / (ref.std() + 1e-8)
    with torch.no_grad():
        sources = apply_model(model, wav, device='cpu', progress=False)[0]
    sources = sources * ref.std() + ref.mean()
    names = model.sources  # ['drums','bass','other','vocals']
    vi = names.index('vocals')
    novocals = sum(sources[i] for i in range(len(names)) if i != vi)  # (2, n)
    novocals = novocals.mean(0).numpy()  # mono
    # resample 44100 -> 32000 for PANNs
    nov32 = librosa.resample(novocals, orig_sr=sr, target_sr=RATE)
    mix32 = librosa.resample(y, orig_sr=sr, target_sr=RATE)
    print(f'  separated. vocals energy={float(np.abs(sources[vi]).mean()):.4f} '
          f'no-vocals energy={float(np.abs(novocals).mean()):.4f}')

    import onnxruntime as ort
    labels = json.load(open('resources/models/panns-classmap.json'))['labels']
    supp_idx = {i for i, n in enumerate(labels)
                if any(s in n.lower() for s in SUPPRESS)}
    session = ort.InferenceSession('resources/models/panns-cnn14.onnx',
                                   providers=['CPUExecutionProvider'])

    print(f'\n{"onset":>6}  {"RAW MIX (top non-suppressed)":40}  NO-VOCALS STEM')
    helped = 0
    for t in ONSETS:
        m = tag(session, labels, supp_idx, mix32, t)
        n = tag(session, labels, supp_idx, nov32, t)
        ms = f'{m[0][0]}={m[0][1]:.2f}' if m else '-'
        ns = '  '.join(f'{l}={s:.2f}' for l, s in n) if n else '-'
        if n and (not m or n[0][1] > m[0][1] + 0.1):
            helped += 1
            ns += '  <-- stronger'
        print(f'{t:6.2f}  {ms:40}  {ns}')
    print(f'\nstem produced a stronger top label on {helped}/{len(ONSETS)} onsets')


if __name__ == '__main__':
    main()
