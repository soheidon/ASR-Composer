"""TXT/VTT出力"""


def fmt_ts(seconds):
    """秒数を HH:MM:SS.mmm 形式に変換"""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


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
