import type { TranscriptDocument } from "./transcript";
import type { CorrectionProposal, CorrectionMode } from "./correction";
import {
  type MultiAsrOrchestrationResult,
  type MultiAsrProgress,
  type EngineExecutionRecord,
  type MultiAsrEngineSpec,
  runMultiAsrOrchestration,
} from "./multi-asr-orchestrator";
import { isEditorDirty, confirmDiscardChanges } from "./editor";
import { escapeHtml } from "./docker";
import { resolveCorrectionProvider } from "./correction-settings";
import { loadCorrectionContext } from "./correction-context";
import { OllamaSynthesisProvider } from "./synthesis-provider";

/**
 * 実行排他ロックのステータス型
 */
export type ActiveAsrExecutionType = "none" | "single" | "multi";

/**
 * Staging可能なMulti-ASR結果型 (success または partial_asr_only に限定)
 */
export type StagedMultiAsrStatus = Extract<
  MultiAsrOrchestrationResult,
  { status: "success" | "partial_asr_only" }
>;

/**
 * Staged Multi-ASR 結果構造
 */
export interface StagedMultiAsrResult {
  runId: string;
  generation: number;
  result: StagedMultiAsrStatus;
  createdAt: string;
}

/**
 * Multi-ASR UI内部ステート
 */
export interface MultiAsrUiState {
  executionType: ActiveAsrExecutionType;
  currentExecutionOwnerId: string | null;
  multiAsrRunGeneration: number;
  fileSelectionGeneration: number;
  selectedAudioDurationSec: number | null;
  currentProgress: MultiAsrProgress | null;
  staging: StagedMultiAsrResult | null;
  lastFailedResult: {
    error: string;
    engineRecords: EngineExecutionRecord[];
  } | null;
}

const state: MultiAsrUiState = {
  executionType: "none",
  currentExecutionOwnerId: null,
  multiAsrRunGeneration: 0,
  fileSelectionGeneration: 0,
  selectedAudioDurationSec: null,
  currentProgress: null,
  staging: null,
  lastFailedResult: null,
};

// ==========================================
// 1. 排他制御ロック (Execution Lock)
// ==========================================

export function getActiveExecutionType(): ActiveAsrExecutionType {
  return state.executionType;
}

export function isAsrRunning(): boolean {
  return state.executionType !== "none";
}

export function acquireExecutionLock(
  type: "single" | "multi",
  ownerId: string
): boolean {
  if (state.executionType !== "none") {
    return false;
  }
  state.executionType = type;
  state.currentExecutionOwnerId = ownerId;
  updateStartButtonsDomState();
  return true;
}

export function releaseExecutionLock(ownerId: string): void {
  if (state.currentExecutionOwnerId === ownerId) {
    state.executionType = "none";
    state.currentExecutionOwnerId = null;
    updateStartButtonsDomState();
  }
}

export function updateStartButtonsDomState(): void {
  const singleBtn = document.getElementById("startBtn") as HTMLButtonElement | null;
  const multiBtn = document.getElementById("startMultiAsrBtn") as HTMLButtonElement | null;
  const cancelMultiBtn = document.getElementById("cancelMultiAsrBtn") as HTMLButtonElement | null;

  const running = state.executionType !== "none";
  const isMultiRunning = state.executionType === "multi";

  if (singleBtn) {
    singleBtn.disabled = running;
  }
  if (multiBtn) {
    // 音声長が未解決または実行中は disabled
    const durationValid =
      typeof state.selectedAudioDurationSec === "number" &&
      state.selectedAudioDurationSec > 0;
    multiBtn.disabled = running || !durationValid;
    multiBtn.innerHTML = isMultiRunning
      ? `<span class="material-symbols-outlined transcription-hourglass">hourglass_top</span>
         <span class="btn-primary-text">Multi-ASR 実行中...</span>`
      : `<span class="material-symbols-outlined">auto_awesome</span>
         <span class="btn-primary-text">Multi-ASRで文字起こし</span>`;
  }
  if (cancelMultiBtn) {
    cancelMultiBtn.style.display = isMultiRunning ? "inline-flex" : "none";
    cancelMultiBtn.disabled = !isMultiRunning;
    const cancelLabel = cancelMultiBtn.querySelector("span:last-child");
    if (cancelLabel) {
      cancelLabel.textContent = "Multi-ASR中止";
    }
  }
}

