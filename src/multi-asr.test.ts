import { describe, it, expect } from "vitest";
import {
  computeOverlapMetrics,
  rangesIntersectWithPadding,
  normalizeMediaPath,
  normalizeMediaFileName,
  validateSegmentTimestamps,
  validateMultiEngineSession,
  alignMultiEngineSession,
  ALIGNMENT_PADDING_SEC,
  MIN_ANCHOR_COVERAGE,
  MIN_CANDIDATE_COVERAGE,
  type MultiEngineSession,
  type EngineTranscriptResult,
} from "./multi-asr";
import type { TranscriptDocument, TranscriptSegment } from "./transcript";

function createSegment(
  id: string,
  start: number,
  end: number,
  text: string,
  speaker = "SPEAKER_00"
): TranscriptSegment {
  return {
    id,
    start,
    end,
    speaker,
    originalSpeaker: speaker,
    text,
    originalText: text,
    sourceEngine: "test-engine",
    sourceSegmentId: id,
    sourceRunId: "run-test",
    status: "raw",
  };
}

function createDoc(
  segments: TranscriptSegment[],
  mediaPath = "C:/Audio/meeting.wav",
  mediaFileName = "meeting.wav",
  engine = "test-engine"
): TranscriptDocument {
  return {
    schemaVersion: 1,
    mediaPath,
    mediaFileName,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    language: "ja",
    sourceEngine: engine,
    sourceRunId: "run-test",
    segments,
  };
}

function createResult(
  engineId: string,
  document: TranscriptDocument,
  timingGranularity: "segment" | "whole_audio" | "word" = "segment",
  durationSec = 60.0
): EngineTranscriptResult {
  return {
    engineId,
    displayName: engineId,
    document,
    durationSec,
    completedAt: "2026-01-01T00:01:00Z",
    timingGranularity,
  };
}

