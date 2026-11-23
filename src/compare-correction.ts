import type { TranscriptDocument, TranscriptSegment } from "./transcript";
import type { MultiEngineSession, MultiEngineAlignmentResult } from "./multi-asr";
import type { CorrectionDictionaryEntry, CorrectionContext, CorrectionMode } from "./correction";
import { cloneTranscriptDocument } from "./correction";
import type { InvokeFn } from "./ollama-provider";

export const DEFAULT_COMPARE_CHUNK_SIZE = 15;

export interface ComparePartnerCandidate {
  engineId: string;
  segmentId: string;
  start: number;
  end: number;
  text: string;
}

export interface CompareCorrectionItem {
  segmentId: string;
  start: number;
  end: number;
  speaker: string | null;
  anchorEngineId: string;
  anchorText: string;
  partnerCandidates: ComparePartnerCandidate[];
}

export interface UnalignedPartnerSegment {
  engineId: string;
  segmentId: string;
  start: number;
  end: number;
  text: string;
}

export interface CompareCorrectionInput {
  anchorEngineId: string;
  partnerEngineId: string;
  items: CompareCorrectionItem[];
  unalignedPartnerSegments: UnalignedPartnerSegment[];
  partnerWholeTextWithoutTiming?: string;
}

export interface CompareCorrectionOutputItem {
  segmentId: string;
  correctedText: string;
}

export interface CompareCorrectionBatchRequest {
  anchorEngineId: string;
  partnerEngineId: string;
  targets: CompareCorrectionItem[];
  unalignedPartnerSegments: UnalignedPartnerSegment[];
  partnerWholeTextWithoutTiming?: string;
  dictionary?: CorrectionDictionaryEntry[];
  context?: CorrectionContext;
  mode?: CorrectionMode;
}

export interface CompareCorrectionProvider {
  correctBatch(request: CompareCorrectionBatchRequest): Promise<CompareCorrectionOutputItem[]>;
}

/**
 * Alignment 結果と相手エンジン結果から 2 エンジン比較補正用の入力を構築する。
 */
export function buildCompareCorrectionInput(params: {
  session: MultiEngineSession;
  alignment: MultiEngineAlignmentResult;
  anchorEngineId: string;
  partnerEngineId: string;
}): CompareCorrectionInput {
  const { session, alignment, anchorEngineId, partnerEngineId } = params;
  const anchorDoc = session.results[anchorEngineId]?.document;
  const partnerDoc = session.results[partnerEngineId]?.document;

  const speakerById = new Map<string, string | null>();
  for (const seg of anchorDoc?.segments ?? []) {
    speakerById.set(seg.id, seg.speaker);
  }

  const usedPartnerSegmentIds = new Set<string>();
  const items: CompareCorrectionItem[] = alignment.groups.map((group) => {
    const partnerCandidates: ComparePartnerCandidate[] = group.candidates
      .filter((c) => c.engineId === partnerEngineId)
      .map((c) => {
        usedPartnerSegmentIds.add(c.sourceSegmentId);
        return {
          engineId: c.engineId,
          segmentId: c.sourceSegmentId,
          start: c.timeRange.start,
          end: c.timeRange.end,
          text: c.text,
        };
      });

    return {
      segmentId: group.anchorSegment.id,
      start: group.anchorSegment.start,
      end: group.anchorSegment.end,
      speaker: speakerById.get(group.anchorSegment.id) ?? group.anchorSegment.speaker ?? null,
      anchorEngineId,
      anchorText: group.anchorSegment.text,
      partnerCandidates,
    };
  });

  const unalignedPartnerSegments: UnalignedPartnerSegment[] = (partnerDoc?.segments ?? [])
    .filter((seg) => !usedPartnerSegmentIds.has(seg.id))
    .map((seg) => ({
      engineId: partnerEngineId,
      segmentId: seg.id,
      start: seg.start,
      end: seg.end,
      text: seg.text,
    }));

  const partnerWholeTextWithoutTiming = partnerDoc?.transcriptTextWithoutTiming?.trim()
    ? partnerDoc.transcriptTextWithoutTiming.trim()
    : undefined;

  return {
    anchorEngineId,
    partnerEngineId,
    items,
    unalignedPartnerSegments,
    partnerWholeTextWithoutTiming,
  };
}