// ==========================================
// 2. 音声長取得 & ファイル選択世代ガード
// ==========================================

export function getSelectedAudioDurationSec(): number | null {
  return state.selectedAudioDurationSec;
}

export function setSelectedAudioDurationSecForTest(duration: number | null): void {
  state.selectedAudioDurationSec = duration;
}

export function getFileSelectionGeneration(): number {
  return state.fileSelectionGeneration;
}

let customAudioFactory: (() => any) | null = null;

export function setAudioFactoryForTest(factory: (() => any) | null): void {
  customAudioFactory = factory;
}

export async function resolveMediaDuration(
  filePath: string,
  isCurrentCheck: () => boolean,
  convertUrlFn?: (path: string) => string
): Promise<number> {
  return new Promise(async (resolve, reject) => {
    try {
      let resolvedUrl: string;
      if (convertUrlFn) {
        resolvedUrl = convertUrlFn(filePath);
      } else {
        try {
          const { convertFileSrc } = await import("@tauri-apps/api/core");
          resolvedUrl = convertFileSrc(filePath);
        } catch {
          resolvedUrl = filePath;
        }
      }

      const audio = customAudioFactory ? customAudioFactory() : new Audio();
      let cleanedUp = false;

      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        audio.removeEventListener("loadedmetadata", onLoaded);
        audio.removeEventListener("error", onError);
        audio.src = "";
      };

      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error("音声メタデータの取得がタイムアウトしました (5秒)"));
      }, 5000);

      const onLoaded = () => {
        clearTimeout(timeoutId);
        if (!isCurrentCheck()) {
          cleanup();
          reject(new Error("Superseded by newer file selection"));
          return;
        }
        const dur = audio.duration;
        cleanup();
        if (typeof dur === "number" && Number.isFinite(dur) && dur > 0) {
          resolve(dur);
        } else {
          reject(new Error(`無効な音声長が取得されました: ${dur}`));
        }
      };

      const onError = () => {
        clearTimeout(timeoutId);
        cleanup();
        reject(new Error("音声メタデータの読み込みに失敗しました"));
      };

      audio.addEventListener("loadedmetadata", onLoaded);
      audio.addEventListener("error", onError);
      audio.src = resolvedUrl;
    } catch (err) {
      reject(err);
    }
  });
}

export async function handleAudioFileSelection(
  filePath: string,
  convertUrlFn?: (path: string) => string
): Promise<number | null> {
  state.fileSelectionGeneration++;
  const currentGen = state.fileSelectionGeneration;

  // 新規ファイル選択時に即時リセット
  state.selectedAudioDurationSec = null;
  updateStartButtonsDomState();

  try {
    const duration = await resolveMediaDuration(
      filePath,
      () => currentGen === state.fileSelectionGeneration,
      convertUrlFn
    );

    // 遅延完了時に世代が同一であることのみ採用
    if (currentGen === state.fileSelectionGeneration) {
      state.selectedAudioDurationSec = duration;
      updateStartButtonsDomState();
      return duration;
    }
    return null;
  } catch (err) {
    if (currentGen === state.fileSelectionGeneration) {
      state.selectedAudioDurationSec = null;
      updateStartButtonsDomState();
    }
    return null;
  }
}

// ==========================================
// 3. Multi-ASR Run Generation & State
// ==========================================

export function getMultiAsrRunGeneration(): number {
  return state.multiAsrRunGeneration;
}

export function incrementMultiAsrRunGeneration(): number {
  state.multiAsrRunGeneration++;
  return state.multiAsrRunGeneration;
}

export function getMultiAsrStaging(): StagedMultiAsrResult | null {
  return state.staging;
}

export function setMultiAsrStaging(staging: StagedMultiAsrResult | null): void {
  state.staging = staging;
}

export function setMultiAsrProgress(progress: MultiAsrProgress | null): void {
  state.currentProgress = progress;
}

export function getMultiAsrProgress(): MultiAsrProgress | null {
  return state.currentProgress;
}

