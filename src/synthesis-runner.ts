import type { MultiEngineAlignmentResult, AlignedSegmentGroup } from "./multi-asr";
import {
  type SynthesisBatchRequest,
  type SynthesisTargetItem,
  type SynthesisCandidate,
  type SynthesisProposal,
  DEFAULT_SYNTHESIS_CHUNK_SIZE,
  SYNTHESIS_CONTEXT_BEFORE,
  SYNTHESIS_CONTEXT_AFTER,
  computeAgreementSummary,
  validateSynthesisCandidate,
  promoteCandidateToSynthesisProposal,
} from "./synthesis";
import type { SynthesisProvider } from "./synthesis-provider";
import { OllamaSynthesisProvider } from "./synthesis-provider";
import {
  type CorrectionDictionaryEntry,
  type CorrectionContext,
  type CorrectionMode,
  type CorrectionProgressCallback,
  DEFAULT_CORRECTION_MODE,
  createCorrectionProgress,
  cloneTranscriptDocument,
} from "./correction";

/**
 * 統合補正実行結果の Discriminated Union
 */
export type SynthesisRunResult =
  | {
      status: "success";
      proposals: SynthesisProposal[];
    }
  | {
      status: "cancelled";
    };

/**
 * 統合補正実行オプション
 */
export interface SynthesisRunOptions {
  alignment: MultiEngineAlignmentResult;
  dictionary?: CorrectionDictionaryEntry[];
  context?: CorrectionContext;
  mode?: CorrectionMode;
  chunkSize?: number;
  provider?: SynthesisProvider;
  onProgress?: CorrectionProgressCallback;
  isCancelled?: () => boolean;
}

interface PreparedBatch {
  batchIndex: number;
  batchRequest: SynthesisBatchRequest;
  windowGroupIndices: { start: number; end: number };
  targetGroups: AlignedSegmentGroup[];
}

/**
 * Multi-ASR アライメント結果に対する統合補正を実行する（Execution Layer）
 */