describe("Phase 3A: Temporal Overlap Primitives & Threshold Boundaries (Public API)", () => {
  it("Test A: 完全一致レンジ -> anchorCoverage=1.0, candidateCoverage=1.0, IoU=1.0", () => {
    const m = computeOverlapMetrics(10.0, 20.0, 10.0, 20.0);
    expect(m.overlapDurationSec).toBe(10.0);
    expect(m.anchorCoverage).toBe(1.0);
    expect(m.candidateCoverage).toBe(1.0);
    expect(m.iou).toBe(1.0);
  });

  it("Test B: 部分オーバーラップ -> overlap=5.0, anchorCoverage=0.5, candidateCoverage=0.5, IoU=0.333...", () => {
    const m = computeOverlapMetrics(10.0, 20.0, 15.0, 25.0);
    expect(m.overlapDurationSec).toBe(5.0);
    expect(m.anchorCoverage).toBe(0.5);
    expect(m.candidateCoverage).toBe(0.5);
    expect(m.iou).toBeCloseTo(5.0 / 15.0, 4);
  });

  it("Test C: 境界接触のみ -> overlap=0.0", () => {
    const m = computeOverlapMetrics(10.0, 20.0, 20.0, 30.0);
    expect(m.overlapDurationSec).toBe(0);
    expect(m.anchorCoverage).toBe(0);
    expect(m.candidateCoverage).toBe(0);
    expect(m.iou).toBe(0);
  });

  it("Test Threshold Public API 1: anchorCoverage = exactly 0.20, candidateCoverage >= 0.20 -> candidate 採択", () => {
    // Anchor [0, 100] (100s), Secondary [80, 180] (100s) -> overlap = 20.0s
    // anchorCoverage = 20 / 100 = 0.20, candidateCoverage = 20 / 100 = 0.20
    const anchorDoc = createDoc([createSegment("a1", 0.0, 100.0, "Anchor100s")], "C:/audio.wav", "audio.wav", "kotoba");
    const secDoc = createDoc([createSegment("s1", 80.0, 180.0, "Sec100s")], "C:/audio.wav", "audio.wav", "sec");

    const session: MultiEngineSession = {
      sessionId: "s-th1",
      mediaPath: "C:/audio.wav",
      mediaFileName: "audio.wav",
      expectedDurationSec: 200.0,
      anchorEngineId: "kotoba",
      results: {
        kotoba: createResult("kotoba", anchorDoc, "segment", 200.0),
        sec: createResult("sec", secDoc, "segment", 200.0),
      },
      createdAt: "2026-01-01T00:00:00Z",
    };

    const res = alignMultiEngineSession(session);
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0].candidates).toHaveLength(1);
    expect(res.groups[0].candidates[0].sourceSegmentId).toBe("s1");
    expect(res.groups[0].candidates[0].metrics.anchorCoverage).toBe(0.20);
    expect(res.groups[0].candidates[0].metrics.candidateCoverage).toBe(0.20);
  });

  it("Test Threshold Public API 2: candidateCoverage = exactly 0.20, anchorCoverage >= 0.20 -> candidate 採択", () => {
    // Anchor [0, 20] (20s), Secondary [0, 100] (100s) -> overlap = 20.0s
    // anchorCoverage = 20 / 20 = 1.0, candidateCoverage = 20 / 100 = 0.20 -> 採択
    const anchorDoc = createDoc([createSegment("a1", 0.0, 20.0, "Anchor20s")], "C:/audio.wav", "audio.wav", "kotoba");
    const secDoc = createDoc([createSegment("s1", 0.0, 100.0, "Sec100s")], "C:/audio.wav", "audio.wav", "sec");

    const session: MultiEngineSession = {
      sessionId: "s-th2",
      mediaPath: "C:/audio.wav",
      mediaFileName: "audio.wav",
      expectedDurationSec: 100.0,
      anchorEngineId: "kotoba",
      results: {
        kotoba: createResult("kotoba", anchorDoc, "segment", 100.0),
        sec: createResult("sec", secDoc, "segment", 100.0),
      },
      createdAt: "2026-01-01T00:00:00Z",
    };

    const res = alignMultiEngineSession(session);
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0].candidates).toHaveLength(1);
    expect(res.groups[0].candidates[0].metrics.candidateCoverage).toBe(0.20);
  });

  it("Test Threshold Public API 3: anchorCoverage = 0.19 -> candidate 除外", () => {
    // Anchor [0, 100] (100s), Secondary [81, 181] (100s) -> overlap = 19.0s
    // anchorCoverage = 19 / 100 = 0.19 < 0.20
    const anchorDoc = createDoc([createSegment("a1", 0.0, 100.0, "Anchor100s")], "C:/audio.wav", "audio.wav", "kotoba");
    const secDoc = createDoc([createSegment("s1", 81.0, 181.0, "Sec100s")], "C:/audio.wav", "audio.wav", "sec");

    const session: MultiEngineSession = {
      sessionId: "s-th3",
      mediaPath: "C:/audio.wav",
      mediaFileName: "audio.wav",
      expectedDurationSec: 200.0,
      anchorEngineId: "kotoba",
      results: {
        kotoba: createResult("kotoba", anchorDoc, "segment", 200.0),
        sec: createResult("sec", secDoc, "segment", 200.0),
      },
      createdAt: "2026-01-01T00:00:00Z",
    };

    const res = alignMultiEngineSession(session);
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0].candidates).toHaveLength(0); // 除外
  });

  it("Test Threshold Public API 4: candidateCoverage = 0.19 -> candidate 除外", () => {
    // Anchor [0, 19] (19s), Secondary [0, 100] (100s) -> overlap = 19.0s
    // anchorCoverage = 19 / 19 = 1.0, candidateCoverage = 19 / 100 = 0.19 < 0.20
    const anchorDoc = createDoc([createSegment("a1", 0.0, 19.0, "Anchor19s")], "C:/audio.wav", "audio.wav", "kotoba");
    const secDoc = createDoc([createSegment("s1", 0.0, 100.0, "Sec100s")], "C:/audio.wav", "audio.wav", "sec");

    const session: MultiEngineSession = {
      sessionId: "s-th4",
      mediaPath: "C:/audio.wav",
      mediaFileName: "audio.wav",
      expectedDurationSec: 100.0,
      anchorEngineId: "kotoba",
      results: {
        kotoba: createResult("kotoba", anchorDoc, "segment", 100.0),
        sec: createResult("sec", secDoc, "segment", 100.0),
      },
      createdAt: "2026-01-01T00:00:00Z",
    };

    const res = alignMultiEngineSession(session);
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0].candidates).toHaveLength(0); // 除外
  });

  it("Test G: Padding による探索 (Ranges intersect with padding)", () => {
    // Anchor [10.0, 20.0], Secondary [20.1, 25.0]
    // 差は 0.1秒 < ALIGNMENT_PADDING_SEC (0.35秒) なので探索対象になる
    const intersects = rangesIntersectWithPadding(10.0, 20.0, 20.1, 25.0, ALIGNMENT_PADDING_SEC);
    expect(intersects).toBe(true);
  });

  it("Test H & W: Padding discovery したが real overlap 0 -> スコア水増しされず最終candidateには採択されない", () => {
    const metrics = computeOverlapMetrics(10.0, 20.0, 20.1, 25.0);
    expect(metrics.overlapDurationSec).toBe(0);
    expect(metrics.anchorCoverage).toBe(0);
    expect(metrics.candidateCoverage).toBe(0);
    expect(metrics.anchorCoverage >= MIN_ANCHOR_COVERAGE).toBe(false);
  });
});