export function setMultiAsrLastFailed(
  failed: { error: string; engineRecords: EngineExecutionRecord[] } | null
): void {
  state.lastFailedResult = failed;
}

export function resetMultiAsrUiStateForTest(): void {
  state.executionType = "none";
  state.currentExecutionOwnerId = null;
  state.multiAsrRunGeneration = 0;
  state.fileSelectionGeneration = 0;
  state.selectedAudioDurationSec = null;
  state.currentProgress = null;
  state.staging = null;
  state.lastFailedResult = null;
}

// ==========================================
// 4. UI Rendering & DOM Sync
// ==========================================

export function formatPartialAsrReasonMessage(
  reason: "single_engine_only" | "no_segment_timing_anchor" | "no_aligned_candidates"
): { title: string; explanation: string } {
  switch (reason) {
    case "single_engine_only":
      return {
        title: "1つのASRエンジンのみ成功",
        explanation:
          "1つのASRエンジンのみ正常完了したため、複数ASRの統合補正はスキップされました。",
      };
    case "no_segment_timing_anchor":
      return {
        title: "区間タイムスタンプを持つAnchorが不在",
        explanation:
          "時間区間情報を持つASR結果が得られなかったため、複数ASRの統合補正はスキップされました。",
      };
    case "no_aligned_candidates":
      return {
        title: "照合候補なし (統合スキップ)",
        explanation:
          "複数ASRの結果を取得しましたが、同一区間として安全に対応付けられる候補がなかったため、統合補正はスキップされました。",
      };
  }
}

export function syncMultiAsrUiFromState(container: ParentNode = document): void {
  const progressSection = container.querySelector("#multiAsrProgressSection") as HTMLElement | null;
  const resultSection = container.querySelector("#multiAsrResultSection") as HTMLElement | null;

  updateStartButtonsDomState();

  // 1. 実行中 Progress
  if (state.executionType === "multi" && state.currentProgress) {
    if (progressSection) {
      progressSection.style.display = "";
      const textEl = progressSection.querySelector(".multi-asr-progress-text");
      const barEl = progressSection.querySelector(".multi-asr-progress-bar") as HTMLElement | null;
      if (textEl) {
        textEl.textContent = state.currentProgress.message;
      }
      if (barEl) {
        barEl.style.width = `${state.currentProgress.percent}%`;
      }
    }
  } else if (progressSection) {
    progressSection.style.display = "none";
  }

  // 2. Staging / Result Card
  if (state.executionType === "none" && resultSection) {
    let html = "";
    if (state.lastFailedResult) {
      html += renderFailedCardHtml(state.lastFailedResult);
    }
    if (state.staging) {
      html += renderStagingCardHtml(state.staging);
    }
    if (html) {
      resultSection.style.display = "";
      resultSection.innerHTML = html;
    } else {
      resultSection.style.display = "none";
      resultSection.innerHTML = "";
    }
  }
}

