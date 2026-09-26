import { deriveSegmentStatus, type TranscriptDocument, type TranscriptSegment } from "./transcript";

/**
 * 補正根拠タイプ
 */
export type CorrectionEvidenceType = "dictionary" | "background" | "context";

/**
 * 補正根拠エントリー
 */
export interface CorrectionEvidence {
  type: CorrectionEvidenceType;
  sourceId?: string;
  description?: string;
}

/**
 * 用語辞書エントリー（Phase 2/3 Provider境界型）
 */
export interface CorrectionDictionaryEntry {
  id: string;
  canonical: string;
  variants: string[];
  category?: string;
  note?: string;
}

/**
 * 背景情報コンテキスト（Phase 2/3 Provider境界型）
 */
export interface CorrectionContext {
  backgroundText: string;
  speakerNotes?: Record<string, string>;
}

/**
 * 外部/パース直後の補正提案候補型（LLM出力境界・IDなし）
 */
export interface ParsedProposalCandidate {
  segmentId: string;
  originalText: string;    // 提案生成時点の segment.text スナップショット
  correctedText: string;   // 補正後テキスト（採用時の正本データ）
  evidence: CorrectionEvidence[];
  explanation: string;
  confidence?: number;     // 0.0 - 1.0 (表示用メタデータ・自動採用には不使用)
}

/**
 * 内部で管理される信頼済み補正提案（一意IDを持つ）
 * ※ changes は含めず、originalText と correctedText を正本とする
 */
export interface CorrectionProposal extends ParsedProposalCandidate {
  id: string;              // アプリ側で付与された一意ID
}

/**
 * UI表示用差分構造
 */
export interface TextChange {
  from: string;
  to: string;
}

/**
 * 受信時バリデーションエラー
 */
export type ValidationErrorType =
  | "MISSING_SEGMENT"
  | "TARGET_SEGMENT_MISMATCH" // Context専用セグメントへの補正提案を拒否
  | "TEXT_MISMATCH"          // 受信時点で segment.text と不一致
  | "EMPTY_TEXT"
  | "NO_CHANGE"              // originalText === correctedText
  | "MISSING_EVIDENCE"       // evidence が空配列または未指定
  | "BAD_EVIDENCE_TYPE"
  | "INVALID_CONFIDENCE";

/**
 * 受信時バリデーション警告（非ブロック）
 */
export type ValidationWarningType =
  | "LARGE_CHANGE"         // 編集距離・変更量が大きい
  | "AMBIGUOUS_OCCURRENCE";

export interface ValidationResult {
  valid: boolean;
  errors: ValidationErrorType[];
  warnings: ValidationWarningType[];
}

/**
 * Ollama エラー分類型
 */
export type OllamaErrorKind =
  | "ConnectionRefused"
  | "HttpStatusError"
  | "ModelNotFound"
  | "Timeout"
  | "MalformedOllamaPayload"
  | "JsonParseError"
  | "SchemaError";

export interface OllamaError {
  kind: OllamaErrorKind;
  message: string;
  statusCode?: number;
}

/**
 * 採用時 (Apply) エラー型
 */
export type ApplyProposalError =
  | "STALE"                // 提案生成後に本文が手動編集された
  | "MISSING_SEGMENT"
  | "INVALID_PROPOSAL";

export interface ApplyProposalResult {
  ok: boolean;
  error?: ApplyProposalError;
}

/**
 * 補正リクエスト
 */
export interface CorrectionRequest {
  document: TranscriptDocument; // 常に参照分離されたクローン
  dictionary?: CorrectionDictionaryEntry[];
  context?: CorrectionContext;
}

/**
 * 補正プロバイダー抽象インターフェース
 */
export interface CorrectionProvider {
  correct(
    request: CorrectionRequest,
    onProgress?: (completed: number, total: number) => void
  ): Promise<CorrectionProposal[]>;
}

/**
 * ドキュメントやオブジェクトをディープクローンする
 */
export function cloneTranscriptDocument<T>(doc: T): T {
  return typeof structuredClone === "function"
    ? structuredClone(doc)
    : (JSON.parse(JSON.stringify(doc)) as T);
}


