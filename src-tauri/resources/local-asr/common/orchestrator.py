#!/usr/bin/env python3
"""全体制御: diarize → transcribe → 出力"""
import subprocess, sys, os, json

VENV = os.environ["VENV"]
WORK_SOURCE = os.environ.get("WORK_SOURCE", "/work/source")
WORK_OUTPUT = os.environ.get("WORK_OUTPUT", "/work/output")
WORK_TMP = os.environ.get("WORK_TMP", "/work/tmp")
INPUT_FILENAME = os.environ["INPUT_FILENAME"]


def main():
    input_path = os.path.join(WORK_SOURCE, INPUT_FILENAME)
    if not os.path.exists(input_path):
        print(f"[ERROR] 入力ファイルが見つかりません: {input_path}", file=sys.stderr)
        sys.exit(1)

    stem = os.path.splitext(INPUT_FILENAME)[0]
    segments_json = os.path.join(WORK_TMP, f"{stem}_segments.json")
    transcript_json = os.path.join(WORK_TMP, f"{stem}_transcript.json")

    os.makedirs(WORK_OUTPUT, exist_ok=True)
    os.makedirs(WORK_TMP, exist_ok=True)

    # 1. 話者分離
    print("[1/4] 話者分離中...", flush=True)
    subprocess.run([
        f"{VENV}/bin/python", "/app/diarize.py",
        "--input", input_path,
        "--output", segments_json,
        "--tmp", WORK_TMP,
    ], check=True)

    # 2. 音声認識
    print("[2/4] 音声認識中...", flush=True)
    subprocess.run([
        f"{VENV}/bin/python", "/app/transcribe.py",
        "--segments", segments_json,
        "--output", transcript_json,
        "--tmp", WORK_TMP,
    ], check=True)

    # 3. 出力生成
    print("[3/4] 結果を出力中...", flush=True)
    from output_writer import parse_output_formats, write_outputs
    with open(transcript_json, encoding="utf-8") as f:
        results = json.load(f)

    formats = parse_output_formats(os.environ.get("OUTPUT_FORMATS", "txt,vtt"))
    generated = write_outputs(results, WORK_OUTPUT, stem, formats, always_write_txt=True)

    print(f"[4/4] 完了。{len(results)}セグメントを出力しました。", flush=True)
    print(f"[OK] 出力ファイル: {[str(p.name) for p in generated]}", flush=True)


if __name__ == "__main__":
    main()
