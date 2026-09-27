import { describe, it, expect } from "vitest";
import {
  deriveTextChanges,
  renderSideBySideDiff,
  computeCharacterDiff,
  splitGraphemes,
  MAX_LCS_CELLS,
  MAX_LCS_GRAPHEMES,
  extractNumericTokens,
  DEFAULT_CORRECTION_MODE,
  validateProposal,
  applyProposal,
  rejectProposal,
  createCorrectionRequest,
  MockCorrectionProvider,
  escapeAttr,
  parseCorrectionEvidence,
  parseCorrectionProposal,
  parseCorrectionProposals,
  parseRawProposalCandidates,
  promoteCandidateToProposal,
  runCorrectionForDocument,
  createCorrectionProgress,
  formatCorrectionProgress,
  type CorrectionProposal,
  type CorrectionEvidence,
  type CorrectionProgress,
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

describe("renderSideBySideDiff & computeCharacterDiff (Unicode・複数箇所分離diff)", () => {
  it("Case A: 単一置換: 変更箇所のみがマークアップされ、前後は通常テキスト", () => {
    const res = renderSideBySideDiff("児童せいしん科", "児童精神科");
    expect(res.originalHtml).toBe('児童<del class="diff-del">せいしん</del>科');
    expect(res.correctedHtml).toBe('児童<ins class="diff-ins">精神</ins>科');
  });

  it("Case B: 複数離れた箇所の置換: 各変更箇所が独立して分離され、中間の共通文字列は未変更として維持される", () => {
    const before = "このけんきゅうでは児童せいしん科について去年調べました";
    const after = "この研究では児童精神科について昨年調べました";
    const res = renderSideBySideDiff(before, after);

    expect(res.originalHtml).toBe(
      'この<del class="diff-del">けんきゅう</del>では児童<del class="diff-del">せいしん</del>科について<del class="diff-del">去</del>年調べました'
    );
    expect(res.correctedHtml).toBe(
      'この<ins class="diff-ins">研究</ins>では児童<ins class="diff-ins">精神</ins>科について<ins class="diff-ins">昨</ins>年調べました'
    );
  });

  it("Case C: 挿入・削除・置換の混在: 正確に各操作を分離してハイライトする", () => {
    const before = "今日は雨でした";
    const after = "明日は大雨でしょう";
    const res = renderSideBySideDiff(before, after);

    expect(res.originalHtml).toBe('<del class="diff-del">今</del>日は雨でし<del class="diff-del">た</del>');
    expect(res.correctedHtml).toBe('<ins class="diff-ins">明</ins>日は<ins class="diff-ins">大</ins>雨でし<ins class="diff-ins">ょう</ins>');
  });

  it("Case D: 完全一致: ハイライトタグなしでエスケープされたテキストを返す", () => {
    const res = renderSideBySideDiff("こんにちは世界", "こんにちは世界");
    expect(res.originalHtml).toBe("こんにちは世界");
    expect(res.correctedHtml).toBe("こんにちは世界");
    expect(res.diffOps).toEqual([{ type: "equal", text: "こんにちは世界" }]);
  });

  it("Case E: 全文置換: 全体が delete と insert になる", () => {
    const res = renderSideBySideDiff("あいうえお", "かきくけこ");
    expect(res.originalHtml).toBe('<del class="diff-del">あいうえお</del>');
    expect(res.correctedHtml).toBe('<ins class="diff-ins">かきくけこ</ins>');
  });

  it("Case F: 絵文字・サロゲートペア (Unicode Code Points): サロゲートペアを破壊せずに正しくdiffする", () => {
    const before = "🙂テスト👨‍👩‍👧‍👦会議";
    const after = "🙂試験👨‍👩‍👧‍👦総会";
    const res = renderSideBySideDiff(before, after);

    expect(res.originalHtml).toBe('🙂<del class="diff-del">テスト</del>👨‍👩‍👧‍👦会<del class="diff-del">議</del>');
    expect(res.correctedHtml).toBe('🙂<ins class="diff-ins">試験</ins>👨‍👩‍👧‍👦<ins class="diff-ins">総</ins>会');
  });

  it("Case G: HTML特殊文字（<, >, &, \", '）が左右両方で厳格にエスケープされる", () => {
    const res = renderSideBySideDiff("<危険&タグ>", "<安全&タグ>");
    expect(res.originalHtml).toContain("&lt;");
    expect(res.originalHtml).toContain("&amp;");
    expect(res.originalHtml).toContain("&gt;");
    expect(res.originalHtml).toContain('<del class="diff-del">危険</del>');
    expect(res.correctedHtml).toContain('<ins class="diff-ins">安全</ins>');
  });

  it("Case H: 日本語句読点の変更: 句読点のみが差分として検出される", () => {
    const before = "はい、わかりました。";
    const after = "はい。了解しました！";
    const res = renderSideBySideDiff(before, after);

    expect(res.originalHtml).toBe('はい<del class="diff-del">、わかり</del>ました<del class="diff-del">。</del>');
    expect(res.correctedHtml).toBe('はい<ins class="diff-ins">。了解し</ins>ました<ins class="diff-ins">！</ins>');
  });
});

describe("splitGraphemes & Bounded LCS (Unicode・上限防御・フォールバック)", () => {
  it("定数値: MAX_LCS_CELLS と MAX_LCS_GRAPHEMES がエクスポートされている", () => {
    expect(MAX_LCS_CELLS).toBe(200_000);
    expect(MAX_LCS_GRAPHEMES).toBe(2_000);
  });

  it("splitGraphemes: Intl.Segmenter 有効時に ZWJ 結合絵文字（👨‍👩‍👧‍👦）を1書記素クラスタとして保持する", () => {
    const graphemes = splitGraphemes("👨‍👩‍👧‍👦", true);
    expect(graphemes).toHaveLength(1);
    expect(graphemes[0]).toBe("👨‍👩‍👧‍👦");
  });

  it("splitGraphemes: Intl.Segmenter 無効化時（フォールバック）でもサロゲートペア（🙂）を破壊しない", () => {
    const chars = splitGraphemes("🙂テスト", false);
    expect(chars).toEqual(["🙂", "テ", "ス", "ト"]);
  });

  it("Case A: 閾値未満の通常入力: mode: 'precise' で精密な部分差分を返す", () => {
    const res = computeCharacterDiff("ABCDEF", "ABXEYF", { maxCells: 100, maxGraphemes: 50 });
    expect(res.mode).toBe("precise");
    expect(res.ops).toEqual([
      { type: "equal", text: "AB" },
      { type: "delete", text: "CD" },
      { type: "insert", text: "X" },
      { type: "equal", text: "E" },
      { type: "insert", text: "Y" },
      { type: "equal", text: "F" },
    ]);
  });

  it("Case B: maxCells 超過時: mode: 'coarse' となり、共通prefix/suffixを保持しつつ中央部を1ブロック置換として安全に返す", () => {
    // 中央部: 15文字 x 15文字 = 225 cells > maxCells: 100
    const before = "START_123456789012345_END";
    const after = "START_abcdefghijklmno_END";
    const res = computeCharacterDiff(before, after, { maxCells: 100 });

    expect(res.mode).toBe("coarse");
    expect(res.ops).toEqual([
      { type: "equal", text: "START_" },
      { type: "delete", text: "123456789012345" },
      { type: "insert", text: "abcdefghijklmno" },
      { type: "equal", text: "_END" },
    ]);
  });

  it("Case C: 片側文字数が maxGraphemes を超過した場合: mode: 'coarse' となる", () => {
    const before = "START_" + "A".repeat(60) + "_END";
    const after = "START_" + "B".repeat(10) + "_END";
    const res = computeCharacterDiff(before, after, { maxGraphemes: 50 });

    expect(res.mode).toBe("coarse");
    expect(res.ops).toEqual([
      { type: "equal", text: "START_" },
      { type: "delete", text: "A".repeat(60) },
      { type: "insert", text: "B".repeat(10) },
      { type: "equal", text: "_END" },
    ]);
  });

  it("Case D: 長大テキスト（5,000文字）の全文置換: フリーズせず瞬時に完了し mode: 'coarse' を返す", () => {
    const before = "X".repeat(5000);
    const after = "Y".repeat(5000);
    const start = performance.now();
    const res = computeCharacterDiff(before, after);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(50); // 50ms未満で即座に完了
    expect(res.mode).toBe("coarse");
    expect(res.ops).toEqual([
      { type: "delete", text: "X".repeat(5000) },
      { type: "insert", text: "Y".repeat(5000) },
    ]);
  });

  it("Case E: 大規模no-diarization文章（10,000文字）: renderSideBySideDiff がフリーズせず安全に動作する", () => {
    const before = "冒頭共通部分。" + "あ".repeat(10000) + "末尾共通部分。";
    const after = "冒頭共通部分。" + "い".repeat(10000) + "末尾共通部分。";

    const start = performance.now();
    const res = renderSideBySideDiff(before, after);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(100);
    expect(res.mode).toBe("coarse");
    expect(res.originalHtml).toBe(`冒頭共通部分。<del class="diff-del">${"あ".repeat(10000)}</del>末尾共通部分。`);
    expect(res.correctedHtml).toBe(`冒頭共通部分。<ins class="diff-ins">${"い".repeat(10000)}</ins>末尾共通部分。`);
  });

  it("Case F: フォールバック時 (coarse mode) でも HTML 特殊文字が厳格にエスケープされる", () => {
    const before = "PREFIX_" + "<script>alert('xss')</script>".repeat(5) + "_SUFFIX";
    const after = "PREFIX_" + "<b>安全</b>".repeat(5) + "_SUFFIX";
    const res = renderSideBySideDiff(before, after, { maxCells: 50 });

    expect(res.mode).toBe("coarse");
    expect(res.originalHtml).not.toContain("<script>");
    expect(res.originalHtml).toContain("&lt;script&gt;");
    expect(res.correctedHtml).not.toContain("<b>");
    expect(res.correctedHtml).toContain("&lt;b&gt;");
  });

  it("Case G: フォールバック時でも左右のプレーンテキスト復元性が完全に保たれる", () => {
    const before = "HEADER_" + "変更前".repeat(20) + "_FOOTER";
    const after = "HEADER_" + "変更後".repeat(20) + "_FOOTER";
    const res = renderSideBySideDiff(before, after, { maxCells: 50 });

    expect(res.mode).toBe("coarse");
    // HTMLタグ（<del>, <ins>）を除去したテキストが元テキスト・補正テキストと完全一致
    const stripHtml = (html: string) => html.replace(/<[^>]+>/g, "");
    expect(stripHtml(res.originalHtml)).toBe(before);
    expect(stripHtml(res.correctedHtml)).toBe(after);
  });
});

describe("extractNumericTokens & NUMERIC_CHANGE (数値保護ガード)", () => {
  it("extractNumericTokens: アラビア数字、小数、符号付き数値、全角数字、カンマ区切り数値を抽出・正規化する", () => {
    expect(extractNumericTokens("3人")).toEqual(["3"]);
    expect(extractNumericTokens("10 mg")).toEqual(["10"]);
    expect(extractNumericTokens("0.5 mg")).toEqual(["0.5"]);
    expect(extractNumericTokens("2025年4月1日")).toEqual(["2025", "4", "1"]);
    expect(extractNumericTokens("-15.2度")).toEqual(["-15.2"]);
    expect(extractNumericTokens("３人")).toEqual(["3"]); // 全角数字
    expect(extractNumericTokens("1,000円")).toEqual(["1000"]); // 正しい桁区切りカンマ
    expect(extractNumericTokens("12,345,678")).toEqual(["12345678"]); // 複数桁区切り
    expect(extractNumericTokens("1,000.50")).toEqual(["1000.50"]); // 桁区切り + 小数
    expect(extractNumericTokens("１，０００円")).toEqual(["1000"]); // 全角カンマ・全角数字
    expect(extractNumericTokens("1,2")).toEqual(["1", "2"]); // 不正な桁区切りは結合せず分離
    expect(extractNumericTokens("12,34")).toEqual(["12", "34"]); // 不正な桁区切りは結合せず分離
    expect(extractNumericTokens("−5 mg")).toEqual(["-5"]); // Unicode minus (\u2212)
    expect(extractNumericTokens("－5 mg")).toEqual(["-5"]); // 全角マイナス (\uFF0D)
    expect(extractNumericTokens("–5 mg")).toEqual(["-5"]); // En dash (\u2013)
    expect(extractNumericTokens("—5 mg")).toEqual(["-5"]); // Em dash (\u2014)
    expect(extractNumericTokens("+5 mg")).toEqual(["+5"]); // ASCII plus
    expect(extractNumericTokens("＋5 mg")).toEqual(["+5"]); // 全角プラス (\uFF0B)
    expect(extractNumericTokens("9007199254740993")).toEqual(["9007199254740993"]); // 巨大整数
    expect(extractNumericTokens("テキストのみで数字なし")).toEqual([]);
  });

  // A. "1,2" → "12" => NUMERIC_CHANGE
  it("Case A: '1,2' → '12' は不正な桁区切り結合として NUMERIC_CHANGE で拒否", () => {
    const seg = createDummySegment({ text: "選択肢1,2です" });
    const prop: CorrectionProposal = {
      id: "prop-a",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "選択肢12です",
      evidence: [{ type: "context" }],
      explanation: "結合改変",
    };
    const res = validateProposal(prop, seg);
    expect(res.valid).toBe(false);
    expect(res.errors).toContain("NUMERIC_CHANGE");
  });

  // B. "12" → "1,2" => NUMERIC_CHANGE
  it("Case B: '12' → '1,2' は数値分割として NUMERIC_CHANGE で拒否", () => {
    const seg = createDummySegment({ text: "番号12です" });
    const prop: CorrectionProposal = {
      id: "prop-b",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "番号1,2です",
      evidence: [{ type: "context" }],
      explanation: "分割改変",
    };
    const res = validateProposal(prop, seg);
    expect(res.valid).toBe(false);
    expect(res.errors).toContain("NUMERIC_CHANGE");
  });

  // C. "1,000" → "1000" => OK
  it("Case C: '1,000' → '1000' は正しい桁区切り除去として許可 (OK)", () => {
    const seg = createDummySegment({ text: "費用は1,000円です" });
    const prop: CorrectionProposal = {
      id: "prop-c",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "費用は1000円です",
      evidence: [{ type: "context" }],
      explanation: "表記統一",
    };
    const res = validateProposal(prop, seg);
    expect(res.errors).not.toContain("NUMERIC_CHANGE");
  });

  // D. "12,345,678" → "12345678" => OK
  it("Case D: '12,345,678' → '12345678' は複数桁区切り除去として許可 (OK)", () => {
    const seg = createDummySegment({ text: "総数は12,345,678個です" });
    const prop: CorrectionProposal = {
      id: "prop-d",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "総数は12345678個です",
      evidence: [{ type: "context" }],
      explanation: "表記統一",
    };
    const res = validateProposal(prop, seg);
    expect(res.errors).not.toContain("NUMERIC_CHANGE");
  });

  // E. "12,34" → "1234" => NUMERIC_CHANGE
  it("Case E: '12,34' → '1234' は不正な桁区切り結合として NUMERIC_CHANGE で拒否", () => {
    const seg = createDummySegment({ text: "データ12,34です" });
    const prop: CorrectionProposal = {
      id: "prop-e",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "データ1234です",
      evidence: [{ type: "context" }],
      explanation: "結合改変",
    };
    const res = validateProposal(prop, seg);
    expect(res.valid).toBe(false);
    expect(res.errors).toContain("NUMERIC_CHANGE");
  });

  // F. "9007199254740993" → "9007199254740992" => NUMERIC_CHANGE (JS Number 精度限界超えの保護)
  it("Case F: '9007199254740993' → '9007199254740992' は parseFloat を経由せず文字列比較により NUMERIC_CHANGE で拒否", () => {
    const seg = createDummySegment({ text: "ID: 9007199254740993 です" });
    const prop: CorrectionProposal = {
      id: "prop-f",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "ID: 9007199254740992 です",
      evidence: [{ type: "context" }],
      explanation: "末尾桁改変",
    };
    const res = validateProposal(prop, seg);
    expect(res.valid).toBe(false);
    expect(res.errors).toContain("NUMERIC_CHANGE");
  });

  // G. 非常に長い整数同士 => Number変換せず正しく比較
  it("Case G: 任意精度の超長大整数同士（30桁）を精度落ちなく比較し NUMERIC_CHANGE で拒否", () => {
    const seg = createDummySegment({ text: "ハッシュ値: 123456789012345678901234567890 です" });
    const prop: CorrectionProposal = {
      id: "prop-g",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "ハッシュ値: 123456789012345678901234567891 です",
      evidence: [{ type: "context" }],
      explanation: "超長大整数改変",
    };
    const res = validateProposal(prop, seg);
    expect(res.valid).toBe(false);
    expect(res.errors).toContain("NUMERIC_CHANGE");
  });

  // H. "−5 mg" → "-5 mg" => OK (Unicode minus)
  it("Case H: '−5 mg' → '-5 mg' は Unicode minus 正規化により許可 (OK)", () => {
    const seg = createDummySegment({ text: "温度は−5 mg/Lです" });
    const prop: CorrectionProposal = {
      id: "prop-h",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "温度は-5 mg/Lです",
      evidence: [{ type: "context" }],
      explanation: "符号半角統一",
    };
    const res = validateProposal(prop, seg);
    expect(res.errors).not.toContain("NUMERIC_CHANGE");
  });

  // I. "－5 mg" → "-5 mg" => OK (全角マイナス)
  it("Case I: '－5 mg' → '-5 mg' は全角マイナス正規化により許可 (OK)", () => {
    const seg = createDummySegment({ text: "温度は－5 mg/Lです" });
    const prop: CorrectionProposal = {
      id: "prop-i",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "温度は-5 mg/Lです",
      evidence: [{ type: "context" }],
      explanation: "符号半角統一",
    };
    const res = validateProposal(prop, seg);
    expect(res.errors).not.toContain("NUMERIC_CHANGE");
  });

  // J. "−5 mg" → "5 mg" => NUMERIC_CHANGE (符号脱落の検出)
  it("Case J: '−5 mg' → '5 mg' は負号脱落として NUMERIC_CHANGE で拒否", () => {
    const seg = createDummySegment({ text: "温度は−5 mg/Lです" });
    const prop: CorrectionProposal = {
      id: "prop-j",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "温度は5 mg/Lです",
      evidence: [{ type: "context" }],
      explanation: "負号脱落",
    };
    const res = validateProposal(prop, seg);
    expect(res.valid).toBe(false);
    expect(res.errors).toContain("NUMERIC_CHANGE");
  });

  // K. "-0.5 mg" → "0.5 mg" => NUMERIC_CHANGE (小数の符号脱落検出)
  it("Case K: '-0.5 mg' → '0.5 mg' は小数の負号脱落として NUMERIC_CHANGE で拒否", () => {
    const seg = createDummySegment({ text: "変化量は-0.5 mgです" });
    const prop: CorrectionProposal = {
      id: "prop-k",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "変化量は0.5 mgです",
      evidence: [{ type: "context" }],
      explanation: "負号脱落",
    };
    const res = validateProposal(prop, seg);
    expect(res.valid).toBe(false);
    expect(res.errors).toContain("NUMERIC_CHANGE");
  });

  // L. "30%" → "20%" => NUMERIC_CHANGE (割合改変)
  it("Case L: '30%' → '20%' は割合改変として NUMERIC_CHANGE で拒否", () => {
    const seg = createDummySegment({ text: "達成率は30%でした" });
    const prop: CorrectionProposal = {
      id: "prop-l",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "達成率は20%でした",
      evidence: [{ type: "context" }],
      explanation: "割合改変",
    };
    const res = validateProposal(prop, seg);
    expect(res.valid).toBe(false);
    expect(res.errors).toContain("NUMERIC_CHANGE");
  });

  // M. "10 mg" → "10mg" => OK (空白調整)
  it("Case M: '10 mg' → '10mg' は空白調整として許可 (OK)", () => {
    const seg = createDummySegment({ text: "10 mgを服用" });
    const prop: CorrectionProposal = {
      id: "prop-m",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "10mgを服用",
      evidence: [{ type: "context" }],
      explanation: "空白除去",
    };
    const res = validateProposal(prop, seg);
    expect(res.errors).not.toContain("NUMERIC_CHANGE");
  });

  // N. "３人" → "3人" => OK (全角数字半角化)
  it("Case N: '３人' → '3人' は全角数字の半角化として許可 (OK)", () => {
    const seg = createDummySegment({ text: "３名が参加" });
    const prop: CorrectionProposal = {
      id: "prop-n",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "3名が参加",
      evidence: [{ type: "context" }],
      explanation: "半角化",
    };
    const res = validateProposal(prop, seg);
    expect(res.errors).not.toContain("NUMERIC_CHANGE");
  });

  // O. "１，０００円" → "1000円" => OK (全角カンマ+全角数字桁区切り)
  it("Case O: '１，０００円' → '1000円' は全角桁区切りの正規化として許可 (OK)", () => {
    const seg = createDummySegment({ text: "価格は１，０００円です" });
    const prop: CorrectionProposal = {
      id: "prop-o",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "価格は1000円です",
      evidence: [{ type: "context" }],
      explanation: "全角桁区切り正規化",
    };
    const res = validateProposal(prop, seg);
    expect(res.errors).not.toContain("NUMERIC_CHANGE");
  });

  it("Hard Error: NUMERIC_CHANGE (数値トークンの削除または追加を検出し拒否)", () => {
    const seg1 = createDummySegment({ text: "1回3錠を服用" });
    const propDrop: CorrectionProposal = {
      id: "prop-drop",
      segmentId: seg1.id,
      originalText: seg1.text,
      correctedText: "3錠を服用", // "1" が脱落
      evidence: [{ type: "context" }],
      explanation: "脱落",
    };
    expect(validateProposal(propDrop, seg1).errors).toContain("NUMERIC_CHANGE");

    const seg2 = createDummySegment({ text: "3錠を服用" });
    const propAdd: CorrectionProposal = {
      id: "prop-add",
      segmentId: seg2.id,
      originalText: seg2.text,
      correctedText: "1回3錠を服用", // "1" を勝手に追加
      evidence: [{ type: "context" }],
      explanation: "追加",
    };
    expect(validateProposal(propAdd, seg2).errors).toContain("NUMERIC_CHANGE");
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

describe("Phase 2: parseRawProposalCandidates & promoteCandidateToProposal", () => {
  const validCandidateObj = {
    segmentId: "seg-001",
    originalText: "クロナゼパンを飲んでいます",
    correctedText: "クロナゼパムを飲んでいます",
    evidence: [{ type: "dictionary" as const, description: "医薬品辞書" }],
    explanation: "薬品名の訂正",
    confidence: 0.95,
  };

  it("IDなしの未検証オブジェクトを正常にパースできる", () => {
    const raw = {
      proposals: [
        validCandidateObj,
        { ...validCandidateObj, segmentId: "seg-002", originalText: "テキスト2", correctedText: "修正2" },
      ],
    };
    const { candidates, discardedCount } = parseRawProposalCandidates(raw);
    expect(candidates).toHaveLength(2);
    expect(candidates[0].segmentId).toBe("seg-001");
    expect(discardedCount).toBe(0);
  });

  it("配列形式の直接入力も許容する", () => {
    const { candidates } = parseRawProposalCandidates([validCandidateObj]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].correctedText).toBe("クロナゼパムを飲んでいます");
  });

  it("不正なオブジェクト（proposalsフィールドも配列もない）は例外をスローする", () => {
    expect(() => parseRawProposalCandidates("invalid")).toThrow("プロポーザルデータが配列または");
    expect(() => parseRawProposalCandidates({ other: 123 })).toThrow("プロポーザルデータが配列または");
  });

  it("promoteCandidateToProposal で一意な ID を付与して昇格できる", () => {
    const customIdGen = () => "custom-uuid-12345";
    const prop = promoteCandidateToProposal(validCandidateObj, customIdGen);
    expect(prop.id).toBe("custom-uuid-12345");
    expect(prop.segmentId).toBe("seg-001");
    expect(prop.correctedText).toBe("クロナゼパムを飲んでいます");
  });

  it("validateProposalCandidate: allowedTargetSegmentIds に含まれないセグメントは TARGET_SEGMENT_MISMATCH でエラー", () => {
    const seg = createDummySegment({ id: "seg-context-only" });
    const candidate = {
      ...validCandidateObj,
      segmentId: "seg-context-only",
      originalText: seg.text,
    };
    const allowed = new Set(["seg-001", "seg-002"]);
    const val = validateProposal(candidate as any, seg, allowed);
    expect(val.valid).toBe(false);
    expect(val.errors).toContain("TARGET_SEGMENT_MISMATCH");
  });
});

describe("runCorrectionForDocument (Shared Execution Core)", () => {
  it("正常系: 有効な提案がセグメントIDごとにグルーピングされ返却される", async () => {
    const seg1 = createDummySegment({ id: "seg-1", text: "テスト文章1" });
    const seg2 = createDummySegment({ id: "seg-2", text: "テスト文章2" });
    const doc = createDummyDocument([seg1, seg2]);

    const proposals: CorrectionProposal[] = [
      {
        id: "prop-1",
        segmentId: "seg-1",
        originalText: "テスト文章1",
        correctedText: "テスト文章1（補正済）",
        evidence: [{ type: "context", description: "文脈" }],
        explanation: "テスト補正",
        confidence: 0.9,
      },
      {
        id: "prop-2",
        segmentId: "seg-2",
        originalText: "テスト文章2",
        correctedText: "テスト文章2（補正済）",
        evidence: [{ type: "dictionary", description: "辞書一致" }],
        explanation: "辞書補正",
        confidence: 0.95,
      },
    ];

    const provider = new MockCorrectionProvider(proposals);
    const result = await runCorrectionForDocument({
      document: doc,
      provider,
    });

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.proposals.size).toBe(2);
      expect(result.proposals.get("seg-1")![0].id).toBe("prop-1");
      expect(result.proposals.get("seg-2")![0].id).toBe("prop-2");
    }
  });

  it("isCancelled が true の場合は status: 'cancelled' を返す", async () => {
    const seg1 = createDummySegment({ id: "seg-1", text: "テスト" });
    const doc = createDummyDocument([seg1]);

    const provider = new MockCorrectionProvider([
      {
        id: "prop-1",
        segmentId: "seg-1",
        originalText: "テスト",
        correctedText: "テスト（補正）",
        evidence: [{ type: "context" }],
        explanation: "テスト",
      },
    ]);

    const result = await runCorrectionForDocument({
      document: doc,
      provider,
      isCancelled: () => true,
    });

    expect(result.status).toBe("cancelled");
  });

  it("不整合な提案（存在しないセグメントID・原文不一致）は除外され、有効な提案0件でも status: 'success' となる", async () => {
    const seg1 = createDummySegment({ id: "seg-1", text: "現在の文章" });
    const doc = createDummyDocument([seg1]);

    const provider = new MockCorrectionProvider([
      {
        id: "prop-stale",
        segmentId: "seg-1",
        originalText: "過去の不一致文章",
        correctedText: "補正後",
        evidence: [{ type: "context" }],
        explanation: "不一致",
      },
    ]);

    const result = await runCorrectionForDocument({
      document: doc,
      provider,
    });

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.proposals.size).toBe(0);
    }
  });

  it("onSuccess コールバックが指定された場合、完了時に検証済み提案を受け取れる", async () => {
    const seg1 = createDummySegment({ id: "seg-1", text: "テスト" });
    const doc = createDummyDocument([seg1]);

    const provider = new MockCorrectionProvider([
      {
        id: "prop-1",
        segmentId: "seg-1",
        originalText: "テスト",
        correctedText: "テスト（補正）",
        evidence: [{ type: "context" }],
        explanation: "テスト",
      },
    ]);

    let capturedProposals: Map<string, CorrectionProposal[]> | null = null;
    const result = await runCorrectionForDocument(
      {
        document: doc,
        provider,
      },
      (proposals) => {
        capturedProposals = proposals;
      },
    );

    expect(result.status).toBe("success");
    expect(capturedProposals).not.toBeNull();
    expect(capturedProposals!.size).toBe(1);
  });

  it("NUMERIC_CHANGE が発生した提案のみが破棄され、同バッチ内の他の有効な提案は正常にステージングされる（ジョブ全体は失敗しない）", async () => {
    const seg1 = createDummySegment({ id: "seg-1", text: "3人が参加しました" });
    const seg2 = createDummySegment({ id: "seg-2", text: "クロナゼパンを服用" });
    const doc = createDummyDocument([seg1, seg2]);

    const provider = new MockCorrectionProvider([
      {
        id: "prop-numeric-fail",
        segmentId: "seg-1",
        originalText: "3人が参加しました",
        correctedText: "5人が参加しました", // NUMERIC_CHANGE -> reject
        evidence: [{ type: "context" }],
        explanation: "人数改変",
      },
      {
        id: "prop-valid",
        segmentId: "seg-2",
        originalText: "クロナゼパンを服用",
        correctedText: "クロナゼパムを服用", // valid
        evidence: [{ type: "dictionary", sourceId: "dict-1" }],
        explanation: "薬剤名訂正",
      },
    ]);

    const result = await runCorrectionForDocument({
      document: doc,
      provider,
      mode: "standard",
    });

    expect(result.status).toBe("success");
    if (result.status === "success") {
      // seg-1 は NUMERIC_CHANGE で除外される
      expect(result.proposals.has("seg-1")).toBe(false);
      // seg-2 は正常に保持される
      expect(result.proposals.has("seg-2")).toBe(true);
      expect(result.proposals.get("seg-2")![0].id).toBe("prop-valid");
    }
  });

  it("mode オプションが createCorrectionRequest に正しく渡される", () => {
    const doc = createDummyDocument();
    const reqMinimal = createCorrectionRequest(doc, undefined, undefined, "minimal");
    expect(reqMinimal.mode).toBe("minimal");

    const reqAggressive = createCorrectionRequest(doc, undefined, undefined, "aggressive");
    expect(reqAggressive.mode).toBe("aggressive");

    const reqDefault = createCorrectionRequest(doc);
    expect(reqDefault.mode).toBe(DEFAULT_CORRECTION_MODE);
  });

  it("Test A & E: 0セグメントドキュメントは Provider を呼ばずクリーンに即座成功し、不正な Batch 0/0 を出さない", async () => {
    const doc = createDummyDocument([]); // 0 segments
    let providerCalled = false;
    const provider: any = {
      correct: async () => {
        providerCalled = true;
        return [];
      },
    };

    const progressList: CorrectionProgress[] = [];
    const result = await runCorrectionForDocument({
      document: doc,
      provider,
      onProgress: (p) => progressList.push(p),
    });

    expect(result.status).toBe("success");
    expect(providerCalled).toBe(false);
    expect(progressList).toHaveLength(1);
    expect(progressList[0].phase).toBe("completed");
    expect(progressList[0].percentage).toBe(100);
    expect(progressList[0].totalChunks).toBe(0);
    expect(progressList[0].currentChunk).toBeNull();
    expect(formatCorrectionProgress(progressList[0])).toBe("完了 (100%)");
  });

  it("Test A & B & C & D: runCorrectionForDocument は starting (totalChunks=null) -> running (Provider固有totalChunks) -> completed の順で通知する", async () => {
    const segments = Array.from({ length: 31 }, (_, i) =>
      createDummySegment({ id: `seg-${i + 1}`, text: `セグメント ${i + 1}` })
    );
    const doc = createDummyDocument(segments);

    const progressList: CorrectionProgress[] = [];
    const provider = new MockCorrectionProvider();
    const result = await runCorrectionForDocument({
      document: doc,
      provider,
      onProgress: (p) => progressList.push(p),
    });

    expect(result.status).toBe("success");
    expect(progressList.length).toBeGreaterThanOrEqual(3);

    // Starting: phase='starting', currentChunk=null, totalChunks=null, percentage=0
    expect(progressList[0].phase).toBe("starting");
    expect(progressList[0].currentChunk).toBeNull();
    expect(progressList[0].totalChunks).toBeNull(); // execution layerはProvider固有のチャンク数を推測しない
    expect(progressList[0].percentage).toBe(0);
    expect(progressList[0].totalSegments).toBe(31);
    expect(formatCorrectionProgress(progressList[0])).toBe("準備中... 0%");

    // Running (MockProvider): MockProvider自身のセマンティクスに従い totalChunks=1
    expect(progressList[1].phase).toBe("running");
    expect(progressList[1].currentChunk).toBe(1);
    expect(progressList[1].totalChunks).toBe(1);
    expect(progressList[1].totalSegments).toBe(31);
    expect(formatCorrectionProgress(progressList[1])).toBe("Batch 1/1 (1–31) 100%");

    // Completed: phase='completed', percentage=100, totalChunks=1
    const last = progressList[progressList.length - 1];
    expect(last.phase).toBe("completed");
    expect(last.percentage).toBe(100);
    expect(last.totalChunks).toBe(1);
    expect(last.completedSegments).toBe(31);
    expect(formatCorrectionProgress(last)).toBe("完了 (100%)");
  });
});