/**
 * Provider呼び出し前の境界関数。
 * エディター状態と参照共有されていない独立した CorrectionRequest を生成する。
 */
export function createCorrectionRequest(
  doc: TranscriptDocument,
  dictionary?: CorrectionDictionaryEntry[],
  context?: CorrectionContext
): CorrectionRequest {
  return {
    document: cloneTranscriptDocument(doc),
    dictionary: dictionary ? cloneTranscriptDocument(dictionary) : undefined,
    context: context ? cloneTranscriptDocument(context) : undefined,
  };
}

/**
 * HTML属性値用の安全なエスケープ関数
 * ダブルクォートやシングルクォートを含む危険文字（&, <, >, ", '）をすべてエスケープする。
 */
export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * unknown 値をランタイムで検査し、安全な CorrectionEvidence オブジェクトであるか検証する
 */
export function parseCorrectionEvidence(value: unknown): CorrectionEvidence | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.type !== "string") {
    return null;
  }
  const sourceId = obj.sourceId === undefined ? undefined : typeof obj.sourceId === "string" ? obj.sourceId : null;
  if (sourceId === null) return null;

  const description = obj.description === undefined ? undefined : typeof obj.description === "string" ? obj.description : null;
  if (description === null) return null;

  return {
    type: obj.type as CorrectionEvidenceType,
    sourceId,
    description,
  };
}

/**
 * unknown 値をランタイムで検査し、安全な ParsedProposalCandidate オブジェクト（IDなし）であるか検証する
 */
export function parseRawProposalCandidate(value: unknown): ParsedProposalCandidate | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const obj = value as Record<string, unknown>;

  if (
    typeof obj.segmentId !== "string" ||
    typeof obj.originalText !== "string" ||
    typeof obj.correctedText !== "string" ||
    typeof obj.explanation !== "string"
  ) {
    return null;
  }

  if (!Array.isArray(obj.evidence)) {
    return null;
  }

  const parsedEvidences: CorrectionEvidence[] = [];
  for (const ev of obj.evidence) {
    const parsed = parseCorrectionEvidence(ev);
    if (!parsed) {
      return null;
    }
    parsedEvidences.push(parsed);
  }

  let confidence: number | undefined = undefined;
  if (obj.confidence !== undefined) {
    if (typeof obj.confidence !== "number" || !Number.isFinite(obj.confidence)) {
      return null;
    }
    confidence = obj.confidence;
  }

  return {
    segmentId: obj.segmentId,
    originalText: obj.originalText,
    correctedText: obj.correctedText,
    evidence: parsedEvidences,
    explanation: obj.explanation,
    confidence,
  };
}

/**
 * unknown 値（配列または { proposals: [...] }）を検査し、有効な候補リスト（IDなし）を抽出する
 */
export function parseRawProposalCandidates(value: unknown): {
  candidates: ParsedProposalCandidate[];
  discardedCount: number;
} {
  let list: unknown[];
  if (Array.isArray(value)) {
    list = value;
  } else if (typeof value === "object" && value !== null && Array.isArray((value as Record<string, unknown>).proposals)) {
    list = (value as Record<string, unknown>).proposals as unknown[];
  } else {
    throw new Error("プロポーザルデータが配列または { proposals: [...] } 形式ではありません。");
  }

  const candidates: ParsedProposalCandidate[] = [];
  let discardedCount = 0;

  for (const item of list) {
    const parsed = parseRawProposalCandidate(item);
    if (parsed) {
      candidates.push(parsed);
    } else {
      discardedCount++;
    }
  }

  return { candidates, discardedCount };
}

/**
 * 有効な ParsedProposalCandidate に一意な ID を付与して CorrectionProposal へ昇格させる
 */
