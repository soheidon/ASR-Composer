import { describe, it, expect } from "vitest";
import {
  deriveTextChanges,
  validateProposal,
  applyProposal,
  rejectProposal,
  createCorrectionRequest,
  MockCorrectionProvider,
  escapeAttr,
  parseCorrectionEvidence,
  parseCorrectionProposal,
  parseCorrectionProposals,
  type CorrectionProposal,
  type CorrectionEvidence,
} from "./correction";
import type { TranscriptDocument, TranscriptSegment } from "./transcript";

function createDummySegment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: "seg-001",
    start: 0.0,
    end: 5.0,
    speaker: "SPEAKER_00",
    originalSpeaker: "SPEAKER_00",
    text: "クロナゼパンを飲んでいます",
    originalText: "クロナゼパンを飲んでいます",
    sourceEngine: "test-engine",
    sourceSegmentId: "1",
    sourceRunId: "run-1",
    status: "raw",
    ...overrides,
  };
}

function createDummyDocument(segments: TranscriptSegment[] = [createDummySegment()]): TranscriptDocument {
  return {
    schemaVersion: 1,
    mediaPath: "/test/audio.mp3",
    mediaFileName: "audio.mp3",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    language: "ja",
    sourceEngine: "test-engine",
    sourceRunId: "run-1",
    segments,
  };
}

describe("deriveTextChanges (簡易diff)", () => {
  it("完全一致の場合は空配列を返す", () => {
    expect(deriveTextChanges("こんにちは", "こんにちは")).toEqual([]);
  });

  it("単一文字の置換で最小差分を抽出する", () => {
    expect(deriveTextChanges("クロナゼパンを飲んでいます", "クロナゼパムを飲んでいます")).toEqual([
      { from: "ン", to: "ム" },
    ]);
  });

  it("中間単語の置換で差分を抽出する", () => {
    expect(deriveTextChanges("明日は東京に行きます", "明日は大阪に行きます")).toEqual([
      { from: "東京", to: "大阪" },
    ]);
  });

  it("文字挿入（純粋追加）を抽出する", () => {
    expect(deriveTextChanges("今日は雨です", "今日は大雨です")).toEqual([
      { from: "", to: "大" },
    ]);
  });

  it("文字削除（純粋削除）を抽出する", () => {
    expect(deriveTextChanges("今日は大雨です", "今日は雨です")).toEqual([
      { from: "大", to: "" },
    ]);
  });

  it("複数箇所の変更でも1つのまとまりとして返す（簡易diff仕様の確認）", () => {
    // 複数箇所（Aさん→A氏、東京→大阪）の変更は中間の共通部分を含めて1つの差分として抽出される
    const changes = deriveTextChanges("Aさんは東京で会った", "A氏は大阪で会った");
    expect(changes).toEqual([
      { from: "さんは東京", to: "氏は大阪" },
    ]);
  });

  it("全文が異なる場合は全体が差分となる", () => {
    expect(deriveTextChanges("あいうえお", "かきくけこ")).toEqual([
      { from: "あいうえお", to: "かきくけこ" },
    ]);
  });
});

