import type { TranscriptDocument, TranscriptSegment } from "./transcript";

/**
 * ASRエンジンのタイムスタンプ粒度・能力
 */
export type TimingGranularity = "segment" | "whole_audio" | "word";

/**
 * 各ASRエンジンのネイティブ文字起こし結果
 */
export interface EngineTranscriptResult {
  engineId: string;                     // 例: "kotoba-whisper", "reazonspeech", "qwen3-asr"
  displayName: string;                  // 例: "Kotoba Whisper v2.0"
  document: TranscriptDocument;         // エンジン出力の不変スナップショット
  durationSec: number;                  // 音声長（秒）> 0
  completedAt: string;                  // ISO 8601
  timingGranularity: TimingGranularity; // タイムスタンプ粒度
  modelName?: string;
  sourceRunId?: string;
}

/**
 * 複数ASR結果を束ねるセッションコンテナ (JSONシリアライズ対応)
 */
export interface MultiEngineSession {
  sessionId: string;
  mediaPath: string;                    // 必須 (空文字・空白のみ不可)
  mediaFileName: string;                // 必須 (空文字・空白のみ不可)
  expectedDurationSec: number;          // 想定音声長（秒）> 0
  anchorEngineId: string;
  results: Record<string, EngineTranscriptResult>;
  createdAt: string;
}

/**
 * 時間軸オーバーラップ詳細指標
 */
export interface OverlapMetrics {
  overlapDurationSec: number;
  anchorCoverage: number;       // overlap / anchorDuration (0.0 - 1.0)
  candidateCoverage: number;    // overlap / candidateDuration (0.0 - 1.0)
  iou: number;                  // overlap / (anchor + cand - overlap) (0.0 - 1.0)
}

/**
 * 時間軸で照合された他エンジンのセグメント候補
 */
export interface AlignedEngineCandidate {
  engineId: string;
  sourceSegmentId: string;
  timeRange: { start: number; end: number };
  text: string;
  metrics: OverlapMetrics;
}

/**
 * 時間軸照合ができない・粒度不足の未整列ソース情報
 */
export interface UnalignedSource {
  engineId: string;
  reason:
    | "whole_audio_timing_only"
    | "duration_mismatch"
    | "no_timing_data"
    | "invalid_timing_data"
    | "unsupported_timing_granularity";
  sourceSegmentIds: string[];
}

/**
 * Anchorセグメントごとのアラインメント結果
 */
export interface AlignedSegmentGroup {
  anchorSegment: TranscriptSegment;
  candidates: AlignedEngineCandidate[];
}

/**
 * セッション全体のアラインメント結果
 */
export interface MultiEngineAlignmentResult {
  sessionId: string;
  anchorEngineId: string;
  groups: AlignedSegmentGroup[];
  unalignedSources: UnalignedSource[];
  warnings: string[];
}

/**
 * アラインメント設定定数
 */
export const ALIGNMENT_PADDING_SEC = 0.35;
export const MIN_ANCHOR_COVERAGE = 0.20;
export const MIN_CANDIDATE_COVERAGE = 0.20;
export const DURATION_MISMATCH_TOLERANCE_SEC = 2.0;

/**
 * メディアパスを比較用に正規化する (Windows/POSIX/UNC両対応)
 * - 前後空白trim
 * - バックスラッシュ '\' を '/' に統一
 * - UNCパス判定 (先頭が "//" で始まる場合は先頭の "//" を保持し、通常ルート "/" と区別)
 * - 残り部分の連続スラッシュを単一スラッシュへ縮退
 * - 末尾スラッシュの整理
 * - Windows前提のcase-insensitivityのための小文字化
 */