/**
 * LLM が返した比較補正出力を検証する（未知ID・重複ID・欠落ID・不正形式を拒否）。
 */
export function validateCompareCorrectionBatchOutput(
  targets: readonly CompareCorrectionItem[],
  outputs: unknown
): CompareCorrectionOutputItem[] {
  if (!Array.isArray(outputs)) {
    throw new Error("LLM比較補正の出力が配列ではありません");
  }
  const expectedIds = new Set(targets.map((t) => t.segmentId));
  const seenIds = new Set<string>();
  const validated: CompareCorrectionOutputItem[] = [];

  for (const item of outputs) {
    if (!item || typeof item !== "object") {
      throw new Error("LLM比較補正の出力要素が不正なオブジェクトです");
    }
    const rec = item as Record<string, unknown>;
    const segmentId = typeof rec.segmentId === "string" ? rec.segmentId : "";
    if (!segmentId || !expectedIds.has(segmentId)) {
      throw new Error(`LLM比較補正が未知の segmentId を返しました: "${segmentId}"`);
    }
    if (seenIds.has(segmentId)) {
      throw new Error(`LLM比較補正が重複した segmentId を返しました: "${segmentId}"`);
    }
    if (typeof rec.correctedText !== "string") {
      throw new Error(`LLM比較補正の correctedText が文字列ではありません (${segmentId})`);
    }
    seenIds.add(segmentId);
    validated.push({
      segmentId,
      correctedText: rec.correctedText,
    });
  }

  for (const expectedId of expectedIds) {
    if (!seenIds.has(expectedId)) {
      throw new Error(`LLM比較補正の出力に必須の segmentId が欠落しています: "${expectedId}"`);
    }
  }

  return validated;
}

const COMPARE_CORRECTION_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    corrections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          segmentId: { type: "string" },
          correctedText: { type: "string" },
        },
        required: ["segmentId", "correctedText"],
        additionalProperties: false,
      },
    },
  },
  required: ["corrections"],
  additionalProperties: false,
};

export class OllamaCompareCorrectionProvider implements CompareCorrectionProvider {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly invokeTauri: InvokeFn;

  constructor(options: { baseUrl: string; model: string; invokeTauri?: InvokeFn }) {
    this.baseUrl = options.baseUrl;
    this.model = options.model;
    this.invokeTauri =
      options.invokeTauri ??
      (async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
        const { invoke } = await import("@tauri-apps/api/core");
        return invoke<T>(cmd, args);
      });
  }

  async correctBatch(request: CompareCorrectionBatchRequest): Promise<CompareCorrectionOutputItem[]> {
    const systemPrompt = [
      "あなたは音声認識結果の比較補正アシスタントです。",
      "2つのASRエンジン（基準エンジンと相手エンジン）の認識結果を比較し、誤認識や変換誤りを補正した日本語/英語テキストを各 segmentId ごとに返してください。",
      "厳守事項:",
      "1. 出力は JSON オブジェクト {\"corrections\": [{\"segmentId\": \"...\", \"correctedText\": \"...\"}]} のみ。",
      "2. 入力 targets に含まれるすべての segmentId を漏れなく、重複なく、そのままの ID で返すこと。",
      "3. タイムスタンプ・話者・segmentId を生成または変更しないこと。",
      "4. 事実や固有名詞を捏造せず、両エンジンの候補と辞書・背景情報を根拠に最も妥当な文言を選ぶこと。",
    ].join("\n");

    const userPayload = {
      anchorEngineId: request.anchorEngineId,
      partnerEngineId: request.partnerEngineId,
      mode: request.mode ?? "standard",
      dictionary: request.dictionary ?? [],
      backgroundContext: request.context?.backgroundText ?? "",
      unalignedPartnerSegments: request.unalignedPartnerSegments,
      partnerWholeTextWithoutTiming: request.partnerWholeTextWithoutTiming,
      targets: request.targets,
    };

    const rawResponse = await this.invokeTauri<{ message?: { content?: string } }>("call_ollama_chat", {
      baseUrl: this.baseUrl,
      model: this.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(userPayload) },
      ],
      format: COMPARE_CORRECTION_RESPONSE_SCHEMA,
    });

    const content = rawResponse?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("LLM比較補正から空の応答が返されました");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      throw new Error(`LLM比較補正の応答JSON解析に失敗しました: ${e}`);
    }

    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as any).corrections)) {
      throw new Error("LLM比較補正の応答に corrections 配列が含まれていません");
    }

    return validateCompareCorrectionBatchOutput(request.targets, (parsed as any).corrections);
  }
}

