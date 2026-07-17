"""全6形式の出力writer"""
import json
import csv
from pathlib import Path


SUPPORTED_FORMATS = {"txt", "json", "md", "srt", "csv", "vtt"}
FORMAT_ORDER = ("txt", "json", "md", "srt", "csv", "vtt")


def fmt_ts(seconds):
    """秒数を HH:MM:SS.mmm 形式に変換"""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


def fmt_ts_srt(seconds):
    """秒数を HH:MM:SS,mmm 形式に変換（SRT用）"""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}".replace(".", ",")


def write_txt(results, path):
    """[SPEAKER_XX] text 形式のTXTを出力"""
    with open(path, "w", encoding="utf-8") as f:
        for r in results:
            f.write(f"[{r['speaker']}] {r['text']}\n")


def write_vtt(results, path):
    """WebVTT形式で出力"""
    with open(path, "w", encoding="utf-8") as f:
        f.write("WEBVTT\n\n")
        for i, r in enumerate(results, 1):
            f.write(f"{i}\n")
            f.write(f"{fmt_ts(r['start'])} --> {fmt_ts(r['end'])}\n")
            f.write(f"<v {r['speaker']}>{r['text']}</v>\n\n")


def write_json(results, path):
    """JSON形式で出力"""
    with open(path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)


def write_markdown(results, path):
    """Markdown形式で出力"""
    with open(path, "w", encoding="utf-8") as f:
        f.write("# 文字起こし\n\n")
        for r in results:
            ts_range = f"{fmt_ts(r['start'])}–{fmt_ts(r['end'])}"
            f.write(f"## {ts_range} — {r['speaker']}\n\n")
            f.write(f"{r['text']}\n\n")


def write_srt(results, path):
    """SRT形式で出力"""
    with open(path, "w", encoding="utf-8") as f:
        for i, r in enumerate(results, 1):
            f.write(f"{i}\n")
            f.write(f"{fmt_ts_srt(r['start'])} --> {fmt_ts_srt(r['end'])}\n")
            f.write(f"[{r['speaker']}] {r['text']}\n\n")


def write_csv(results, path):
    """CSV形式で出力（UTF-8 BOM付き）"""
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["start", "end", "speaker", "text"])
        for r in results:
            writer.writerow([fmt_ts(r['start']), fmt_ts(r['end']), r['speaker'], r['text']])


def parse_output_formats(raw_formats: str) -> set:
    """OUTPUT_FORMATS環境変数を解析し、対応形式のsetを返す。未知形式はValueError。"""
    formats = {
        value.strip().lower()
        for value in raw_formats.split(",")
        if value.strip()
    }
    unknown = formats - SUPPORTED_FORMATS
    if unknown:
        raise ValueError(
            f"未対応の出力形式です: {', '.join(sorted(unknown))}"
        )
    return formats


def write_outputs(results, output_dir, stem, formats, always_write_txt=True):
    """選択された形式でファイルを生成し、生成パスのリストを返す。"""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    formats = set(formats)

    writers = {
        "txt": write_txt,
        "json": write_json,
        "md": write_markdown,
        "srt": write_srt,
        "csv": write_csv,
        "vtt": write_vtt,
    }

    generated = []

    if always_write_txt:
        txt_path = output_dir / f"{stem}.txt"
        write_txt(results, txt_path)
        generated.append(txt_path)

    for fmt in FORMAT_ORDER:
        if fmt not in formats:
            continue
        if fmt == "txt" and always_write_txt:
            continue
        path = output_dir / f"{stem}.{fmt}"
        writers[fmt](results, path)
        generated.append(path)

    return generated
