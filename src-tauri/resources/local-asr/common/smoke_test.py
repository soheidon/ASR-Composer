#!/usr/bin/env python3
"""環境検証スクリプト（venv-diarまたはvenv-asrから個別に実行する）"""
import argparse, importlib.util, os, sys


def check_gpu():
    import numpy, torch
    print(f"[OK] Python {sys.version.split()[0]}")
    print(f"[OK] numpy {numpy.__version__}")
    print(f"[OK] torch {torch.__version__}")
    print(f"[OK] torch CUDA {torch.version.cuda}")
    if not torch.cuda.is_available():
        raise RuntimeError("CUDAを利用できません")
    print(f"[OK] CUDA device: {torch.cuda.get_device_name(0)}")


def check_diarization():
    import torch
    from torch.serialization import add_safe_globals
    from torch.torch_version import TorchVersion
    from pyannote.audio.core.task import Specifications, Problem, Resolution
    add_safe_globals([TorchVersion, Specifications, Problem, Resolution])
    print("[OK] add_safe_globals succeeded")

    import pyannote.audio
    print(f"[OK] pyannote.audio {pyannote.audio.__version__}")

    if importlib.util.find_spec("torchcodec") is not None:
        raise RuntimeError("torchcodec must NOT be installed")
    print("[OK] torchcodec is not installed")

    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        print("[SKIP] HF_TOKEN not set, skipping model load test")
        return

    if not torch.cuda.is_available():
        raise RuntimeError("話者分離環境からCUDAを利用できません")

    from pyannote.audio import Pipeline
    p = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1", use_auth_token=hf_token)
    p.to(torch.device("cuda"))
    print("[OK] speaker-diarization-3.1 loaded on CUDA")
    del p
    torch.cuda.empty_cache()


def check_asr():
    import torch
    if not torch.cuda.is_available():
        raise RuntimeError("ASR環境からCUDAを利用できません")
    print(f"[OK] ASR torch {torch.__version__}")
    print(f"[OK] ASR CUDA {torch.version.cuda}")
    print(f"[OK] ASR device {torch.cuda.get_device_name(0)}")

    from reazonspeech.espnet.asr import load_model
    model = load_model(device="cuda")
    print("[OK] ReazonSpeech ESPnet loaded on CUDA")
    del model
    torch.cuda.empty_cache()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--component", choices=["gpu", "diarization", "asr"], required=True)
    args = parser.parse_args()

    try:
        if args.component == "gpu":
            check_gpu()
        elif args.component == "diarization":
            check_diarization()
        elif args.component == "asr":
            check_asr()
    except Exception as e:
        print(f"[FAIL] {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
