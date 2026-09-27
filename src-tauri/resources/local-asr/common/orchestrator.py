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

    enable_diarization = os.environ.get("ENABLE_DIARIZATION", "1") == "1"
    wav_path = os.path.join(WORK_TMP, "input_16k.wav")

    # 1. 話者分離
    if enable_diarization:
        print("[1/4] 話者分離中...", flush=True)
        subprocess.run([
            f"{VENV}/bin/python", "/app/diarize.py",
            "--input", input_path,
            "--output", segments_json,
            "--tmp", WORK_TMP,
        ], check=True)
    else:
        # 話者分離スキップ: 音声を16kHz mono WAVに変換し、単一セグメント（speaker: None）としてASRを実行
        # ※ ReazonSpeech ESPnet はセグメント単位の認識モデルのため、
        #   diarizationなし時は音声全体 [0, duration] を1セグメント fallback として処理する。
        print("[1/4] 話者分離スキップ（音声変換中）...", flush=True)
        subprocess.run([
            "ffmpeg", "-y", "-i", input_path,
            "-ar", "16000", "-ac", "1", wav_path
        ], check=True, capture_output=True)

        from pydub import AudioSegment
        audio = AudioSegment.from_wav(wav_path)
        duration_sec = len(audio) / 1000.0

        single_segment = [{
            "speaker": None,
            "start": 0.0,
            "end": duration_sec,
        }]
        with open(segments_json, "w", encoding="utf-8") as f:
            json.dump(single_segment, f, ensure_ascii=False, indent=2)

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