export function normalizeMediaPath(pathStr: string): string {
  if (!pathStr) return "";
  const trimmed = pathStr.trim();
  if (!trimmed) return "";

  const slashified = trimmed.replace(/\\/g, "/");
  const isUnc = slashified.startsWith("//") && !slashified.startsWith("///");

  let pathBody = isUnc ? slashified.slice(2) : slashified;
  pathBody = pathBody.replace(/\/+/g, "/");

  let result = isUnc ? `//${pathBody}` : pathBody;

  // 末尾スラッシュの整理 (ルート "//" または "/" 自体は残す)
  if (result.length > (isUnc ? 2 : 1) && result.endsWith("/")) {
    result = result.slice(0, -1);
  }

  return result.toLowerCase();
}

/**
 * ファイル名を比較用に正規化する (Windows前提のcase-insensitivity)
 */
export function normalizeMediaFileName(fileName: string): string {
  return fileName.trim().toLowerCase();
}

/**
 * 2つの時間区間のオーバーラップメトリクスを厳密に計算する (Paddingなしの本来の時間で計算)
 */
export function computeOverlapMetrics(
  anchorStart: number,
  anchorEnd: number,
  candidateStart: number,
  candidateEnd: number
): OverlapMetrics {
  const anchorDuration = Math.max(0, anchorEnd - anchorStart);
  const candidateDuration = Math.max(0, candidateEnd - candidateStart);

  if (anchorDuration === 0 || candidateDuration === 0) {
    return {
      overlapDurationSec: 0,
      anchorCoverage: 0,
      candidateCoverage: 0,
      iou: 0,
    };
  }

  const overlapStart = Math.max(anchorStart, candidateStart);
  const overlapEnd = Math.min(anchorEnd, candidateEnd);
  const overlapDurationSec = Math.max(0, overlapEnd - overlapStart);

  const anchorCoverage = overlapDurationSec / anchorDuration;
  const candidateCoverage = overlapDurationSec / candidateDuration;
  const unionDuration = anchorDuration + candidateDuration - overlapDurationSec;
  const iou = unionDuration > 0 ? overlapDurationSec / unionDuration : 0;

  return {
    overlapDurationSec,
    anchorCoverage,
    candidateCoverage,
    iou,
  };
}

/**
 * Padded Window を用いて2つの区間が探索対象として交差するか判定する
 */
export function rangesIntersectWithPadding(
  anchorStart: number,
  anchorEnd: number,
  candidateStart: number,
  candidateEnd: number,
  paddingSec: number = ALIGNMENT_PADDING_SEC
): boolean {
  const paddedAnchorStart = anchorStart - paddingSec;
  const paddedAnchorEnd = anchorEnd + paddingSec;
  return Math.max(paddedAnchorStart, candidateStart) < Math.min(paddedAnchorEnd, candidateEnd);
}

/**
 * 単一セグメントのタイムスタンプ整合性を検証する
 */
export function isSegmentTimestampValid(
  segment: TranscriptSegment,
  durationSec: number,
  toleranceSec: number = DURATION_MISMATCH_TOLERANCE_SEC
): boolean {
  if (
    typeof segment.start !== "number" ||
    typeof segment.end !== "number" ||
    !Number.isFinite(segment.start) ||
    !Number.isFinite(segment.end)
  ) {
    return false;
  }

  if (segment.start < 0) {
    return false;
  }

  if (segment.end <= segment.start) {
    return false;
  }

  if (durationSec > 0) {
    const maxAllowed = durationSec + toleranceSec;
    if (segment.start > maxAllowed || segment.end > maxAllowed) {
      return false;
    }
  }

  return true;
}

/**
 * セグメント配列全体のタイムスタンプ整合性および一意性を検証する
 */