export function promoteCandidateToProposal(
  candidate: ParsedProposalCandidate,
  idGenerator: () => string = () =>
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `prop-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
): CorrectionProposal {
  return {
    ...candidate,
    id: idGenerator(),
  };
}

/**
 * unknown 値をランタイムで検査し、安全な CorrectionProposal オブジェクトであるか検証する
 */
export function parseCorrectionProposal(value: unknown): CorrectionProposal | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id.trim() === "") {
    return null;
  }

  const candidate = parseRawProposalCandidate(value);
  if (!candidate) return null;

  return {
    id: obj.id,
    ...candidate,
  };
}

/**
 * Providerレスポンス（unknown）全体を検査し、有効な CorrectionProposal のリストを返す
 * - トップレベルが配列でない場合はエラーをスロー
 * - 配列内の不正な proposal は破棄し、有効なものだけを抽出する
 */
export interface ParseProposalsResult {
  proposals: CorrectionProposal[];
  discardedCount: number;
}

export function parseCorrectionProposals(value: unknown): ParseProposalsResult {
  if (!Array.isArray(value)) {
    throw new Error("Providerレスポンスが配列形式ではありません。");
  }

  const proposals: CorrectionProposal[] = [];
  let discardedCount = 0;

  for (const item of value) {
    const parsed = parseCorrectionProposal(item);
    if (parsed) {
      proposals.push(parsed);
    } else {
      discardedCount++;
    }
  }

  return { proposals, discardedCount };
}

/**
 * 簡易diff導出関数（Phase 1仕様）
 * 先頭・末尾の共通部分（Common Prefix / Common Suffix）を除外して変化部分の { from, to } を抽出する。
 * ※ 複数箇所の変更を精密に分解するdiffではなく、1つのまとまりとして返す簡易diffです。
 * ※ Phase 1ではUTF-16インデックス単位で比較を行っています（サロゲートペア等の複雑な異体字処理はPhase 2以降で検討）。
 */
export function deriveTextChanges(originalText: string, correctedText: string): TextChange[] {
  if (originalText === correctedText) return [];
  let start = 0;
  while (
    start < originalText.length &&
    start < correctedText.length &&
    originalText[start] === correctedText[start]
  ) {
    start++;
  }
  let endOrig = originalText.length - 1;
  let endCorr = correctedText.length - 1;
  while (
    endOrig >= start &&
    endCorr >= start &&
    originalText[endOrig] === correctedText[endCorr]
  ) {
    endOrig--;
    endCorr--;
  }
  return [
    {
      from: originalText.slice(start, endOrig + 1),
      to: correctedText.slice(start, endCorr + 1),
    },
  ];
}

const VALID_EVIDENCE_TYPES = new Set<CorrectionEvidenceType>(["dictionary", "background", "context"]);

/**
 * 提案候補の妥当性検証
 * @param candidate 検証対象の提案候補
 * @param segment 対象セグメント
 * @param allowedTargetSegmentIds 補正対象として許可されたセグメントIDの集合（Context専用セグメントへの提案を TARGET_SEGMENT_MISMATCH で拒否）
 */
export function validateProposalCandidate(
  candidate: ParsedProposalCandidate,
  segment: TranscriptSegment | undefined,
  allowedTargetSegmentIds?: Set<string>
): ValidationResult {
  const errors: ValidationErrorType[] = [];
  const warnings: ValidationWarningType[] = [];

  // 1. セグメント存在
  if (!segment) {
    errors.push("MISSING_SEGMENT");
    return { valid: false, errors, warnings };
  }

  // 2. チャンク内対象範囲外（コンテキスト専用セグメントへの提案）
  if (allowedTargetSegmentIds && !allowedTargetSegmentIds.has(candidate.segmentId)) {
    errors.push("TARGET_SEGMENT_MISMATCH");
  }

  // 3. 本文一致 (Stale / Mismatch)
  if (candidate.originalText !== segment.text) {
    errors.push("TEXT_MISMATCH");
  }

  // 4. 空文字
  if (!candidate.correctedText || candidate.correctedText.trim() === "") {
    errors.push("EMPTY_TEXT");
  }

  // 5. NO_CHANGE
  if (candidate.originalText === candidate.correctedText) {
    errors.push("NO_CHANGE");
  }

  // 6. MISSING_EVIDENCE
  if (!Array.isArray(candidate.evidence) || candidate.evidence.length === 0) {
    errors.push("MISSING_EVIDENCE");
  } else {
    // 7. BAD_EVIDENCE_TYPE
    for (const ev of candidate.evidence) {
      if (!ev || !VALID_EVIDENCE_TYPES.has(ev.type)) {
        errors.push("BAD_EVIDENCE_TYPE");
        break;
      }
    }
  }

  // 8. INVALID_CONFIDENCE
  if (candidate.confidence !== undefined) {
    if (
      typeof candidate.confidence !== "number" ||
      !Number.isFinite(candidate.confidence) ||
      candidate.confidence < 0 ||
      candidate.confidence > 1
    ) {
      errors.push("INVALID_CONFIDENCE");
    }
  }

  // Warnings チェック (validの場合に評価)
  if (errors.length === 0) {
    // LARGE_CHANGE warning: 文字数差が20文字以上、または元テキストが10文字以上で変化比率50%超
    const lenDiff = Math.abs(candidate.correctedText.length - candidate.originalText.length);
    const origLen = candidate.originalText.length;
    if (lenDiff >= 20 || (origLen >= 10 && lenDiff / origLen >= 0.5)) {
      warnings.push("LARGE_CHANGE");
    }

    // AMBIGUOUS_OCCURRENCE: 簡易diffで得られた from が元テキスト内に2箇所以上出現する場合
    const changes = deriveTextChanges(candidate.originalText, candidate.correctedText);
    for (const ch of changes) {
      if (ch.from.length > 0) {
        const count = candidate.originalText.split(ch.from).length - 1;
        if (count > 1) {
          warnings.push("AMBIGUOUS_OCCURRENCE");
          break;
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * 提案の妥当性検証（CorrectionProposal / ParsedProposalCandidate 共通）
 */
export function validateProposal(
  proposal: CorrectionProposal,
  segment: TranscriptSegment | undefined,
  allowedTargetSegmentIds?: Set<string>
): ValidationResult {
  return validateProposalCandidate(proposal, segment, allowedTargetSegmentIds);
}

/**
 * 補正提案の採用
 * - Staleチェック: proposal.originalText !== segment.text なら "STALE" を返して中止
 * - 成功時: segment.text を更新、status を deriveSegmentStatus で 'edited' に更新
 * - segment.originalText は絶対に更新しない
 * - 同一セグメントの全提案をクリアする
 */
export function applyProposal(
  proposal: CorrectionProposal,
  currentDoc: TranscriptDocument,
  activeProposals: Map<string, CorrectionProposal[]>
): ApplyProposalResult {
  const segment = currentDoc.segments.find((s) => s.id === proposal.segmentId);
  if (!segment) {
    return { ok: false, error: "MISSING_SEGMENT" };
  }

  // Stale チェック: 提案作成後にユーザーが手動編集している場合は拒否
  if (proposal.originalText !== segment.text) {
    return { ok: false, error: "STALE" };
  }

  // バリデーションチェック
  const val = validateProposal(proposal, segment);
  if (!val.valid) {
    return { ok: false, error: "INVALID_PROPOSAL" };
  }

  // 採用反映
  segment.text = proposal.correctedText;
  segment.status = deriveSegmentStatus(segment); // 'edited'

  // 同一セグメントの全提案をクリア
  activeProposals.delete(segment.id);

  return { ok: true };
}

/**
 * 補正提案の却下
 * - 対象提案のみをアクティブリストから削除
 * - ドキュメントは一切不変
 */
export function rejectProposal(
  proposalId: string,
  segmentId: string,
  activeProposals: Map<string, CorrectionProposal[]>
): void {
  const current = activeProposals.get(segmentId);
  if (!current) return;

  const remaining = current.filter((p) => p.id !== proposalId);
  if (remaining.length === 0) {
    activeProposals.delete(segmentId);
  } else {
    activeProposals.set(segmentId, remaining);
  }
}

/**
 * Phase 1 Mock Provider（決定論的 fixture 返却）
 */
export class MockCorrectionProvider implements CorrectionProvider {
  private fixtures: CorrectionProposal[];

  constructor(fixtures: CorrectionProposal[] = []) {
    this.fixtures = fixtures;
  }

  async correct(request: CorrectionRequest): Promise<CorrectionProposal[]> {
    const validSegmentIds = new Set(request.document.segments.map((s) => s.id));
    return this.fixtures.filter((f) => validSegmentIds.has(f.segmentId));
  }
}