export type CompareCorrectionRunResult =
  | {
      status: "success";
      input: CompareCorrectionInput;
      corrections: CompareCorrectionOutputItem[];
      finalDocument: TranscriptDocument;
    }
  | {
      status: "cancelled";
    };

/**
 * 2エンジン比較結果に対して LLM 比較補正を実行し、基準時刻・ID・話者を不変のまま最終 TranscriptDocument を生成する。
 */
export async function runCompareCorrection(params: {
  session: MultiEngineSession;
  alignment: MultiEngineAlignmentResult;
  anchorEngineId: string;
  partnerEngineId: string;
  provider: CompareCorrectionProvider;
  dictionary?: CorrectionDictionaryEntry[];
  context?: CorrectionContext;
  mode?: CorrectionMode;
  chunkSize?: number;
  isCancelled?: () => boolean;
}): Promise<CompareCorrectionRunResult> {
  const {
    session,
    alignment,
    anchorEngineId,
    partnerEngineId,
    provider,
    dictionary,
    context,
    mode,
    chunkSize = DEFAULT_COMPARE_CHUNK_SIZE,
    isCancelled,
  } = params;

  const anchorDoc = session.results[anchorEngineId]?.document;
  if (!anchorDoc) {
    throw new Error(`基準エンジン (${anchorEngineId}) の TranscriptDocument が見つかりません`);
  }

  const input = buildCompareCorrectionInput({
    session,
    alignment,
    anchorEngineId,
    partnerEngineId,
  });

  const allCorrections: CompareCorrectionOutputItem[] = [];
  for (let i = 0; i < input.items.length; i += chunkSize) {
    if (isCancelled?.()) {
      return { status: "cancelled" };
    }
    const targets = input.items.slice(i, i + chunkSize);
    const batchOutputs = await provider.correctBatch({
      anchorEngineId,
      partnerEngineId,
      targets,
      unalignedPartnerSegments: i === 0 ? input.unalignedPartnerSegments : [],
      partnerWholeTextWithoutTiming: i === 0 ? input.partnerWholeTextWithoutTiming : undefined,
      dictionary,
      context,
      mode,
    });
    const validated = validateCompareCorrectionBatchOutput(targets, batchOutputs);
    allCorrections.push(...validated);
  }

  if (isCancelled?.()) {
    return { status: "cancelled" };
  }

  const correctionById = new Map<string, string>();
  for (const c of allCorrections) {
    correctionById.set(c.segmentId, c.correctedText);
  }

  const finalDocument = cloneTranscriptDocument(anchorDoc);
  finalDocument.updatedAt = new Date().toISOString();
  finalDocument.segments = finalDocument.segments.map((seg): TranscriptSegment => {
    const corrected = correctionById.get(seg.id);
    if (corrected === undefined) {
      return seg;
    }
    return {
      ...seg,
      text: corrected,
      status: corrected !== seg.originalText ? "edited" : "raw",
    };
  });

  return {
    status: "success",
    input,
    corrections: allCorrections,
    finalDocument,
  };
}
