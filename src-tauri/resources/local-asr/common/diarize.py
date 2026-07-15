#!/usr/bin/env python3
"""話者分離（venv-diar で実行）"""
import argparse, json, os, subprocess, sys, gc

# ---- PyTorch 2.8 + pyannote 3.3.2 互換性パッチ ----
# 失敗時は明示的に異常終了する（握りつぶさない）
import torch
from torch.serialization import add_safe_globals
from torch.torch_version import TorchVersion
from pyannote.audio.core.task import Specifications, Problem, Resolution

add_safe_globals([
    TorchVersion,
    Specifications,
    Problem,
    Resolution,
])

from pyannote.audio import Pipeline


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--tmp", required=True)
    args = parser.parse_args()

    # ffmpegで16kHz mono WAV変換
    wav_path = os.path.join(args.tmp, "input_16k.wav")
    subprocess.run([
        "ffmpeg", "-y", "-i", args.input,
        "-ar", "16000", "-ac", "1", wav_path
    ], check=True, capture_output=True)

    # CUDA必須
    if not torch.cuda.is_available():
        raise RuntimeError("話者分離に必要なCUDA GPUを利用できません")

    # pyannoteパイプライン
    hf_token = os.environ["HF_TOKEN"]
    num_speakers = os.environ.get("NUM_SPEAKERS", "").strip()
    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1",
        use_auth_token=hf_token,
    )
    pipeline.to(torch.device("cuda"))

    ns = int(num_speakers) if num_speakers and num_speakers not in ("auto", "", "none") else None
    diarization = pipeline(wav_path, num_speakers=ns)

    segments = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        segments.append({
            "speaker": speaker,
            "start": turn.start,
            "end": turn.end,
        })

    if not segments:
        raise RuntimeError("話者分離結果が0件でした")

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(segments, f, ensure_ascii=False, indent=2)

    print(f"[OK] 話者分離完了: {len(segments)}セグメント", flush=True)

    # VRAM解放
    del pipeline
    gc.collect()
    torch.cuda.empty_cache()


if __name__ == "__main__":
    main()
