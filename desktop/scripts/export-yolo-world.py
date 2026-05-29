# Exports YOLO-World-S with a fixed overlay-class prompt set to ONNX.
#
# YOLO-World is open-vocabulary at training time; `set_classes()` bakes a
# concrete prompt list into the model so the exported ONNX is a normal
# YOLO detector with those classes as outputs. We pick prompts that map
# cleanly to our MediaOverlay kinds:
#
#   index 0: sticker            -> sticker
#   index 1: gif                -> gif
#   index 2: screenshot         -> image
#   index 3: picture in picture -> pip_video
#   index 4: emoji              -> emoji_graphic
#
# Run from desktop/:
#   pip install ultralytics onnx onnxsim
#   python scripts/export-yolo-world.py
#
# Output: resources/models/yolo-world-overlays.onnx
# Tweak the CLASSES list and re-run to experiment with different prompts.

import os
import shutil
import sys

from ultralytics import YOLO

CLASSES = [
    'sticker',
    'gif',
    'screenshot',
    'picture in picture',
    'emoji',
]

# Where to put the final ONNX, relative to desktop/.
OUT_DIR = os.path.join('resources', 'models')
OUT_NAME = 'yolo-world-overlays.onnx'

# Ultralytics auto-downloads weights on first use into ~/.config/ultralytics.
# 'yolov8s-worldv2.pt' is the small variant, ~80 MB.
MODEL = 'yolov8s-worldv2.pt'


def main() -> None:
    print(f'loading {MODEL}...', flush=True)
    model = YOLO(MODEL)

    print(f'baking classes: {CLASSES}', flush=True)
    model.set_classes(CLASSES)

    print('exporting to ONNX (imgsz=640, opset=12, dynamic=False)...', flush=True)
    # opset 12 is a safe baseline for onnxruntime-web (WASM); dynamic
    # axes would let us vary batch but we always run batch=1.
    exported = model.export(format='onnx', imgsz=640, opset=12, dynamic=False)

    os.makedirs(OUT_DIR, exist_ok=True)
    dest = os.path.join(OUT_DIR, OUT_NAME)
    shutil.move(exported, dest)
    print(f'wrote {dest}', flush=True)


if __name__ == '__main__':
    sys.exit(main())