describe("CorrectionProgress schema & formatCorrectionProgress", () => {
  it("createCorrectionProgress: starting 状態のプロパティ検証 (currentChunk=null, totalChunks=null, percentage=0, range=null)", () => {
    const p = createCorrectionProgress({
      phase: "starting",
      completedChunks: 0,
      totalChunks: null,
      completedSegments: 0,
      totalSegments: 270,
    });
    expect(p.phase).toBe("starting");
    expect(p.currentChunk).toBeNull();
    expect(p.completedChunks).toBe(0);
    expect(p.totalChunks).toBeNull();
    expect(p.percentage).toBe(0);
    expect(p.segmentStart).toBeNull();
    expect(p.segmentEnd).toBeNull();
    expect(formatCorrectionProgress(p)).toBe("準備中... 0%");
  });

  it("createCorrectionProgress: running 状態のプロパティ検証 (Batch 4/18, Segments 46-60, completedSegments=45/270 -> 16%)", () => {
    const p = createCorrectionProgress({
      phase: "running",
      currentChunk: 4,
      completedChunks: 3,
      totalChunks: 18,
      completedSegments: 45, // 前バッチ(3*15=45)までの完了セグメント数
      totalSegments: 270,
      segmentStart: 46,
      segmentEnd: 60,
    });
    expect(p.phase).toBe("running");
    expect(p.currentChunk).toBe(4);
    expect(p.completedChunks).toBe(3);
    expect(p.totalChunks).toBe(18);
    expect(p.percentage).toBe(16); // Math.floor(45 / 270 * 100) = 16% (保守的計算)
    expect(p.segmentStart).toBe(46);
    expect(p.segmentEnd).toBe(60);
    expect(formatCorrectionProgress(p)).toBe("Batch 4/18 (46–60) 16%");
  });

  it("createCorrectionProgress: completed 状態のプロパティ検証 (100% 完了)", () => {
    const p = createCorrectionProgress({
      phase: "completed",
      completedChunks: 18,
      totalChunks: 18,
      completedSegments: 270,
      totalSegments: 270,
    });
    expect(p.phase).toBe("completed");
    expect(p.currentChunk).toBeNull();
    expect(p.totalChunks).toBe(18);
    expect(p.percentage).toBe(100);
    expect(p.segmentStart).toBeNull();
    expect(p.segmentEnd).toBeNull();
    expect(formatCorrectionProgress(p)).toBe("完了 (100%)");
  });
});



