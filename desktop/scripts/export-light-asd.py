# Exports Light-ASD (ASD_Model + lossAV.FC) to ONNX.
# Output: forward(audio, visual) -> per-frame speaking probability.
import sys
import numpy as np
import torch
import torch.nn as nn

sys.path.insert(0, '/tmp/Light-ASD')
from model.Model import ASD_Model

CKPT = '/tmp/Light-ASD/weight/finetuning_TalkSet.model'
OUT = '/tmp/light-asd.onnx'


class ExportModel(nn.Module):
    def __init__(self):
        super().__init__()
        self.asd = ASD_Model()
        self.fc = nn.Linear(128, 2)

    def forward(self, audio, visual):
        outsAV, _ = self.asd(audio, visual)        # (T, 128)
        logits = self.fc(outsAV)                   # (T, 2)
        return torch.softmax(logits, dim=-1)[:, 1] # (T,) speaking prob


def main():
    m = ExportModel()
    state = torch.load(CKPT, map_location='cpu')

    prefixes = sorted({k.split('.')[0] for k in state})
    print('checkpoint top-level keys:', prefixes)

    asd_sd, fc_sd = {}, {}
    for k, v in state.items():
        if k.startswith('model.'):
            asd_sd[k[len('model.'):]] = v
        elif k.startswith('lossAV.FC.'):
            fc_sd[k[len('lossAV.FC.'):]] = v

    missing, unexpected = m.asd.load_state_dict(asd_sd, strict=False)
    print(f'ASD_Model load: {len(asd_sd)} keys, missing={len(missing)}, unexpected={len(unexpected)}')
    m.fc.load_state_dict(fc_sd)
    print(f'FC load: {len(fc_sd)} keys')
    m.eval()

    # Audio is 100 fps (MFCC), visual 25 fps -> 4:1.
    T_v = 50
    T_a = T_v * 4
    audio = torch.randn(1, T_a, 13)
    visual = torch.rand(1, T_v, 112, 112) * 255.0

    # The audio encoder applies MaxPool3d to a 4D tensor (pooling only the
    # last dim); the legacy ONNX exporter mangles its attributes. Swap to
    # the numerically-equivalent MaxPool2d, which exports cleanly.
    with torch.no_grad():
        ref_orig = m(audio, visual)
    m.asd.audioEncoder.pool1 = nn.MaxPool2d(kernel_size=(1, 3), stride=(1, 2), padding=(0, 1))
    m.asd.audioEncoder.pool2 = nn.MaxPool2d(kernel_size=(1, 3), stride=(1, 2), padding=(0, 1))
    with torch.no_grad():
        ref = m(audio, visual)
    print(f'pool swap max diff: {(ref_orig - ref).abs().max().item():.2e}')
    print('torch output shape:', tuple(ref.shape))

    torch.onnx.export(
        m, (audio, visual), OUT,
        input_names=['audio', 'visual'],
        output_names=['speaking_score'],
        dynamic_axes={
            'audio': {1: 'Ta'},
            'visual': {1: 'Tv'},
            'speaking_score': {0: 'T'},
        },
        opset_version=17,
        dynamo=False,
    )
    print('exported:', OUT)

    # The legacy exporter emits MaxPool3d with a malformed 'dilations'
    # attribute that onnxruntime rejects. Strip it (default = no dilation).
    import onnx
    g = onnx.load(OUT)
    fixed = 0
    for node in g.graph.node:
        if node.op_type == 'MaxPool':
            keep = [a for a in node.attribute if a.name != 'dilations']
            if len(keep) != len(node.attribute):
                fixed += 1
            del node.attribute[:]
            node.attribute.extend(keep)
    onnx.save(g, OUT)
    print(f'patched {fixed} MaxPool nodes')

    import onnxruntime as ort
    sess = ort.InferenceSession(OUT, providers=['CPUExecutionProvider'])
    out = sess.run(None, {'audio': audio.numpy(), 'visual': visual.numpy()})[0]
    diff = np.abs(out - ref.numpy()).max()
    print(f'onnx output shape: {out.shape}  max abs diff vs torch: {diff:.2e}')
    if diff < 1e-3:
        print('VERIFY OK')
    else:
        print('VERIFY FAILED - outputs diverge')


if __name__ == '__main__':
    main()
