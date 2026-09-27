import type { TranscriptSegment } from "./transcript";
import {
  type CorrectionEvidence,
  type CorrectionDictionaryEntry,
  type CorrectionContext,
  type CorrectionMode,
  type CorrectionProposal,
  type ParsedProposalCandidate,
  type ValidationResult,
  validateProposalCandidate,
} from "./correction";

/**
 * 統合補正チャンクのデフォルトサイズ（Anchor 時系列ウィンドウサイズ）
 */
export const DEFAULT_SYNTHESIS_CHUNK_SIZE = 8;
export const SYNTHESIS_CONTEXT_BEFORE = 2;
export const SYNTHESIS_CONTEXT_AFTER = 2;

/**
 * プロンプト提示用の整列済み単一候補情報
 */
export interface SynthesisCandidate {
  engineId: string;
  sourceSegmentId: string;
  text: string;
  overlapDurationSec: number;
  anchorCoverage: number;
  candidateCoverage: number;
  iou: number;
}

/**
 * テキスト正規化による一致グループ
 */
export interface SynthesisAgreementGroup {
  normalizedText: string;
  engineIds: string[];         // 重複排除された distinct engineId リスト
  rawTexts: string[];
  isConsensus: boolean;        // distinct engineCount >= 2 (Anchor含む)
}

/**
 * Anchorと候補間の一致状況サマリー
 */
export interface SynthesisAgreementSummary {
  hasConsensus: boolean;       // consensusGroups.length > 0
  groups: SynthesisAgreementGroup[];
  consensusGroups: SynthesisAgreementGroup[]; // isConsensus === true のグループ一覧
}

/**
 * 単一Anchorセグメントに対する統合リクエスト項目
 */
export interface SynthesisTargetItem {
  segmentId: string;
  text: string;
  start: number;
  end: number;
  engineId: string;
  candidates: SynthesisCandidate[]; // candidates.length >= 1
  agreement?: SynthesisAgreementSummary;
}

/**
 * 1バッチ分の統合補正リクエスト（Provider境界型）
 */
export interface SynthesisBatchRequest {
  anchorEngineId: string;
  targets: SynthesisTargetItem[];
  contextBefore?: TranscriptSegment[];
  contextAfter?: TranscriptSegment[];
  dictionary?: CorrectionDictionaryEntry[];
  context?: CorrectionContext;
  mode: CorrectionMode;
}

/**
 * 支持ASRソースの追跡情報（アプリ側で算出）
 */
export interface SynthesisSupportingSource {
  engineId: string;
  sourceSegmentId: string;
}

/**
 * LLM出力直後の未信頼候補型（IDなし・Phase 2 と同一構造）
 */
export type ParsedSynthesisProposalCandidate = ParsedProposalCandidate;

/**
 * アプリ側で検証・昇格された信頼済み統合補正提案
 */
export interface SynthesisProposal extends CorrectionProposal {
  kind: "multi_asr_synthesis";
  anchorEngineId: string;
  supportingSources: SynthesisSupportingSource[];
  agreementSummary?: SynthesisAgreementSummary;
}

/**
 * 一致比較（Agreement）専用のテキスト正規化
 * ※ この出力は一致キーとしてのみ使用し、correctedText や NUMERIC_CHANGE 判定には絶対に使用しない
 */
export function normalizeForAgreement(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[、。，．！？!?「」『』（）()\[\]【】\s]/g, "");
}

/**
 * Anchor および候補群の一致状況を解析し、サマリーを生成する（Pure Function）
 * - 各エンジンの投票は 1 engineId につき最大 1 vote（同一 engine から複数 segment があっても 1）
 * - Anchor 自身も 1 distinct engine としてカウント
 * - 単一 winner を強制せず、isConsensus === true の全グループを consensusGroups に含める
 */
export function computeAgreementSummary(
  anchorEngineId: string,
  anchorText: string,
  candidates: SynthesisCandidate[]
): SynthesisAgreementSummary {
  const normMap = new Map<
    string,
    { engineIdsSet: Set<string>; rawTextsSet: Set<string> }
  >();

  // 1. Anchor を追加
  const anchorNorm = normalizeForAgreement(anchorText);
  if (!normMap.has(anchorNorm)) {
    normMap.set(anchorNorm, {
      engineIdsSet: new Set([anchorEngineId]),
      rawTextsSet: new Set([anchorText]),
    });
  } else {
    const entry = normMap.get(anchorNorm)!;
    entry.engineIdsSet.add(anchorEngineId);
    entry.rawTextsSet.add(anchorText);
  }

  // 2. 各 candidate を追加（同一 engineId の複数 candidate は Set で重複排除）
  for (const cand of candidates) {
    const candNorm = normalizeForAgreement(cand.text);
    if (!normMap.has(candNorm)) {
      normMap.set(candNorm, {
        engineIdsSet: new Set([cand.engineId]),
        rawTextsSet: new Set([cand.text]),
      });
    } else {
      const entry = normMap.get(candNorm)!;
      entry.engineIdsSet.add(cand.engineId);
      entry.rawTextsSet.add(cand.text);
    }
  }

  const groups: SynthesisAgreementGroup[] = [];
  const consensusGroups: SynthesisAgreementGroup[] = [];

  for (const [normText, data] of normMap.entries()) {
    const engineIds = Array.from(data.engineIdsSet);
    const rawTexts = Array.from(data.rawTextsSet);
    const isConsensus = engineIds.length >= 2;

    const grp: SynthesisAgreementGroup = {
      normalizedText: normText,
      engineIds,
      rawTexts,
      isConsensus,
    };

    groups.push(grp);
    if (isConsensus) {
      consensusGroups.push(grp);
    }
  }

  return {
    hasConsensus: consensusGroups.length > 0,
    groups,
    consensusGroups,
  };
}

