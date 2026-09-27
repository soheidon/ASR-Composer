import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildSynthesisSystemPrompt,
  buildSynthesisUserPrompt,
  OllamaSynthesisProvider,
  setSynthesisTauriInvokeForTest,
  OLLAMA_SYNTHESIS_SCHEMA,
} from "./synthesis-provider";
import type { SynthesisBatchRequest, SynthesisTargetItem } from "./synthesis";

describe("Synthesis Provider & Prompt Contracts (Phase 3B)", () => {
  beforeEach(() => {
    setSynthesisTauriInvokeForTest(null);
  });

  it("Test O: minimal / standard / aggressive 各モードのシステムプロンプト構築", () => {
    const minimalPrompt = buildSynthesisSystemPrompt("minimal");
    expect(minimalPrompt).toContain("【補正モード: 最小修正 (minimal)】");
    expect(minimalPrompt).toContain("文体改善");

    const standardPrompt = buildSynthesisSystemPrompt("standard");
    expect(standardPrompt).toContain("【補正モード: 標準 (standard)】");
    expect(standardPrompt).toContain("前後文脈から確実性の高い誤認識");

    const aggressivePrompt = buildSynthesisSystemPrompt("aggressive");
    expect(aggressivePrompt).toContain("【補正モード: 積極修正 (aggressive)】");
    expect(aggressivePrompt).toContain("助詞の脱落や言い直し・重複を整理");
  });

  it("Test M: 用語辞書（dictionary）が正式表記の強い根拠としてプロンプトに定義されること", () => {
    const sysPrompt = buildSynthesisSystemPrompt("standard");
    expect(sysPrompt).toContain("用語辞書 (dictionary): 正式表記・固有名詞の強い補助根拠");
    expect(sysPrompt).toContain("ただし発話にない語の無差別挿入は禁止");

    const target: SynthesisTargetItem = {
      segmentId: "seg-1",
      text: "じどうせいしんいがく",
      start: 0,
      end: 5,
      engineId: "kotoba",
      candidates: [],
    };

    const userPrompt = buildSynthesisUserPrompt(
      [target],
      undefined,
      undefined,
      [{ id: "d1", canonical: "児童精神医学", variants: ["じどうせいしんいがく"] }]
    );

    expect(userPrompt).toContain("【用語辞書 (dictionary)】");
    expect(userPrompt).toContain("正式表記: 「児童精神医学」");
  });

  it("Test N: 背景情報（background）が弱い文脈として扱われ、発話外情報の追加禁止がプロンプト契約として明記されること", () => {
    const sysPrompt = buildSynthesisSystemPrompt("standard");
    expect(sysPrompt).toContain("背景情報 / 話者メモ (background / speakerNotes): 専門分野・文脈理解のための弱い補助（発話外情報の追加は厳禁）");
    expect(sysPrompt).toContain("発話内容の忠実維持: 発話に存在しない新事実・情報・推測を追加しないでください");

    const target: SynthesisTargetItem = {
      segmentId: "seg-1",
      text: "本日の議題です",
      start: 0,
      end: 5,
      engineId: "kotoba",
      candidates: [],
    };

    const userPrompt = buildSynthesisUserPrompt(
      [target],
      undefined,
      undefined,
      undefined,
      { backgroundText: "医療DX推進会議", speakerNotes: { SPEAKER_00: "主治医" } }
    );

    expect(userPrompt).toContain("【背景情報 (background) ※文脈理解のための弱い参考情報】");
    expect(userPrompt).toContain("- 全体背景: 医療DX推進会議");
    expect(userPrompt).toContain("- 話者情報:");
    expect(userPrompt).toContain("* SPEAKER_00: 主治医");
  });

  it("Test R: 候補不一致・不確実時に Anchor Baseline を維持（No-change）するルールがプロンプト契約として明記されること", () => {
    const sysPrompt = buildSynthesisSystemPrompt("standard");
    expect(sysPrompt).toContain("修正が不要または確証がないセグメントについては、proposal を出力しないでください（proposal なしが正常な判断です）");
  });

  it("OllamaSynthesisProvider: call_ollama_chat を呼び出し、構造化出力を正しくパースする", async () => {
    const mockResponse = {
      message: {
        content: JSON.stringify({
          proposals: [
            {
              segmentId: "seg-1",
              originalText: "じどうせいしんいがく",
              correctedText: "児童精神医学",
              evidence: [{ type: "dictionary", sourceId: "d1" }],
              explanation: "辞書に基づく正式表記への修正",
              confidence: 0.98,
            },
          ],
        }),
      },
    };

    const mockInvoke = vi.fn().mockResolvedValue(mockResponse);
    setSynthesisTauriInvokeForTest(mockInvoke);

    const provider = new OllamaSynthesisProvider({
      baseUrl: "http://127.0.0.1:11434",
      model: "test-model",
      temperature: 0,
      numPredict: 2048,
    });
    const target: SynthesisTargetItem = {
      segmentId: "seg-1",
      text: "じどうせいしんいがく",
      start: 0,
      end: 5,
      engineId: "kotoba",
      candidates: [
        {
          engineId: "whisper",
          sourceSegmentId: "w1",
          text: "児童精神医学",
          overlapDurationSec: 5.0,
          anchorCoverage: 1.0,
          candidateCoverage: 1.0,
          iou: 1.0,
        },
      ],
    };

    const req: SynthesisBatchRequest = {
      anchorEngineId: "kotoba",
      targets: [target],
      mode: "standard",
    };

    const result = await provider.synthesize(req);
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    const callArgs = mockInvoke.mock.calls[0];
    expect(callArgs[0]).toBe("call_ollama_chat");

    const invokeParams = callArgs[1] as Record<string, unknown>;
    expect(invokeParams).toHaveProperty("input");
    expect(invokeParams).not.toHaveProperty("payload");

    const input = invokeParams.input as Record<string, unknown>;
    expect(input.baseUrl).toBe("http://127.0.0.1:11434");
    expect(input.model).toBe("test-model");
    expect(input.format).toEqual(OLLAMA_SYNTHESIS_SCHEMA);
    expect(input.stream).toBe(undefined); // not in request object or handled by rust
    expect(input.think).toBe(false);
    expect(input.timeoutSecs).toBe(120);
    expect(input.options).toEqual({
      temperature: 0,
      num_predict: 2048,
    });
    expect(Array.isArray(input.messages)).toBe(true);

    expect(result.length).toBe(1);
    expect(result[0].segmentId).toBe("seg-1");
    expect(result[0].correctedText).toBe("児童精神医学");
  });
});