export async function runSynthesisForAlignment(
  options: SynthesisRunOptions
): Promise<SynthesisRunResult> {
  const {
    alignment,
    dictionary,
    context,
    mode = DEFAULT_CORRECTION_MODE,
    chunkSize = DEFAULT_SYNTHESIS_CHUNK_SIZE,
    provider = new OllamaSynthesisProvider(),
    onProgress,
    isCancelled,
  } = options;

  // chunkSize 検証 (有限の正の整数であることを必須とする)
  if (
    typeof chunkSize !== "number" ||
    !Number.isFinite(chunkSize) ||
    !Number.isInteger(chunkSize) ||
    chunkSize <= 0
  ) {
    throw new Error(`無効な chunkSize です: ${chunkSize}。1以上の有限の整数を指定してください。`);
  }

  // 初期キャンセルチェック
  if (isCancelled && isCancelled()) {
    return { status: "cancelled" };
  }

  const allGroups = alignment.groups || [];
  if (allGroups.length === 0) {
    if (onProgress) {
      onProgress(
        createCorrectionProgress({
          phase: "completed",
          completedChunks: 0,
          totalChunks: 0,
          completedSegments: 0,
          totalSegments: 0,
        })
      );
    }
    return { status: "success", proposals: [] };
  }

  // 1. Anchor時系列全体の配列を連続ウィンドウ（contiguous windows）へ分割
  const preparedBatches: PreparedBatch[] = [];
  const totalWindowCount = Math.ceil(allGroups.length / chunkSize);

  for (let w = 0; w < totalWindowCount; w++) {
    const startIdx = w * chunkSize;
    const endIdx = Math.min(startIdx + chunkSize, allGroups.length);
    const windowGroups = allGroups.slice(startIdx, endIdx);

    // Context Extraction (full sequence から抽出)
    const contextBeforeStart = Math.max(0, startIdx - SYNTHESIS_CONTEXT_BEFORE);
    const contextBefore =
      startIdx > 0
        ? allGroups
            .slice(contextBeforeStart, startIdx)
            .map((g) => cloneTranscriptDocument(g.anchorSegment))
        : undefined;

    const contextAfterEnd = Math.min(allGroups.length, endIdx + SYNTHESIS_CONTEXT_AFTER);
    const contextAfter =
      endIdx < allGroups.length
        ? allGroups
            .slice(endIdx, contextAfterEnd)
            .map((g) => cloneTranscriptDocument(g.anchorSegment))
        : undefined;

    // ウィンドウ内で candidates.length >= 1 のグループのみ targets 化
    const targetGroups: AlignedSegmentGroup[] = [];
    const targets: SynthesisTargetItem[] = [];

    for (const grp of windowGroups) {
      if (grp.candidates && grp.candidates.length > 0) {
        targetGroups.push(grp);

        const synthCandidates: SynthesisCandidate[] = grp.candidates.map((c) => ({
          engineId: c.engineId,
          sourceSegmentId: c.sourceSegmentId,
          text: c.text,
          overlapDurationSec: c.metrics.overlapDurationSec,
          anchorCoverage: c.metrics.anchorCoverage,
          candidateCoverage: c.metrics.candidateCoverage,
          iou: c.metrics.iou,
        }));

        const agreement = computeAgreementSummary(
          alignment.anchorEngineId,
          grp.anchorSegment.text,
          synthCandidates
        );

        targets.push({
          segmentId: grp.anchorSegment.id,
          text: grp.anchorSegment.text,
          start: grp.anchorSegment.start,
          end: grp.anchorSegment.end,
          engineId: alignment.anchorEngineId,
          candidates: synthCandidates,
          agreement,
        });
      }
    }

    // candidate が 1 件以上あるウィンドウのみ実行バッチとして登録
    if (targets.length > 0) {
      preparedBatches.push({
        batchIndex: preparedBatches.length + 1,
        batchRequest: {
          anchorEngineId: alignment.anchorEngineId,
          targets,
          contextBefore,
          contextAfter,
          dictionary: dictionary ? cloneTranscriptDocument(dictionary) : undefined,
          context: context ? cloneTranscriptDocument(context) : undefined,
          mode,
        },
        windowGroupIndices: { start: startIdx + 1, end: endIdx },
        targetGroups,
      });
    }
  }

  // 送信対象バッチが 0 件の場合（全セグメントで candidate 0 件）
  if (preparedBatches.length === 0) {
    if (onProgress) {
      onProgress(
        createCorrectionProgress({
          phase: "completed",
          completedChunks: 0,
          totalChunks: 0,
          completedSegments: 0,
          totalSegments: 0,
        })
      );
    }
    return { status: "success", proposals: [] };
  }

  const totalChunks = preparedBatches.length;
  const totalTargetSegments = preparedBatches.reduce(
    (sum, b) => sum + b.batchRequest.targets.length,
    0
  );

  // 初期進捗通知 (starting)
  if (onProgress) {
    onProgress(
      createCorrectionProgress({
        phase: "starting",
        completedChunks: 0,
        totalChunks,
        completedSegments: 0,
        totalSegments: totalTargetSegments,
      })
    );
  }

  let completedSegments = 0;
  let completedChunks = 0;
  const allProposals: SynthesisProposal[] = [];

  for (let i = 0; i < preparedBatches.length; i++) {
    // チャンク前キャンセルチェック
    if (isCancelled && isCancelled()) {
      return { status: "cancelled" };
    }

    const batch = preparedBatches[i];
    const currentChunkNumber = i + 1;

    if (onProgress) {
      onProgress(
        createCorrectionProgress({
          phase: "running",
          currentChunk: currentChunkNumber,
          completedChunks,
          totalChunks,
          completedSegments,
          totalSegments: totalTargetSegments,
          segmentStart: batch.windowGroupIndices.start,
          segmentEnd: batch.windowGroupIndices.end,
        })
      );
    }

    let rawCandidates;
    try {
      rawCandidates = await provider.synthesize(batch.batchRequest);
    } catch (err: unknown) {
      // プロバイダー例外時もキャンセルなら cancelled を返す
      if (isCancelled && isCancelled()) {
        return { status: "cancelled" };
      }
      throw err;
    }

    // チャンク後キャンセルチェック
    if (isCancelled && isCancelled()) {
      return { status: "cancelled" };
    }

    // バリデーション & 昇格
    const allowedTargetSegmentIds = new Set(
      batch.batchRequest.targets.map((t) => t.segmentId)
    );
    const targetItemMap = new Map(
      batch.batchRequest.targets.map((t) => [t.segmentId, t])
    );
    const targetGroupMap = new Map(
      batch.targetGroups.map((g) => [g.anchorSegment.id, g.anchorSegment])
    );

    for (const cand of rawCandidates) {
      const anchorSeg = targetGroupMap.get(cand.segmentId);
      const targetItem = targetItemMap.get(cand.segmentId);

      if (!anchorSeg || !targetItem) {
        // TARGET_SEGMENT_MISMATCH または未知セグメントは安全にスキップ
        continue;
      }

      const validation = validateSynthesisCandidate(
        cand,
        anchorSeg,
        allowedTargetSegmentIds
      );

      if (validation.valid) {
        const proposal = promoteCandidateToSynthesisProposal(
          cand,
          alignment.anchorEngineId,
          targetItem
        );
        allProposals.push(proposal);
      }
    }

    completedSegments += batch.batchRequest.targets.length;
    completedChunks += 1;
  }

  // 最終進捗通知 (completed)
  if (onProgress) {
    onProgress(
      createCorrectionProgress({
        phase: "completed",
        completedChunks,
        totalChunks,
        completedSegments: totalTargetSegments,
        totalSegments: totalTargetSegments,
      })
    );
  }

  return {
    status: "success",
    proposals: allProposals,
  };
}
