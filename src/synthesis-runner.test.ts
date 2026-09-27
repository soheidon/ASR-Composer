import { describe, it, expect, vi } from "vitest";
import { runSynthesisForAlignment } from "./synthesis-runner";
import { DEFAULT_SYNTHESIS_CHUNK_SIZE } from "./synthesis";
import type { SynthesisProvider } from "./synthesis-provider";
import type { MultiEngineAlignmentResult, AlignedSegmentGroup } from "./multi-asr";
import type { TranscriptSegment } from "./transcript";
import type { CorrectionProgress } from "./correction";

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
    sourceEngine: "kotoba-whisper",
    sourceSegmentId: id,
    sourceRunId: "run-test",
    status: "raw",
  };
}

function createGroup(
  anchorId: string,
  start: number,
  end: number,
  text: string,
  candidates: Array<{ engineId: string; sourceSegmentId: string; text: string }> = []
): AlignedSegmentGroup {
  return {
    anchorSegment: createSegment(anchorId, start, end, text),
    candidates: candidates.map((c) => ({
      engineId: c.engineId,
      sourceSegmentId: c.sourceSegmentId,
      timeRange: { start, end },
      text: c.text,
      metrics: {
        overlapDurationSec: end - start,
        anchorCoverage: 1.0,
        candidateCoverage: 1.0,
        iou: 1.0,
      },
    })),
  };
}