export function renderStagingCardHtml(staging: StagedMultiAsrResult): string {
  const res = staging.result;
  if (res.status === "success") {
    const isZeroProposal = res.staging.proposals.length === 0;
    const anchorEngine = res.staging.session.anchorEngineId;
    const proposalCount = res.staging.proposals.length;
    const totalCandidates = res.staging.alignment.groups.reduce(
      (sum, g) => sum + g.candidates.length,
      0
    );

    return `
      <div class="multi-asr-card card-success">
        <div class="card-header">
          <span class="material-symbols-outlined icon-success">
            ${isZeroProposal ? "check_circle" : "auto_awesome"}
          </span>
          <div class="card-header-titles">
            <h4 class="card-title">
              ${isZeroProposal ? "Multi-ASR 完了 (補正なし)" : `Multi-ASR 統合補正完了 (${proposalCount}件の提案)`}
            </h4>
            <span class="card-subtitle">Anchor: ${escapeHtml(anchorEngine)} | 照合候補: ${totalCandidates}件</span>
          </div>
        </div>
        <div class="card-body">
          <p class="card-description">
            ${
              isZeroProposal
                ? "複数ASRを比較照合しましたが、Anchorのテキストが最も妥当と判断されたため、修正提案はありませんでした。"
                : "複数ASRの時間軸照合とLLM統合補正が完了しました。エディターで差分をプレビュー・適用できます。"
            }
          </p>
          ${renderEngineSummaryList(res.staging.engineRecords)}
        </div>
        <div class="card-actions">
          <button id="btnOpenMultiAsrInEditor" class="btn btn-primary" type="button">
            <span class="material-symbols-outlined">edit_note</span>
            <span>${isZeroProposal ? "正本エディターで開く" : "統合候補をレビュー"}</span>
          </button>
        </div>
      </div>
    `;
  }

  if (res.status === "partial_asr_only") {
    const reasonInfo = formatPartialAsrReasonMessage(res.reason);
    const anchorEngine = res.session.anchorEngineId;

    return `
      <div class="multi-asr-card card-warning">
        <div class="card-header">
          <span class="material-symbols-outlined icon-warning">info</span>
          <div class="card-header-titles">
            <h4 class="card-title">${escapeHtml(reasonInfo.title)}</h4>
            <span class="card-subtitle">利用可能Engine: ${escapeHtml(anchorEngine)}</span>
          </div>
        </div>
        <div class="card-body">
          <p class="card-description">${escapeHtml(reasonInfo.explanation)}</p>
          ${renderEngineSummaryList(res.engineRecords)}
        </div>
        <div class="card-actions">
          <button id="btnOpenMultiAsrInEditor" class="btn btn-secondary" type="button">
            <span class="material-symbols-outlined">edit_note</span>
            <span>ASR結果を開く (${escapeHtml(anchorEngine)})</span>
          </button>
        </div>
      </div>
    `;
  }

  return "";
}

export function renderFailedCardHtml(failed: {
  error: string;
  engineRecords: EngineExecutionRecord[];
}): string {
  return `
    <div class="multi-asr-card card-error">
      <div class="card-header">
        <span class="material-symbols-outlined icon-error">error</span>
        <div class="card-header-titles">
          <h4 class="card-title">Multi-ASR 処理エラー</h4>
        </div>
      </div>
      <div class="card-body">
        <p class="card-error-text">${escapeHtml(failed.error)}</p>
        ${renderEngineSummaryList(failed.engineRecords)}
      </div>
    </div>
  `;
}

function renderEngineSummaryList(records: EngineExecutionRecord[]): string {
  if (!records || records.length === 0) return "";
  const items = records
    .map((r) => {
      const isSuccess = r.status === "success";
      const badgeClass = isSuccess ? "status-success" : "status-failed";
      const statusText = isSuccess ? "完了" : "失敗";
      const timingText = r.timingGranularity === "segment" ? "区間単位" : "全体単位";
      return `
        <li class="engine-record-item">
          <span class="engine-name">${escapeHtml(r.displayName || r.engineId)}</span>
          <span class="engine-badge ${badgeClass}">[${statusText}]</span>
          <span class="engine-timing">${isSuccess ? timingText : escapeHtml(r.error || "")}</span>
        </li>
      `;
    })
    .join("");

  return `
    <div class="engine-summary-container">
      <div class="engine-summary-header">各エンジン実行結果:</div>
      <ul class="engine-record-list">${items}</ul>
    </div>
  `;
}

// ==========================================
// 5. 安全な Editor Handoff トランザクション
// ==========================================

export interface PreparedHandoffData {
  document: TranscriptDocument;
  proposalsMap: Map<string, CorrectionProposal[]> | null;
}

export function prepareHandoffData(
  staging: StagedMultiAsrResult
): PreparedHandoffData | null {
  if (!staging || !staging.result) return null;

  if (staging.result.status === "success") {
    const session = staging.result.staging.session;
    const anchorResult = session.results[session.anchorEngineId];
    if (!anchorResult?.document) return null;

    const proposalsMap = new Map<string, CorrectionProposal[]>();
    for (const prop of staging.result.staging.proposals) {
      const list = proposalsMap.get(prop.segmentId) || [];
      list.push(prop);
      proposalsMap.set(prop.segmentId, list);
    }

    return {
      document: anchorResult.document,
      proposalsMap,
    };
  }

  if (staging.result.status === "partial_asr_only") {
    const session = staging.result.session;
    const anchorResult = session.results[session.anchorEngineId];
    if (!anchorResult?.document) return null;

    return {
      document: anchorResult.document,
      proposalsMap: null,
    };
  }

  return null;
}