describe("Phase 3A: Media Path & FileName Normalization (Windows / UNC / Identity)", () => {
  it("Test UNC 1: Windows UNC path (\\\\Server\\Share\\Audio\\Test.wav) vs (//server/share/audio/test.wav) -> 同一視", () => {
    const p1 = normalizeMediaPath("\\\\Server\\Share\\Audio\\Test.wav");
    const p2 = normalizeMediaPath("//server/share/audio/test.wav");
    expect(p1).toBe("//server/share/audio/test.wav");
    expect(p2).toBe("//server/share/audio/test.wav");
    expect(p1).toBe(p2);
  });

  it("Test UNC 2: UNC path (//server/share/...) と 通常ルート (/server/share/...) は別扱い", () => {
    const unc = normalizeMediaPath("\\\\Server\\Share\\file.wav");
    const normalRoot = normalizeMediaPath("/Server/Share/file.wav");
    expect(unc).toBe("//server/share/file.wav");
    expect(normalRoot).toBe("/server/share/file.wav");
    expect(unc).not.toBe(normalRoot);
  });

  it("Test UNC 3: UNC path の大小文字差 -> 同一", () => {
    expect(normalizeMediaPath("\\\\SERVER\\SHARE\\FILE.WAV")).toBe(normalizeMediaPath("//server/share/file.wav"));
  });

  it("Test FileName: mediaFileName 比較は trim & case-insensitive (Test.wav vs test.wav -> 同一)", () => {
    expect(normalizeMediaFileName("  Test.WAV  ")).toBe("test.wav");
    expect(normalizeMediaFileName("test.wav")).toBe("test.wav");
    expect(normalizeMediaFileName("  Test.WAV  ")).toBe(normalizeMediaFileName("test.wav"));
  });

  it("Test Empty Identity: mediaPath / mediaFileName が空文字または空白のみ -> validation error", () => {
    const doc = createDoc([createSegment("a1", 0, 5, "テスト")], "", "");
    const session: MultiEngineSession = {
      sessionId: "s1",
      mediaPath: "   ",
      mediaFileName: "  ",
      expectedDurationSec: 60.0,
      anchorEngineId: "kotoba",
      results: {
        kotoba: createResult("kotoba", doc, "segment", 60.0),
      },
      createdAt: "2026-01-01T00:00:00Z",
    };
    const val = validateMultiEngineSession(session);
    expect(val.valid).toBe(false);
    expect(val.errors.some((e) => e.includes("mediaPath is required"))).toBe(true);
    expect(val.errors.some((e) => e.includes("mediaFileName is required"))).toBe(true);
    expect(val.errors.some((e) => e.includes("document.mediaPath is required"))).toBe(true);
    expect(val.errors.some((e) => e.includes("document.mediaFileName is required"))).toBe(true);
  });
});

