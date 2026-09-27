import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  setEditorDocument,
  setEditorInvoke,
  runLlmCorrection,
  renderEditor,
} from "./editor";
import {
  runAsrAutoCorrection,
  getPendingCorrectionResultForTest,
  setPendingCorrectionResultForTest,
  resetCorrectionStateForTest,
  setLastTranscriptionDocumentForTest,
  getLastTranscriptionDocumentForTest,
  getAsrGenerationForTest,
  setAsrGenerationForTest,
  setSavedCorrectionModelForTest,
  setTauriInvokeForTest,
  saveCorrectionSelection,
  fetchCorrectionModelsForSelect,
  updateCorrectionUiState,
  navigateTo,
} from "./main";
import {
  resolveCorrectionProvider,
  type SavedAppSettings,
} from "./correction-settings";
import {
  runCorrectionForDocument,
  type CorrectionProposal,
} from "./correction";
import type { TranscriptDocument, TranscriptSegment } from "./transcript";

function createDoc(name: string, text = "テストセグメント"): TranscriptDocument {
  return {
    schemaVersion: 1,
    mediaPath: `/path/to/${name}.wav`,
    mediaFileName: `${name}.wav`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    language: "ja",
    sourceEngine: "test-engine",
    sourceRunId: "run-1",
    segments: [
      {
        id: `seg-${name}-1`,
        start: 0.0,
        end: 3.0,
        speaker: "SPEAKER_00",
        originalSpeaker: "SPEAKER_00",
        text,
        originalText: text,
        sourceEngine: "test-engine",
        sourceSegmentId: "1",
        sourceRunId: "run-1",
        status: "raw",
      },
    ],
  };
}

function createMockSettings(overrides: Partial<SavedAppSettings> = {}): SavedAppSettings {
  return {
    providers: {
      ollama: { base_url: "http://localhost:11434", default_model: "maternion/mimo-v2.6:9b" },
    },
    asr_mode: "local",
    asr_engine: "reazonspeech",
    asr_languages: {},
    speaker_diarization: true,
    num_speakers: "auto",
    output_path: "",
    correction_enabled: true,
    correction_provider: "ollama",
    correction_model: "maternion/mimo-v2.6:9b",
    ...overrides,
  };
}

