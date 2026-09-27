import { describe, it, expect } from "vitest";
import {
  normalizeForAgreement,
  computeAgreementSummary,
  parseRawSynthesisCandidates,
  computeSupportingSources,
  validateSynthesisCandidate,
  promoteCandidateToSynthesisProposal,
  type SynthesisCandidate,
  type ParsedSynthesisProposalCandidate,
  type SynthesisTargetItem,
} from "./synthesis";
import type { TranscriptSegment } from "./transcript";

function createSegment(
  id: string,
  text: string,
  start = 0,
  end = 5,
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
    sourceRunId: "run-1",
    status: "raw",
  };
}

describe("Synthesis Domain & Normalization (Phase 3B)", () => {
  it("normalizeForAgreement: NFKC, 空白, 句読点を除去して比較用文字列を生成する", () => {
    const raw = "　児童 精神医学、ですね！？ (テスト)　";
    const norm = normalizeForAgreement(raw);
    expect(norm).toBe("児童精神医学ですねテスト");
  });

  it("Test AE: 一致正規化処理が original / corrected / raw candidate text を mutation しないこと", () => {
    const original = "　児童 精神医学、ですね！？　";
    const snapshot = original;
    const norm = normalizeForAgreement(original);
    expect(original).toBe(snapshot);
    expect(norm).toBe("児童精神医学ですね");
  });

  it("Test P: 複数候補が正規化一致（Consensus）している場合の consensusGroups 生成", () => {
    const candidates: SynthesisCandidate[] = [
      {
        engineId: "engine-b",
        sourceSegmentId: "b1",
        text: "児童精神医学",
        overlapDurationSec: 4.0,
        anchorCoverage: 0.8,
        candidateCoverage: 0.8,
        iou: 0.7,
      },
    ];

    const summary = computeAgreementSummary("engine-a", "児童 精神医学", candidates);
    expect(summary.hasConsensus).toBe(true);
    expect(summary.consensusGroups.length).toBe(1);
    expect(summary.consensusGroups[0].engineIds).toEqual(expect.arrayContaining(["engine-a", "engine-b"]));
    expect(summary.consensusGroups[0].isConsensus).toBe(true);
  });

  it("Test Q: 候補同士が不一致の場合のグループ分割と hasConsensus = false", () => {
    const candidates: SynthesisCandidate[] = [
      {
        engineId: "engine-b",
        sourceSegmentId: "b1",
        text: "小児精神科",
        overlapDurationSec: 4.0,
        anchorCoverage: 0.8,
        candidateCoverage: 0.8,
        iou: 0.7,
      },
      {
        engineId: "engine-c",
        sourceSegmentId: "c1",
        text: "児童心理学",
        overlapDurationSec: 4.0,
        anchorCoverage: 0.8,
        candidateCoverage: 0.8,
        iou: 0.7,
      },
    ];

    const summary = computeAgreementSummary("engine-a", "児童精神医学", candidates);
    expect(summary.hasConsensus).toBe(false);
    expect(summary.consensusGroups.length).toBe(0);
    expect(summary.groups.length).toBe(3);
  });

  it("Test V: 同一エンジンから2 candidate segments -> distinctEngineCount は 1", () => {
    const candidates: SynthesisCandidate[] = [
      {
        engineId: "kotoba",
        sourceSegmentId: "k1",
        text: "精神医学",
        overlapDurationSec: 2.0,
        anchorCoverage: 0.4,
        candidateCoverage: 0.9,
        iou: 0.4,
      },
      {
        engineId: "kotoba",
        sourceSegmentId: "k2",
        text: "精神医学",
        overlapDurationSec: 2.0,
        anchorCoverage: 0.4,
        candidateCoverage: 0.9,
        iou: 0.4,
      },
    ];

    // Anchor は異なるテキスト ("心理学")
    const summary = computeAgreementSummary("reazon", "心理学", candidates);
    expect(summary.hasConsensus).toBe(false);
    const kotobaGrp = summary.groups.find((g) => g.normalizedText === "精神医学");
    expect(kotobaGrp).toBeDefined();
    expect(kotobaGrp?.engineIds).toEqual(["kotoba"]);
    expect(kotobaGrp?.isConsensus).toBe(false);
  });

  it("Test W: Anchor + Kotoba 2セグメント -> 2 engine consensus として扱い、3 votes とは扱わない", () => {
    const candidates: SynthesisCandidate[] = [
      {
        engineId: "kotoba",
        sourceSegmentId: "k1",
        text: "児童精神医学",
        overlapDurationSec: 2.0,
        anchorCoverage: 0.4,
        candidateCoverage: 0.9,
        iou: 0.4,
      },
      {
        engineId: "kotoba",
        sourceSegmentId: "k2",
        text: "児童精神医学",
        overlapDurationSec: 2.0,
        anchorCoverage: 0.4,
        candidateCoverage: 0.9,
        iou: 0.4,
      },
    ];

    const summary = computeAgreementSummary("reazon", "児童精神医学", candidates);
    expect(summary.hasConsensus).toBe(true);
    expect(summary.consensusGroups.length).toBe(1);
    expect(summary.consensusGroups[0].engineIds).toEqual(expect.arrayContaining(["reazon", "kotoba"]));
    expect(summary.consensusGroups[0].engineIds.length).toBe(2);
  });

  it("Test AA: 複数一致グループが存在する場合に consensusGroups に複数格納され単一winnerを強制しないこと", () => {
    const candidates: SynthesisCandidate[] = [
      {
        engineId: "engine-b",
        sourceSegmentId: "b1",
        text: "児童精神医学",
        overlapDurationSec: 4.0,
        anchorCoverage: 0.8,
        candidateCoverage: 0.8,
        iou: 0.7,
      },
      {
        engineId: "engine-c",
        sourceSegmentId: "c1",
        text: "小児精神医学",
        overlapDurationSec: 4.0,
        anchorCoverage: 0.8,
        candidateCoverage: 0.8,
        iou: 0.7,
      },
      {
        engineId: "engine-d",
        sourceSegmentId: "d1",
        text: "小児精神医学",
        overlapDurationSec: 4.0,
        anchorCoverage: 0.8,
        candidateCoverage: 0.8,
        iou: 0.7,
      },
    ];

    const summary = computeAgreementSummary("engine-a", "児童精神医学", candidates);
    expect(summary.hasConsensus).toBe(true);
    expect(summary.consensusGroups.length).toBe(2);
    const grp1 = summary.consensusGroups.find((g) => g.normalizedText === "児童精神医学");
    const grp2 = summary.consensusGroups.find((g) => g.normalizedText === "小児精神医学");
    expect(grp1?.engineIds).toEqual(expect.arrayContaining(["engine-a", "engine-b"]));
    expect(grp2?.engineIds).toEqual(expect.arrayContaining(["engine-c", "engine-d"]));
  });
});