describe("Phase 3A: Segment ID Validation & Immutability", () => {
  it("Test Segment ID A: Anchor segment.id = \"\" -> validation error", () => {
    const anchorDoc = createDoc([createSegment("", 0.0, 5.0, "空ID")], "C:/audio.wav", "audio.wav", "kotoba");
    const session: MultiEngineSession = {
      sessionId: "s-empty-id",
      mediaPath: "C:/audio.wav",
      mediaFileName: "audio.wav",
      expectedDurationSec: 60.0,
      anchorEngineId: "kotoba",
      results: {
        kotoba: createResult("kotoba", anchorDoc, "segment", 60.0),
      },
      createdAt: "2026-01-01T00:00:00Z",
    };
    const val = validateMultiEngineSession(session);
    expect(val.valid).toBe(false);
    expect(val.errors.some((e) => e.includes("has missing or empty id"))).toBe(true);
  });

  it("Test Segment ID B: Anchor segment.id = \"   \" -> validation error", () => {
    const anchorDoc = createDoc([createSegment("   ", 0.0, 5.0, "空白ID")], "C:/audio.wav", "audio.wav", "kotoba");
    const session: MultiEngineSession = {
      sessionId: "s-space-id",
      mediaPath: "C:/audio.wav",
      mediaFileName: "audio.wav",
      expectedDurationSec: 60.0,
      anchorEngineId: "kotoba",
      results: {
        kotoba: createResult("kotoba", anchorDoc, "segment", 60.0),
      },
      createdAt: "2026-01-01T00:00:00Z",
    };
    const val = validateMultiEngineSession(session);
    expect(val.valid).toBe(false);
    expect(val.errors.some((e) => e.includes("has missing or empty id"))).toBe(true);
  });

  it("Test Segment ID C: Secondary segment.id = \"\" -> validation error", () => {
    const anchorDoc = createDoc([createSegment("a1", 0.0, 5.0, "Anchor")], "C:/audio.wav", "audio.wav", "kotoba");
    const secDoc = createDoc([createSegment("", 0.0, 5.0, "Sec空ID")], "C:/audio.wav", "audio.wav", "sec");
    const session: MultiEngineSession = {
      sessionId: "s-sec-empty-id",
      mediaPath: "C:/audio.wav",
      mediaFileName: "audio.wav",
      expectedDurationSec: 60.0,
      anchorEngineId: "kotoba",
      results: {
        kotoba: createResult("kotoba", anchorDoc, "segment", 60.0),
        sec: createResult("sec", secDoc, "segment", 60.0),
      },
      createdAt: "2026-01-01T00:00:00Z",
    };
    const val = validateMultiEngineSession(session);
    expect(val.valid).toBe(false);
    expect(val.errors.some((e) => e.includes("has missing or empty id"))).toBe(true);
  });

  it("Test Segment ID D: Secondary segment.id = \"   \" -> validation error", () => {
    const anchorDoc = createDoc([createSegment("a1", 0.0, 5.0, "Anchor")], "C:/audio.wav", "audio.wav", "kotoba");
    const secDoc = createDoc([createSegment("   ", 0.0, 5.0, "Sec空白ID")], "C:/audio.wav", "audio.wav", "sec");
    const session: MultiEngineSession = {
      sessionId: "s-sec-space-id",
      mediaPath: "C:/audio.wav",
      mediaFileName: "audio.wav",
      expectedDurationSec: 60.0,
      anchorEngineId: "kotoba",
      results: {
        kotoba: createResult("kotoba", anchorDoc, "segment", 60.0),
        sec: createResult("sec", secDoc, "segment", 60.0),
      },
      createdAt: "2026-01-01T00:00:00Z",
    };
    const val = validateMultiEngineSession(session);
    expect(val.valid).toBe(false);
    expect(val.errors.some((e) => e.includes("has missing or empty id"))).toBe(true);
  });

  it("Test Segment ID E & F: 正常なIDで通過し、入力 segment.id が一切 mutation されない", () => {
    const anchorSeg = createSegment("seg-001", 0.0, 5.0, "Anchor");
    const secSeg = createSegment("SEC-001", 0.0, 5.0, "Sec"); // 大小文字が異なるID
    const anchorDoc = createDoc([anchorSeg], "C:/audio.wav", "audio.wav", "kotoba");
    const secDoc = createDoc([secSeg], "C:/audio.wav", "audio.wav", "sec");

    const session: MultiEngineSession = {
      sessionId: "s-valid-id",
      mediaPath: "C:/audio.wav",
      mediaFileName: "audio.wav",
      expectedDurationSec: 60.0,
      anchorEngineId: "kotoba",
      results: {
        kotoba: createResult("kotoba", anchorDoc, "segment", 60.0),
        sec: createResult("sec", secDoc, "segment", 60.0),
      },
      createdAt: "2026-01-01T00:00:00Z",
    };

    const res = alignMultiEngineSession(session);
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0].anchorSegment.id).toBe("seg-001");
    expect(res.groups[0].candidates[0].sourceSegmentId).toBe("SEC-001");

    // 入力元のオブジェクトが変更されていないこと
    expect(anchorSeg.id).toBe("seg-001");
    expect(secSeg.id).toBe("SEC-001");
  });

  it("Test Duplicate IDs 1: Anchor ドキュメント内に重複 segment ID が存在 -> validation error", () => {
    const seg1 = createSegment("seg-001", 0.0, 5.0, "テスト1");
    const seg2 = createSegment("seg-001", 5.0, 10.0, "テスト2 (重複ID)");
    const anchorDoc = createDoc([seg1, seg2], "C:/audio.wav", "audio.wav", "kotoba");

    const session: MultiEngineSession = {
      sessionId: "s-dup",
      mediaPath: "C:/audio.wav",
      mediaFileName: "audio.wav",
      expectedDurationSec: 60.0,
      anchorEngineId: "kotoba",
      results: {
        kotoba: createResult("kotoba", anchorDoc, "segment", 60.0),
      },
      createdAt: "2026-01-01T00:00:00Z",
    };

    const val = validateMultiEngineSession(session);
    expect(val.valid).toBe(false);
    expect(val.errors.some((e) => e.includes("duplicate segment ID"))).toBe(true);
  });

  it("Test Duplicate IDs 2: Secondary ドキュメント内に重複 segment ID が存在 -> validation error", () => {
    const anchorDoc = createDoc([createSegment("a1", 0.0, 5.0, "Anchor")], "C:/audio.wav", "audio.wav", "kotoba");
    const secDoc = createDoc([createSegment("s1", 0.0, 5.0, "S1"), createSegment("s1", 5.0, 10.0, "S1重複")], "C:/audio.wav", "audio.wav", "sec");

    const session: MultiEngineSession = {
      sessionId: "s-dup2",
      mediaPath: "C:/audio.wav",
      mediaFileName: "audio.wav",
      expectedDurationSec: 60.0,
      anchorEngineId: "kotoba",
      results: {
        kotoba: createResult("kotoba", anchorDoc, "segment", 60.0),
        sec: createResult("sec", secDoc, "segment", 60.0),
      },
      createdAt: "2026-01-01T00:00:00Z",
    };

    const val = validateMultiEngineSession(session);
    expect(val.valid).toBe(false);
    expect(val.errors.some((e) => e.includes("duplicate segment ID"))).toBe(true);
  });
});