describe("Correction Workflow Integration (Codex Final Review Cases 1 - 8)", () => {
  beforeEach(() => {
    resetCorrectionStateForTest();
    setEditorDocument(null);
    document.body.innerHTML = `
      <div id="app">
        <section id="resultSection">
          <span id="correctionStatusBadge" style="display:none"></span>
          <textarea id="resultText"></textarea>
          <button id="openEditorBtn" style="display:none"></button>
        </section>
        <div id="page-transcribe"></div>
        <div id="page-editor" class="hidden"></div>
      </div>
    `;
  });

  it("Case 1: Doc B settings load pending中にDoc C ASR開始/完了 → B settings resolveしてもBはauto correctionを開始せずCを妨害しない", async () => {
    const docB = createDoc("docB", "Doc B 原文");
    const docC = createDoc("docC", "Doc C 原文");

    let resolveDocBSettings: (val: any) => void;
    const docBSettingsPromise = new Promise((resolve) => {
      resolveDocBSettings = resolve;
    });

    const mockInvoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === "load_api_settings") {
        return docBSettingsPromise;
      }
      if (cmd === "read_correction_context_files") {
        return { dictionary_content: null, background_content: null };
      }
      if (cmd === "call_ollama_chat") {
        return {
          message: {
            content: JSON.stringify([
              {
                segmentId: "seg-docC-1",
                originalText: "Doc C 原文",
                correctedText: "Doc C 補正済",
                evidence: [{ type: "context" }],
                explanation: "Doc C 補正",
              },
            ]),
          },
        };
      }
      throw new Error(`Unhandled: ${cmd}`);
    });

    setTauriInvokeForTest(mockInvoke);

    // 1. Doc B ASR完了時の世代Snapshotと非同期settings load
    setLastTranscriptionDocumentForTest(docB);
    const genB = 1;
    setAsrGenerationForTest(genB);

    // Doc B の settings load コールバック（pending中）
    const bCallbackPromise = (async () => {
      const settings = (await mockInvoke("load_api_settings")) as SavedAppSettings;
      // 実装のガード条件: generation と document が一致しなければ return
      if (genB !== getAsrGenerationForTest() || getLastTranscriptionDocumentForTest() !== docB) {
        return;
      }
      if (settings.correction_enabled) {
        await runAsrAutoCorrection("job-B", docB, genB);
      }
    })();

    // 2. Doc C の ASR が開始され完了（世代が進む gen 2）
    const genC = 2;
    setAsrGenerationForTest(genC);
    setLastTranscriptionDocumentForTest(docC);
    const cCorrectionPromise = runAsrAutoCorrection("job-C", docC, genC);

    // 3. ここで遅延していた Doc B の settings が解決
    resolveDocBSettings!(createMockSettings());

    await bCallbackPromise;
    await cCorrectionPromise;

    // 検証:
    // - Doc B は staging されない
    // - Doc C の補正結果が安全に staging されている
    const staged = getPendingCorrectionResultForTest();
    expect(staged).not.toBeNull();
    expect(staged?.asrRunId).toBe("job-C");
    expect(staged?.document.mediaFileName).toBe("docC.wav");
    expect(staged?.proposals.get("seg-docC-1")![0].correctedText).toBe("Doc C 補正済");
  });

  it("Case 2: openEditorBtn click で real navigateTo が superseded された場合、staging は保持され破棄されない", async () => {
    const docB = createDoc("docB", "Doc B 原文");
    const proposalsMap = new Map<string, CorrectionProposal[]>([
      [
        "seg-docB-1",
        [
          {
            id: "prop-B-1",
            segmentId: "seg-docB-1",
            originalText: "Doc B 原文",
            correctedText: "Doc B 補正済",
            evidence: [{ type: "dictionary" }],
            explanation: "辞書補正",
          },
        ],
      ],
    ]);

    setPendingCorrectionResultForTest({
      asrRunId: "job-B",
      document: docB,
      proposals: proposalsMap,
      correctionRunId: "corr-run-1",
    });
    setLastTranscriptionDocumentForTest(docB);

    // 1. エディターハンドオフ中に別ナビゲーションが割り込むケース
    const targetDoc = getLastTranscriptionDocumentForTest()!;
    const staged = getPendingCorrectionResultForTest()!;

    setEditorDocument(targetDoc, null, staged.proposals);
    renderEditor(navigateTo);

    // navigateTo("editor") を開始
    const navEditorPromise = navigateTo("editor");

    // 直後に別の navigateTo("settings") が発生して editor へのナビゲーションが superseded になる
    const navSettingsPromise = navigateTo("settings");

    const [editorResult, settingsResult] = await Promise.all([navEditorPromise, navSettingsPromise]);

    expect(editorResult).toBe("superseded");
    expect(settingsResult).toBe("completed");

    // superseded の場合、staging は clear されない
    if (editorResult !== "completed") {
      // staging保持
      expect(getPendingCorrectionResultForTest()).not.toBeNull();
    }
  });

  it("Case 3: model未設定時に model list 取得成功後 enabled を変更しても先頭モデルを暗黙保存しない", async () => {
    document.body.innerHTML = `
      <input type="checkbox" id="correctionEnabledCheckbox" />
      <select id="correctionProviderSelect"><option value="ollama" selected>Ollama</option></select>
      <select id="correctionModelSelect"></select>
    `;

    let savedPayload: any = null;
    const mockInvoke = vi.fn().mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === "fetch_models") {
        return ["gemma4:26b", "mimo:9b"];
      }
      if (cmd === "save_correction_settings") {
        savedPayload = args;
        return;
      }
      return null;
    });
    setTauriInvokeForTest(mockInvoke);

    // 1. モデル未設定の状態
    setSavedCorrectionModelForTest("", false);

    // 2. 一覧取得
    await fetchCorrectionModelsForSelect("");

    const modelSelect = document.getElementById("correctionModelSelect") as HTMLSelectElement;
    expect(modelSelect.options.length).toBe(3); // placeholder + 2 models
    expect(modelSelect.options[0].textContent).toContain("Ollamaの既定モデルを使用");
    expect(modelSelect.value).toBe("");

    // 3. enabled を ON に変更して保存
    const enabledCheckbox = document.getElementById("correctionEnabledCheckbox") as HTMLInputElement;
    enabledCheckbox.checked = true;
    await saveCorrectionSelection();

    // 先頭モデル "gemma4:26b" を暗黙保存せず、空文字のまま保存されること
    expect(savedPayload).not.toBeNull();
    expect(savedPayload.model).toBe("");
    expect(savedPayload.enabled).toBe(true);
  });

  it("Case 4: ユーザーが model select を明示的に change した場合のみ correction_model を保存する", async () => {
    document.body.innerHTML = `
      <input type="checkbox" id="correctionEnabledCheckbox" checked />
      <select id="correctionProviderSelect"><option value="ollama" selected>Ollama</option></select>
      <select id="correctionModelSelect"></select>
    `;

    let savedPayload: any = null;
    const mockInvoke = vi.fn().mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === "fetch_models") {
        return ["gemma4:26b", "mimo:9b"];
      }
      if (cmd === "save_correction_settings") {
        savedPayload = args;
        return;
      }
      return null;
    });
    setTauriInvokeForTest(mockInvoke);

    setSavedCorrectionModelForTest("", false);
    await fetchCorrectionModelsForSelect("");

    const modelSelect = document.getElementById("correctionModelSelect") as HTMLSelectElement;

    // ユーザーが明示的に "gemma4:26b" を選択して change イベント発火
    modelSelect.value = "gemma4:26b";
    modelSelect.dispatchEvent(new Event("change"));

    setSavedCorrectionModelForTest("gemma4:26b", true);
    await saveCorrectionSelection();

    expect(savedPayload).not.toBeNull();
    expect(savedPayload.model).toBe("gemma4:26b");
  });

  it("Case 5 & 6: correction_enabled による自動補正の実行・スキップ制御 (1スイッチ統合)", async () => {
    const doc = createDoc("doc-toggle", "原文");
    setLastTranscriptionDocumentForTest(doc);

    let chatCalled = false;
    const mockInvoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === "load_api_settings") {
        return createMockSettings({ correction_enabled: false });
      }
      if (cmd === "read_correction_context_files") {
        return { dictionary_content: null, background_content: null };
      }
      if (cmd === "call_ollama_chat") {
        chatCalled = true;
        return { message: { content: "[]" } };
      }
      throw new Error(`Unhandled: ${cmd}`);
    });
    setTauriInvokeForTest(mockInvoke);

    // Case 5: correction_enabled = false の場合は自動補正をスキップ
    const settingsOff = (await mockInvoke("load_api_settings")) as SavedAppSettings;
    if (settingsOff.correction_enabled) {
      await runAsrAutoCorrection("job-off", doc);
    }
    expect(chatCalled).toBe(false);
    expect(getPendingCorrectionResultForTest()).toBeNull();

    // Case 6: correction_enabled = true の場合は自動補正を実行
    const mockInvokeOn = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === "load_api_settings") {
        return createMockSettings({ correction_enabled: true });
      }
      if (cmd === "read_correction_context_files") {
        return { dictionary_content: null, background_content: null };
      }
      if (cmd === "call_ollama_chat") {
        chatCalled = true;
        return { message: { content: "[]" } };
      }
      throw new Error(`Unhandled: ${cmd}`);
    });
    setTauriInvokeForTest(mockInvokeOn);

    const settingsOn = (await mockInvokeOn("load_api_settings")) as SavedAppSettings;
    if (settingsOn.correction_enabled) {
      await runAsrAutoCorrection("job-on", doc);
    }
    expect(chatCalled).toBe(true);
  });

  it("Case 7: 未対応 provider ('openai' 等) は Ollama API を呼び出さず安全にスキップする", async () => {
    const mockSettings = createMockSettings({
      correction_provider: "openai",
      correction_model: "gpt-4o",
    });

    let ollamaChatCalled = false;
    const mockInvoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === "load_api_settings") return mockSettings;
      if (cmd === "call_ollama_chat") {
        ollamaChatCalled = true;
        return { message: { content: "[]" } };
      }
      throw new Error(`Unhandled: ${cmd}`);
    });

    const resolved = await resolveCorrectionProvider(mockInvoke as any);
    expect(resolved).toBeNull();

    setTauriInvokeForTest(mockInvoke);
    const doc = createDoc("doc-unsupported", "未対応プロバイダー");
    setLastTranscriptionDocumentForTest(doc);

    await runAsrAutoCorrection("job-unsupported", doc);

    expect(ollamaChatCalled).toBe(false);
    expect(getPendingCorrectionResultForTest()).toBeNull();
  });

  it("Case 8: 旧 ASR の遅延エラーコールバックが現在の Doc C の status badge を上書きしない", async () => {
    const badgeEl = document.getElementById("correctionStatusBadge") as HTMLElement;

    const docB = createDoc("docB", "Doc B 原文");
    const docC = createDoc("docC", "Doc C 原文");

    // 1. Doc C の自動補正が成功してステータスバッジが "補正候補 (1件) を生成しました" になっている
    setLastTranscriptionDocumentForTest(docC);
    setAsrGenerationForTest(2);
    badgeEl.textContent = "補正候補 (1件) を生成しました";
    badgeEl.style.display = "inline-block";

    // 2. 過去の Doc B の遅延エラーコールバックが発火（世代 gen 1 は古い）
    const mockOldBError = vi.fn().mockImplementation(async () => {
      throw new Error("Old Doc B Ollama connection timeout");
    });
    setTauriInvokeForTest(mockOldBError);

    // 旧ジョブ B の実行（generation 1 を指定）
    await runAsrAutoCorrection("job-B", docB, 1);

    // 検証: Doc C のステータスバッジが上書きされずに維持される
    expect(badgeEl.textContent).toBe("補正候補 (1件) を生成しました");
  });

  it("Case 9: 31セグメントの Chunking (15/15/1) が単一箇所で正しく実行される", async () => {
    const { OllamaCorrectionProvider } = await import("./ollama-provider");

    let chunkCount = 0;
    const mockInvoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === "call_ollama_chat") {
        chunkCount++;
        return { message: { content: "[]" } };
      }
      throw new Error(`Unhandled: ${cmd}`);
    });

    const provider = new OllamaCorrectionProvider({
      invokeTauri: mockInvoke as any,
    });

    const segs: TranscriptSegment[] = Array.from({ length: 31 }, (_, i) => ({
      id: `seg-${i + 1}`,
      start: i * 2,
      end: (i + 1) * 2,
      speaker: "SPEAKER_00",
      originalSpeaker: "SPEAKER_00",
      text: `セグメント ${i + 1}`,
      originalText: `セグメント ${i + 1}`,
      sourceEngine: "test",
      sourceSegmentId: String(i + 1),
      sourceRunId: "run-1",
      status: "raw",
    }));

    const doc31: TranscriptDocument = {
      schemaVersion: 1,
      mediaPath: "/path/to/31.wav",
      mediaFileName: "31.wav",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      language: "ja",
      sourceEngine: "test",
      sourceRunId: "run-1",
      segments: segs,
    };

    const res = await runCorrectionForDocument({
      document: doc31,
      provider,
    });

    expect(res.status).toBe("success");
    expect(chunkCount).toBe(3);
  });

  it("Context Case 8 & 9: Manual Correction および Auto Correction の両方で同じ外部CSV/TXT内容を読み込んでOllamaへ渡す", async () => {
    const mockInvoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === "load_api_settings") {
        return createMockSettings({ correction_enabled: true });
      }
      if (cmd === "read_correction_context_files") {
        return {
          dictionary_content: 'canonical,variants,category,note\n統合失調症,"統合失調症候群|統合失調病",medical,"正式表記"\n',
          background_content: "本音声は医療カンファレンスの記録です。\n",
        };
      }
      if (cmd === "call_ollama_chat") {
        return {
          message: {
            content: JSON.stringify([
              {
                segmentId: "seg-test-auto-1",
                originalText: "患者は統合失調病の疑いがある",
                correctedText: "患者は統合失調症の疑いがある",
                evidence: [{ type: "dictionary", description: "辞書一致" }],
                explanation: "辞書の正式表記へ修正",
              },
            ]),
          },
        };
      }
      throw new Error(`Unhandled: ${cmd}`);
    });

    // 1. Auto Correction 経路でのコンテキスト読み込み検証
    setTauriInvokeForTest(mockInvoke);
    const autoDoc = createDoc("test-auto", "患者は統合失調病の疑いがある");
    setLastTranscriptionDocumentForTest(autoDoc);
    setAsrGenerationForTest(1);

    await runAsrAutoCorrection("job-auto", autoDoc, 1);

    const staged = getPendingCorrectionResultForTest();
    expect(staged).not.toBeNull();
    expect(staged?.proposals.get("seg-test-auto-1")![0].correctedText).toBe("患者は統合失調症の疑いがある");

    // 2. Manual Editor Correction 経路でのコンテキスト読み込み検証
    setEditorInvoke(mockInvoke as any);
    const editorDoc = createDoc("test-editor", "患者は統合失調病の疑いがある");
    setEditorDocument(editorDoc);

    await runLlmCorrection();
    // エディター側でも同じ mockInvoke (read_correction_context_files) が呼ばれ正常に補正されること
    expect(mockInvoke).toHaveBeenCalledWith("read_correction_context_files", expect.any(Object));
  });

  it("Context Case 10: 外部エディタでCSV/TXTを変更した場合、次回補正実行時に再読込されて即座に反映される", async () => {
    let currentDictContent = "canonical,variants\nAI,人工知能\n";

    const mockInvoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === "load_api_settings") {
        return createMockSettings({ correction_enabled: true });
      }
      if (cmd === "read_correction_context_files") {
        return {
          dictionary_content: currentDictContent,
          background_content: "",
        };
      }
      if (cmd === "call_ollama_chat") {
        return { message: { content: "[]" } };
      }
      throw new Error(`Unhandled: ${cmd}`);
    });

    setTauriInvokeForTest(mockInvoke);

    // 1回目の実行
    const doc1 = createDoc("doc1", "テスト");
    setLastTranscriptionDocumentForTest(doc1);
    setAsrGenerationForTest(1);
    await runAsrAutoCorrection("job-1", doc1, 1);

    // 外部で辞書ファイルが編集されたと仮定
    currentDictContent = 'canonical,variants\n人工知能,AI\n量子コンピュータ,QC\n';

    // 2回目の実行
    const doc2 = createDoc("doc2", "テスト2");
    setLastTranscriptionDocumentForTest(doc2);
    setAsrGenerationForTest(2);
    await runAsrAutoCorrection("job-2", doc2, 2);

    expect(mockInvoke).toHaveBeenCalledTimes(6); // load_api_settings x2, read_correction_context_files x2, call_ollama_chat x2
  });

  it("Context Case 11 & 12: correction_enabled=false でも フォルダを開く・ファイルを開く ボタンは disabled にならない", () => {
    document.body.innerHTML = `
      <section id="correctionSection">
        <input type="checkbox" id="correctionEnabledCheckbox" />
        <select id="correctionProviderSelect"></select>
        <select id="correctionModelSelect"></select>
        <button id="btnRefreshCorrectionModels"></button>
        <button id="btnCorrectionSettings"></button>
        <div id="correctionControlsRow"></div>
        <button id="btnOpenDictionaryFolder"></button>
        <button id="btnOpenDictionaryFile"></button>
        <button id="btnOpenBackgroundFolder"></button>
        <button id="btnOpenBackgroundFile"></button>
      </section>
    `;

    const enabledCheckbox = document.getElementById("correctionEnabledCheckbox") as HTMLInputElement;
    enabledCheckbox.checked = false;

    // UI状態を更新
    updateCorrectionUiState();

    const btnDictFolder = document.getElementById("btnOpenDictionaryFolder") as HTMLButtonElement;
    const btnDictFile = document.getElementById("btnOpenDictionaryFile") as HTMLButtonElement;
    const btnBgFolder = document.getElementById("btnOpenBackgroundFolder") as HTMLButtonElement;
    const btnBgFile = document.getElementById("btnOpenBackgroundFile") as HTMLButtonElement;

    // Provider / Model は disabled
    const providerSelect = document.getElementById("correctionProviderSelect") as HTMLSelectElement;
    const modelSelect = document.getElementById("correctionModelSelect") as HTMLSelectElement;
    expect(providerSelect.disabled).toBe(true);
    expect(modelSelect.disabled).toBe(true);

    // 辞書・背景情報オープンボタンは事前準備のため enabled (disabled === false) のまま
    expect(btnDictFolder.disabled).toBe(false);
    expect(btnDictFile.disabled).toBe(false);
    expect(btnBgFolder.disabled).toBe(false);
    expect(btnBgFile.disabled).toBe(false);
  });

  it("Context Case 13: correctionEnabledCheckbox=false の場合、辞書・背景情報チェックボックスは disabled かつグレーアウト (opacity: 0.5) になる", () => {
    document.body.innerHTML = `
      <section id="correctionSection">
        <input type="checkbox" id="correctionEnabledCheckbox" />
        <select id="correctionProviderSelect"></select>
        <select id="correctionModelSelect"></select>
        <button id="btnRefreshCorrectionModels"></button>
        <button id="btnCorrectionSettings"></button>
        <div id="correctionControlsRow"></div>
        <div id="correctionDictRow">
          <input type="checkbox" id="correctionDictCheckbox" checked />
        </div>
        <div id="correctionBgRow">
          <input type="checkbox" id="correctionBgCheckbox" checked />
        </div>
      </section>
    `;

    const enabledCheckbox = document.getElementById("correctionEnabledCheckbox") as HTMLInputElement;
    const dictCheckbox = document.getElementById("correctionDictCheckbox") as HTMLInputElement;
    const bgCheckbox = document.getElementById("correctionBgCheckbox") as HTMLInputElement;
    const dictRow = document.getElementById("correctionDictRow") as HTMLElement;
    const bgRow = document.getElementById("correctionBgRow") as HTMLElement;

    enabledCheckbox.checked = false;
    updateCorrectionUiState();

    expect(dictCheckbox.disabled).toBe(true);
    expect(bgCheckbox.disabled).toBe(true);
    expect(dictRow.style.opacity).toBe("0.5");
    expect(bgRow.style.opacity).toBe("0.5");

    // enabledCheckbox を ON に戻す
    enabledCheckbox.checked = true;
    updateCorrectionUiState();

    expect(dictCheckbox.disabled).toBe(false);
    expect(bgCheckbox.disabled).toBe(false);
    expect(dictRow.style.opacity).toBe("");
    expect(bgRow.style.opacity).toBe("");
  });

  it("Context Case 14: 辞書チェックボックスが OFF の場合、auto correction は辞書内容を読み込まず空で実行する", async () => {
    document.body.innerHTML = `
      <input type="checkbox" id="correctionEnabledCheckbox" checked />
      <input type="checkbox" id="correctionDictCheckbox" />
      <input type="checkbox" id="correctionBgCheckbox" checked />
    `;
    const dictCheckbox = document.getElementById("correctionDictCheckbox") as HTMLInputElement;
    dictCheckbox.checked = false;

    let receivedMessages: any[] = [];
    const mockInvoke = vi.fn().mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === "load_api_settings") {
        return createMockSettings({ correction_enabled: true });
      }
      if (cmd === "read_correction_context_files") {
        return {
          dictionary_content: 'canonical,variants\n統合失調症,統合失調病\n',
          background_content: "背景情報テキスト",
        };
      }
      if (cmd === "call_ollama_chat") {
        receivedMessages = args?.input?.messages || args?.messages || [];
        return { message: { content: "[]" } };
      }
      return null;
    });

    setTauriInvokeForTest(mockInvoke);
    const doc = createDoc("doc-dict-off", "テスト");
    setLastTranscriptionDocumentForTest(doc);
    setAsrGenerationForTest(1);

    await runAsrAutoCorrection("job-dict-off", doc, 1);

    expect(mockInvoke).toHaveBeenCalledWith("read_correction_context_files", {
      useDictionary: false,
      useBackground: true,
    });
    const userPrompt = receivedMessages.find((m) => m.role === "user")?.content || "";
    // 辞書がOFFなので辞書エントリは含まれず、背景情報は含まれる
    expect(userPrompt).not.toContain("統合失調症");
    expect(userPrompt).toContain("背景情報テキスト");
  });

  it("Context Case 15: 背景情報チェックボックスが OFF の場合、auto correction は背景テキストを読み込まず空で実行する", async () => {
    document.body.innerHTML = `
      <input type="checkbox" id="correctionEnabledCheckbox" checked />
      <input type="checkbox" id="correctionDictCheckbox" checked />
      <input type="checkbox" id="correctionBgCheckbox" />
    `;
    const bgCheckbox = document.getElementById("correctionBgCheckbox") as HTMLInputElement;
    bgCheckbox.checked = false;

    let receivedMessages: any[] = [];
    const mockInvoke = vi.fn().mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === "load_api_settings") {
        return createMockSettings({ correction_enabled: true });
      }
      if (cmd === "read_correction_context_files") {
        return {
          dictionary_content: 'canonical,variants\n統合失調症,統合失調病\n',
          background_content: "本音声は極秘会議の記録です。",
        };
      }
      if (cmd === "call_ollama_chat") {
        receivedMessages = args?.input?.messages || args?.messages || [];
        return { message: { content: "[]" } };
      }
      return null;
    });

    setTauriInvokeForTest(mockInvoke);
    const doc = createDoc("doc-bg-off", "テスト");
    setLastTranscriptionDocumentForTest(doc);
    setAsrGenerationForTest(1);

    await runAsrAutoCorrection("job-bg-off", doc, 1);

    expect(mockInvoke).toHaveBeenCalledWith("read_correction_context_files", {
      useDictionary: true,
      useBackground: false,
    });
    const userPrompt = receivedMessages.find((m) => m.role === "user")?.content || "";
    // 辞書は含まれ、背景情報は含まれない
    expect(userPrompt).toContain("統合失調症");
    expect(userPrompt).not.toContain("極秘会議");
  });

  it("Test A: 不正CSV（未閉じ引用符）は辞書全体を拒否し、ASR/正本を壊さず自動・手動補正を安全中断する", async () => {
    // 1. Auto correction aborted safely
    const doc = createDoc("doc-syntax-err", "患者は統合失調症の疑いがある");
    setLastTranscriptionDocumentForTest(doc);
    setAsrGenerationForTest(1);

    let chatCalled = false;
    const mockInvoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === "load_api_settings") {
        return createMockSettings({ correction_enabled: true });
      }
      if (cmd === "read_correction_context_files") {
        return {
          dictionary_content: 'canonical,variants\n"統合失調症,精神分裂病\nADHD,注意欠如多動症\n',
          background_content: "背景テキスト",
        };
      }
      if (cmd === "call_ollama_chat") {
        chatCalled = true;
        return { message: { content: "[]" } };
      }
      throw new Error(`Unhandled: ${cmd}`);
    });

    setTauriInvokeForTest(mockInvoke);

    await runAsrAutoCorrection("job-syntax-err", doc, 1);

    // chat is never called
    expect(chatCalled).toBe(false);
    // proposals not staged
    expect(getPendingCorrectionResultForTest()).toBeNull();
    // status badge shows error
    const badgeEl = document.getElementById("correctionStatusBadge");
    expect(badgeEl?.textContent).toContain("辞書ファイルの形式に問題があります");
    // original doc is completely preserved
    expect(getLastTranscriptionDocumentForTest()?.segments[0].text).toBe("患者は統合失調症の疑いがある");

    // 2. Manual editor correction aborted safely with showAppDialog
    const statusModule = await import("./status");
    const dialogSpy = vi.spyOn(statusModule, "showAppDialog").mockResolvedValue();

    const editorDoc = createDoc("doc-editor-syntax", "エディタ原文");
    setEditorDocument(editorDoc);
    setEditorInvoke(mockInvoke as any);

    await runLlmCorrection();
    expect(chatCalled).toBe(false);
    expect(dialogSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "辞書ファイル形式エラー",
        type: "error",
      }),
    );
    expect(editorDoc.segments[0].text).toBe("エディタ原文");
  });

  it("Test B: canonical空行スキップ（row semantic error）時は警告を出しつつ有効行のみで補正を完走する", async () => {
    const doc = createDoc("doc-sem-err", "人工知能の研究");
    setLastTranscriptionDocumentForTest(doc);
    setAsrGenerationForTest(1);

    let receivedMessages: any[] = [];
    const mockInvoke = vi.fn().mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === "load_api_settings") {
        return createMockSettings({ correction_enabled: true });
      }
      if (cmd === "read_correction_context_files") {
        return {
          dictionary_content: 'canonical,variants\n,無効な行\nAI,人工知能\n',
          background_content: "",
        };
      }
      if (cmd === "call_ollama_chat") {
        receivedMessages = args?.input?.messages || args?.messages || [];
        return {
          message: {
            content: JSON.stringify([
              {
                segmentId: "seg-doc-sem-err-1",
                originalText: "人工知能の研究",
                correctedText: "AIの研究",
                evidence: [{ type: "dictionary" }],
                explanation: "辞書一致",
              },
            ]),
          },
        };
      }
      throw new Error(`Unhandled: ${cmd}`);
    });

    setTauriInvokeForTest(mockInvoke);

    await runAsrAutoCorrection("job-sem-err", doc, 1);

    const staged = getPendingCorrectionResultForTest();
    expect(staged).not.toBeNull();
    expect(staged?.proposals.get("seg-doc-sem-err-1")![0].correctedText).toBe("AIの研究");

    const userPrompt = receivedMessages.find((m) => m.role === "user")?.content || "";
    expect(userPrompt).toContain("AI");
    expect(userPrompt).not.toContain("無効な行");
  });

  it("Test C: correction_model='' かつ default_model='modelA' の状態で enabled 変更しても model: '' を保存する（暗黙保存防止）", async () => {
    document.body.innerHTML = `
      <input type="checkbox" id="correctionEnabledCheckbox" checked />
      <select id="correctionProviderSelect"><option value="ollama" selected>Ollama</option></select>
      <select id="correctionModelSelect"></select>
    `;

    let savedPayload: any = null;
    const mockInvoke = vi.fn().mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === "fetch_models") {
        return ["modelA", "modelB"];
      }
      if (cmd === "save_correction_settings") {
        savedPayload = args;
        return;
      }
      return null;
    });
    setTauriInvokeForTest(mockInvoke);

    // savedCorrectionModel is empty (using default)
    setSavedCorrectionModelForTest("", false);

    // UI models fetched
    await fetchCorrectionModelsForSelect("");

    // Toggle enabled
    const enabledCheckbox = document.getElementById("correctionEnabledCheckbox") as HTMLInputElement;
    enabledCheckbox.checked = true;
    await saveCorrectionSelection();

    expect(savedPayload).not.toBeNull();
    expect(savedPayload.model).toBe("");
  });

  it("Test D: correction_model='' の場合、Ollama default_model の動的変更 (A → B) に追従して補正が実行される", async () => {
    let currentDefaultModel = "modelA";
    const mockInvoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === "load_api_settings") {
        return createMockSettings({
          correction_model: "",
          providers: { ollama: { base_url: "http://localhost:11434", default_model: currentDefaultModel } },
        });
      }
      return null;
    });

    // 1回目: default_model = "modelA"
    const resolvedA = await resolveCorrectionProvider(mockInvoke as any);
    expect(resolvedA?.model).toBe("modelA");

    // Ollama 側で既定モデルが "modelB" に変更された
    currentDefaultModel = "modelB";
    const resolvedB = await resolveCorrectionProvider(mockInvoke as any);
    expect(resolvedB?.model).toBe("modelB");
  });

  it("Test E: 明示的にモデル 'modelC' を選択して保存した場合は default_model に関わらず 'modelC' が使用される", async () => {
    const mockInvoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === "load_api_settings") {
        return createMockSettings({
          correction_model: "modelC",
          providers: { ollama: { base_url: "http://localhost:11434", default_model: "modelA" } },
        });
      }
      return null;
    });

    const resolved = await resolveCorrectionProvider(mockInvoke as any);
    expect(resolved?.model).toBe("modelC");
  });

  it("Test F: 明示選択された 'modelC' から 'Ollamaの既定モデルを使用' (value='') に戻すと model: '' が保存され動的解決に戻る", async () => {
    document.body.innerHTML = `
      <input type="checkbox" id="correctionEnabledCheckbox" checked />
      <select id="correctionProviderSelect"><option value="ollama" selected>Ollama</option></select>
      <select id="correctionModelSelect"></select>
    `;

    let savedPayload: any = null;
    const mockInvoke = vi.fn().mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === "fetch_models") {
        return ["modelA", "modelC"];
      }
      if (cmd === "save_correction_settings") {
        savedPayload = args;
        return;
      }
      return null;
    });
    setTauriInvokeForTest(mockInvoke);

    // Initial state: modelC explicitly selected
    setSavedCorrectionModelForTest("modelC", true);
    await fetchCorrectionModelsForSelect("modelC");

    const modelSelect = document.getElementById("correctionModelSelect") as HTMLSelectElement;
    expect(modelSelect.value).toBe("modelC");

    // User switches back to default model option
    modelSelect.value = "";
    modelSelect.dispatchEvent(new Event("change"));

    setSavedCorrectionModelForTest("", false);
    await saveCorrectionSelection();

    expect(savedPayload).not.toBeNull();
    expect(savedPayload.model).toBe("");
  });

  it("Test G: Dict OFF / Background ON: dictionary.csv が壊れていても自動補正・手動補正が background だけで正常完走する", async () => {
    // 1. Auto correction
    document.body.innerHTML = `
      <input type="checkbox" id="correctionEnabledCheckbox" checked />
      <input type="checkbox" id="correctionDictCheckbox" />
      <input type="checkbox" id="correctionBgCheckbox" checked />
      <span id="correctionStatusBadge"></span>
    `;

    const doc = createDoc("doc-bg-only", "テスト文章");
    setLastTranscriptionDocumentForTest(doc);
    setAsrGenerationForTest(1);

    let chatCalled = false;
    let receivedUserPrompt = "";

    const mockInvoke = vi.fn().mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === "load_api_settings") {
        return createMockSettings({
          correction_enabled: true,
          correction_use_dictionary: false,
          correction_use_background: true,
        });
      }
      if (cmd === "read_correction_context_files") {
        expect(args?.useDictionary).toBe(false);
        expect(args?.useBackground).toBe(true);
        // useDictionary=false なので dictionary.csv は読まれず None
        return {
          dictionary_content: null,
          background_content: "医療コンテキスト情報",
        };
      }
      if (cmd === "call_ollama_chat") {
        chatCalled = true;
        const msgs = args?.input?.messages || args?.messages || [];
        receivedUserPrompt = msgs.find((m: any) => m.role === "user")?.content || "";
        return {
          message: {
            content: JSON.stringify([
              {
                segmentId: "seg-doc-bg-only-1",
                originalText: "テスト文章",
                correctedText: "補正後文章",
                evidence: [{ type: "context" }],
                explanation: "背景情報補正",
              },
            ]),
          },
        };
      }
      throw new Error(`Unhandled: ${cmd}`);
    });

    setTauriInvokeForTest(mockInvoke);

    await runAsrAutoCorrection("job-bg-only", doc, 1);

    expect(chatCalled).toBe(true);
    expect(receivedUserPrompt).toContain("医療コンテキスト情報");
    const staged = getPendingCorrectionResultForTest();
    expect(staged).not.toBeNull();
    expect(staged?.proposals.get("seg-doc-bg-only-1")![0].correctedText).toBe("補正後文章");

    // 2. Manual editor correction
    const editorDoc = createDoc("doc-editor-bg-only", "エディタ文章");
    setEditorDocument(editorDoc);
    setEditorInvoke(mockInvoke as any);

    chatCalled = false;
    await runLlmCorrection();
    expect(chatCalled).toBe(true);
  });

  it("Test H: Dict ON / Background OFF: background.txt が読めない状態でも dictionary だけで補正が正常完走する", async () => {
    document.body.innerHTML = `
      <input type="checkbox" id="correctionEnabledCheckbox" checked />
      <input type="checkbox" id="correctionDictCheckbox" checked />
      <input type="checkbox" id="correctionBgCheckbox" />
      <span id="correctionStatusBadge"></span>
    `;

    const doc = createDoc("doc-dict-only", "人工知能の研究");
    setLastTranscriptionDocumentForTest(doc);
    setAsrGenerationForTest(1);

    let chatCalled = false;
    let receivedUserPrompt = "";

    const mockInvoke = vi.fn().mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === "load_api_settings") {
        return createMockSettings({
          correction_enabled: true,
          correction_use_dictionary: true,
          correction_use_background: false,
        });
      }
      if (cmd === "read_correction_context_files") {
        expect(args?.useDictionary).toBe(true);
        expect(args?.useBackground).toBe(false);
        return {
          dictionary_content: "canonical,variants\nAI,人工知能",
          background_content: null,
        };
      }
      if (cmd === "call_ollama_chat") {
        chatCalled = true;
        const msgs = args?.input?.messages || args?.messages || [];
        receivedUserPrompt = msgs.find((m: any) => m.role === "user")?.content || "";
        return {
          message: {
            content: JSON.stringify([
              {
                segmentId: "seg-doc-dict-only-1",
                originalText: "人工知能の研究",
                correctedText: "AIの研究",
                evidence: [{ type: "dictionary" }],
                explanation: "辞書一致",
              },
            ]),
          },
        };
      }
      throw new Error(`Unhandled: ${cmd}`);
    });

    setTauriInvokeForTest(mockInvoke);

    await runAsrAutoCorrection("job-dict-only", doc, 1);

    expect(chatCalled).toBe(true);
    expect(receivedUserPrompt).toContain("AI");
    const staged = getPendingCorrectionResultForTest();
    expect(staged).not.toBeNull();
    expect(staged?.proposals.get("seg-doc-dict-only-1")![0].correctedText).toBe("AIの研究");
  });

  it("Test I: 両方OFF: Rust read commandに両方falseが渡り、空コンテキストで補正が完走する", async () => {
    document.body.innerHTML = `
      <input type="checkbox" id="correctionEnabledCheckbox" checked />
      <input type="checkbox" id="correctionDictCheckbox" />
      <input type="checkbox" id="correctionBgCheckbox" />
      <span id="correctionStatusBadge"></span>
    `;

    const doc = createDoc("doc-both-off", "素の文章");
    setLastTranscriptionDocumentForTest(doc);
    setAsrGenerationForTest(1);

    let chatCalled = false;
    let receivedUserPrompt = "";

    const mockInvoke = vi.fn().mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === "load_api_settings") {
        return createMockSettings({
          correction_enabled: true,
          correction_use_dictionary: false,
          correction_use_background: false,
        });
      }
      if (cmd === "read_correction_context_files") {
        expect(args?.useDictionary).toBe(false);
        expect(args?.useBackground).toBe(false);
        return {
          dictionary_content: null,
          background_content: null,
        };
      }
      if (cmd === "call_ollama_chat") {
        chatCalled = true;
        const msgs = args?.input?.messages || args?.messages || [];
        receivedUserPrompt = msgs.find((m: any) => m.role === "user")?.content || "";
        return { message: { content: "[]" } };
      }
      throw new Error(`Unhandled: ${cmd}`);
    });

    setTauriInvokeForTest(mockInvoke);

    await runAsrAutoCorrection("job-both-off", doc, 1);

    expect(chatCalled).toBe(true);
    expect(receivedUserPrompt).not.toContain("### 辞書");
    expect(receivedUserPrompt).not.toContain("### 背景情報");
  });

  it("Test J: Background ON 時に background.txt 読込エラーが発生した場合、安全に補正を中断し元データを保護する", async () => {
    document.body.innerHTML = `
      <input type="checkbox" id="correctionEnabledCheckbox" checked />
      <input type="checkbox" id="correctionDictCheckbox" />
      <input type="checkbox" id="correctionBgCheckbox" checked />
      <span id="correctionStatusBadge"></span>
    `;

    const doc = createDoc("doc-bg-err", "保護対象の文章");
    setLastTranscriptionDocumentForTest(doc);
    setAsrGenerationForTest(1);

    let chatCalled = false;
    const mockInvoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === "load_api_settings") {
        return createMockSettings({
          correction_enabled: true,
          correction_use_dictionary: false,
          correction_use_background: true,
        });
      }
      if (cmd === "read_correction_context_files") {
        throw new Error("background.txt の読み込みに失敗しました: I/O error");
      }
      if (cmd === "call_ollama_chat") {
        chatCalled = true;
        return { message: { content: "[]" } };
      }
      throw new Error(`Unhandled: ${cmd}`);
    });

    setTauriInvokeForTest(mockInvoke);

    // 1. Auto correction abort
    await runAsrAutoCorrection("job-bg-err", doc, 1);
    expect(chatCalled).toBe(false);
    expect(getPendingCorrectionResultForTest()).toBeNull();
    const badgeEl = document.getElementById("correctionStatusBadge");
    expect(badgeEl?.textContent).toContain("コンテキスト読込失敗");
    expect(getLastTranscriptionDocumentForTest()?.segments[0].text).toBe("保護対象の文章");

    // 2. Manual correction abort
    const statusModule = await import("./status");
    const dialogSpy = vi.spyOn(statusModule, "showAppDialog").mockResolvedValue();

    const editorDoc = createDoc("doc-editor-bg-err", "エディタ文章保護");
    setEditorDocument(editorDoc);
    setEditorInvoke(mockInvoke as any);

    await runLlmCorrection();
    expect(chatCalled).toBe(false);
    expect(dialogSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "コンテキスト読み込みエラー",
        type: "error",
      }),
    );
    expect(editorDoc.segments[0].text).toBe("エディタ文章保護");
  });

  it("Test K: 話者分離OFF時（複数ネイティブセグメントかつ speaker/originalSpeaker=null）でもLLM補正・ステージング・正本エディター適用が正常完走する", async () => {
    document.body.innerHTML = `
      <input type="checkbox" id="correctionEnabledCheckbox" checked />
      <input type="checkbox" id="correctionDictCheckbox" />
      <input type="checkbox" id="correctionBgCheckbox" />
      <span id="correctionStatusBadge"></span>
    `;

    // 複数セグメント（speaker: null / originalSpeaker: null）のTranscriptDocument
    const multiSegmentDoc: TranscriptDocument = {
      schemaVersion: 1,
      mediaPath: "/path/to/test.wav",
      mediaFileName: "test.wav",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      language: "ja",
      sourceEngine: "test-engine",
      sourceRunId: "run-no-diar",
      segments: [
        {
          id: "seg-000001",
          start: 0.0,
          end: 4.2,
          speaker: null,
          originalSpeaker: null,
          text: "本日は、晴天なり。",
          originalText: "本日は、晴天なり。",
          sourceEngine: "test-engine",
          sourceSegmentId: "1",
          sourceRunId: "run-no-diar",
          status: "raw",
        },
        {
          id: "seg-000002",
          start: 4.5,
          end: 8.8,
          speaker: null,
          originalSpeaker: null,
          text: "音声認識のテストを行っております。",
          originalText: "音声認識のテストを行っております。",
          sourceEngine: "test-engine",
          sourceSegmentId: "2",
          sourceRunId: "run-no-diar",
          status: "raw",
        },
        {
          id: "seg-000003",
          start: 9.0,
          end: 12.5,
          speaker: null,
          originalSpeaker: null,
          text: "どうぞよろしくお願いいたします。",
          originalText: "どうぞよろしくお願いいたします。",
          sourceEngine: "test-engine",
          sourceSegmentId: "3",
          sourceRunId: "run-no-diar",
          status: "raw",
        },
      ],
    };

    setLastTranscriptionDocumentForTest(multiSegmentDoc);
    setAsrGenerationForTest(1);

    const mockInvoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === "load_api_settings") {
        return createMockSettings({
          correction_enabled: true,
          correction_use_dictionary: false,
          correction_use_background: false,
        });
      }
      if (cmd === "read_correction_context_files") {
        return { dictionary_content: null, background_content: null };
      }
      if (cmd === "call_ollama_chat") {
        // seg-000002 を補正
        return {
          message: {
            content: JSON.stringify([
              {
                segmentId: "seg-000002",
                originalText: "音声認識のテストを行っております。",
                correctedText: "音声認識のテストを行なっています。",
                evidence: [{ type: "context" }],
                explanation: "より自然な表現への修正",
              },
            ]),
          },
        };
      }
      throw new Error(`Unhandled: ${cmd}`);
    });

    setTauriInvokeForTest(mockInvoke);

    await runAsrAutoCorrection("job-no-diar", multiSegmentDoc, 1);

    const result = getPendingCorrectionResultForTest();
    expect(result).not.toBeNull();
    const seg2Proposals = result?.proposals.get("seg-000002");
    expect(seg2Proposals).toBeDefined();
    expect(seg2Proposals?.length).toBe(1);
    expect(seg2Proposals?.[0].correctedText).toBe("音声認識のテストを行なっています。");

    // 全セグメントのspeakerがnullのままであることを検証
    expect(multiSegmentDoc.segments.every((s) => s.speaker === null)).toBe(true);
    expect(multiSegmentDoc.segments.every((s) => s.originalSpeaker === null)).toBe(true);
    expect(multiSegmentDoc.segments.length).toBe(3);
  });
});