export function validateSegmentTimestamps(
  segments: TranscriptSegment[],
  durationSec: number
): { valid: boolean; reason?: string } {
  if (segments.length === 0) {
    return { valid: true };
  }

  const seenIds = new Set<string>();

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];

    // 1. 重複 Segment ID の検出
    if (!s.id || typeof s.id !== "string" || !s.id.trim()) {
      return { valid: false, reason: `Segment[${i}] has missing or empty id` };
    }
    if (seenIds.has(s.id)) {
      return { valid: false, reason: `Duplicate segment ID detected: "${s.id}"` };
    }
    seenIds.add(s.id);

    // 2. タイムスタンプ有限性
    if (
      typeof s.start !== "number" ||
      typeof s.end !== "number" ||
      !Number.isFinite(s.start) ||
      !Number.isFinite(s.end)
    ) {
      return { valid: false, reason: `Segment[${i}] has non-finite timestamps: start=${s.start}, end=${s.end}` };
    }

    // 3. start >= 0
    if (s.start < 0) {
      return { valid: false, reason: `Segment[${i}] has negative start time: ${s.start}` };
    }

    // 4. end > start
    if (s.end <= s.start) {
      return { valid: false, reason: `Segment[${i}] has end <= start: start=${s.start}, end=${s.end}` };
    }

    // 5. duration 超過チェック
    if (durationSec > 0) {
      const maxAllowed = durationSec + DURATION_MISMATCH_TOLERANCE_SEC;
      if (s.start > maxAllowed || s.end > maxAllowed) {
        return { valid: false, reason: `Segment[${i}] timestamps (start=${s.start}, end=${s.end}) exceed duration (${durationSec}s) plus tolerance` };
      }
    }
  }

  return { valid: true };
}

/**
 * MultiEngineSession のメタデータおよび同一音声整合性を検証する
 */
