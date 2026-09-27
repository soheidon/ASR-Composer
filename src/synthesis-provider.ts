import type {
  SynthesisBatchRequest,
  ParsedSynthesisProposalCandidate,
  SynthesisTargetItem,
} from "./synthesis";
import { parseRawSynthesisCandidates } from "./synthesis";
import {
  type CorrectionDictionaryEntry,
  type CorrectionContext,
  type CorrectionMode,
  DEFAULT_CORRECTION_MODE,
} from "./correction";
import type { TranscriptSegment } from "./transcript";

export const DEFAULT_NUM_PREDICT = 1024;

/**
 * Tauri invoke ラッパー型
 */
export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

let globalInvokeFn: InvokeFn | null = null;

export function setSynthesisTauriInvokeForTest(fn: InvokeFn | null): void {
  globalInvokeFn = fn;
}

/**
 * 統合補正プロバイダー抽象インターフェース (1バッチ通信のみ担当)
 */
export interface SynthesisProvider {
  synthesize(batchRequest: SynthesisBatchRequest): Promise<ParsedSynthesisProposalCandidate[]>;
}

export interface OllamaSynthesisProviderConfig {
  baseUrl?: string;
  model?: string;
  timeoutSecs?: number;
  numPredict?: number;
  think?: boolean;
  temperature?: number;
  invokeTauri?: InvokeFn;
}

/**
 * Ollama Structured Outputs (JSON Schema) for Multi-ASR Synthesis
 */
