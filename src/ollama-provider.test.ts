import { describe, it, expect, vi } from "vitest";
import {
  OllamaCorrectionProvider,
  buildChunkUserPrompt,
  buildSystemPrompt,
  OLLAMA_PROPOSAL_SCHEMA,
  OLLAMA_CORRECTION_SYSTEM_PROMPT,
} from "./ollama-provider";
import { createCorrectionRequest } from "./correction";
import type { TranscriptDocument, TranscriptSegment } from "./transcript";

function createDummySegment(id: string, text: string, overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id,
    start: 0.0,
    end: 5.0,
    speaker: "SPEAKER_00",
    originalSpeaker: "SPEAKER_00",
    text,
    originalText: text,
    sourceEngine: "test-engine",
    sourceSegmentId: id,
    sourceRunId: "run-1",
    status: "raw",
    ...overrides,
  };
}

function createDummyDoc(segments: TranscriptSegment[]): TranscriptDocument {
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

describe("OllamaCorrectionProvider", () => {
  describe("buildSystemPrompt & Mode Directives", () => {
    it("minimal: 最小修正ディレクティブを含み、積極修正ディレクティブを含まない", () => {
      const prompt = buildSystemPrompt("minimal");
      expect(prompt).toContain("【補正モード: 最小修正 (minimal)】");
      expect(prompt).toContain("ASRとしての明白な誤認識・固有名詞・専門用語・辞書合致語句のみを最小限修正");
      expect(prompt).not.toContain("【補正モード: 積極修正 (aggressive)】");
    });

    it("standard: 標準補正ディレクティブを含む", () => {
      const prompt = buildSystemPrompt("standard");
      expect(prompt).toContain("【補正モード: 標準 (standard)】");
      expect(prompt).toContain("前後文脈から確実性の高いASR誤認識を訂正");
      expect(prompt).not.toContain("【補正モード: 最小修正 (minimal)】");
    });

    it("aggressive: 積極修正ディレクティブを含む", () => {
      const prompt = buildSystemPrompt("aggressive");
      expect(prompt).toContain("【補正モード: 積極修正 (aggressive)】");
      expect(prompt).toContain("助詞の脱落や言い直し・重複を整理");
      expect(prompt).not.toContain("【補正モード: 最小修正 (minimal)】");
    });

    it("Global Safety Rules & Authority Hierarchy: 全てのモードで厳格に維持される", () => {
      for (const mode of ["minimal", "standard", "aggressive"] as const) {
        const prompt = buildSystemPrompt(mode);
        expect(prompt).toContain("【Global Safety Rules（全モード共通・厳格遵守）】");
        expect(prompt).toContain("発話に存在しない新事実・情報・推測を追加しないでください");
        expect(prompt).toContain("要約・省略の禁止");
        expect(prompt).toContain("セグメント構造の維持");
        expect(prompt).toContain("話し言葉のニュアンス維持");
        expect(prompt).toContain("背景情報（background.txt / 話者メモ）に記載されているだけの事実を発話へ勝手に追加しないでください");
        expect(prompt).toContain("【コンテキストの権威性 (Authority Hierarchy)】");
        expect(prompt).toContain("1. 対象セグメントの原文: 発話内容そのもの（最優先の正本）");
        expect(prompt).toContain("2. 用語辞書 (dictionary): 正式表記を判断する強い補助根拠");
        expect(prompt).toContain("3. 背景情報 (background): 候補選択・専門領域理解のための弱い文脈情報");
        expect(prompt).toContain("4. 参照コンテキスト (context): 前後文脈理解のみ（補正対象外）");
      }
    });
  });

  it("buildChunkUserPrompt: 辞書、背景情報、前後コンテキスト、対象セグメントを明示的権威性とともにフォーマットする", () => {
    const target = [createDummySegment("seg-1", "ターゲット本文")];
    const before = [createDummySegment("seg-0", "前文脈")];
    const after = [createDummySegment("seg-2", "後文脈")];
    const dict = [{ id: "d1", canonical: "アスピリン", variants: ["あすぴりん"], note: "解熱鎮痛剤" }];
    const ctx = {
      backgroundText: "医療系学会議事録",
      speakerNotes: { SPEAKER_00: "医師" },
    };

    const prompt = buildChunkUserPrompt(target, before, after, dict, ctx);
    expect(prompt).toContain("【用語辞書（正式表記の強い補助根拠・背景情報より優先）】");
    expect(prompt).toContain("アスピリン (誤読/表記ゆれ: あすぴりん) [注記: 解熱鎮痛剤]");
    expect(prompt).toContain("【背景情報（文脈理解のみ・発話外の事実追加禁止）】");
    expect(prompt).toContain("医療系学会議事録");
    expect(prompt).toContain("【話者情報】");
    expect(prompt).toContain("- SPEAKER_00: 医師");
    expect(prompt).toContain("【参照コンテキスト（前・補正対象外）】");
    expect(prompt).toContain("(ID: seg-0)");
    expect(prompt).toContain("【対象セグメント（補正対象）】");
    expect(prompt).toContain("(ID: seg-1)");
    expect(prompt).toContain("【参照コンテキスト（後・補正対象外）】");
    expect(prompt).toContain("(ID: seg-2)");
  });

  it("Ollama /api/chat リクエストに stream: false, format schema, options temperature: 0 が指定される", async () => {
    let capturedArgs: any = null;
    const mockInvoke = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "call_ollama_chat") {
        capturedArgs = args;
        return {
          message: {
            role: "assistant",
            content: JSON.stringify({
              proposals: [
                {
                  segmentId: "seg-1",
                  originalText: "誤認識テキスト",
                  correctedText: "正常テキスト",
                  evidence: [{ type: "context", description: "文脈" }],
                  explanation: "誤りの修正",
                },
              ],
            }),
          },
        };
      }
      throw new Error(`Unexpected command: ${cmd}`);
    };

    const provider = new OllamaCorrectionProvider({
      invokeTauri: mockInvoke as any,
      model: "test-model:latest",
    });

    const doc = createDummyDoc([createDummySegment("seg-1", "誤認識テキスト")]);
    const request = createCorrectionRequest(doc);

    const proposals = await provider.correct(request);
    expect(capturedArgs).not.toBeNull();
    expect(capturedArgs.input).toBeDefined();
    // フラット構造のまま渡されていないことを保証
    expect(capturedArgs.model).toBeUndefined();
    expect(capturedArgs.input.baseUrl).toBe("http://localhost:11434");
    expect(capturedArgs.input.model).toBe("test-model:latest");
    expect(capturedArgs.input.format).toEqual(OLLAMA_PROPOSAL_SCHEMA);
    expect(capturedArgs.input.options).toEqual({ temperature: 0, num_predict: 1024 });
    expect(capturedArgs.input.think).toBe(false);
    expect(capturedArgs.input.messages[0].role).toBe("system");
    expect(capturedArgs.input.messages[0].content).toBe(OLLAMA_CORRECTION_SYSTEM_PROMPT);
    expect(capturedArgs.input.timeoutSecs).toBe(120);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].segmentId).toBe("seg-1");
    expect(proposals[0].correctedText).toBe("正常テキスト");
    expect(proposals[0].id).toBeDefined();
  });

  it("numPredict および think のカスタム設定が payload に反映される", async () => {
    let capturedArgs: any = null;
    const mockInvoke = async (_cmd: string, args?: Record<string, unknown>) => {
      capturedArgs = args;
      return {
        done_reason: "stop",
        eval_count: 50,
        prompt_eval_count: 300,
        message: {
          role: "assistant",
          content: JSON.stringify({ proposals: [] }),
        },
      };
    };

    const provider = new OllamaCorrectionProvider({
      invokeTauri: mockInvoke as any,
      numPredict: 512,
      think: false,
    });

    const doc = createDummyDoc([createDummySegment("seg-1", "本文")]);
    await provider.correct(createCorrectionRequest(doc));

    expect(capturedArgs.input.think).toBe(false);
    expect(capturedArgs.input.options.num_predict).toBe(512);
  });

  it("done_reason: length による出力上限到達時は明確な切断診断エラーをスローする", async () => {
    const provider = new OllamaCorrectionProvider({
      invokeTauri: async () => ({
        done_reason: "length",
        eval_count: 4096,
        prompt_eval_count: 392,
        message: {
          role: "assistant",
          content: '{"proposals": [{"segmentId": "seg-1", "correctedText": "途中で切れた',
        },
      }) as any,
    });
    const doc = createDummyDoc([createDummySegment("seg-1", "本文")]);
    await expect(provider.correct(createCorrectionRequest(doc))).rejects.toThrow(
      "モデル出力が上限に達して途中で切断されました (done_reason: length, eval_count: 4096)"
    );
  });

  it("Unexpected end of JSON input (done_reason !== length) 時は不完全JSON/途中切断可能性の診断エラーをスローする", async () => {
    const provider = new OllamaCorrectionProvider({
      invokeTauri: async () => ({
        done_reason: "stop",
        eval_count: 2000,
        prompt_eval_count: 392,
        message: {
          role: "assistant",
          content: '{"proposals": [{"segmentId": "seg-1"',
        },
      }) as any,
    });
    const doc = createDummyDoc([createDummySegment("seg-1", "本文")]);
    await expect(provider.correct(createCorrectionRequest(doc))).rejects.toThrow(
      "JSONが不完全です。出力が途中で切断された可能性があります (done_reason: stop, eval_count: 2000)"
    );
  });

  it("Ollamaレスポンスの message.content 抽出失敗や壊れたJSONで適切に例外をスローする", async () => {
    // message がない場合
    const provider1 = new OllamaCorrectionProvider({
      invokeTauri: async () => ({ invalid: true }) as any,
    });
    const doc = createDummyDoc([createDummySegment("seg-1", "本文")]);
    await expect(provider1.correct(createCorrectionRequest(doc))).rejects.toThrow("Ollamaレスポンス");

    // message.content が壊れたJSON文字列（末尾切断以外の構文エラー）の場合
    const provider2 = new OllamaCorrectionProvider({
      invokeTauri: async () => ({
        done_reason: "stop",
        message: { role: "assistant", content: "{ not a valid json }" },
      }) as any,
    });
    await expect(provider2.correct(createCorrectionRequest(doc))).rejects.toThrow("構文解析に失敗しました");
  });

  it("isCancelled が true になった場合、後続チャンクの送信を直ちに中止する", async () => {
    const segments: TranscriptSegment[] = [];
    for (let i = 0; i < 35; i++) {
      segments.push(createDummySegment(`seg-${i}`, `セグメントテキスト ${i}`));
    }
    const doc = createDummyDoc(segments);
    const request = createCorrectionRequest(doc);

    let chunkSendCount = 0;
    let cancelled = false;

    const mockInvoke = async (cmd: string) => {
      if (cmd === "call_ollama_chat") {
        chunkSendCount++;
        // 1チャンク目処理後にキャンセル状態へ変更
        cancelled = true;
        return {
          message: {
            role: "assistant",
            content: JSON.stringify({
              proposals: [
                {
                  segmentId: "seg-0",
                  originalText: "セグメントテキスト 0",
                  correctedText: "修正テキスト 0",
                  evidence: [{ type: "context" }],
                  explanation: "説明",
                },
              ],
            }),
          },
        };
      }
      throw new Error(`Unexpected command: ${cmd}`);
    };

    const provider = new OllamaCorrectionProvider({
      invokeTauri: mockInvoke as any,
      isCancelled: () => cancelled,
    });

    await provider.correct(request);
    // 35セグメント（3チャンク予定）だが、1チャンク目完了で即停止し2チャンク目以降は送信されない
    expect(chunkSendCount).toBe(1);
  });

  it("チャンク境界テスト (15セグメント=1チャンク, 30セグメント=2チャンク, 31セグメント=3チャンク)", async () => {
    const runForCount = async (count: number) => {
      const segs = Array.from({ length: count }, (_, i) => createDummySegment(`seg-${i}`, `テキスト ${i}`));
      let chunks = 0;
      const mock = async () => {
        chunks++;
        return {
          message: { role: "assistant", content: JSON.stringify({ proposals: [] }) },
        };
      };
      const p = new OllamaCorrectionProvider({ invokeTauri: mock as any });
      await p.correct(createCorrectionRequest(createDummyDoc(segs)));
      return chunks;
    };

    expect(await runForCount(15)).toBe(1);
    expect(await runForCount(30)).toBe(2);
    expect(await runForCount(31)).toBe(3);
  });

  it("空ドキュメントの場合は空配列を返しTauri呼び出しを行わない", async () => {
    const mockInvoke = vi.fn();
    const provider = new OllamaCorrectionProvider({
      invokeTauri: mockInvoke as any,
    });
    const doc = createDummyDoc([]);
    const res = await provider.correct(createCorrectionRequest(doc));
    expect(res).toEqual([]);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("Correction Mode (minimal / aggressive) がリクエストからスナップショットされ、対応する System Prompt が送信される", async () => {
    let capturedSystemPrompt: string | null = null;
    const mockInvoke = async (_cmd: string, args?: any) => {
      capturedSystemPrompt = args?.input?.messages?.[0]?.content ?? null;
      return {
        message: {
          role: "assistant",
          content: JSON.stringify({ proposals: [] }),
        },
      };
    };

    const provider = new OllamaCorrectionProvider({ invokeTauri: mockInvoke as any });
    const doc = createDummyDoc([createDummySegment("seg-1", "テスト")]);

    // minimal
    const reqMinimal = createCorrectionRequest(doc, undefined, undefined, "minimal");
    await provider.correct(reqMinimal);
    expect(capturedSystemPrompt).toContain("【補正モード: 最小修正 (minimal)】");
    expect(capturedSystemPrompt).not.toContain("【補正モード: 積極修正 (aggressive)】");

    // aggressive
    const reqAggressive = createCorrectionRequest(doc, undefined, undefined, "aggressive");
    await provider.correct(reqAggressive);
    expect(capturedSystemPrompt).toContain("【補正モード: 積極修正 (aggressive)】");
    expect(capturedSystemPrompt).not.toContain("【補正モード: 最小修正 (minimal)】");
  });

  it("Test B, C, D, E, F: 31セグメント（3チャンク）の進捗通知シーケンス・対象範囲・保守的パーセンテージ検証", async () => {
    const segs = Array.from({ length: 31 }, (_, i) => createDummySegment(`seg-${i + 1}`, `テキスト ${i + 1}`));
    const doc = createDummyDoc(segs);

    const mock = async () => ({
      message: { role: "assistant", content: JSON.stringify({ proposals: [] }) },
    });

    const provider = new OllamaCorrectionProvider({ invokeTauri: mock as any });
    const progressList: any[] = [];

    await provider.correct(createCorrectionRequest(doc), (p) => progressList.push(p));

    // 各チャンクごとに送信前(1) + 完了後(1) = 2回、計 3 chunks * 2 = 6回
    expect(progressList).toHaveLength(6);

    // Chunk 1 前: Batch 1/3, Segments 1-15, completed=0/31 -> 0%
    expect(progressList[0]).toMatchObject({
      phase: "running",
      currentChunk: 1,
      completedChunks: 0,
      totalChunks: 3,
      completedSegments: 0,
      totalSegments: 31,
      segmentStart: 1,
      segmentEnd: 15,
      percentage: 0,
    });

    // Chunk 1 後: Batch 1/3, completed=15/31 -> 48%
    expect(progressList[1]).toMatchObject({
      phase: "running",
      currentChunk: 1,
      completedChunks: 1,
      totalChunks: 3,
      completedSegments: 15,
      totalSegments: 31,
      segmentStart: 1,
      segmentEnd: 15,
      percentage: 48, // Math.floor(15/31*100) = 48
    });

    // Chunk 2 前: Batch 2/3, Segments 16-30, completed=15/31 -> 48%
    expect(progressList[2]).toMatchObject({
      phase: "running",
      currentChunk: 2,
      completedChunks: 1,
      totalChunks: 3,
      completedSegments: 15,
      totalSegments: 31,
      segmentStart: 16,
      segmentEnd: 30,
      percentage: 48,
    });

    // Chunk 2 後: Batch 2/3, completed=30/31 -> 96%
    expect(progressList[3]).toMatchObject({
      phase: "running",
      currentChunk: 2,
      completedChunks: 2,
      totalChunks: 3,
      completedSegments: 30,
      totalSegments: 31,
      segmentStart: 16,
      segmentEnd: 30,
      percentage: 96,
    });

    // Chunk 3 前: Batch 3/3, Segments 31-31, completed=30/31 -> 96%
    expect(progressList[4]).toMatchObject({
      phase: "running",
      currentChunk: 3,
      completedChunks: 2,
      totalChunks: 3,
      completedSegments: 30,
      totalSegments: 31,
      segmentStart: 31,
      segmentEnd: 31,
      percentage: 96,
    });

    // Chunk 3 後: Batch 3/3, completed=31/31 -> 100% (最終完了時のみ100%)
    expect(progressList[5]).toMatchObject({
      phase: "running",
      currentChunk: 3,
      completedChunks: 3,
      totalChunks: 3,
      completedSegments: 31,
      totalSegments: 31,
      segmentStart: 31,
      segmentEnd: 31,
      percentage: 100,
    });
  });
});