describe("validateProposal (Hard Errors & Warnings)", () => {
  const validEvidence: CorrectionEvidence[] = [
    { type: "dictionary", sourceId: "drug-001", description: "医薬品辞書" },
  ];

  it("正常なプロポーザルは valid=true, errors=[], warnings=[] となる", () => {
    const seg = createDummySegment();
    const prop: CorrectionProposal = {
      id: "prop-1",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "クロナゼパムを飲んでいます",
      evidence: validEvidence,
      explanation: "薬剤名の誤認識訂正",
      confidence: 0.95,
    };

    const res = validateProposal(prop, seg);
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
  });

  it("Hard Error: MISSING_SEGMENT (セグメント未指定/不存在)", () => {
    const prop: CorrectionProposal = {
      id: "prop-1",
      segmentId: "seg-unknown",
      originalText: "テキスト",
      correctedText: "修正テキスト",
      evidence: validEvidence,
      explanation: "説明",
    };
    const res = validateProposal(prop, undefined);
    expect(res.valid).toBe(false);
    expect(res.errors).toContain("MISSING_SEGMENT");
  });

  it("Hard Error: TEXT_MISMATCH (originalText とセグメント現在値が不一致)", () => {
    const seg = createDummySegment({ text: "手動編集されたテキスト" });
    const prop: CorrectionProposal = {
      id: "prop-1",
      segmentId: seg.id,
      originalText: "古いテキスト",
      correctedText: "修正テキスト",
      evidence: validEvidence,
      explanation: "説明",
    };
    const res = validateProposal(prop, seg);
    expect(res.valid).toBe(false);
    expect(res.errors).toContain("TEXT_MISMATCH");
  });

  it("Hard Error: EMPTY_TEXT (correctedTextが空文字または空白)", () => {
    const seg = createDummySegment();
    const prop: CorrectionProposal = {
      id: "prop-1",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "   ",
      evidence: validEvidence,
      explanation: "説明",
    };
    const res = validateProposal(prop, seg);
    expect(res.valid).toBe(false);
    expect(res.errors).toContain("EMPTY_TEXT");
  });

  it("Hard Error: NO_CHANGE (originalText === correctedText)", () => {
    const seg = createDummySegment();
    const prop: CorrectionProposal = {
      id: "prop-1",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: seg.text, // 変更なし
      evidence: validEvidence,
      explanation: "変更なし",
    };
    const res = validateProposal(prop, seg);
    expect(res.valid).toBe(false);
    expect(res.errors).toContain("NO_CHANGE");
  });

  it("Hard Error: MISSING_EVIDENCE (evidenceが空配列または未指定)", () => {
    const seg = createDummySegment();
    const prop: CorrectionProposal = {
      id: "prop-1",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "クロナゼパムを飲んでいます",
      evidence: [], // 空配列
      explanation: "説明",
    };
    const res = validateProposal(prop, seg);
    expect(res.valid).toBe(false);
    expect(res.errors).toContain("MISSING_EVIDENCE");
  });

  it("Hard Error: BAD_EVIDENCE_TYPE (無効なevidence type)", () => {
    const seg = createDummySegment();
    const prop: CorrectionProposal = {
      id: "prop-1",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "クロナゼパムを飲んでいます",
      evidence: [{ type: "unknown" as any, description: "不正" }],
      explanation: "説明",
    };
    const res = validateProposal(prop, seg);
    expect(res.valid).toBe(false);
    expect(res.errors).toContain("BAD_EVIDENCE_TYPE");
  });

  it("Hard Error: INVALID_CONFIDENCE (負数、>1.0、NaN)", () => {
    const seg = createDummySegment();
    const prop1: CorrectionProposal = {
      id: "prop-1",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "クロナゼパムを飲んでいます",
      evidence: validEvidence,
      explanation: "説明",
      confidence: 1.5,
    };
    expect(validateProposal(prop1, seg).errors).toContain("INVALID_CONFIDENCE");

    const prop2: CorrectionProposal = {
      ...prop1,
      confidence: -0.1,
    };
    expect(validateProposal(prop2, seg).errors).toContain("INVALID_CONFIDENCE");

    const prop3: CorrectionProposal = {
      ...prop1,
      confidence: NaN,
    };
    expect(validateProposal(prop3, seg).errors).toContain("INVALID_CONFIDENCE");
  });

  it("Warning: LARGE_CHANGE (大きな変更量でもvalid=trueを維持し警告を付与)", () => {
    const seg = createDummySegment({ text: "本日は晴天なり、明日は雨となる予定です。" });
    const prop: CorrectionProposal = {
      id: "prop-1",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "本日は大嵐であり、洪水警報が発令される見通しとなっております。", // 大幅変更
      evidence: validEvidence,
      explanation: "大幅改変",
      confidence: 0.8,
    };

    const res = validateProposal(prop, seg);
    expect(res.valid).toBe(true);
    expect(res.warnings).toContain("LARGE_CHANGE");
  });

  it("Warning: AMBIGUOUS_OCCURRENCE (置換対象が複数箇所に存在する場合に警告を付与)", () => {
    const seg = createDummySegment({ text: "猫が好きで、猫といつも暮らしています" });
    const prop: CorrectionProposal = {
      id: "prop-1",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "犬が好きで、猫といつも暮らしています", // 「猫」が2箇所ある
      evidence: validEvidence,
      explanation: "動物名訂正",
    };

    const res = validateProposal(prop, seg);
    expect(res.valid).toBe(true);
    expect(res.warnings).toContain("AMBIGUOUS_OCCURRENCE");
  });

  it("複数根拠 (dictionary + background + context) を同時に保持できる", () => {
    const seg = createDummySegment();
    const prop: CorrectionProposal = {
      id: "prop-multi",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "クロナゼパムを飲んでいます",
      evidence: [
        { type: "dictionary", sourceId: "d-1", description: "向精神薬辞書" },
        { type: "background", description: "処方箋メモ記載" },
        { type: "context", description: "文脈適合" },
      ],
      explanation: "3つの根拠に基づく高精度補正",
      confidence: 0.98,
    };

    const res = validateProposal(prop, seg);
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });
});

