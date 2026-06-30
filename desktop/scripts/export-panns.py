# Exports PANNs CNN14 (AudioSet tagger, 527 classes) to ONNX for the SFX
# type classifier (src/main/analyze/sfx-audioset.ts). The exported model
# maps a 32 kHz waveform [batch, samples] to clipwise_output [batch, 527]
# (per-class sigmoid scores). CNN14's STFT front-end is Conv-based, so the
# export uses ops onnxruntime-web (WASM) supports — unlike YAMNet's
# tf.signal STFT via tf2onnx.
#
# Prereqs (mirrors export-syncnet.py's manual-clone convention):
#   git clone https://github.com/qiuqiangkong/audioset_tagging_cnn \
#     /tmp/audioset_tagging_cnn
#   # CNN14 checkpoint (Cnn14_mAP=0.431.pth) from the PANNs Zenodo release
#   # linked in that repo's README; place it at:
#   #   /tmp/Cnn14_mAP=0.431.pth
#   pip install torch onnx onnxruntime numpy librosa torchlibrosa
#
# Run from desktop/:
#   python scripts/export-panns.py
#     [--repo /tmp/audioset_tagging_cnn]
#     [--ckpt /tmp/Cnn14_mAP=0.431.pth]
#     [--out resources/models]
import argparse
import csv
import json
import os
import sys

import numpy as np
import torch
import torch.nn as nn


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument('--repo', default='/tmp/audioset_tagging_cnn',
                   help='clone of qiuqiangkong/audioset_tagging_cnn')
    p.add_argument('--model', default='Cnn6', choices=['Cnn6', 'Cnn14'],
                   help='PANNs architecture. Cnn6 (~19MB, mAP .343) is the '
                        'shippable default; Cnn14 (~320MB, mAP .431) is bigger.')
    p.add_argument('--ckpt', default='/tmp/Cnn6_mAP=0.343.pth',
                   help='checkpoint .pth matching --model')
    p.add_argument('--out', default='resources/models',
                   help='output dir for panns-cnn14.onnx + classmap')
    return p.parse_args()


class Cnn14Clipwise(nn.Module):
    """Wraps CNN14 so forward(waveform) -> clipwise_output only (the
    embedding output is dropped; the runtime only needs class scores)."""

    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, waveform):
        out = self.model(waveform)
        return out['clipwise_output']


def load_labels(repo: str) -> list:
    csv_path = os.path.join(repo, 'metadata', 'class_labels_indices.csv')
    labels = []
    with open(csv_path, newline='') as f:
        reader = csv.DictReader(f)  # columns: index, mid, display_name
        for row in sorted(reader, key=lambda r: int(r['index'])):
            labels.append(row['display_name'])
    if len(labels) != 527:
        print(f'WARNING: expected 527 labels, got {len(labels)}',
              file=sys.stderr)
    return labels


def main():
    args = parse_args()
    if not os.path.isdir(args.repo):
        sys.exit(f'repo not found: {args.repo} (clone it — see header)')
    if not os.path.isfile(args.ckpt):
        sys.exit(f'checkpoint not found: {args.ckpt} (download it — see header)')

    sys.path.insert(0, os.path.join(args.repo, 'pytorch'))
    import models as panns  # noqa: E402

    # Both Cnn6 and Cnn14 share the same constructor signature and the same
    # 32 kHz / 64-mel front-end, so the runtime (sfx-audioset.ts) is
    # identical regardless of which is exported.
    ModelClass = getattr(panns, args.model)
    model = ModelClass(
        sample_rate=32000, window_size=1024, hop_size=320,
        mel_bins=64, fmin=50, fmax=14000, classes_num=527,
    )
    ckpt = torch.load(args.ckpt, map_location='cpu', weights_only=False)
    state = ckpt['model'] if 'model' in ckpt else ckpt
    missing, unexpected = model.load_state_dict(state, strict=False)
    print(f'load: missing={len(missing)}, unexpected={len(unexpected)}')
    model.eval()

    net = Cnn14Clipwise(model).eval()
    # ~0.5 s @ 32 kHz, batch of 2, to exercise the dynamic axes.
    dummy = torch.randn(2, 16000)

    os.makedirs(args.out, exist_ok=True)
    out_path = os.path.join(args.out, 'panns-cnn14.onnx')

    with torch.no_grad():
        ref = net(dummy)

    torch.onnx.export(
        net, dummy, out_path,
        input_names=['waveform'], output_names=['clipwise_output'],
        dynamic_axes={
            'waveform': {0: 'batch', 1: 'samples'},
            'clipwise_output': {0: 'batch'},
        },
        opset_version=17, dynamo=False,
    )

    import onnxruntime as ort
    sess = ort.InferenceSession(out_path, providers=['CPUExecutionProvider'])
    got = sess.run(None, {'waveform': dummy.numpy()})[0]
    diff = np.abs(got - ref.numpy()).max()
    print(f'onnx: {out_path}  out {got.shape}  max diff vs torch {diff:.2e}  '
          f'{"OK" if diff < 1e-3 else "FAILED"}')

    labels = load_labels(args.repo)
    classmap_path = os.path.join(args.out, 'panns-classmap.json')
    with open(classmap_path, 'w') as f:
        json.dump({'labels': labels}, f)
    print(f'classmap: {classmap_path}  ({len(labels)} labels)')


if __name__ == '__main__':
    main()
