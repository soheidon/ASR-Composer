"""Tests for output_writer.py covering both diarized and non-diarized outputs."""
import os
import json
import tempfile
import unittest
from pathlib import Path

from output_writer import (
    write_txt,
    write_vtt,
    write_json,
    write_markdown,
    write_srt,
    write_csv,
    write_outputs,
    parse_output_formats,
)


class TestOutputWriter(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.out_dir = Path(self.temp_dir.name)

        # Diarization OFF results (speaker is None or empty)
        self.no_speaker_results = [
            {"speaker": None, "start": 0.0, "end": 2.5, "text": "こんにちは。"},
            {"speaker": None, "start": 3.0, "end": 6.123, "text": "テストです。"},
        ]

        # Diarization ON results (speaker is present)
        self.with_speaker_results = [
            {"speaker": "SPEAKER_00", "start": 0.0, "end": 2.5, "text": "こんにちは。"},
            {"speaker": "SPEAKER_01", "start": 3.0, "end": 6.123, "text": "テストです。"},
        ]

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_no_speaker_txt(self):
        txt_path = self.out_dir / "out.txt"
        write_txt(self.no_speaker_results, txt_path)
        content = txt_path.read_text(encoding="utf-8")
        self.assertEqual(content, "こんにちは。\nテストです。\n")
        self.assertNotIn("None", content)
        self.assertNotIn("[", content)

    def test_with_speaker_txt(self):
        txt_path = self.out_dir / "out_spk.txt"
        write_txt(self.with_speaker_results, txt_path)
        content = txt_path.read_text(encoding="utf-8")
        self.assertEqual(content, "[SPEAKER_00] こんにちは。\n[SPEAKER_01] テストです。\n")

    def test_no_speaker_vtt(self):
        vtt_path = self.out_dir / "out.vtt"
        write_vtt(self.no_speaker_results, vtt_path)
        content = vtt_path.read_text(encoding="utf-8")
        self.assertIn("WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.500\nこんにちは。\n\n2\n00:00:03.000 --> 00:00:06.123\nテストです。\n\n", content)
        self.assertNotIn("<v", content)
        self.assertNotIn("None", content)

    def test_with_speaker_vtt(self):
        vtt_path = self.out_dir / "out_spk.vtt"
        write_vtt(self.with_speaker_results, vtt_path)
        content = vtt_path.read_text(encoding="utf-8")
        self.assertIn("<v SPEAKER_00>こんにちは。</v>", content)
        self.assertIn("<v SPEAKER_01>テストです。</v>", content)

    def test_no_speaker_markdown(self):
        md_path = self.out_dir / "out.md"
        write_markdown(self.no_speaker_results, md_path)
        content = md_path.read_text(encoding="utf-8")
        self.assertIn("## 00:00:00.000–00:00:02.500\n\nこんにちは。\n\n", content)
        self.assertNotIn("None", content)
        self.assertNotIn("—", content)

    def test_with_speaker_markdown(self):
        md_path = self.out_dir / "out_spk.md"
        write_markdown(self.with_speaker_results, md_path)
        content = md_path.read_text(encoding="utf-8")
        self.assertIn("## 00:00:00.000–00:00:02.500 — SPEAKER_00\n\nこんにちは。\n\n", content)

    def test_no_speaker_srt(self):
        srt_path = self.out_dir / "out.srt"
        write_srt(self.no_speaker_results, srt_path)
        content = srt_path.read_text(encoding="utf-8")
        self.assertIn("1\n00:00:00,000 --> 00:00:02,500\nこんにちは。\n\n", content)
        self.assertNotIn("None", content)
        self.assertNotIn("[", content)

    def test_with_speaker_srt(self):
        srt_path = self.out_dir / "out_spk.srt"
        write_srt(self.with_speaker_results, srt_path)
        content = srt_path.read_text(encoding="utf-8")
        self.assertIn("[SPEAKER_00] こんにちは。\n\n", content)

    def test_no_speaker_csv(self):
        csv_path = self.out_dir / "out.csv"
        write_csv(self.no_speaker_results, csv_path)
        content = csv_path.read_text(encoding="utf-8-sig")
        lines = [line.strip() for line in content.splitlines() if line.strip()]
        self.assertEqual(lines[0], "start,end,speaker,text")
        self.assertEqual(lines[1], "00:00:00.000,00:00:02.500,,こんにちは。")
        self.assertNotIn("None", content)

    def test_no_speaker_json(self):
        json_path = self.out_dir / "out.json"
        write_json(self.no_speaker_results, json_path)
        data = json.loads(json_path.read_text(encoding="utf-8"))
        self.assertEqual(len(data), 2)
        self.assertIsNone(data[0]["speaker"])
        self.assertEqual(data[0]["text"], "こんにちは。")

    def test_write_outputs_all_formats(self):
        formats = {"txt", "json", "md", "srt", "csv", "vtt"}
        generated = write_outputs(self.no_speaker_results, self.out_dir, "test_job", formats)
        self.assertEqual(len(generated), 6)
        segments_json = self.out_dir / "test_job.segments.json"
        self.assertTrue(segments_json.exists())


if __name__ == "__main__":
    unittest.main()