export async function executeEditorHandoff(
  staging: StagedMultiAsrResult,
  navigateTo: (page: any) => Promise<any>,
  setEditorDocWithProposals: (
    doc: TranscriptDocument,
    proposals: Map<string, CorrectionProposal[]>,
    filePath: string | null
  ) => void,
  setEditorDoc: (doc: TranscriptDocument, filePath: string | null) => void,
  renderEditor: (nav: any) => void
): Promise<boolean> {
  // 1. 事前準備 & 検証 (失敗時はEditor状態に一切触らない)
  const prepared = prepareHandoffData(staging);
  if (!prepared) {
    throw new Error("Multi-ASR Staging データの準備に失敗しました");
  }

  // 2. Dirty Guard
  if (isEditorDirty()) {
    const confirmed = await confirmDiscardChanges();
    if (!confirmed) {
      return false; // キャンセルされたため何もしない
    }
  }

  // 3. ナビゲーション実行
  const navResult = await navigateTo("editor");
  if (navResult !== "completed") {
    return false; // ナビゲーションが完了しなかった場合はEditor状態を変更しない
  }

  // 4. ナビゲーション確定後にアトミックにドキュメント置換
  if (prepared.proposalsMap && prepared.proposalsMap.size > 0) {
    setEditorDocWithProposals(prepared.document, prepared.proposalsMap, null);
  } else {
    setEditorDoc(prepared.document, null);
  }
  renderEditor(navigateTo);

  // 5. Staging を安全にクリア
  if (state.staging === staging) {
    state.staging = null;
  }

  return true;
}

// ==========================================
// 6. Multi-ASR UI 実行エントリポイント
// ==========================================

export interface StartMultiAsrUiOptions {
  targetFilePath?: string;
  duration?: number | null;
  invokeFn?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  engines?: MultiAsrEngineSpec[];
  showDialogFn?: (dialog: { title: string; message: string; type?: "error" | "info" | "success" }) => Promise<void> | void;
  onJobIdChange?: (jobId: string | null) => void;
  isCancelled?: () => boolean;
  useDictionary?: boolean;
  useBackground?: boolean;
}

export function createDefaultMultiAsrEngines(
  invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>,
  onJobIdChange?: (jobId: string | null) => void
): MultiAsrEngineSpec[] {
  const configs: Array<{ engineId: string; displayName: string; timingGranularity: "segment" | "whole_audio" }> = [
    { engineId: "kotoba-whisper", displayName: "Kotoba Whisper v2.0", timingGranularity: "segment" },
    { engineId: "reazonspeech", displayName: "ReazonSpeech v2.0", timingGranularity: "whole_audio" },
    { engineId: "qwen3-asr", displayName: "Qwen3 ASR", timingGranularity: "whole_audio" },
  ];

  return configs.map(({ engineId, displayName, timingGranularity }) => ({
    engineId,
    displayName,
    timingGranularity,
    runTranscription: async (mediaPath: string) => {
      const currentEngineJobId = crypto.randomUUID();
      onJobIdChange?.(currentEngineJobId);
      try {
        const res = await invokeFn<{ document?: TranscriptDocument }>("local_asr_transcribe", {
          jobId: currentEngineJobId,
          audioPath: mediaPath,
          outputPath: "",
          outputFormats: ["txt", "vtt"],
          engine: engineId,
          saveToDisk: false,
        });
        if (!res || !res.document) {
          throw new Error(`${displayName} の Document が生成されませんでした`);
        }
        return res.document;
      } finally {
        onJobIdChange?.(null);
      }
    },
  }));
}