/**
 * 許可されたプロパティのみを許容する厳格なオブジェクトキーチェック
 */
function hasOnlyAllowedKeys(obj: Record<string, unknown>, allowedKeys: string[]): boolean {
  const allowedSet = new Set(allowedKeys);
  for (const k of Object.keys(obj)) {
    if (!allowedSet.has(k)) {
      return false;
    }
  }
  return true;
}

/**
 * unknown 値をランタイムで厳格検査し、ParsedSynthesisProposalCandidate 配列としてパースする。
 * 未知の余剰フィールドが含まれる場合は fail-closed として reject する。
 */
export function parseRawSynthesisCandidates(rawPayload: unknown): ParsedSynthesisProposalCandidate[] | null {
  if (typeof rawPayload !== "object" || rawPayload === null) {
    return null;
  }
  const root = rawPayload as Record<string, unknown>;
  if (!hasOnlyAllowedKeys(root, ["proposals"])) {
    return null;
  }

  if (!Array.isArray(root.proposals)) {
    return null;
  }

  const allowedCandidateKeys = [
    "segmentId",
    "originalText",
    "correctedText",
    "evidence",
    "explanation",
    "confidence",
  ];

  const allowedEvidenceKeys = ["type", "sourceId", "description"];
  const validEvidenceTypes = new Set(["dictionary", "background", "context"]);

  const result: ParsedSynthesisProposalCandidate[] = [];

  for (const item of root.proposals) {
    if (typeof item !== "object" || item === null) {
      return null;
    }
    const prop = item as Record<string, unknown>;

    // Strict schema check: 未知プロパティがあれば reject
    if (!hasOnlyAllowedKeys(prop, allowedCandidateKeys)) {
      return null;
    }

    if (
      typeof prop.segmentId !== "string" ||
      typeof prop.originalText !== "string" ||
      typeof prop.correctedText !== "string" ||
      typeof prop.explanation !== "string"
    ) {
      return null;
    }

    if (!Array.isArray(prop.evidence)) {
      return null;
    }

    const parsedEvidences: CorrectionEvidence[] = [];
    for (const ev of prop.evidence) {
      if (typeof ev !== "object" || ev === null) {
        return null;
      }
      const evObj = ev as Record<string, unknown>;
      if (!hasOnlyAllowedKeys(evObj, allowedEvidenceKeys)) {
        return null;
      }

      if (typeof evObj.type !== "string" || !validEvidenceTypes.has(evObj.type)) {
        return null;
      }

      const sourceId =
        evObj.sourceId === undefined
          ? undefined
          : typeof evObj.sourceId === "string"
          ? evObj.sourceId
          : null;
      if (sourceId === null) return null;

      const description =
        evObj.description === undefined
          ? undefined
          : typeof evObj.description === "string"
          ? evObj.description
          : null;
      if (description === null) return null;

      parsedEvidences.push({
        type: evObj.type as CorrectionEvidence["type"],
        sourceId,
        description,
      });
    }

    let confidence: number | undefined = undefined;
    if (prop.confidence !== undefined) {
      if (typeof prop.confidence !== "number" || !Number.isFinite(prop.confidence)) {
        return null;
      }
      confidence = prop.confidence;
    }

    result.push({
      segmentId: prop.segmentId,
      originalText: prop.originalText,
      correctedText: prop.correctedText,
      evidence: parsedEvidences,
      explanation: prop.explanation,
      confidence,
    });
  }

  return result;
}

/**
 * correctedText と各候補の正規化完全一致から、アプリ側で客観的に supportingSources を算出する
 */
export function computeSupportingSources(
  correctedText: string,
  candidates: SynthesisCandidate[]
): SynthesisSupportingSource[] {
  const normCorrected = normalizeForAgreement(correctedText);
  if (!normCorrected) {
    return [];
  }

  const result: SynthesisSupportingSource[] = [];
  for (const cand of candidates) {
    const normCand = normalizeForAgreement(cand.text);
    if (normCand === normCorrected) {
      result.push({
        engineId: cand.engineId,
        sourceSegmentId: cand.sourceSegmentId,
      });
    }
  }

  return result;
}

/**
 * ProposalCandidate の決定的バリデーション
 */
export function validateSynthesisCandidate(
  candidate: ParsedSynthesisProposalCandidate,
  targetSegment: TranscriptSegment,
  allowedTargetSegmentIds: Set<string>
): ValidationResult {
  // Phase 2 の共通バリデーション（TARGET_SEGMENT_MISMATCH, TEXT_MISMATCH, NUMERIC_CHANGE, etc.）
  return validateProposalCandidate(candidate, targetSegment, allowedTargetSegmentIds);
}

/**
 * 検証済み候補をアプリ管理の一意 UUID を持つ信頼済み SynthesisProposal へ昇格する
 */
export function promoteCandidateToSynthesisProposal(
  candidate: ParsedSynthesisProposalCandidate,
  anchorEngineId: string,
  targetItem: SynthesisTargetItem
): SynthesisProposal {
  const supportingSources = computeSupportingSources(
    candidate.correctedText,
    targetItem.candidates
  );

  const uuid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `synth-prop-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  return {
    ...candidate,
    id: uuid,
    kind: "multi_asr_synthesis",
    anchorEngineId,
    supportingSources,
    agreementSummary: targetItem.agreement,
  };
}