describe("Synthesis Runner Integration (Phase 3B)", () => {
  it("Test A & Test E: Anchor + 1 Aligned Candidate -> Proposal 生成と ID 追跡", async () => {
    const group = createGroup("a1", 0.0, 5.0, "じどうせいしんいがく", [
      { engineId: "whisper", sourceSegmentId: "w1", text: "児童精神医学" },
    ]);

    const alignment: MultiEngineAlignmentResult = {
      sessionId: "s1",
      anchorEngineId: "kotoba",
      groups: [group],
      unalignedSources: [],
      warnings: [],
    };

    const mockProvider: SynthesisProvider = {
      synthesize: vi.fn().mockResolvedValue([
        {
          segmentId: "a1",
          originalText: "じどうせいしんいがく",
          correctedText: "児童精神医学",
          evidence: [{ type: "context" }],
          explanation: "ASR候補に基づく補正",
        },
      ]),
    };

    const result = await runSynthesisForAlignment({
      alignment,
      provider: mockProvider,
    });

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.proposals.length).toBe(1);
      const prop = result.proposals[0];
      expect(prop.segmentId).toBe("a1");
      expect(prop.correctedText).toBe("児童精神医学");
      expect(prop.kind).toBe("multi_asr_synthesis");
      expect(prop.anchorEngineId).toBe("kotoba");
      expect(prop.supportingSources).toEqual([
        { engineId: "whisper", sourceSegmentId: "w1" },
      ]);
    }
  });

  it("Test B: Anchor + 複数 Aligned Candidates -> Consensus サマリーと複数支持ソースの保持", async () => {
    const group = createGroup("a1", 0.0, 5.0, "じどうせいしんいがく", [
      { engineId: "whisper", sourceSegmentId: "w1", text: "児童精神医学" },
      { engineId: "reazon", sourceSegmentId: "r1", text: "児童精神医学" },
    ]);

    const alignment: MultiEngineAlignmentResult = {
      sessionId: "s1",
      anchorEngineId: "kotoba",
      groups: [group],
      unalignedSources: [],
      warnings: [],
    };

    const mockProvider: SynthesisProvider = {
      synthesize: vi.fn().mockImplementation(async (req) => {
        expect(req.targets[0].agreement?.hasConsensus).toBe(true);
        expect(req.targets[0].agreement?.consensusGroups.length).toBe(1);
        return [
          {
            segmentId: "a1",
            originalText: "じどうせいしんいがく",
            correctedText: "児童精神医学",
            evidence: [{ type: "context" }],
            explanation: "複数ASR一致に基づく補正",
          },
        ];
      }),
    };

    const result = await runSynthesisForAlignment({
      alignment,
      provider: mockProvider,
    });

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.proposals.length).toBe(1);
      expect(result.proposals[0].supportingSources.length).toBe(2);
      expect(result.proposals[0].supportingSources).toEqual(
        expect.arrayContaining([
          { engineId: "whisper", sourceSegmentId: "w1" },
          { engineId: "reazon", sourceSegmentId: "r1" },
        ])
      );
    }
  });

  it("Test C: candidate なしセグメントが混在しても Anchor 時系列連続性を維持し、full sequence から context を抽出する", async () => {
    // 10個のグループを作成（a1:あり, a2..a8:なし, a9:あり, a10:なし）
    const groups: AlignedSegmentGroup[] = [];
    for (let i = 1; i <= 10; i++) {
      if (i === 1 || i === 9) {
        groups.push(
          createGroup(`a${i}`, (i - 1) * 5, i * 5, `テキスト ${i}`, [
            { engineId: "whisper", sourceSegmentId: `w${i}`, text: `候補 ${i}` },
          ])
        );
      } else {
        groups.push(createGroup(`a${i}`, (i - 1) * 5, i * 5, `テキスト ${i}`, []));
      }
    }

    const alignment: MultiEngineAlignmentResult = {
      sessionId: "s-mixed",
      anchorEngineId: "kotoba",
      groups,
      unalignedSources: [],
      warnings: [],
    };

    const receivedRequests: unknown[] = [];
    const mockProvider: SynthesisProvider = {
      synthesize: vi.fn().mockImplementation(async (req) => {
        receivedRequests.push(req);
        return [];
      }),
    };

    // chunkSize = 8 (Window 1: a1..a8, Window 2: a9..a10)
    const result = await runSynthesisForAlignment({
      alignment,
      chunkSize: 8,
      provider: mockProvider,
    });

    expect(result.status).toBe("success");
    expect(mockProvider.synthesize).toHaveBeenCalledTimes(2);

    // Window 1 の検証: target は a1 のみ、contextAfter に a9, a10 が含まれる
    const req1 = receivedRequests[0] as {
      targets: Array<{ segmentId: string }>;
      contextAfter?: Array<{ id: string }>;
    };
    expect(req1.targets.map((t) => t.segmentId)).toEqual(["a1"]);
    expect(req1.contextAfter?.map((s) => s.id)).toEqual(["a9", "a10"]);

    // Window 2 の検証: target は a9 のみ、contextBefore に a7, a8 が含まれる
    const req2 = receivedRequests[1] as {
      targets: Array<{ segmentId: string }>;
      contextBefore?: Array<{ id: string }>;
    };
    expect(req2.targets.map((t) => t.segmentId)).toEqual(["a9"]);
    expect(req2.contextBefore?.map((s) => s.id)).toEqual(["a7", "a8"]);
  });

  it("Test D: whole_audio（unalignedSources）がプロンプトへ一切入らないこと", async () => {
    const group = createGroup("a1", 0.0, 5.0, "テキスト", [
      { engineId: "whisper", sourceSegmentId: "w1", text: "候補" },
    ]);

    const alignment: MultiEngineAlignmentResult = {
      sessionId: "s1",
      anchorEngineId: "kotoba",
      groups: [group],
      unalignedSources: [
        {
          engineId: "reazonspeech-whole",
          reason: "whole_audio_timing_only",
          sourceSegmentIds: ["r-whole"],
        },
      ],
      warnings: [],
    };

    let receivedCandidates: unknown[] = [];
    const mockProvider: SynthesisProvider = {
      synthesize: vi.fn().mockImplementation(async (req) => {
        receivedCandidates = req.targets[0].candidates;
        return [];
      }),
    };

    await runSynthesisForAlignment({ alignment, provider: mockProvider });
    expect(receivedCandidates.length).toBe(1);
    expect((receivedCandidates[0] as { engineId: string }).engineId).toBe("whisper");
  });

  it("Test X & Test Y: 全ターゲットが candidate 0 件の場合は Provider call 0 回で即座に成功を返す", async () => {
    const groups = [
      createGroup("a1", 0.0, 5.0, "テキスト1", []),
      createGroup("a2", 5.0, 10.0, "テキスト2", []),
    ];

    const alignment: MultiEngineAlignmentResult = {
      sessionId: "s-zero",
      anchorEngineId: "kotoba",
      groups,
      unalignedSources: [],
      warnings: [],
    };

    const mockProvider: SynthesisProvider = {
      synthesize: vi.fn(),
    };

    const progressReports: CorrectionProgress[] = [];
    const result = await runSynthesisForAlignment({
      alignment,
      provider: mockProvider,
      onProgress: (p) => progressReports.push(p),
    });

    expect(mockProvider.synthesize).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "success", proposals: [] });
    expect(progressReports.length).toBe(1);
    expect(progressReports[0].phase).toBe("completed");
  });

  it("Test S: 入力データ（MultiEngineAlignmentResult）の完全な不変性（Immutability）", async () => {
    const group = createGroup("a1", 0.0, 5.0, "テキスト", [
      { engineId: "whisper", sourceSegmentId: "w1", text: "候補" },
    ]);
    const alignment: MultiEngineAlignmentResult = {
      sessionId: "s1",
      anchorEngineId: "kotoba",
      groups: [group],
      unalignedSources: [],
      warnings: [],
    };

    const snapshot = JSON.stringify(alignment);
    const mockProvider: SynthesisProvider = {
      synthesize: vi.fn().mockResolvedValue([]),
    };

    await runSynthesisForAlignment({ alignment, provider: mockProvider });
    expect(JSON.stringify(alignment)).toBe(snapshot);
  });

  it("Logical Cancellation: 開始前・実行途中のキャンセルで { status: 'cancelled' } を返し、部分提案を破棄する", async () => {
    const groups = [
      createGroup("a1", 0.0, 5.0, "テキスト1", [
        { engineId: "whisper", sourceSegmentId: "w1", text: "候補1" },
      ]),
      createGroup("a2", 5.0, 10.0, "テキスト2", [
        { engineId: "whisper", sourceSegmentId: "w2", text: "候補2" },
      ]),
    ];

    const alignment: MultiEngineAlignmentResult = {
      sessionId: "s-cancel",
      anchorEngineId: "kotoba",
      groups,
      unalignedSources: [],
      warnings: [],
    };

    // 1. 開始前キャンセル
    const resBefore = await runSynthesisForAlignment({
      alignment,
      isCancelled: () => true,
    });
    expect(resBefore).toEqual({ status: "cancelled" });

    // 2. チャンク実行中キャンセル
    let cancelFlag = false;
    const mockProvider: SynthesisProvider = {
      synthesize: vi.fn().mockImplementation(async () => {
        cancelFlag = true; // 1回目のバッチ後にキャンセル
        return [
          {
            segmentId: "a1",
            originalText: "テキスト1",
            correctedText: "候補1",
            evidence: [{ type: "context" }],
            explanation: "修正",
          },
        ];
      }),
    };

    const resDuring = await runSynthesisForAlignment({
      alignment,
      chunkSize: 1, // 2バッチに分割
      provider: mockProvider,
      isCancelled: () => cancelFlag,
    });

    expect(resDuring).toEqual({ status: "cancelled" });
  });

  describe("chunkSize parameter validation", () => {
    const validAlignment: MultiEngineAlignmentResult = {
      sessionId: "s-chunk-val",
      anchorEngineId: "kotoba",
      groups: [
        createGroup("a1", 0.0, 5.0, "テキスト1", [
          { engineId: "whisper", sourceSegmentId: "w1", text: "候補1" },
        ]),
      ],
      unalignedSources: [],
      warnings: [],
    };

    it("Case A: chunkSize = 0 -> rejects with Error", async () => {
      await expect(
        runSynthesisForAlignment({ alignment: validAlignment, chunkSize: 0 })
      ).rejects.toThrow("無効な chunkSize です: 0");
    });

    it("Case B: chunkSize = -1 -> rejects with Error", async () => {
      await expect(
        runSynthesisForAlignment({ alignment: validAlignment, chunkSize: -1 })
      ).rejects.toThrow("無効な chunkSize です: -1");
    });

    it("Case C: chunkSize = NaN -> rejects with Error", async () => {
      await expect(
        runSynthesisForAlignment({ alignment: validAlignment, chunkSize: NaN })
      ).rejects.toThrow("無効な chunkSize です: NaN");
    });

    it("Case D: chunkSize = Infinity -> rejects with Error", async () => {
      await expect(
        runSynthesisForAlignment({ alignment: validAlignment, chunkSize: Infinity })
      ).rejects.toThrow("無効な chunkSize です: Infinity");
    });

    it("Case E: chunkSize = 1.5 (non-integer) -> rejects with Error", async () => {
      await expect(
        runSynthesisForAlignment({ alignment: validAlignment, chunkSize: 1.5 })
      ).rejects.toThrow("無効な chunkSize です: 1.5");
    });

    it("Case F: chunkSize = 1 (minimum positive integer) -> valid execution", async () => {
      const mockProvider: SynthesisProvider = {
        synthesize: vi.fn().mockResolvedValue([]),
      };
      const res = await runSynthesisForAlignment({
        alignment: validAlignment,
        chunkSize: 1,
        provider: mockProvider,
      });
      expect(res.status).toBe("success");
    });

    it("Case G: chunkSize = DEFAULT_SYNTHESIS_CHUNK_SIZE (8) -> valid execution", async () => {
      const mockProvider: SynthesisProvider = {
        synthesize: vi.fn().mockResolvedValue([]),
      };
      const res = await runSynthesisForAlignment({
        alignment: validAlignment,
        chunkSize: DEFAULT_SYNTHESIS_CHUNK_SIZE,
        provider: mockProvider,
      });
      expect(res.status).toBe("success");
    });
  });
});
