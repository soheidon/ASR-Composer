import type { TranscriptDocument } from "./transcript";
import {
  type MultiEngineSession,
  type EngineTranscriptResult,
  type MultiEngineAlignmentResult,
  type TimingGranularity,
  validateMultiEngineSession,
  alignMultiEngineSession,
} from "./multi-asr";
import { type SynthesisProposal } from "./synthesis";
import {
  type SynthesisRunResult,
  type SynthesisRunOptions,
  runSynthesisForAlignment,
} from "./synthesis-runner";
import type { SynthesisProvider } from "./synthesis-provider";
import type {
  CorrectionDictionaryEntry,
  CorrectionContext,
  CorrectionMode,
} from "./correction";

/**
 * Partial ASR結果の理由区分
 */
export type PartialAsrReason =
  | "single_engine_only"
  | "no_segment_timing_anchor"
  | "no_aligned_candidates";

/**
 * 個別エンジンの実行記録
 */
export interface EngineExecutionRecord {
  engineId: string;
  displayName: string;
  status: "success" | "failed" | "skipped";
  durationSec?: number;
  timingGranularity?: TimingGranularity;
  error?: string;
}

/**
 * 正常完了時のStaging用Multi-ASR結果
 */
export interface PendingMultiAsrResult {
  session: MultiEngineSession;
  alignment: MultiEngineAlignmentResult;
  proposals: SynthesisProposal[];
  engineRecords: EngineExecutionRecord[];
}

/**
 * Multi-ASR オーケストレーション実行結果 (Discriminated Union)
 */
export type MultiAsrOrchestrationResult =
  | {
      status: "success";
      staging: PendingMultiAsrResult;
    }
  | {
      status: "partial_asr_only";
      reason: PartialAsrReason;
      session: MultiEngineSession;
      engineRecords: EngineExecutionRecord[];
    }
  | {
      status: "failed";
      error: string;
      engineRecords: EngineExecutionRecord[];
    }
  | {
      status: "stale";
    }
  | {
      status: "cancelled";
    };

/**
 * ASRエンジン実行スペック
 */
export interface MultiAsrEngineSpec {
  engineId: string;
  displayName: string;
  runTranscription: (
    mediaPath: string,
    options?: { isCancelled?: () => boolean }
  ) => Promise<TranscriptDocument>;
  preferredAnchorPriority?: number;
  timingGranularity?: TimingGranularity;
}

/**
 * Multi-ASR 進捗状況
 */
export interface MultiAsrProgress {
  phase: "transcribing" | "aligning" | "synthesizing";
  currentEngineId?: string;
  engineIndex?: number;
  totalEngines?: number;
  percent: number;
  message: string;
}

/**
 * Multi-ASR オーケストレーション実行オプション
 */
export interface MultiAsrOrchestratorOptions {
  mediaPath: string;
  mediaFileName: string;
  expectedDurationSec: number;
  engines: MultiAsrEngineSpec[];
  anchorEngineId?: string;
  dictionary?: CorrectionDictionaryEntry[];
  context?: CorrectionContext;
  mode?: CorrectionMode;
  chunkSize?: number;
  synthesisProvider?: SynthesisProvider;
  isCancelled?: () => boolean;
  isCurrentRun?: () => boolean;
  onProgress?: (progress: MultiAsrProgress) => void;
}

/**
 * TranscriptDocument から動的に TimingGranularity を導出する
 */
export function deriveTimingGranularity(
  document: TranscriptDocument,
  durationSec: number
): TimingGranularity {
  if (!document || !Array.isArray(document.segments) || document.segments.length === 0) {
    return "whole_audio";
  }

  const segs = document.segments;

  if (segs.length === 1) {
    const s = segs[0];
    const segDuration = s.end - s.start;
    // 1セグメントで全体 (durationの80%以上) を覆っている場合は whole_audio とみなす
    if (s.start <= 1.0 && durationSec > 0 && segDuration >= durationSec * 0.8) {
      return "whole_audio";
    }
    // 1セグメントだが明確に短区間タイムスタンプの場合は segment
    return "segment";
  }

  return "segment";
}

/**
 * Multi-ASR Transcription Orchestration を実行する
 */