describe("applyProposal / rejectProposal (ライフサイクル & 不変性)", () => {
  it("採用成功: segment.textが更新され、originalTextは不変、status='edited'、全proposalがクリアされる", () => {
    const seg = createDummySegment();
    const doc = createDummyDocument([seg]);
    const activeProposals = new Map<string, CorrectionProposal[]>();

    const prop1: CorrectionProposal = {
      id: "prop-1",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "クロナゼパムを飲んでいます",
      evidence: [{ type: "dictionary", sourceId: "dict-1" }],
      explanation: "薬剤名補正",
      confidence: 0.95,
    };
    const prop2: CorrectionProposal = {
      id: "prop-2",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "クロナゼパムを服用しています",
      evidence: [{ type: "context" }],
      explanation: "別候補",
      confidence: 0.8,
    };

    activeProposals.set(seg.id, [prop1, prop2]);

    const res = applyProposal(prop1, doc, activeProposals);
    expect(res.ok).toBe(true);

    // text は更新される
    expect(seg.text).toBe("クロナゼパムを飲んでいます");
    // originalText は絶対に書き換わらない
    expect(seg.originalText).toBe("クロナゼパンを飲んでいます");
    // status は edited
    expect(seg.status).toBe("edited");
    // 当該セグメントの全 proposal がクリアされていること
    expect(activeProposals.has(seg.id)).toBe(false);
  });

  it("Stale防御: 提案生成後に手動編集された場合、STALEエラーとなり本文は上書きされない", () => {
    const seg = createDummySegment();
    const doc = createDummyDocument([seg]);
    const activeProposals = new Map<string, CorrectionProposal[]>();

    const prop: CorrectionProposal = {
      id: "prop-1",
      segmentId: seg.id,
      originalText: seg.text, // "クロナゼパンを飲んでいます"
      correctedText: "クロナゼパムを飲んでいます",
      evidence: [{ type: "dictionary" }],
      explanation: "薬剤名補正",
    };
    activeProposals.set(seg.id, [prop]);

    // ユーザーが手動編集
    seg.text = "ユーザーが手動で書き直した文章";

    const res = applyProposal(prop, doc, activeProposals);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("STALE");

    // 手動編集内容が保護されていること
    expect(seg.text).toBe("ユーザーが手動で書き直した文章");
    expect(seg.originalText).toBe("クロナゼパンを飲んでいます");
  });

  it("却下処理: 対象proposalのみが削除され、同セグメントの他proposalやドキュメントは完全不変", () => {
    const seg = createDummySegment();
    const activeProposals = new Map<string, CorrectionProposal[]>();

    const prop1: CorrectionProposal = {
      id: "prop-1",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "候補1",
      evidence: [{ type: "context" }],
      explanation: "説明1",
    };
    const prop2: CorrectionProposal = {
      id: "prop-2",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "候補2",
      evidence: [{ type: "context" }],
      explanation: "説明2",
    };
    activeProposals.set(seg.id, [prop1, prop2]);

    // prop1 を却下
    rejectProposal("prop-1", seg.id, activeProposals);

    expect(activeProposals.get(seg.id)).toEqual([prop2]);
    expect(seg.text).toBe("クロナゼパンを飲んでいます");
    expect(seg.status).toBe("raw");

    // 残りの prop2 を却下
    rejectProposal("prop-2", seg.id, activeProposals);
    expect(activeProposals.has(seg.id)).toBe(false);
  });
});