describe("Synthesis Runtime Parser & Strict Schema (Phase 3B)", () => {
  it("Test F: 未知の余剰フィールドが含まれる場合は strict parser / schema validation で reject されること", () => {
    const invalidPayloadWithExtra = {
      proposals: [
        {
          segmentId: "seg-1",
          originalText: "元のテキスト",
          correctedText: "補正後テキスト",
          evidence: [{ type: "dictionary", sourceId: "d1", description: "辞書一致" }],
          explanation: "修正理由",
          supportingSources: [{ engineId: "fake-engine", sourceSegmentId: "fake-id" }], // 未知フィールド
        },
      ],
    };

    const parsed = parseRawSynthesisCandidates(invalidPayloadWithExtra);
    expect(parsed).toBeNull();
  });

  it("Test H: 不正なJSON / スキーマ違反レスポンス（型不一致・必須欠落）を安全に reject すること", () => {
    expect(parseRawSynthesisCandidates(null)).toBeNull();
    expect(parseRawSynthesisCandidates("string")).toBeNull();
    expect(parseRawSynthesisCandidates({ proposals: "not-an-array" })).toBeNull();
    expect(
      parseRawSynthesisCandidates({
        proposals: [
          {
            segmentId: "seg-1",
            // originalText 欠落
            correctedText: "補正後",
            evidence: [],
            explanation: "理由",
          },
        ],
      })
    ).toBeNull();
  });

  it("正常な proposals ペイロードをパースして ParsedSynthesisProposalCandidate 配列を返す", () => {
    const validPayload = {
      proposals: [
        {
          segmentId: "seg-1",
          originalText: "元のテキスト",
          correctedText: "補正後テキスト",
          evidence: [{ type: "dictionary", sourceId: "d1", description: "辞書一致" }],
          explanation: "修正理由",
          confidence: 0.95,
        },
      ],
    };

    const parsed = parseRawSynthesisCandidates(validPayload);
    expect(parsed).not.toBeNull();
    expect(parsed?.length).toBe(1);
    expect(parsed?.[0].segmentId).toBe("seg-1");
    expect(parsed?.[0].confidence).toBe(0.95);
  });
});