export function validateMultiEngineSession(session: MultiEngineSession): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. session.mediaPath 必須チェック
  if (!session.mediaPath || !session.mediaPath.trim()) {
    errors.push("MultiEngineSession.mediaPath is required and cannot be empty or whitespace-only.");
  }

  // 2. session.mediaFileName 必須チェック
  if (!session.mediaFileName || !session.mediaFileName.trim()) {
    errors.push("MultiEngineSession.mediaFileName is required and cannot be empty or whitespace-only.");
  }

  // 3. expectedDurationSec の検証
  if (
    typeof session.expectedDurationSec !== "number" ||
    !Number.isFinite(session.expectedDurationSec) ||
    session.expectedDurationSec <= 0
  ) {
    errors.push(`MultiEngineSession.expectedDurationSec must be a finite positive number, got: ${session.expectedDurationSec}`);
  }

  const engineIds = Object.keys(session.results || {});
  if (engineIds.length === 0) {
    errors.push("MultiEngineSession contains no engine results.");
    return { valid: false, errors, warnings };
  }

  if (!session.anchorEngineId || !session.results[session.anchorEngineId]) {
    errors.push(`Anchor engine "${session.anchorEngineId}" does not exist in session results.`);
  }

  const normalizedSessionPath = normalizeMediaPath(session.mediaPath);
  const normalizedSessionFileName = normalizeMediaFileName(session.mediaFileName);

  for (const [key, res] of Object.entries(session.results)) {
    // 4. Record key と result.engineId の一致検証
    if (key !== res.engineId) {
      errors.push(`Session results key "${key}" does not match result.engineId "${res.engineId}".`);
    }

    // 5. durationSec の検証
    if (typeof res.durationSec !== "number" || !Number.isFinite(res.durationSec) || res.durationSec <= 0) {
      errors.push(`Engine "${res.engineId}" durationSec must be a finite positive number, got: ${res.durationSec}`);
    }

    // 6. document.mediaPath 必須 & 正規化比較
    if (!res.document?.mediaPath || !res.document.mediaPath.trim()) {
      errors.push(`Engine "${res.engineId}" document.mediaPath is required and cannot be empty.`);
    } else {
      const normalizedDocPath = normalizeMediaPath(res.document.mediaPath);
      if (normalizedSessionPath && normalizedDocPath !== normalizedSessionPath) {
        errors.push(`Engine "${res.engineId}" mediaPath mismatch: expected "${session.mediaPath}", got "${res.document.mediaPath}"`);
      }
    }

    // 7. document.mediaFileName 必須 & 大小文字非依存比較
    if (!res.document?.mediaFileName || !res.document.mediaFileName.trim()) {
      errors.push(`Engine "${res.engineId}" document.mediaFileName is required and cannot be empty.`);
    } else {
      const normalizedDocFileName = normalizeMediaFileName(res.document.mediaFileName);
      if (normalizedSessionFileName && normalizedDocFileName !== normalizedSessionFileName) {
        errors.push(`Engine "${res.engineId}" mediaFileName mismatch: expected "${session.mediaFileName}", got "${res.document.mediaFileName}"`);
      }
    }

    // 8. Segment ID の存在および一意性チェック (Anchor & Secondary 共通で厳格検証)
    if (res.document?.segments) {
      const seenIds = new Set<string>();
      for (let i = 0; i < res.document.segments.length; i++) {
        const seg = res.document.segments[i];
        if (!seg.id || typeof seg.id !== "string" || !seg.id.trim()) {
          errors.push(`Engine "${res.engineId}" document segment[${i}] has missing or empty id.`);
          break;
        }
        if (seenIds.has(seg.id)) {
          errors.push(`Engine "${res.engineId}" document has duplicate segment ID "${seg.id}".`);
          break;
        }
        seenIds.add(seg.id);
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
 * MultiEngineSession を時間軸で照合し、セグメントグループを生成する
 */
export function alignMultiEngineSession(session: MultiEngineSession): MultiEngineAlignmentResult {
  const validation = validateMultiEngineSession(session);
  const warnings = [...validation.warnings];

  if (!validation.valid) {
    return {
      sessionId: session?.sessionId || "invalid",
      anchorEngineId: session?.anchorEngineId || "unknown",
      groups: [],
      unalignedSources: [
        {
          engineId: "unknown",
          reason: "invalid_timing_data",
          sourceSegmentIds: [],
        },
      ],
      warnings: validation.errors.concat(warnings),
    };
  }

  const anchorResult = session.results[session.anchorEngineId];
  const anchorDoc = anchorResult.document;
  const groups: AlignedSegmentGroup[] = [];
  const unalignedSources: UnalignedSource[] = [];

  // Anchor の能力チェック
  if (anchorResult.timingGranularity === "whole_audio") {
    return {
      sessionId: session.sessionId,
      anchorEngineId: session.anchorEngineId,
      groups: [],
      unalignedSources: [
        {
          engineId: session.anchorEngineId,
          reason: "whole_audio_timing_only",
          sourceSegmentIds: anchorDoc.segments.map((s) => s.id),
        },
      ],
      warnings: [`Anchor engine "${session.anchorEngineId}" has whole_audio timing granularity and cannot provide segment-level alignment bounds.`],
    };
  }

  if (anchorResult.timingGranularity !== "segment") {
    return {
      sessionId: session.sessionId,
      anchorEngineId: session.anchorEngineId,
      groups: [],
      unalignedSources: [
        {
          engineId: session.anchorEngineId,
          reason: "unsupported_timing_granularity",
          sourceSegmentIds: anchorDoc.segments.map((s) => s.id),
        },
      ],
      warnings: [`Anchor engine "${session.anchorEngineId}" has unsupported timing granularity "${anchorResult.timingGranularity}".`],
    };
  }

  // Anchor の duration 不一致チェック
  if (Math.abs(anchorResult.durationSec - session.expectedDurationSec) > DURATION_MISMATCH_TOLERANCE_SEC) {
    return {
      sessionId: session.sessionId,
      anchorEngineId: session.anchorEngineId,
      groups: [],
      unalignedSources: [
        {
          engineId: session.anchorEngineId,
          reason: "duration_mismatch",
          sourceSegmentIds: anchorDoc.segments.map((s) => s.id),
        },
      ],
      warnings: [`Anchor engine "${session.anchorEngineId}" duration (${anchorResult.durationSec}s) differs from expected (${session.expectedDurationSec}s) by more than ${DURATION_MISMATCH_TOLERANCE_SEC}s.`],
    };
  }

  // 各 Secondary エンジンの Capability & Validity を事前分類
  const eligibleSecondaryEngines: string[] = [];

  for (const [engineId, res] of Object.entries(session.results)) {
    if (engineId === session.anchorEngineId) {
      continue;
    }

    // 1. duration mismatch
    if (Math.abs(res.durationSec - session.expectedDurationSec) > DURATION_MISMATCH_TOLERANCE_SEC) {
      warnings.push(`Secondary engine "${engineId}" duration (${res.durationSec}s) differs from expected (${session.expectedDurationSec}s).`);
      unalignedSources.push({
        engineId,
        reason: "duration_mismatch",
        sourceSegmentIds: res.document.segments.map((s) => s.id),
      });
      continue;
    }

    // 2. whole_audio
    if (res.timingGranularity === "whole_audio") {
      unalignedSources.push({
        engineId,
        reason: "whole_audio_timing_only",
        sourceSegmentIds: res.document.segments.map((s) => s.id),
      });
      continue;
    }

    // 3. unsupported timing granularity (例: "word")
    if (res.timingGranularity !== "segment") {
      unalignedSources.push({
        engineId,
        reason: "unsupported_timing_granularity",
        sourceSegmentIds: res.document.segments.map((s) => s.id),
      });
      continue;
    }

    // 4. timestamp validity
    const timingVal = validateSegmentTimestamps(res.document.segments, res.durationSec);
    if (!timingVal.valid) {
      warnings.push(`Secondary engine "${engineId}" has invalid timestamps: ${timingVal.reason}`);
      unalignedSources.push({
        engineId,
        reason: "invalid_timing_data",
        sourceSegmentIds: res.document.segments.map((s) => s.id),
      });
      continue;
    }

    eligibleSecondaryEngines.push(engineId);
  }

  // Anchor セグメントのソートコピー（非破壊）
  const sortedAnchorSegments = [...anchorDoc.segments].sort((a, b) => a.start - b.start);

  // Anchor の各セグメントについて候補を探索
  for (const anchorSeg of sortedAnchorSegments) {
    // Anchor 自身のタイムスタンプ妥当性検査: 不正なAnchorセグメントは group を作らずスキップ
    if (!isSegmentTimestampValid(anchorSeg, anchorResult.durationSec)) {
      warnings.push(`Skipped invalid Anchor segment "${anchorSeg.id}" with start=${anchorSeg.start}, end=${anchorSeg.end}`);
      continue;
    }

    const candidates: AlignedEngineCandidate[] = [];

    for (const secEngineId of eligibleSecondaryEngines) {
      const secResult = session.results[secEngineId];
      // Secondary セグメントもソートコピーで走査
      const sortedSecSegments = [...secResult.document.segments].sort((a, b) => a.start - b.start);

      for (const secSeg of sortedSecSegments) {
        // Padded Range で探索 (Discovery)
        if (
          rangesIntersectWithPadding(
            anchorSeg.start,
            anchorSeg.end,
            secSeg.start,
            secSeg.end,
            ALIGNMENT_PADDING_SEC
          )
        ) {
          // 本来の時刻で厳密に OverlapMetrics を計算
          const metrics = computeOverlapMetrics(
            anchorSeg.start,
            anchorSeg.end,
            secSeg.start,
            secSeg.end
          );

          // 採択基準: anchorCoverage >= MIN_ANCHOR_COVERAGE かつ candidateCoverage >= MIN_CANDIDATE_COVERAGE
          if (
            metrics.anchorCoverage >= MIN_ANCHOR_COVERAGE &&
            metrics.candidateCoverage >= MIN_CANDIDATE_COVERAGE
          ) {
            candidates.push({
              engineId: secEngineId,
              sourceSegmentId: secSeg.id,
              timeRange: { start: secSeg.start, end: secSeg.end },
              text: secSeg.text,
              metrics,
            });
          }
        }
      }
    }

    groups.push({
      anchorSegment: anchorSeg,
      candidates,
    });
  }

  return {
    sessionId: session.sessionId,
    anchorEngineId: session.anchorEngineId,
    groups,
    unalignedSources,
    warnings,
  };
}
