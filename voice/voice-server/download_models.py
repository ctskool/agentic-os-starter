"""Download the voice models (run once, ~350MB total):
  - kokoro-v1.0.onnx + voices-v1.0.bin  (Kokoro TTS, from thewh1teagle/kokoro-onnx releases)
  - hey_jarvis wake-word model          (openwakeword)
Whisper's model downloads itself on first STT call.
Idempotent — skips files that already exist.
"""
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
FILES = ["kokoro-v1.0.onnx", "voices-v1.0.bin"]


def fetch(name: str) -> None:
    dest = os.path.join(HERE, name)
    if os.path.exists(dest) and os.path.getsize(dest) > 1_000_000:
        print(f"[skip] {name} already present")
        return
    url = f"{BASE}/{name}"
    print(f"[get ] {url}")

    def hook(blocks, bs, total):
        if total > 0:
            pct = min(100, blocks * bs * 100 // total)
            sys.stdout.write(f"\r       {name}: {pct}%")
            sys.stdout.flush()

    urllib.request.urlretrieve(url, dest + ".part", reporthook=hook)
    os.replace(dest + ".part", dest)
    print(f"\r[ ok ] {name}          ")


for f in FILES:
    fetch(f)

print("[get ] openwakeword hey_jarvis model")
from openwakeword.utils import download_models  # noqa: E402

download_models(["hey_jarvis_v0.1"])
print("[ ok ] all voice models ready")