describe("createCorrectionRequest & MockCorrectionProvider (参照分離 & 決定論)", () => {
  it("createCorrectionRequest: ディープクローンによりProvider側での変更が元Docに波及しない", () => {
    const seg = createDummySegment();
    const originalDoc = createDummyDocument([seg]);

    const request = createCorrectionRequest(originalDoc);

    // 参照が別であること
    expect(request.document).not.toBe(originalDoc);
    expect(request.document.segments[0]).not.toBe(originalDoc.segments[0]);

    // request 側を変更しても元ドキュメントに影響しない
    request.document.segments[0].text = "破壊的変更";
    expect(originalDoc.segments[0].text).toBe("クロナゼパンを飲んでいます");
  });

  it("MockCorrectionProvider: 定義したfixtureを決定論的に返却する", async () => {
    const seg = createDummySegment();
    const doc = createDummyDocument([seg]);
    const request = createCorrectionRequest(doc);

    const fixture: CorrectionProposal = {
      id: "prop-fixture-1",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "クロナゼパムを飲んでいます",
      evidence: [{ type: "dictionary", sourceId: "dict-1" }],
      explanation: "モックテスト候補",
    };

    const provider = new MockCorrectionProvider([fixture]);
    const results = await provider.correct(request);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("prop-fixture-1");
  });
});

describe("escapeAttr (HTML属性値エスケープ)", () => {
  it("属性突破用の危険文字（&, <, >, \", '）を正しくエスケープする", () => {
    expect(escapeAttr('abc" onmouseover="alert(1)')).toBe("abc&quot; onmouseover=&quot;alert(1)");
    expect(escapeAttr("'><img src=x onerror=alert(1)>")).toBe("&#39;&gt;&lt;img src=x onerror=alert(1)&gt;");
    expect(escapeAttr("normal-id_123")).toBe("normal-id_123");
    expect(escapeAttr("Tom & Jerry's \"Favorite\" <Show>")).toBe("Tom &amp; Jerry&#39;s &quot;Favorite&quot; &lt;Show&gt;");
  });
});

