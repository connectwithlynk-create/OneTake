# Exports SyncNet (syncnet_v2) to two ONNX models: the lip encoder and the
# audio encoder. Each maps its input window to a 1024-d embedding; sync is
# the distance between a lip embedding and an audio embedding (computed in
# JS downstream). Lip input: (N,3,5,224,224) BGR 0-255. Audio input:
# (N,1,13,20) MFCC.
import sys
import numpy as np
import torch
import torch.nn as nn

sys.path.insert(0, '/tmp/syncnet_python')
from SyncNetModel import S

CKPT = '/tmp/syncnet_python/data/syncnet_v2.model'


class LipNet(nn.Module):
    def __init__(self, s: S):
        super().__init__()
        self.s = s

    def forward(self, x):
        return self.s.forward_lip(x)


class AudNet(nn.Module):
    def __init__(self, s: S):
        super().__init__()
        self.s = s

    def forward(self, x):
        return self.s.forward_aud(x)


def patch_maxpool(path: str) -> None:
    # Legacy exporter can emit MaxPool with a malformed 'dilations' attr.
    import onnx
    g = onnx.load(path)
    for node in g.graph.node:
        if node.op_type == 'MaxPool':
            keep = [a for a in node.attribute if a.name != 'dilations']
            del node.attribute[:]
            node.attribute.extend(keep)
    onnx.save(g, path)


def main():
    m = S(num_layers_in_fc_layers=1024)
    state = torch.load(CKPT, map_location='cpu', weights_only=True)
    missing, unexpected = m.load_state_dict(state, strict=False)
    print(f'load: {len(state)} keys, missing={len(missing)}, unexpected={len(unexpected)}')
    m.eval()

    lip = LipNet(m).eval()
    aud = AudNet(m).eval()
    lip_in = torch.randn(2, 3, 5, 224, 224)
    aud_in = torch.randn(2, 1, 13, 20)

    import onnxruntime as ort
    for net, inp, name, out_path in [
        (lip, lip_in, 'lip', '/tmp/syncnet-lip.onnx'),
        (aud, aud_in, 'aud', '/tmp/syncnet-aud.onnx'),
    ]:
        with torch.no_grad():
            ref = net(inp)
        torch.onnx.export(
            net, inp, out_path,
            input_names=[name], output_names=['embed'],
            dynamic_axes={name: {0: 'N'}, 'embed': {0: 'N'}},
            opset_version=17, dynamo=False,
        )
        patch_maxpool(out_path)
        sess = ort.InferenceSession(out_path, providers=['CPUExecutionProvider'])
        got = sess.run(None, {name: inp.numpy()})[0]
        diff = np.abs(got - ref.numpy()).max()
        print(f'{name}: {out_path}  out {got.shape}  max diff vs torch {diff:.2e}  '
              f'{"OK" if diff < 1e-3 else "FAILED"}')


if __name__ == '__main__':
    main()