describe("App-side Supporting Sources & Validation (Phase 3B)", () => {
  const sampleCandidates: SynthesisCandidate[] = [
    {
      engineId: "kotoba",
      sourceSegmentId: "k-100",
      text: "児童精神医学",
      overlapDurationSec: 4.0,
      anchorCoverage: 0.9,
      candidateCoverage: 0.9,
      iou: 0.8,
    },
    {
      engineId: "whisper",
      sourceSegmentId: "w-200",
      text: "小児精神医学",
      overlapDurationSec: 4.0,
      anchorCoverage: 0.9,
      candidateCoverage: 0.9,
      iou: 0.8,
    },
  ];

  it("Test G & Test Z: correctedText と candidate の正規化完全一致のみが supportingSources に入ること", () => {
    const sources = computeSupportingSources("児童 精神医学", sampleCandidates);
    expect(sources).toEqual([{ engineId: "kotoba", sourceSegmentId: "k-100" }]);
  });

  it("Test AB: dictionary由来の修正で candidate との完全一致なし -> supportingSources = [] でも valid", () => {
    const sources = computeSupportingSources("児童青年精神医学", sampleCandidates);
    expect(sources).toEqual([]);
  });

  it("Test I & Test AD: context-only segment への提案 -> TARGET_SEGMENT_MISMATCH で拒否", () => {
    const cand: ParsedSynthesisProposalCandidate = {
      segmentId: "ctx-seg",
      originalText: "文脈セグメント",
      correctedText: "文脈セグメント修正",
      evidence: [{ type: "context" }],
      explanation: "文脈修正",
    };
    const seg = createSegment("ctx-seg", "文脈セグメント");
    const allowed = new Set(["target-seg-1", "target-seg-2"]);

    const res = validateSynthesisCandidate(cand, seg, allowed);
    expect(res.valid).toBe(false);
    expect(res.errors).toContain("TARGET_SEGMENT_MISMATCH");
  });

  it("Test J: originalText スナップショット不一致（Stale 提案） -> TEXT_MISMATCH で拒否", () => {
    const cand: ParsedSynthesisProposalCandidate = {
      segmentId: "seg-1",
      originalText: "古いテキスト",
      correctedText: "新しいテキスト",
      evidence: [{ type: "dictionary" }],
      explanation: "修正",
    };
    const seg = createSegment("seg-1", "編集済みテキスト");
    const allowed = new Set(["seg-1"]);

    const res = validateSynthesisCandidate(cand, seg, allowed);
    expect(res.valid).toBe(false);
    expect(res.errors).toContain("TEXT_MISMATCH");
  });

  it("Test K & Test AC: Anchor '10 mg' / Candidate '20 mg' / LLM '20 mg' -> NUMERIC_CHANGE で reject", () => {
    const cand: ParsedSynthesisProposalCandidate = {
      segmentId: "seg-num",
      originalText: "投与量は 10 mg です",
      correctedText: "投与量は 20 mg です",
      evidence: [{ type: "context" }],
      explanation: "数値変更",
    };
    const seg = createSegment("seg-num", "投与量は 10 mg です");
    const allowed = new Set(["seg-num"]);

    const res = validateSynthesisCandidate(cand, seg, allowed);
    expect(res.valid).toBe(false);
    expect(res.errors).toContain("NUMERIC_CHANGE");
  });

  it("Test L: NO_CHANGE（変更なし提案）の拒否", () => {
    const cand: ParsedSynthesisProposalCandidate = {
      segmentId: "seg-1",
      originalText: "同じテキスト",
      correctedText: "同じテキスト",
      evidence: [{ type: "dictionary" }],
      explanation: "変更なし",
    };
    const seg = createSegment("seg-1", "同じテキスト");
    const allowed = new Set(["seg-1"]);

    const res = validateSynthesisCandidate(cand, seg, allowed);
    expect(res.valid).toBe(false);
    expect(res.errors).toContain("NO_CHANGE");
  });

  it("Test T & Test U: promoteCandidateToSynthesisProposal でアプリ側一意 UUID が付与されること", () => {
    const cand: ParsedSynthesisProposalCandidate = {
      segmentId: "seg-1",
      originalText: "元のテキスト",
      correctedText: "児童精神医学",
      evidence: [{ type: "dictionary", sourceId: "d1" }],
      explanation: "用語修正",
    };

    const targetItem: SynthesisTargetItem = {
      segmentId: "seg-1",
      text: "元のテキスト",
      start: 0,
      end: 5,
      engineId: "reazon",
      candidates: sampleCandidates,
    };

    const prop = promoteCandidateToSynthesisProposal(cand, "reazon", targetItem);
    expect(prop.id).toBeDefined();
    expect(typeof prop.id).toBe("string");
    expect(prop.kind).toBe("multi_asr_synthesis");
    expect(prop.anchorEngineId).toBe("reazon");
    expect(prop.supportingSources).toEqual([{ engineId: "kotoba", sourceSegmentId: "k-100" }]);
  });
});
