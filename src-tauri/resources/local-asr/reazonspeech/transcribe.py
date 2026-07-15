#!/usr/bin/env python3
"""音声認識（venv-asr で実行）— ReazonSpeech ESPnet"""
import argparse, json, os, sys
from pydub import AudioSegment


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--segments", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--tmp", required=True)
    args = parser.parse_args()

    with open(args.segments, encoding="utf-8") as f:
        segments = json.load(f)

    import torch
    from reazonspeech.espnet.asr import load_model, transcribe, audio_from_path

    if not torch.cuda.is_available():
        raise RuntimeError("音声認識に必要なCUDA GPUを利用できません")

    model = load_model(device="cuda")

    wav_path = os.path.join(args.tmp, "input_16k.wav")
    audio = AudioSegment.from_wav(wav_path)

    results = []
    failed_count = 0
    for i, seg in enumerate(segments):
        start_ms = int(seg["start"] * 1000)
        end_ms = int(seg["end"] * 1000)
        chunk = audio[start_ms:end_ms]
        chunk_path = os.path.join(args.tmp, f"chunk_{i:04d}.wav")
        chunk.export(chunk_path, format="wav")

        try:
            audio_data = audio_from_path(chunk_path)
            ret = transcribe(model, audio_data)
            text = (ret.text or "").strip()
        except Exception as exc:
            failed_count += 1
            print(f"[WARN] セグメント {i} ASR失敗: {exc}", file=sys.stderr, flush=True)
            text = ""
        finally:
            if os.path.exists(chunk_path):
                os.remove(chunk_path)

        results.append({
            "speaker": seg["speaker"],
            "start": seg["start"],
            "end": seg["end"],
            "text": text,
        })

    if segments and failed_count == len(segments):
        raise RuntimeError("すべてのセグメントの音声認識に失敗しました")

    if failed_count:
        print(f"[WARN] {failed_count}/{len(segments)}セグメントの認識に失敗しました",
              file=sys.stderr, flush=True)

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