export const OLLAMA_SYNTHESIS_SCHEMA = {
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
 * Multi-ASR 統合補正用システムプロンプトを構築する（Pure Function）
 */
export function buildSynthesisSystemPrompt(mode: CorrectionMode = DEFAULT_CORRECTION_MODE): string {
  const modeDirectives: Record<CorrectionMode, string> = {
    minimal: `【補正モード: 最小修正 (minimal)】
- 目的: 原文の構造・口語性を完全に維持し、明白なASR誤認識・固有名詞・専門用語・用語辞書合致語句のみを最小限修正します。
- 許可: 明白なASR誤変換、固有名詞、専門用語、用語辞書に基づく正式表記への訂正、最低限の句読点。
- 禁止: 言い換え、助詞の補完、フィラーの削除、文の再構成、文体改善。他候補と対立して確証がない場合はAnchorを維持。`,

    standard: `【補正モード: 標準 (standard)】
- 目的: 意味と口語表現を忠実に維持しながら、他ASR候補の一致状況や前後文脈から確実性の高い誤認識を訂正します。
- 許可: 最小修正の全内容、複数ASR候補の証拠に基づく高確度な誤認補正、同音異義語・表記ゆれの是正、自然な句読点。
- 禁止: 要約、発話外の情報の追加、積極的な書き換え、不要なフィラー削除。`,

    aggressive: `【補正モード: 積極修正 (aggressive)】
- 目的: 発話内容そのものを維持しながら、他ASR候補の情報を参照して助詞の脱落や言い直し・重複を整理します。
- 許可: 標準の全内容、明白な助詞脱落の補正、重複・言い直しの整理、明白なフィラーの整理、軽微な語順整理。
- 禁止: 新事実の生成、要約、発話外の内容補完、専門的推論による加筆、敬体/常体の全面変換。`,
  };

  const directive = modeDirectives[mode] || modeDirectives.standard;

  return `あなたは音声認識（Multi-ASR）統合補正エンジンです。
基準となる【Anchor Baseline（編集対象の正本）】と、同一時間帯に対応付けられた【時間整列ASR候補（Aligned Candidates）】を比較し、Anchorの音声認識誤りを補正してください。

${directive}

【権威性階層 (Authority Hierarchy)】
■ 発話内容の根拠:
1. Anchor Baseline (Primary Canonical Baseline): 発話内容の編集対象・比較基準。
2. 時間整列ASR候補 (Aligned Candidates): 同一発話を別エンジンが認識した補助証拠。
3. 前後文脈 (Context Before / After): 会話の流れの理解のみ（補正対象外）。

■ 表記・用語の根拠:
1. 用語辞書 (dictionary): 正式表記・固有名詞の強い補助根拠（ただし発話にない語の無差別挿入は禁止）。
2. 時間整列ASR候補 (Aligned Candidates): 表記ゆれや漢字変換の補助証拠。
3. 背景情報 / 話者メモ (background / speakerNotes): 専門分野・文脈理解のための弱い補助（発話外情報の追加は厳禁）。

【Global Safety Rules（全モード共通・厳格遵守）】
1. 発話内容の忠実維持: 発話に存在しない新事実・情報・推測を追加しないでください（創作・捏造・ハルシネーションの厳禁）。
2. 複数ASR候補の扱い: 複数エンジンが同一の誤認識をしている可能性もあります。候補が互いに矛盾・分裂している場合は無理に修正せず Anchor Baseline を維持（No-change）してください。
3. セグメント構造の維持: セグメントの結合・分割・ID変更を行わず、入力された segmentId と 1:1 で対応する proposal を出力してください。
4. 参照コンテキストの保護: 【参照コンテキスト (Reference Context)】のセグメントは文脈理解のためだけに参照し、絶対に proposal を出力しないでください。
5. 変更がない場合の原則: 修正が不要または確証がないセグメントについては、proposal を出力しないでください（proposal なしが正常な判断です）。`;
}

/**
 * Multi-ASR 統合補正用ユーザープロンプトを構築する（Pure Function）
 */
export function buildSynthesisUserPrompt(
  targets: SynthesisTargetItem[],
  contextBefore?: TranscriptSegment[],
  contextAfter?: TranscriptSegment[],
  dictionary?: CorrectionDictionaryEntry[],
  context?: CorrectionContext
): string {
  const parts: string[] = [];

  // 1. 用語辞書
  if (dictionary && dictionary.length > 0) {
    parts.push("【用語辞書 (dictionary)】");
    dictionary.forEach((entry) => {
      let line = `- 正式表記: 「${entry.canonical}」`;
      if (entry.variants.length > 0) {
        line += ` (別表記・誤認例: ${entry.variants.map((v) => `「${v}」`).join(", ")})`;
      }
      if (entry.category) {
        line += ` [分類: ${entry.category}]`;
      }
      if (entry.note) {
        line += ` ※ ${entry.note}`;
      }
      parts.push(line);
    });
    parts.push("");
  }

  // 2. 背景情報・話者メモ
  if (context && (context.backgroundText || context.speakerNotes)) {
    parts.push("【背景情報 (background) ※文脈理解のための弱い参考情報】");
    if (context.backgroundText) {
      parts.push(`- 全体背景: ${context.backgroundText}`);
    }
    if (context.speakerNotes && Object.keys(context.speakerNotes).length > 0) {
      parts.push("- 話者情報:");
      for (const [spk, note] of Object.entries(context.speakerNotes)) {
        parts.push(`  * ${spk}: ${note}`);
      }
    }
    parts.push("");
  }

  // 3. 前方参照コンテキスト
  if (contextBefore && contextBefore.length > 0) {
    parts.push("【参照コンテキスト (直前の発話・補正対象外)】");
    contextBefore.forEach((seg) => {
      parts.push(`[${seg.id}] (${seg.speaker}): ${seg.text}`);
    });
    parts.push("");
  }

  // 4. 補正対象セグメントと他ASR候補
  parts.push("【補正対象セグメント (Target Segments)】");
  targets.forEach((target) => {
    parts.push(`--- Segment [${target.segmentId}] (${target.start.toFixed(2)}s - ${target.end.toFixed(2)}s) ---`);
    parts.push(`Anchor Baseline [${target.engineId}]: 「${target.text}」`);

    if (target.candidates.length > 0) {
      parts.push("時間整列ASR候補:");
      target.candidates.forEach((cand, idx) => {
        parts.push(
          `  (${idx + 1}) [${cand.engineId} / seg:${cand.sourceSegmentId}] (重なり:${cand.overlapDurationSec.toFixed(2)}s, カバー率:${Math.round(cand.anchorCoverage * 100)}%): 「${cand.text}」`
        );
      });
    }

    if (target.agreement && target.agreement.hasConsensus) {
      const consensusDescs = target.agreement.consensusGroups.map(
        (g) => `「${g.rawTexts.join(" / ")}」 (一致エンジン: ${g.engineIds.join(", ")})`
      );
      parts.push(`  * 一致サマリー: ${consensusDescs.join("; ")}`);
    }
  });

  // 5. 後方参照コンテキスト
  if (contextAfter && contextAfter.length > 0) {
    parts.push("");
    parts.push("【参照コンテキスト (直後の発話・補正対象外)】");
    contextAfter.forEach((seg) => {
      parts.push(`[${seg.id}] (${seg.speaker}): ${seg.text}`);
    });
  }

  return parts.join("\n");
}

/**
 * Ollama をバックエンドとする Multi-ASR 統合補正プロバイダー
 */
export class OllamaSynthesisProvider implements SynthesisProvider {
  private baseUrl: string;
  private model: string;
  private timeoutSecs: number;
  private numPredict: number;
  private think: boolean;
  private temperature: number;
  private invokeTauriFn?: InvokeFn;

  constructor(config: OllamaSynthesisProviderConfig = {}) {
    this.baseUrl = config.baseUrl || "http://localhost:11434";
    this.model = config.model || "qwen2.5:7b-instruct";
    this.timeoutSecs = config.timeoutSecs || 120;
    this.numPredict = config.numPredict ?? DEFAULT_NUM_PREDICT;
    this.think = config.think ?? false;
    this.temperature = config.temperature ?? 0;
    this.invokeTauriFn = config.invokeTauri;
  }

  private async callTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    if (this.invokeTauriFn) {
      return this.invokeTauriFn<T>(cmd, args);
    }
    if (globalInvokeFn) {
      return globalInvokeFn<T>(cmd, args);
    }
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<T>(cmd, args);
    }
    throw new Error("この操作はTauriアプリ内でのみ利用できます");
  }

  async synthesize(batchRequest: SynthesisBatchRequest): Promise<ParsedSynthesisProposalCandidate[]> {
    if (batchRequest.targets.length === 0) {
      return [];
    }

    const systemPrompt = buildSynthesisSystemPrompt(batchRequest.mode);
    const userPrompt = buildSynthesisUserPrompt(
      batchRequest.targets,
      batchRequest.contextBefore,
      batchRequest.contextAfter,
      batchRequest.dictionary,
      batchRequest.context
    );

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    let rawResponse: unknown;
    try {
      rawResponse = await this.callTauri<unknown>("call_ollama_chat", {
        input: {
          baseUrl: this.baseUrl,
          model: this.model,
          messages,
          format: OLLAMA_SYNTHESIS_SCHEMA,
          options: {
            temperature: this.temperature,
            num_predict: this.numPredict,
          },
          think: this.think,
          timeoutSecs: this.timeoutSecs,
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Ollama API error: ${msg}`);
    }

    let contentStr: string;
    if (typeof rawResponse === "object" && rawResponse !== null) {
      const respObj = rawResponse as Record<string, unknown>;
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

    let responseObj: unknown;
    try {
      responseObj = JSON.parse(contentStr);
    } catch {
      throw new Error("Ollama returned malformed JSON");
    }

    const candidates = parseRawSynthesisCandidates(responseObj);
    if (!candidates) {
      throw new Error("Ollama payload did not match strict SynthesisProposal schema");
    }

    return candidates;
  }
}
