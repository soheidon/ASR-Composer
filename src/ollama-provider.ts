import {
  type CorrectionProposal,
  type CorrectionProvider,
  type CorrectionRequest,
  type CorrectionDictionaryEntry,
  type CorrectionContext,
  parseRawProposalCandidates,
  validateProposalCandidate,
  promoteCandidateToProposal,
} from "./correction";
import type { TranscriptSegment } from "./transcript";

export const CHUNK_SIZE = 15;
export const CONTEXT_BEFORE = 2;
export const CONTEXT_AFTER = 2;

/**
 * Ollama Structured Outputs (JSON Schema)
 */
export const OLLAMA_PROPOSAL_SCHEMA = {
  type: "object",
  properties: {
    proposals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          segmentId: { type: "string" },
          originalText: { type: "string" },
          correctedText: { type: "string" },
          evidence: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["dictionary", "background", "context"] },
                sourceId: { type: "string" },
                description: { type: "string" },
              },
              required: ["type"],
              additionalProperties: false,
            },
          },
          explanation: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["segmentId", "originalText", "correctedText", "evidence", "explanation"],
        additionalProperties: false,
      },
    },
  },
  required: ["proposals"],
  additionalProperties: false,
};

/**
 * ASR誤認識補正専用システムプロンプト
 */
export const OLLAMA_CORRECTION_SYSTEM_PROMPT = `あなたは音声認識（ASR）誤認識補正エンジンです。
【対象セグメント (Target Segments)】のテキストに含まれる明らかな音声認識の誤り（同音異義語、固有名詞、専門用語の聞き間違い）のみを補正してください。

【厳格な規則】
1. 【参照コンテキスト (Reference Context)】のセグメントは前後の文脈理解のためだけに参照し、絶対に補正提案（proposals）を出力しないでください。
2. 要約、文体改善、言い換え、敬体/常体の統一は行わないでください。
3. 情報を追加・削除せず、創作しないでください。
4. 確実な根拠がない場合は proposal を出力しないでください。

【根拠 (evidence)】
- dictionary: 用語辞書に合致する表記
- background: 背景情報・登壇者メモに合致する表記
- context: 前後文脈から明らかな誤認識

指定された JSON Schema に従った JSON オブジェクトのみを出力してください。`;

/**
 * チャンク単位のユーザープロンプトを構築する
 */
export function buildChunkUserPrompt(
  targetSegments: TranscriptSegment[],
  contextBefore: TranscriptSegment[],
  contextAfter: TranscriptSegment[],
  dictionary?: CorrectionDictionaryEntry[],
  context?: CorrectionContext
): string {
  const parts: string[] = [];

  if (dictionary && dictionary.length > 0) {
    parts.push("【用語辞書】");
    for (const entry of dictionary) {
      const vars = entry.variants.length > 0 ? ` (誤読/表記ゆれ: ${entry.variants.join(", ")})` : "";
      const note = entry.note ? ` [注記: ${entry.note}]` : "";
      parts.push(`- 正式表記: ${entry.canonical}${vars}${note}`);
    }
    parts.push("");
  }

  if (context && context.backgroundText.trim().length > 0) {
    parts.push("【背景情報】");
    parts.push(context.backgroundText.trim());
    if (context.speakerNotes && Object.keys(context.speakerNotes).length > 0) {
      parts.push("【話者情報】");
      for (const [speaker, note] of Object.entries(context.speakerNotes)) {
        parts.push(`- ${speaker}: ${note}`);
      }
    }
    parts.push("");
  }

  if (contextBefore.length > 0) {
    parts.push("【参照コンテキスト（前・補正対象外）】");
    for (const seg of contextBefore) {
      const speaker = seg.speaker ? ` [${seg.speaker}]` : "";
      parts.push(`- (ID: ${seg.id})${speaker} ${seg.text}`);
    }
    parts.push("");
  }

  parts.push("【対象セグメント（補正対象）】");
  for (const seg of targetSegments) {
    const speaker = seg.speaker ? ` [${seg.speaker}]` : "";
    parts.push(`- (ID: ${seg.id})${speaker} ${seg.text}`);
  }
  parts.push("");

  if (contextAfter.length > 0) {
    parts.push("【参照コンテキスト（後・補正対象外）】");
    for (const seg of contextAfter) {
      const speaker = seg.speaker ? ` [${seg.speaker}]` : "";
      parts.push(`- (ID: ${seg.id})${speaker} ${seg.text}`);
    }
    parts.push("");
  }

  return parts.join("\n");
}

export const DEFAULT_NUM_PREDICT = 1024;

export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export interface OllamaCorrectionProviderConfig {
  baseUrl?: string;
  model?: string;
  timeoutSecs?: number;
  numPredict?: number;
  think?: boolean;
  invokeTauri?: InvokeFn;
  idGenerator?: () => string;
  isCancelled?: () => boolean;
}

export class OllamaCorrectionProvider implements CorrectionProvider {
  private baseUrl: string;
  private model: string;
  private timeoutSecs: number;
  private numPredict: number;
  private think: boolean;
  private invokeTauriFn?: InvokeFn;
  private idGenerator: () => string;
  private isCancelledFn?: () => boolean;