describe("Phase 3A: Timestamp & Duration Validity Validation", () => {
  it("Test T: NaN / Infinity timestamp -> invalid", () => {
    const segs = [createSegment("s1", NaN, 10.0, "テスト")];
    const val = validateSegmentTimestamps(segs, 60.0);
    expect(val.valid).toBe(false);
    expect(val.reason).toContain("non-finite");
  });

  it("Test U: end <= start -> invalid", () => {
    const segs = [createSegment("s1", 10.0, 10.0, "テスト")];
    const val = validateSegmentTimestamps(segs, 60.0);
    expect(val.valid).toBe(false);
    expect(val.reason).toContain("end <= start");
  });

  it("Test V: end が duration + tolerance を大幅に超える timestamp -> invalid", () => {
    const segs = [createSegment("s1", 50.0, 70.0, "テスト")]; // 70 > 60 + 2
    const val = validateSegmentTimestamps(segs, 60.0);
    expect(val.valid).toBe(false);
    expect(val.reason).toContain("exceed duration");
  });

  it("Test Duration 1: result.durationSec が NaN / 0 / 負数 -> validation error", () => {
    const doc = createDoc([createSegment("a1", 0, 5, "テスト")]);
    const session: MultiEngineSession = {
      sessionId: "s1",
      mediaPath: "C:/audio.wav",
      mediaFileName: "audio.wav",
      expectedDurationSec: 60.0,
      anchorEngineId: "kotoba",
      results: {
        kotoba: createResult("kotoba", doc, "segment", 0), // 0 is invalid
      },
      createdAt: "2026-01-01T00:00:00Z",
    };
    const val = validateMultiEngineSession(session);
    expect(val.valid).toBe(false);
    expect(val.errors.some((e) => e.includes("durationSec must be a finite positive number"))).toBe(true);
  });

  it("Test Duration 2: expectedDurationSec が NaN / 負数 -> validation error", () => {
    const doc = createDoc([createSegment("a1", 0, 5, "テスト")]);
    const session: MultiEngineSession = {
      sessionId: "s1",
      mediaPath: "C:/audio.wav",
      mediaFileName: "audio.wav",
      expectedDurationSec: -10,
      anchorEngineId: "kotoba",
      results: {
        kotoba: createResult("kotoba", doc, "segment", 60.0),
      },
      createdAt: "2026-01-01T00:00:00Z",
    };
    const val = validateMultiEngineSession(session);
    expect(val.valid).toBe(false);
    expect(val.errors.some((e) => e.includes("expectedDurationSec must be a finite positive number"))).toBe(true);
  });

  it("Test Key Consistency: Record key と result.engineId の不一致 -> validation error", () => {
    const doc = createDoc([createSegment("a1", 0, 5, "テスト")]);
    const session: MultiEngineSession = {
      sessionId: "s1",
      mediaPath: "C:/audio.wav",
      mediaFileName: "audio.wav",
      expectedDurationSec: 60.0,
      anchorEngineId: "kotoba",
      results: {
        kotoba: createResult("qwen3-asr", doc, "segment", 60.0), // key "kotoba" != engineId "qwen3-asr"
      },
      createdAt: "2026-01-01T00:00:00Z",
    };
    const val = validateMultiEngineSession(session);
    expect(val.valid).toBe(false);
    expect(val.errors.some((e) => e.includes("does not match result.engineId"))).toBe(true);
  });

  it("Test Duration Boundary 1: durationSec 差がちょうど 2.0 秒 -> allowed", () => {
    const anchorDoc = createDoc([createSegment("a1", 0.0, 5.0, "A")], "C:/audio.wav", "audio.wav", "kotoba");
    const secDoc = createDoc([createSegment("s1", 0.0, 5.0, "S")], "C:/audio.wav", "audio.wav", "sec");

    const session: MultiEngineSession = {
      sessionId: "s-dur-exact",
      mediaPath: "C:/audio.wav",
      mediaFileName: "audio.wav",
      expectedDurationSec: 60.0,
      anchorEngineId: "kotoba",
      results: {
        kotoba: createResult("kotoba", anchorDoc, "segment", 60.0),
        sec: createResult("sec", secDoc, "segment", 62.0), // 差ちょうど 2.0s
      },
      createdAt: "2026-01-01T00:00:00Z",
    };

    const res = alignMultiEngineSession(session);
    expect(res.groups).toHaveLength(1);
    expect(res.unalignedSources).toHaveLength(0); // 2.0s以内なのでunalignedにされない
  });

  it("Test Duration Boundary 2: durationSec 差が 2.01 秒 -> mismatch (unalignedSources)", () => {
    const anchorDoc = createDoc([createSegment("a1", 0.0, 5.0, "A")], "C:/audio.wav", "audio.wav", "kotoba");
    const secDoc = createDoc([createSegment("s1", 0.0, 5.0, "S")], "C:/audio.wav", "audio.wav", "sec");

    const session: MultiEngineSession = {
      sessionId: "s-dur-over",
      mediaPath: "C:/audio.wav",
      mediaFileName: "audio.wav",
      expectedDurationSec: 60.0,
      anchorEngineId: "kotoba",
      results: {
        kotoba: createResult("kotoba", anchorDoc, "segment", 60.0),
        sec: createResult("sec", secDoc, "segment", 62.01), // 差 > 2.0s
      },
      createdAt: "2026-01-01T00:00:00Z",
    };

    const res = alignMultiEngineSession(session);
    expect(res.unalignedSources).toEqual([
      {
        engineId: "sec",
        reason: "duration_mismatch",
        sourceSegmentIds: ["s1"],
      },
    ]);
  });
});