export async function startMultiAsrFromUi(options: StartMultiAsrUiOptions = {}): Promise<void> {
  const targetFilePath = options.targetFilePath;
  const showDialog = options.showDialogFn ?? (async (dialog) => {
    try {
      const { showAppDialog } = await import("./status");
      await showAppDialog(dialog);
    } catch {
      console.error(dialog.title, dialog.message);
    }
  });

  if (!targetFilePath) {
    await showDialog({ title: "エラー", message: "音声ファイルを選択してください", type: "error" });
    return;
  }

  const duration = options.duration !== undefined ? options.duration : getSelectedAudioDurationSec();
  if (!duration || duration <= 0) {
    await showDialog({
      title: "エラー",
      message: "音声ファイルの再生時間を取得できませんでした。対応フォーマットの有効な音声ファイルであるか確認してください。",
      type: "error",
    });
    return;
  }

  const initialFileGen = getFileSelectionGeneration();
  const runId = crypto.randomUUID();
  if (!acquireExecutionLock("multi", runId)) {
    return;
  }

  const runGeneration = incrementMultiAsrRunGeneration();
  setMultiAsrLastFailed(null);
  syncMultiAsrUiFromState();

  const invokeFn = options.invokeFn ?? (async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  });

  const engines = options.engines ?? createDefaultMultiAsrEngines(invokeFn, options.onJobIdChange);
  const isCancelled = options.isCancelled ?? (() => false);

  const isStillCurrentRun = () =>
    runGeneration === getMultiAsrRunGeneration() &&
    initialFileGen === getFileSelectionGeneration();

  try {
    let synthesisProvider: OllamaSynthesisProvider;
    let correctionMode: CorrectionMode | undefined;
    try {
      const resolved = await resolveCorrectionProvider(invokeFn);
      if (!resolved || !resolved.model) {
        throw new Error("LLM補正プロバイダーまたはモデルが設定されていません。設定画面でLLMプロバイダーとモデルを設定してください。");
      }
      correctionMode = resolved.mode;
      synthesisProvider = new OllamaSynthesisProvider({
        baseUrl: resolved.baseUrl,
        model: resolved.model,
        invokeTauri: invokeFn,
      });
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      await showDialog({
        title: "エラー",
        message: `LLM補正プロバイダーの初期化に失敗しました: ${errorMsg}`,
        type: "error",
      });
      return;
    }

    if (!isStillCurrentRun() || isCancelled()) {
      return;
    }

    let useDictionary = options.useDictionary;
    if (useDictionary === undefined) {
      const dictCheckbox = document.getElementById("correctionDictCheckbox") as HTMLInputElement | null;
      useDictionary = dictCheckbox ? dictCheckbox.checked : true;
    }

    let useBackground = options.useBackground;
    if (useBackground === undefined) {
      const bgCheckbox = document.getElementById("correctionBgCheckbox") as HTMLInputElement | null;
      useBackground = bgCheckbox ? bgCheckbox.checked : true;
    }

    const contextLoadResult = await loadCorrectionContext({
      useDictionary,
      useBackground,
      invokeFn,
    });

    if (contextLoadResult.status !== "success") {
      throw new Error(contextLoadResult.message || "用語辞書・背景情報の読み込みに失敗しました");
    }

    const dictionary = contextLoadResult.dictionary;
    const context = contextLoadResult.context;

    if (!isStillCurrentRun() || isCancelled()) {
      return;
    }

    const result = await runMultiAsrOrchestration({
      mediaPath: targetFilePath,
      mediaFileName: targetFilePath.split(/[\\/]/).pop() ?? targetFilePath,
      expectedDurationSec: duration,
      engines,
      synthesisProvider,
      dictionary,
      context,
      mode: correctionMode,
      isCancelled,
      isCurrentRun: isStillCurrentRun,
      onProgress: (prog) => {
        if (!isStillCurrentRun() || isCancelled()) return;
        setMultiAsrProgress(prog);
        syncMultiAsrUiFromState();
      },
    });

    if (isStillCurrentRun()) {
      if (result.status === "success" || result.status === "partial_asr_only") {
        setMultiAsrStaging({
          runId,
          generation: runGeneration,
          result,
          createdAt: new Date().toISOString(),
        });
      } else if (result.status === "failed") {
        setMultiAsrLastFailed({
          error: result.error,
          engineRecords: result.engineRecords,
        });
      }
    }
  } catch (err) {
    if (isStillCurrentRun() && !isCancelled()) {
      setMultiAsrLastFailed({
        error: String(err),
        engineRecords: [],
      });
    }
  } finally {
    releaseExecutionLock(runId);
    setMultiAsrProgress(null);
    syncMultiAsrUiFromState();
  }
}