describe("Runtime Shape Validation (parseCorrectionProposal / parseCorrectionProposals)", () => {
  it("parseCorrectionEvidence: 正常なオブジェクトをパースし、不正なオブジェクトはnullを返す", () => {
    expect(parseCorrectionEvidence({ type: "dictionary", sourceId: "d-1", description: "説明" })).toEqual({
      type: "dictionary",
      sourceId: "d-1",
      description: "説明",
    });
    expect(parseCorrectionEvidence(null)).toBeNull();
    expect(parseCorrectionEvidence({ type: 123 })).toBeNull();
    expect(parseCorrectionEvidence({ type: "context", sourceId: 123 })).toBeNull();
    expect(parseCorrectionEvidence({ type: "context", description: 123 })).toBeNull();
  });

  const validProposalObj = {
    id: "prop-1",
    segmentId: "seg-1",
    originalText: "原文",
    correctedText: "補正文",
    evidence: [{ type: "dictionary", sourceId: "d-1", description: "辞書" }],
    explanation: "説明文",
    confidence: 0.95,
  };

  it("正常なオブジェクトは CorrectionProposal として正しくパースされる", () => {
    const res = parseCorrectionProposal(validProposalObj);
    expect(res).not.toBeNull();
    expect(res?.id).toBe("prop-1");
    expect(res?.confidence).toBe(0.95);
  });

  it("非オブジェクトまたはnullはnullを返す", () => {
    expect(parseCorrectionProposal(null)).toBeNull();
    expect(parseCorrectionProposal("文字列")).toBeNull();
    expect(parseCorrectionProposal(123)).toBeNull();
  });

  it("必須文字列フィールドの欠落または型不正はnullを返す (e.g. correctedText: number)", () => {
    expect(parseCorrectionProposal({ ...validProposalObj, correctedText: 123 })).toBeNull();
    expect(parseCorrectionProposal({ ...validProposalObj, id: undefined })).toBeNull();
    expect(parseCorrectionProposal({ ...validProposalObj, segmentId: true })).toBeNull();
    expect(parseCorrectionProposal({ ...validProposalObj, explanation: null })).toBeNull();
  });

  it("evidence が配列でない場合は null を返す (e.g. evidence: string)", () => {
    expect(parseCorrectionProposal({ ...validProposalObj, evidence: "dictionary" })).toBeNull();
    expect(parseCorrectionProposal({ ...validProposalObj, evidence: null })).toBeNull();
  });

  it("evidence の要素が不正（type欠落、sourceId型不正など）な場合は null を返す", () => {
    expect(parseCorrectionProposal({ ...validProposalObj, evidence: [{ description: "typeなし" }] })).toBeNull();
    expect(parseCorrectionProposal({ ...validProposalObj, evidence: [{ type: "dictionary", sourceId: 123 }] })).toBeNull();
  });

  it("confidence が数値でない（文字列 '0.9' や NaN）場合は null を返す", () => {
    expect(parseCorrectionProposal({ ...validProposalObj, confidence: "0.9" })).toBeNull();
    expect(parseCorrectionProposal({ ...validProposalObj, confidence: NaN })).toBeNull();
    expect(parseCorrectionProposal({ ...validProposalObj, confidence: Infinity })).toBeNull();
  });

  it("confidence が省略されている場合は undefined として許容する", () => {
    const withoutConfidence = { ...validProposalObj };
    delete (withoutConfidence as any).confidence;
    const res = parseCorrectionProposal(withoutConfidence);
    expect(res).not.toBeNull();
    expect(res?.confidence).toBeUndefined();
  });

  it("parseCorrectionProposals: トップレベルが配列でない場合は例外をスローする", () => {
    expect(() => parseCorrectionProposals("not array")).toThrow("配列形式");
    expect(() => parseCorrectionProposals({ proposals: [] })).toThrow("配列形式");
  });

  it("parseCorrectionProposals: 有効な提案と不正な提案が混在する場合、有効なものだけを残し不正なものを破棄する", () => {
    const rawList = [
      validProposalObj,
      { ...validProposalObj, id: "prop-invalid-1", correctedText: 123 }, // 不正
      { ...validProposalObj, id: "prop-2", correctedText: "正常2" },       // 正常
      "壊れたデータ",                                                    // 不正
      { ...validProposalObj, id: "prop-invalid-2", evidence: "invalid" }, // 不正
    ];

    const res = parseCorrectionProposals(rawList);
    expect(res.proposals).toHaveLength(2);
    expect(res.proposals[0].id).toBe("prop-1");
    expect(res.proposals[1].id).toBe("prop-2");
    expect(res.discardedCount).toBe(3);
  });
});