describe("Phase 3A: MultiEngineSession Alignment Execution & Safeguards", () => {
  it("Test Anchor Whole Audio: Anchor 全体が whole_audio の場合、セグメントアラインメント不可として clean empty groups で終了", () => {
    const anchorDoc = createDoc([createSegment("a1", 0.0, 60.0, "全文")], "C:/meeting.wav", "meeting.wav", "reazon");
    const secDoc = createDoc([createSegment("s1", 0.0, 5.0, "部分")], "C:/meeting.wav", "meeting.wav", "kotoba");

    const session: MultiEngineSession = {
      sessionId: "session-anchor-whole",
      mediaPath: "C:/meeting.wav",
      mediaFileName: "meeting.wav",
      expectedDurationSec: 60.0,
      anchorEngineId: "reazon",
      results: {
        reazon: createResult("reazon", anchorDoc, "whole_audio", 60.0),
        kotoba: createResult("kotoba", secDoc, "segment", 60.0),
      },
      createdAt: "2026-01-01T00:00:00Z",
    };

    const res = alignMultiEngineSession(session);
    expect(res.groups).toHaveLength(0);
    expect(res.unalignedSources).toEqual([
      {
        engineId: "reazon",
        reason: "whole_audio_timing_only",
        sourceSegmentIds: ["a1"],
      },
    ]);
  });

  it("Test Anchor Word Granularity: Anchor が word granularity の場合、groups = [] で unsupported_timing_granularity 終了", () => {
    const anchorDoc = createDoc([createSegment("w1", 0.0, 1.0, "単語")], "C:/meeting.wav", "meeting.wav", "word-engine");

    const session: MultiEngineSession = {
      sessionId: "session-anchor-word",
      mediaPath: "C:/meeting.wav",
      mediaFileName: "meeting.wav",
      expectedDurationSec: 60.0,
      anchorEngineId: "word-engine",
      results: {
        "word-engine": createResult("word-engine", anchorDoc, "word", 60.0),
      },
      createdAt: "2026-01-01T00:00:00Z",
    };

    const res = alignMultiEngineSession(session);
    expect(res.groups).toHaveLength(0);
    expect(res.unalignedSources).toEqual([
      {
        engineId: "word-engine",
        reason: "unsupported_timing_granularity",
        sourceSegmentIds: ["w1"],
      },
    ]);
  });

  it("Test Empty Documents: Anchor 0件 または Secondary 0件 でもクラッシュせず正常終了", () => {
    const emptyAnchorDoc = createDoc([], "C:/meeting.wav", "meeting.wav", "kotoba");
    const emptySecDoc = createDoc([], "C:/meeting.wav", "meeting.wav", "sec-engine");

    const session: MultiEngineSession = {
      sessionId: "session-empty",
      mediaPath: "C:/meeting.wav",
      mediaFileName: "meeting.wav",
      expectedDurationSec: 30.0,
      anchorEngineId: "kotoba",
      results: {
        kotoba: createResult("kotoba", emptyAnchorDoc, "segment", 30.0),
        "sec-engine": createResult("sec-engine", emptySecDoc, "segment", 30.0),
      },
      createdAt: "2026-01-01T00:00:00Z",
    };

    const res = alignMultiEngineSession(session);
    expect(res.groups).toHaveLength(0);
    expect(res.unalignedSources).toHaveLength(0);
  });

  it("Test Unsorted Input: 入力セグメントが未ソートでも、ソート順で安定してアラインされ元ドキュメントは不変", () => {
    const a2 = createSegment("a2", 5.0, 10.0, "後半");
    const a1 = createSegment("a1", 0.0, 5.0, "前半");
    const anchorDoc = createDoc([a2, a1], "C:/meeting.wav", "meeting.wav", "kotoba"); // 順序が逆

    const s2 = createSegment("s2", 5.0, 10.0, "後半S");
    const s1 = createSegment("s1", 0.0, 5.0, "前半S");
    const secDoc = createDoc([s2, s1], "C:/meeting.wav", "meeting.wav", "sec");

    const session: MultiEngineSession = {
      sessionId: "session-unsorted",
      mediaPath: "C:/meeting.wav",
      mediaFileName: "meeting.wav",
      expectedDurationSec: 10.0,
      anchorEngineId: "kotoba",
      results: {
        kotoba: createResult("kotoba", anchorDoc, "segment", 10.0),
        sec: createResult("sec", secDoc, "segment", 10.0),
      },
      createdAt: "2026-01-01T00:00:00Z",
    };

    const res = alignMultiEngineSession(session);
    // ソート順 (0.0->5.0 が先、5.0->10.0 が後) で group が生成される
    expect(res.groups[0].anchorSegment.id).toBe("a1");
    expect(res.groups[0].candidates[0].sourceSegmentId).toBe("s1");
    expect(res.groups[1].anchorSegment.id).toBe("a2");
    expect(res.groups[1].candidates[0].sourceSegmentId).toBe("s2");

    // 元の配列順序は不変
    expect(anchorDoc.segments[0].id).toBe("a2");
    expect(secDoc.segments[0].id).toBe("s2");
  });

  it("Test D: 複数SecondaryがAnchorをカバーする場合、両方を候補として抽出", () => {
    const anchorSeg = createSegment("a1", 10.0, 20.0, "今日の議題はAIです");
    const anchorDoc = createDoc([anchorSeg], "C:/meeting.wav", "meeting.wav", "kotoba");

    const secSeg1 = createSegment("s1", 10.0, 15.0, "本日の議題は");
    const secSeg2 = createSegment("s2", 15.0, 20.0, "人工知能についてです");
    const secDoc = createDoc([secSeg1, secSeg2], "C:/meeting.wav", "meeting.wav", "sec-engine");

    const session: MultiEngineSession = {
      sessionId: "session-1",
      mediaPath: "C:/meeting.wav",
      mediaFileName: "meeting.wav",
      expectedDurationSec: 30.0,
      anchorEngineId: "kotoba",
      results: {
        kotoba: createResult("kotoba", anchorDoc, "segment", 30.0),
        "sec-engine": createResult("sec-engine", secDoc, "segment", 30.0),
      },
      createdAt: "2026-01-01T00:00:00Z",
    };

    const res = alignMultiEngineSession(session);
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0].candidates).toHaveLength(2);
    expect(res.groups[0].candidates[0].sourceSegmentId).toBe("s1");
    expect(res.groups[0].candidates[1].sourceSegmentId).toBe("s2");
    expect(res.unalignedSources).toHaveLength(0);
  });

  it("Test I & R: 31秒の長セグメント vs 2秒のAnchor -> candidateCoverage不足により直接候補から除外される", () => {
    const anchorSeg = createSegment("a1", 12.0, 14.0, "短いAnchor");
    const anchorDoc = createDoc([anchorSeg], "C:/meeting.wav", "meeting.wav", "kotoba");

    // 0〜31秒の長セグメント (2秒Anchorに対して candidateCoverage = 2 / 31 ≈ 0.064 < 0.20)
    const longSeg = createSegment("long-1", 0.0, 31.0, "これは非常に長いセグメントのテキストです。");
    const secDoc = createDoc([longSeg], "C:/meeting.wav", "meeting.wav", "long-engine");

    const session: MultiEngineSession = {
      sessionId: "session-long",
      mediaPath: "C:/meeting.wav",
      mediaFileName: "meeting.wav",
      expectedDurationSec: 31.0,
      anchorEngineId: "kotoba",
      results: {
        kotoba: createResult("kotoba", anchorDoc, "segment", 31.0),
        "long-engine": createResult("long-engine", secDoc, "segment", 31.0),
      },
      createdAt: "2026-01-01T00:00:00Z",
    };

    const res = alignMultiEngineSession(session);
    expect(res.groups).toHaveLength(1);
    // candidateCoverage不足のため、このAnchorの候補には採択されない
    expect(res.groups[0].candidates).toHaveLength(0);
  });

  it("Test J & K & L & S: whole_audio (Qwen / Reazon no-diarization) は unalignedSources に1度だけ保持され、各Anchorグループへ全文複製されない", () => {
    const anchorSeg1 = createSegment("a1", 0.0, 5.0, "セグメント1");
    const anchorSeg2 = createSegment("a2", 5.0, 10.0, "セグメント2");
    const anchorDoc = createDoc([anchorSeg1, anchorSeg2], "C:/meeting.wav", "meeting.wav", "kotoba");

    const qwenSeg = createSegment("q1", 0.0, 60.0, "Qwenの1万文字の全文テキスト...");
    const qwenDoc = createDoc([qwenSeg], "C:/meeting.wav", "meeting.wav", "qwen3-asr");

    const reazonSeg = createSegment("r1", 0.0, 60.0, "Reazonの全文テキスト...");
    const reazonDoc = createDoc([reazonSeg], "C:/meeting.wav", "meeting.wav", "reazonspeech");

    const session: MultiEngineSession = {
      sessionId: "session-whole",
      mediaPath: "C:/meeting.wav",
      mediaFileName: "meeting.wav",
      expectedDurationSec: 60.0,
      anchorEngineId: "kotoba",
      results: {
        kotoba: createResult("kotoba", anchorDoc, "segment", 60.0),
        "qwen3-asr": createResult("qwen3-asr", qwenDoc, "whole_audio", 60.0),
        reazonspeech: createResult("reazonspeech", reazonDoc, "whole_audio", 60.0),
      },
      createdAt: "2026-01-01T00:00:00Z",
    };

    const res = alignMultiEngineSession(session);

    // Anchor groups は 2件
    expect(res.groups).toHaveLength(2);
    // 各Anchor groupの candidates は 0件（whole_audio から捏造しない）
    expect(res.groups[0].candidates).toHaveLength(0);
    expect(res.groups[1].candidates).toHaveLength(0);

    // unalignedSources は全体レベルで 2件のみ（セグメント数倍に複製されない）
    expect(res.unalignedSources).toHaveLength(2);
    expect(res.unalignedSources).toEqual([
      {
        engineId: "qwen3-asr",
        reason: "whole_audio_timing_only",
        sourceSegmentIds: ["q1"],
      },
      {
        engineId: "reazonspeech",
        reason: "whole_audio_timing_only",
        sourceSegmentIds: ["r1"],
      },
    ]);
  });

  it("Test M: Kotoba ネイティブセグメント同士の正常な時間軸アラインメント (スラッシュ/大小文字違いのパスも同一視)", () => {
    const anchorSeg1 = createSegment("a1", 0.0, 5.0, "こんにちは");
    const anchorSeg2 = createSegment("a2", 5.0, 10.0, "さようなら");
    const anchorDoc = createDoc([anchorSeg1, anchorSeg2], "C:\\Meeting.wav", "meeting.wav", "engine-a");

    const secSeg1 = createSegment("s1", 0.2, 4.8, "こんにちは。");
    const secSeg2 = createSegment("s2", 5.1, 9.9, "さようなら。");
    const secDoc = createDoc([secSeg1, secSeg2], "c:/meeting.wav", "meeting.wav", "engine-b");

    const session: MultiEngineSession = {
      sessionId: "session-normal",
      mediaPath: "C:/meeting.wav",
      mediaFileName: "meeting.wav",
      expectedDurationSec: 10.0,
      anchorEngineId: "engine-a",
      results: {
        "engine-a": createResult("engine-a", anchorDoc, "segment", 10.0),
        "engine-b": createResult("engine-b", secDoc, "segment", 10.0),
      },
      createdAt: "2026-01-01T00:00:00Z",
    };

    const res = alignMultiEngineSession(session);
    expect(res.groups).toHaveLength(2);
    expect(res.groups[0].candidates).toHaveLength(1);
    expect(res.groups[0].candidates[0].text).toBe("こんにちは。");
    expect(res.groups[1].candidates).toHaveLength(1);
    expect(res.groups[1].candidates[0].text).toBe("さようなら。");
  });

  it("Test N: 異なるパスのファイル (ディレクトリ違い) -> validation error で拒絶", () => {
    const anchorDoc = createDoc([createSegment("a1", 0.0, 5.0, "テスト")], "C:/A/audio.wav", "audio.wav", "engine-a");
    const secDoc = createDoc([createSegment("s1", 0.0, 5.0, "テスト")], "C:/B/audio.wav", "audio.wav", "engine-b");

    const session: MultiEngineSession = {
      sessionId: "session-mismatch",
      mediaPath: "C:/A/audio.wav",
      mediaFileName: "audio.wav",
      expectedDurationSec: 10.0,
      anchorEngineId: "engine-a",
      results: {
        "engine-a": createResult("engine-a", anchorDoc, "segment", 10.0),
        "engine-b": createResult("engine-b", secDoc, "segment", 10.0),
      },
      createdAt: "2026-01-01T00:00:00Z",
    };

    const res = alignMultiEngineSession(session);
    expect(res.groups).toHaveLength(0);
    expect(res.warnings.some((w) => w.includes("mediaPath mismatch"))).toBe(true);
  });

  it("Test P: Anchor 切替の非破壊性 (raw results が一切変更されない)", () => {
    const docA = createDoc([createSegment("a1", 0.0, 5.0, "A1")], "C:/audio.wav", "audio.wav", "engine-a");
    const docB = createDoc([createSegment("b1", 0.0, 5.0, "B1")], "C:/audio.wav", "audio.wav", "engine-b");

    const session: MultiEngineSession = {
      sessionId: "session-switch",
      mediaPath: "C:/audio.wav",
      mediaFileName: "audio.wav",
      expectedDurationSec: 10.0,
      anchorEngineId: "engine-a",
      results: {
        "engine-a": createResult("engine-a", docA, "segment", 10.0),
        "engine-b": createResult("engine-b", docB, "segment", 10.0),
      },
      createdAt: "2026-01-01T00:00:00Z",
    };

    // 1回目: Anchor = engine-a
    const res1 = alignMultiEngineSession(session);
    expect(res1.anchorEngineId).toBe("engine-a");
    expect(res1.groups[0].anchorSegment.id).toBe("a1");

    // 2回目: Anchor を engine-b に切り替え
    const sessionSwitched = { ...session, anchorEngineId: "engine-b" };
    const res2 = alignMultiEngineSession(sessionSwitched);
    expect(res2.anchorEngineId).toBe("engine-b");
    expect(res2.groups[0].anchorSegment.id).toBe("b1");

    // 生データは不変
    expect(session.results["engine-a"].document.segments[0].text).toBe("A1");
    expect(session.results["engine-b"].document.segments[0].text).toBe("B1");
  });

  it("Test Q: Document Immutability (入力ドキュメントが完全に不変であること)", () => {
    const seg = createSegment("a1", 0.0, 5.0, "不変テキスト");
    const doc = createDoc([seg], "C:/audio.wav", "audio.wav", "engine-a");
    const originalSnapshot = JSON.stringify(doc);

    const session: MultiEngineSession = {
      sessionId: "session-immut",
      mediaPath: "C:/audio.wav",
      mediaFileName: "audio.wav",
      expectedDurationSec: 10.0,
      anchorEngineId: "engine-a",
      results: {
        "engine-a": createResult("engine-a", doc, "segment", 10.0),
      },
      createdAt: "2026-01-01T00:00:00Z",
    };

    alignMultiEngineSession(session);
    expect(JSON.stringify(doc)).toBe(originalSnapshot);
  });

  it("Test X: Secondary word granularity -> unalignedSources に unsupported_timing_granularity として安全に分類", () => {
    const anchorDoc = createDoc([createSegment("a1", 0.0, 5.0, "テスト")], "C:/audio.wav", "audio.wav", "engine-a");
    const wordDoc = createDoc([createSegment("w1", 0.0, 5.0, "テスト")], "C:/audio.wav", "audio.wav", "word-engine");

    const session: MultiEngineSession = {
      sessionId: "session-word",
      mediaPath: "C:/audio.wav",
      mediaFileName: "audio.wav",
      expectedDurationSec: 10.0,
      anchorEngineId: "engine-a",
      results: {
        "engine-a": createResult("engine-a", anchorDoc, "segment", 10.0),
        "word-engine": createResult("word-engine", wordDoc, "word", 10.0),
      },
      createdAt: "2026-01-01T00:00:00Z",
    };

    const res = alignMultiEngineSession(session);
    expect(res.unalignedSources).toEqual([
      {
        engineId: "word-engine",
        reason: "unsupported_timing_granularity",
        sourceSegmentIds: ["w1"],
      },
    ]);
  });

  it("Exported Alignment Constants match specifications", () => {
    expect(ALIGNMENT_PADDING_SEC).toBe(0.35);
    expect(MIN_ANCHOR_COVERAGE).toBe(0.20);
    expect(MIN_CANDIDATE_COVERAGE).toBe(0.20);
  });
});