export async function runMultiAsrOrchestration(
  options: MultiAsrOrchestratorOptions
): Promise<MultiAsrOrchestrationResult> {
  const {
    mediaPath,
    mediaFileName,
    expectedDurationSec,
    engines,
    anchorEngineId,
    dictionary,
    context,
    mode,
    chunkSize,
    synthesisProvider,
    isCancelled,
    isCurrentRun,
    onProgress,
  } = options;

  // 1. 基本パラメータ事前検証
  if (!mediaPath || typeof mediaPath !== "string" || !mediaPath.trim()) {
    return {
      status: "failed",
      error: "mediaPath is required and cannot be empty or whitespace-only.",
      engineRecords: [],
    };
  }

  if (!mediaFileName || typeof mediaFileName !== "string" || !mediaFileName.trim()) {
    return {
      status: "failed",
      error: "mediaFileName is required and cannot be empty or whitespace-only.",
      engineRecords: [],
    };
  }

  if (
    typeof expectedDurationSec !== "number" ||
    !Number.isFinite(expectedDurationSec) ||
    expectedDurationSec <= 0
  ) {
    return {
      status: "failed",
      error: `expectedDurationSec must be a finite positive number, got: ${expectedDurationSec}`,
      engineRecords: [],
    };
  }

  if (!Array.isArray(engines) || engines.length === 0) {
    return {
      status: "failed",
      error: "No engines configured for multi-ASR orchestration.",
      engineRecords: [],
    };
  }

  // 重複 engineId 検証
  const seenEngineIds = new Set<string>();
  for (const engine of engines) {
    if (!engine.engineId || typeof engine.engineId !== "string" || !engine.engineId.trim()) {
      return {
        status: "failed",
        error: "Engine spec has missing or empty engineId.",
        engineRecords: [],
      };
    }
    if (seenEngineIds.has(engine.engineId)) {
      return {
        status: "failed",
        error: `Duplicate engine ID found in engine specs: "${engine.engineId}".`,
        engineRecords: [],
      };
    }
    seenEngineIds.add(engine.engineId);
  }

  // 早期キャンセル・Stale確認 (stale優先)
  if (isCurrentRun && !isCurrentRun()) {
    return { status: "stale" };
  }
  if (isCancelled?.()) {
    return { status: "cancelled" };
  }

  const engineRecords: EngineExecutionRecord[] = [];
  const successfulResults: Record<string, EngineTranscriptResult> = {};
  const totalEngines = engines.length;

  // 2. ASRエンジン逐次実行 (GPU/VRAM保護のため並列実行は厳禁)
  for (let i = 0; i < totalEngines; i++) {
    const engine = engines[i];

    if (isCurrentRun && !isCurrentRun()) {
      return { status: "stale" };
    }
    if (isCancelled?.()) {
      return { status: "cancelled" };
    }

    onProgress?.({
      phase: "transcribing",
      currentEngineId: engine.engineId,
      engineIndex: i,
      totalEngines,
      percent: Math.round((i / totalEngines) * 70),
      message: `Running transcription with ${engine.displayName}...`,
    });

    try {
      const doc = await engine.runTranscription(mediaPath, { isCancelled });

      // catch後のcancel / stale確認
      if (isCurrentRun && !isCurrentRun()) {
        return { status: "stale" };
      }
      if (isCancelled?.()) {
        return { status: "cancelled" };
      }

      const docDuration = expectedDurationSec;
      const timingGranularity =
        engine.timingGranularity || deriveTimingGranularity(doc, docDuration);

      const engineResult: EngineTranscriptResult = {
        engineId: engine.engineId,
        displayName: engine.displayName,
        document: doc,
        durationSec: docDuration,
        completedAt: new Date().toISOString(),
        timingGranularity,
      };

      successfulResults[engine.engineId] = engineResult;
      engineRecords.push({
        engineId: engine.engineId,
        displayName: engine.displayName,
        status: "success",
        durationSec: docDuration,
        timingGranularity,
      });
    } catch (err: any) {
      // エラー発生時のcancel / stale確認
      if (isCurrentRun && !isCurrentRun()) {
        return { status: "stale" };
      }
      if (isCancelled?.()) {
        return { status: "cancelled" };
      }

      const errorMessage =
        err instanceof Error ? err.message : String(err || "Unknown transcription error");

      engineRecords.push({
        engineId: engine.engineId,
        displayName: engine.displayName,
        status: "failed",
        error: errorMessage,
      });
    }
  }

  // 3. 実行後キャンセル・Stale確認
  if (isCurrentRun && !isCurrentRun()) {
    return { status: "stale" };
  }
  if (isCancelled?.()) {
    return { status: "cancelled" };
  }

  const successEngineIds = Object.keys(successfulResults);

  // 全ASRエンジン失敗
  if (successEngineIds.length === 0) {
    return {
      status: "failed",
      error: "All ASR engines failed during transcription.",
      engineRecords,
    };
  }

  // 4. Session Anchor の安全な初期選択 (MultiEngineSession invariant 保証)
  // sessionAnchorEngineId は必ず successfulResults に存在する engineId を設定
  const defaultSessionAnchorId =
    anchorEngineId && successfulResults[anchorEngineId]
      ? anchorEngineId
      : successEngineIds[0];

  const session: MultiEngineSession = {
    sessionId: `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    mediaPath,
    mediaFileName,
    expectedDurationSec,
    anchorEngineId: defaultSessionAnchorId,
    results: successfulResults,
    createdAt: new Date().toISOString(),
  };

  // Session の厳格バリデーション (Source of Truth)
  const sessionValidation = validateMultiEngineSession(session);
  if (!sessionValidation.valid) {
    return {
      status: "failed",
      error: `MultiEngineSession validation failed: ${sessionValidation.errors.join("; ")}`,
      engineRecords,
    };
  }

  // 5. 1台のみ成功の場合
  if (successEngineIds.length === 1) {
    return {
      status: "partial_asr_only",
      reason: "single_engine_only",
      session,
      engineRecords,
    };
  }

  // 6. 2台以上成功時の Temporal Anchor 解決
  let temporalAnchorEngineId: string | null = null;

  if (anchorEngineId) {
    // ユーザー明示指定がある場合: 指定エンジンが未成功または segment 粒度でない場合は自動フォールバックしない
    const specifiedResult = successfulResults[anchorEngineId];
    if (specifiedResult && specifiedResult.timingGranularity === "segment") {
      temporalAnchorEngineId = anchorEngineId;
    }
  } else {
    // 未指定時の自動選択: timingGranularity === "segment" を持つ成功エンジンから選択
    const segmentCandidates = engines.filter(
      (e) =>
        successfulResults[e.engineId] &&
        successfulResults[e.engineId].timingGranularity === "segment"
    );

    if (segmentCandidates.length > 0) {
      // preferredAnchorPriority 降順、配列定義順を維持してソート
      const sorted = [...segmentCandidates].sort((a, b) => {
        const priorityA = a.preferredAnchorPriority ?? 0;
        const priorityB = b.preferredAnchorPriority ?? 0;
        if (priorityB !== priorityA) {
          return priorityB - priorityA;
        }
        return engines.indexOf(a) - engines.indexOf(b);
      });

      temporalAnchorEngineId = sorted[0].engineId;
    }
  }

  // segment 粒度を持つ有効な Temporal Anchor が存在しない場合
  if (!temporalAnchorEngineId) {
    return {
      status: "partial_asr_only",
      reason: "no_segment_timing_anchor",
      session,
      engineRecords,
    };
  }

  // Temporal Anchor を Session に反映
  if (session.anchorEngineId !== temporalAnchorEngineId) {
    session.anchorEngineId = temporalAnchorEngineId;
  }

  // 7. Temporal Alignment
  onProgress?.({
    phase: "aligning",
    percent: 75,
    message: "Aligning multi-engine transcripts...",
  });

  const alignment = alignMultiEngineSession(session);

  // Candidates 総数カウント
  const totalCandidates = alignment.groups.reduce(
    (sum, g) => sum + g.candidates.length,
    0
  );

  if (totalCandidates === 0) {
    return {
      status: "partial_asr_only",
      reason: "no_aligned_candidates",
      session,
      engineRecords,
    };
  }

  // 8. LLM Synthesis 実行
  if (isCurrentRun && !isCurrentRun()) {
    return { status: "stale" };
  }
  if (isCancelled?.()) {
    return { status: "cancelled" };
  }

  onProgress?.({
    phase: "synthesizing",
    percent: 80,
    message: "Running multi-ASR LLM synthesis...",
  });

  // StaleまたはCancelで後続LLMチャンク通信を即座に停止する合成Predicate
  const shouldStopSynthesis = () =>
    (isCancelled?.() ?? false) || !(isCurrentRun?.() ?? true);

  const synthesisOptions: SynthesisRunOptions = {
    alignment,
    dictionary,
    context,
    mode,
    chunkSize,
    provider: synthesisProvider,
    isCancelled: shouldStopSynthesis,
    onProgress: (prog) => {
      onProgress?.({
        phase: "synthesizing",
        percent: 80 + Math.round(prog.percentage * 0.2),
        message: prog.phase,
      });
    },
  };

  let synthesisResult: SynthesisRunResult;
  try {
    synthesisResult = await runSynthesisForAlignment(synthesisOptions);
  } catch (err: any) {
    if (isCurrentRun && !isCurrentRun()) {
      return { status: "stale" };
    }
    if (isCancelled?.()) {
      return { status: "cancelled" };
    }

    const errorMessage =
      err instanceof Error ? err.message : String(err || "Synthesis execution failed");

    return {
      status: "failed",
      error: `Synthesis execution failed: ${errorMessage}`,
      engineRecords,
    };
  }

  if (synthesisResult.status === "cancelled") {
    if (isCurrentRun && !isCurrentRun()) {
      return { status: "stale" };
    }
    if (isCancelled?.()) {
      return { status: "cancelled" };
    }
    return { status: "cancelled" };
  }

  if (isCurrentRun && !isCurrentRun()) {
    return { status: "stale" };
  }
  if (isCancelled?.()) {
    return { status: "cancelled" };
  }

  return {
    status: "success",
    staging: {
      session,
      alignment,
      proposals: synthesisResult.proposals,
      engineRecords,
    },
  };
}