  constructor(config: OllamaCorrectionProviderConfig = {}) {
    this.baseUrl = config.baseUrl || "http://localhost:11434";
    this.model = config.model || "qwen2.5:7b";
    this.timeoutSecs = config.timeoutSecs || 120;
    this.numPredict = config.numPredict ?? DEFAULT_NUM_PREDICT;
    this.think = config.think ?? false;
    this.invokeTauriFn = config.invokeTauri;
    this.isCancelledFn = config.isCancelled;
    this.idGenerator =
      config.idGenerator ||
      (() =>
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `prop-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
  }

  private async callTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    if (this.invokeTauriFn) {
      return this.invokeTauriFn<T>(cmd, args);
    }
    const globalTauri = (window as unknown as { __TAURI_INTERNALS__?: { invoke: InvokeFn } })
      ?.__TAURI_INTERNALS__;
    if (globalTauri?.invoke) {
      return globalTauri.invoke<T>(cmd, args);
    }
    throw new Error("Tauri環境が利用できません。");
  }

  async correct(
    request: CorrectionRequest,
    onProgress?: (completed: number, total: number) => void
  ): Promise<CorrectionProposal[]> {
    const segments = request.document.segments;
    if (segments.length === 0) {
      return [];
    }

    const totalChunks = Math.ceil(segments.length / CHUNK_SIZE);
    const allProposals: CorrectionProposal[] = [];
    const allSegmentsMap = new Map(segments.map((s) => [s.id, s]));

    for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
      // チャンク送信前のキャンセル確認
      if (this.isCancelledFn?.()) {
        break;
      }

      const targetStart = chunkIdx * CHUNK_SIZE;
      const targetEnd = Math.min((chunkIdx + 1) * CHUNK_SIZE, segments.length);
      const targetSegments = segments.slice(targetStart, targetEnd);

      const contextBeforeStart = Math.max(0, targetStart - CONTEXT_BEFORE);
      const contextBefore = segments.slice(contextBeforeStart, targetStart);

      const contextAfterEnd = Math.min(segments.length, targetEnd + CONTEXT_AFTER);
      const contextAfter = segments.slice(targetEnd, contextAfterEnd);

      const allowedTargetIds = new Set(targetSegments.map((s) => s.id));

      const userPrompt = buildChunkUserPrompt(
        targetSegments,
        contextBefore,
        contextAfter,
        request.dictionary,
        request.context
      );

      const messages = [
        { role: "system", content: OLLAMA_CORRECTION_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ];

      const rawResponse = await this.callTauri<unknown>("call_ollama_chat", {
        input: {
          baseUrl: this.baseUrl,
          model: this.model,
          messages,
          format: OLLAMA_PROPOSAL_SCHEMA,
          options: {
            temperature: 0,
            num_predict: this.numPredict,
          },
          think: this.think,
          timeoutSecs: this.timeoutSecs,
        },
      });

      // チャンク受信後のキャンセル確認
      if (this.isCancelledFn?.()) {
        break;
      }

      // レスポンスから message.content (string) およびメタデータを安全に抽出
      let contentStr: string;
      let doneReason: string | undefined;
      let evalCount: number | undefined;
      let promptEvalCount: number | undefined;

      if (typeof rawResponse === "object" && rawResponse !== null) {
        const respObj = rawResponse as Record<string, unknown>;
        if (typeof respObj.done_reason === "string") {
          doneReason = respObj.done_reason;
        }
        if (typeof respObj.eval_count === "number") {
          evalCount = respObj.eval_count;
        }
        if (typeof respObj.prompt_eval_count === "number") {
          promptEvalCount = respObj.prompt_eval_count;
        }

        if ("message" in respObj) {
          const msg = (respObj as { message?: { content?: unknown } }).message;
          if (typeof msg?.content === "string") {
            contentStr = msg.content;
          } else {
            throw new Error("Ollamaレスポンスの message.content が文字列ではありません。");
          }
        } else {
          throw new Error("Ollamaレスポンスの形式が不正です。");
        }
      } else if (typeof rawResponse === "string") {
        contentStr = rawResponse;
      } else {
        throw new Error("Ollamaレスポンスの形式が不正です。");
      }

      // デバッグメタデータログ（プライバシー保護のため本文データは出力しない）
      console.debug("[OllamaCorrectionProvider] Chunk response metadata:", {
        chunk: `${chunkIdx + 1}/${totalChunks}`,
        doneReason,
        evalCount,
        promptEvalCount,
        contentLength: contentStr.length,
      });

      // JSON パース & 切断エラー診断
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(contentStr);
      } catch (e) {
        const parseMsg = e instanceof Error ? e.message : String(e);
        if (doneReason === "length") {
          throw new Error(
            `モデル出力が上限に達して途中で切断されました (done_reason: length, eval_count: ${evalCount ?? "unknown"})`
          );
        }
        if (
          parseMsg.includes("Unexpected end of JSON input") ||
          parseMsg.includes("Unexpected end of data") ||
          parseMsg.includes("Unterminated string") ||
          parseMsg.includes("Expected ',' or '}' after property value") ||
          parseMsg.includes("Expected double-quoted property name") ||
          parseMsg.includes("Expected ':' after property name")
        ) {
          throw new Error(
            `JSONが不完全です。出力が途中で切断された可能性があります (done_reason: ${doneReason ?? "unknown"}, eval_count: ${evalCount ?? "unknown"})`
          );
        }
        throw new Error(
          `Ollamaから返却された補正JSONの構文解析に失敗しました: ${parseMsg}`
        );
      }

      // 候補抽出
      const { candidates } = parseRawProposalCandidates(parsedJson);

      // セマンティックバリデーション ＆ 信頼済み提案への昇格
      for (const cand of candidates) {
        const seg = allSegmentsMap.get(cand.segmentId);
        const val = validateProposalCandidate(cand, seg, allowedTargetIds);
        if (val.valid) {
          allProposals.push(promoteCandidateToProposal(cand, this.idGenerator));
        }
      }

      if (onProgress && !this.isCancelledFn?.()) {
        onProgress(chunkIdx + 1, totalChunks);
      }
    }

    return allProposals;
  }
}
