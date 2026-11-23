import type { TranscriptDocument } from "./transcript";
import type {
  CorrectionProposal,
  CorrectionMode,
  CorrectionDictionaryEntry,
  CorrectionContext,
} from "./correction";
import {
  type MultiAsrOrchestrationResult,
  type MultiAsrProgress,
  type EngineExecutionRecord,
  type MultiAsrEngineSpec,
  type MultiAsrExecutionMode,
  runMultiAsrOrchestration,
} from "./multi-asr-orchestrator";
import { isEditorDirty, confirmDiscardChanges } from "./editor";
import { escapeHtml } from "./docker";
import { resolveCorrectionProvider, type SavedAppSettings } from "./correction-settings";
import { loadCorrectionContext } from "./correction-context";
import { OllamaSynthesisProvider } from "./synthesis-provider";
import {
  convertGoogleRawResponseToTranscriptDocument,
  type GoogleSttRawResponse,
} from "./google-stt";
import {
  OllamaCompareCorrectionProvider,
  type CompareCorrectionProvider,
} from "./compare-correction";
import type { TimingGranularity } from "./multi-asr";

/**
 * 実行排他ロックのステータス型
 */
export type ActiveAsrExecutionType = "none" | "single" | "multi";

/**
 * Staging可能なMulti-ASR結果型 (success / partial_asr_only / compare_ready)
 */
export type StagedMultiAsrStatus = Extract<
  MultiAsrOrchestrationResult,
  { status: "success" | "partial_asr_only" | "compare_ready" }
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

export function formatCompareTimestamp(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) {
    return "--:--.-";
  }
  const mins = Math.floor(sec / 60);
  const secs = Math.floor(sec % 60);
  const tenths = Math.floor((sec * 10) % 10);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${tenths}`;
}

function isCloudAsrEngineId(engineId: string): boolean {
  return engineId === "google_stt" || engineId === "xiaomi_mimo_asr" ||
    engineId.endsWith(":google_stt") || engineId.endsWith(":xiaomi_mimo_asr");
}

export function buildCompareExportPayload(
  res: Extract<MultiAsrOrchestrationResult, { status: "compare_ready" }>
) {
  return {
    schemaVersion: 1,
    mode: "compare" as const,
    anchorEngineId: res.designatedAnchorEngineId,
    anchorAvailable: res.anchorAvailable,
    anchorUnavailableReason: res.anchorUnavailableReason ?? null,
    partialAsrFailure: Boolean(res.partialAsrFailure),
    correctionStatus: res.correctionStatus ?? null,
    correctionError: res.correctionError ?? null,
    engineOrder: [...res.engineOrder],
    mediaPath: res.session.mediaPath,
    mediaFileName: res.session.mediaFileName,
    rawGoogleResponses: res.rawGoogleResponses ?? null,
    compareInput: res.compareInput ?? null,
    llmCorrections: res.llmCorrections ?? null,
    finalDocument: res.finalDocument ?? null,
    results: res.engineOrder.map((engineId) => {
      const record = res.engineRecords.find((r) => r.engineId === engineId);
      const engineResult = res.session.results[engineId];
      return {
        engineId,
        displayName: engineResult?.displayName ?? record?.displayName ?? engineId,
        status: record?.status ?? (engineResult ? "success" : "failed"),
        error: record?.error ?? null,
        timingGranularity: engineResult?.timingGranularity ?? record?.timingGranularity ?? null,
        isDesignatedAnchor: engineId === res.designatedAnchorEngineId,
        document: engineResult?.document ?? null,
      };
    }),
  };
}

function renderCompareColumnsHtml(
  res: Extract<MultiAsrOrchestrationResult, { status: "compare_ready" }>
): string {
  const columns = res.engineOrder
    .map((engineId, index) => {
      const isAnchor = engineId === res.designatedAnchorEngineId;
      const roleLabel = isAnchor
        ? res.anchorAvailable ? `ASRエンジン ${index + 1} (基準)` : `ASRエンジン ${index + 1} (基準時刻なし)`
        : `ASRエンジン ${index + 1}`;
      const record = res.engineRecords.find((r) => r.engineId === engineId);
      const engineResult = res.session.results[engineId];
      const displayName = engineResult?.displayName ?? record?.displayName ?? engineId;
      const isSuccess = Boolean(engineResult);
      const isGoogle = engineId === "cloud:google_stt";
      const timingNote = !isSuccess
        ? "失敗"
        : isAnchor
          ? res.anchorAvailable
            ? isGoogle
              ? "基準タイムスタンプ (Google単語単位)"
              : "基準タイムスタンプ (区間単位)"
            : res.anchorUnavailableReason === "invalid_anchor_timestamps"
              ? "基準利用不可 (タイムスタンプ不正)"
              : isGoogle
                ? "基準利用不可 (単語時刻なし)"
                : "基準利用不可 (全体単位)"
          : isCloudAsrEngineId(engineId)
            ? isGoogle
              ? "Google単語タイムスタンプ"
              : "時間情報なし (テキストのみ)"
          : `ASRエンジン ${index + 1}の独立タイムスタンプ (再配置なし)`;

      const segmentsHtml = isSuccess && engineResult
        ? engineResult.document.segments.length > 0
          ? engineResult.document.segments
            .map(
              (seg) => `
                <div class="compare-segment-item">
              <span class="compare-segment-time">${engineResult?.timingGranularity === "whole_audio" && isCloudAsrEngineId(engineId) ? "[時間情報なし]" : `[${formatCompareTimestamp(seg.start)} - ${formatCompareTimestamp(seg.end)}]`}</span>
                  <span class="compare-segment-text">${escapeHtml(seg.text)}</span>
                </div>
              `
            )
            .join("")
          : engineResult.document.transcriptTextWithoutTiming
            ? `<div class="compare-segment-item"><span class="compare-segment-time">[時間情報なし]</span><span class="compare-segment-text">${escapeHtml(engineResult.document.transcriptTextWithoutTiming)}</span></div>`
            : `<p class="card-description">文字起こしテキストがありません。</p>`
        : `<p class="card-error-text">${escapeHtml(record?.error || "文字起こしに失敗しました")}</p>`;

      return `
        <div class="multi-asr-compare-column" data-compare-engine="${escapeHtml(engineId)}">
          <div class="compare-column-header">
            <span class="compare-role-badge">${escapeHtml(roleLabel)}</span>
            <strong class="compare-engine-name">${escapeHtml(displayName)}</strong>
            <span class="engine-badge ${isSuccess ? "status-success" : "status-failed"}">[${isSuccess ? "完了" : "失敗"}]</span>
          </div>
          <div class="compare-timing-note">${escapeHtml(timingNote)}</div>
          <div class="compare-segments-list">${segmentsHtml}</div>
        </div>
      `;
    })
    .join("");

  return `<div class="multi-asr-compare-grid">${columns}</div>`;
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

  if (res.status === "compare_ready") {
    const anchorResult = res.session.results[res.designatedAnchorEngineId];
    const firstFallbackId = res.engineOrder.find((id) => Boolean(res.session.results[id]));
    const firstFallbackResult = firstFallbackId ? res.session.results[firstFallbackId] : undefined;
    const anchorRecord = res.engineRecords.find((r) => r.engineId === res.designatedAnchorEngineId);
    const anchorName = anchorResult?.displayName ?? anchorRecord?.displayName ?? res.designatedAnchorEngineId;

    const failedRecords = res.engineRecords.filter((r) => r.status === "failed");
    const hasCorrectedFinal =
      res.correctionStatus === "success" && Boolean(res.finalDocument);
    const hasCorrectionFailure = res.correctionStatus === "failed";

    const statusTitle = res.partialAsrFailure
      ? "Multi-ASR 部分成功 (片側ASR失敗・比較補正なし)"
      : hasCorrectedFinal
        ? "Multi-ASR 2エンジン比較LLM補正完了"
        : hasCorrectionFailure
          ? "Multi-ASR 比較LLM補正失敗 (生結果は保持)"
          : res.anchorAvailable
            ? "Multi-ASR 結果比較"
            : "Multi-ASR 結果比較 (基準時刻不在)";

    const anchorIndex = res.engineOrder.indexOf(res.designatedAnchorEngineId) + 1;
    const anchorLabel = `ASRエンジン ${anchorIndex || 1}`;
    const failedSummaryText = failedRecords
      .map((r) => `${r.displayName || r.engineId}: ${r.error || "不明なエラー"}`)
      .join(" / ");

    const statusDescription = res.partialAsrFailure
      ? `片方のASRが失敗したため比較補正は実行せず、成功した生結果のみを表示しています（単一ASR補正へ自動切替しません）。失敗: ${failedSummaryText}`
      : hasCorrectionFailure
        ? `LLM比較補正に失敗しました（${res.correctionError || "詳細不明"}）。補正済み最終結果は生成されていませんが、両エンジンの生結果は保持されています。`
        : hasCorrectedFinal
          ? `${anchorLabel}（${anchorName}）のタイムスタンプを基準として保持し、両エンジンの結果を比較してLLM補正済み最終結果を生成しました。`
          : res.anchorAvailable
            ? `${anchorLabel}（${anchorName}）の区間タイムスタンプを基準として保持し、両方の生結果を並べて比較しています。`
            : res.anchorUnavailableReason === "first_engine_failed"
              ? `${anchorLabel}（${anchorName}）が失敗したため基準タイムスタンプは不在です。もう一方を自動で基準へ切り替えず、時間基準付き比較は利用不可としています。`
              : res.anchorUnavailableReason === "invalid_anchor_timestamps"
                ? `${anchorLabel}（${anchorName}）のタイムスタンプが不正（負値・非有限・範囲外等）のため、基準タイムスタンプは不在です。もう一方を自動で基準へ切り替えず、時間基準付き比較は利用不可としています。`
                : `${anchorLabel}（${anchorName}）が区間タイムスタンプを持たないため、時間基準付き比較は利用不可です（生テキストのみ比較できます）。`;

    const apiAnchorHasNoTiming =
      !res.partialAsrFailure &&
      isCloudAsrEngineId(res.designatedAnchorEngineId) &&
      !res.anchorAvailable;
    const canOpenInEditor =
      !hasCorrectionFailure &&
      res.anchorUnavailableReason !== "invalid_anchor_timestamps" &&
      !apiAnchorHasNoTiming;
    const openTargetName = canOpenInEditor
      ? hasCorrectedFinal
        ? `${anchorName} 補正済み最終結果`
        : anchorResult?.displayName ?? firstFallbackResult?.displayName
      : undefined;
    const openBtnLabel = hasCorrectedFinal
      ? `補正済み最終結果を開く (${anchorName})`
      : res.anchorAvailable
        ? `基準結果を開く (${openTargetName})`
        : anchorResult
          ? `ASRエンジン ${anchorIndex || 1}の結果を開く (基準時刻なし: ${openTargetName})`
          : `結果を開く (基準外: ${openTargetName})`;

    const finalDocSectionHtml = hasCorrectedFinal && res.finalDocument
      ? `
        <div class="compare-final-result" id="compareFinalResultSection">
          <h5 class="compare-final-title">LLM比較補正済み最終結果 (基準: ${escapeHtml(anchorName)})</h5>
          <div class="compare-segments-list">
            ${res.finalDocument.segments
              .map(
                (seg) => `
                  <div class="compare-segment-item">
                    <span class="compare-segment-time">[${formatCompareTimestamp(seg.start)} - ${formatCompareTimestamp(seg.end)}]</span>
                    <span class="compare-segment-text">${escapeHtml(seg.text)}</span>
                  </div>
                `
              )
              .join("")}
          </div>
        </div>
      `
      : "";

    return `
      <div class="multi-asr-card ${res.anchorAvailable && !res.partialAsrFailure && !hasCorrectionFailure ? "card-success" : "card-warning"}">
        <div class="card-header">
          <span class="material-symbols-outlined ${res.anchorAvailable && !res.partialAsrFailure && !hasCorrectionFailure ? "icon-success" : "icon-warning"}">
            ${res.anchorAvailable && !res.partialAsrFailure && !hasCorrectionFailure ? "compare" : "info"}
          </span>
          <div class="card-header-titles">
            <h4 class="card-title">${escapeHtml(statusTitle)}</h4>
            <span class="card-subtitle">${res.anchorAvailable ? "基準エンジン" : "基準指定"}: ${escapeHtml(anchorLabel)} (${escapeHtml(anchorName)}) | 実行順: ${escapeHtml(res.engineOrder.map((id, index) => `エンジン${index + 1}: ${id}`).join(" → "))}</span>
          </div>
        </div>
        <div class="card-body">
          <p class="card-description">${escapeHtml(statusDescription)}</p>
          ${finalDocSectionHtml}
          ${renderCompareColumnsHtml(res)}
        </div>
        <div class="card-actions">
          ${
            openTargetName
              ? `<button id="btnOpenMultiAsrInEditor" class="btn btn-primary" type="button">
                   <span class="material-symbols-outlined">edit_note</span>
                   <span>${escapeHtml(openBtnLabel)}</span>
                 </button>`
              : ""
          }
          <button id="btnCopyMultiAsrCompareJson" class="btn btn-secondary" type="button">
            <span class="material-symbols-outlined">content_copy</span>
            <span>比較JSONをコピー</span>
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

  if (staging.result.status === "compare_ready") {
    const res = staging.result;
    if (res.correctionStatus === "failed") {
      return null;
    }
    if (res.correctionStatus === "success" && res.finalDocument) {
      return {
        document: res.finalDocument,
        proposalsMap: null,
      };
    }
    if (
      res.anchorUnavailableReason === "invalid_anchor_timestamps" ||
      (!res.partialAsrFailure && isCloudAsrEngineId(res.designatedAnchorEngineId) && !res.anchorAvailable)
    ) {
      return null;
    }
    const anchorDoc = res.session.results[res.designatedAnchorEngineId]?.document;
    if (anchorDoc) {
      return {
        document: anchorDoc,
        proposalsMap: null,
      };
    }
    const fallbackId = res.engineOrder.find((id) => Boolean(res.session.results[id]?.document));
    const fallbackDoc = fallbackId ? res.session.results[fallbackId]?.document : undefined;
    if (!fallbackDoc) return null;
    return {
      document: fallbackDoc,
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
  executionMode?: MultiAsrExecutionMode;
  engineOrder?: string[];
  anchorEngineId?: string;
  compareCorrectionProvider?: CompareCorrectionProvider;
  showDialogFn?: (dialog: { title: string; message: string; type?: "error" | "info" | "success" }) => Promise<void> | void;
  onJobIdChange?: (jobId: string | null, engineId?: string) => void;
  isCancelled?: () => boolean;
  useDictionary?: boolean;
  useBackground?: boolean;
  language?: string;
}

export const MULTI_ASR_ENGINE_CATALOG: ReadonlyArray<{
  engineId: string;
  displayName: string;
  timingGranularity: "segment" | "whole_audio";
}> = [
  { engineId: "kotoba-whisper", displayName: "Kotoba Whisper v2.0", timingGranularity: "segment" },
  { engineId: "reazonspeech", displayName: "ReazonSpeech v2.0", timingGranularity: "whole_audio" },
  { engineId: "qwen3-asr", displayName: "Qwen3 ASR", timingGranularity: "whole_audio" },
];

export const MULTI_ASR_API_ENGINE_CATALOG: ReadonlyArray<{ engineId: string; displayName: string }> = [
  { engineId: "google_stt", displayName: "Google Cloud Speech-to-Text" },
  { engineId: "xiaomi_mimo_asr", displayName: "Xiaomi MiMo Speech Recognition" },
];

export function createMultiAsrEnginesByOrder(
  engineOrder: string[] | undefined,
  invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>,
  onJobIdChange?: (jobId: string | null, engineId?: string) => void,
  language = "ja",
  rawGoogleResponses?: Record<string, GoogleSttRawResponse>,
  expectedDurationSec?: number,
): MultiAsrEngineSpec[] {
  const requested = engineOrder?.length ? engineOrder : ["local:kotoba-whisper", "local:reazonspeech", "local:qwen3-asr"];
  const configs = requested.map((choice) => {
    const separator = choice.indexOf(":");
    const sourceMode = separator > 0
      ? choice.slice(0, separator)
      : choice === "google_stt" || choice === "xiaomi_mimo_asr" ? "cloud" : "local";
    const engineId = separator > 0 ? choice.slice(separator + 1) : choice;
    const catalog = sourceMode === "cloud" ? MULTI_ASR_API_ENGINE_CATALOG : MULTI_ASR_ENGINE_CATALOG;
    const entry = catalog.find((item) => item.engineId === engineId);
    if (!entry || (sourceMode !== "cloud" && sourceMode !== "local")) return null;
    const timingGranularity: TimingGranularity | undefined =
      sourceMode === "cloud"
        ? (engineId === "google_stt" ? "segment" : "whole_audio")
        : ("timingGranularity" in entry ? (entry.timingGranularity as TimingGranularity) : undefined);
    return {
      choiceId: `${sourceMode}:${engineId}`,
      sourceMode,
      engineId,
      displayName: entry.displayName,
      timingGranularity,
    };
  }).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  return configs.map(({ choiceId, sourceMode, engineId, displayName, timingGranularity }) => ({
    engineId: choiceId,
    displayName,
    timingGranularity,
    runTranscription: async (mediaPath: string) => {
      const currentEngineJobId = crypto.randomUUID();
      onJobIdChange?.(currentEngineJobId, choiceId);
      try {
        if (sourceMode === "cloud") {
          const settings = await invokeFn<SavedAppSettings>("load_api_settings");
          const provider = settings.providers?.[engineId];
          let transcript = "";
          const mediaFileName = mediaPath.split(/[\\/]/).pop() || mediaPath;
          if (engineId === "google_stt") {
            const options = provider?.options ?? {};
            const projectId = options.project_id?.trim() ?? "";
            const location = options.location?.trim() ?? "";
            if (!projectId || !location) throw new Error("Google Speech-to-TextのプロジェクトIDとロケーションを設定してください");
            const langCode = language.toLowerCase().startsWith("en") ? "en-US" : language.toLowerCase().startsWith("zh") ? "cmn-Hans-CN" : "ja-JP";
            const result = await invokeFn<{
              transcript?: string;
              rawResponse?: GoogleSttRawResponse;
              raw_response?: GoogleSttRawResponse;
            }>("google_stt_recognize", {
              input: {
                projectId,
                location,
                recognizerId: options.recognizer_id?.trim() || "_",
                languageCode: langCode,
                model: "chirp_2",
                audioPath: mediaPath,
              },
            });
            transcript = result.transcript ?? "";
            const rawResponse = result.rawResponse ?? result.raw_response;
            if (rawResponse !== undefined) {
              if (rawGoogleResponses) {
                rawGoogleResponses[choiceId] = rawResponse;
              }
              const converted = convertGoogleRawResponseToTranscriptDocument({
                rawResponse,
                mediaPath,
                mediaFileName,
                language,
                sourceRunId: currentEngineJobId,
                expectedDurationSec,
                transcriptFallback: transcript,
              });
              if (converted.ok) {
                return converted.document;
              }
              if (transcript.trim() || converted.documentWithoutTiming.transcriptTextWithoutTiming?.trim()) {
                return converted.documentWithoutTiming;
              }
              throw new Error(converted.reason || `${displayName} から有効な単語タイムスタンプ付き結果が返されませんでした`);
            }
          } else if (engineId === "xiaomi_mimo_asr") {
            const apiLanguage = language.toLowerCase().startsWith("en") ? "en" : language.toLowerCase().startsWith("zh") ? "zh" : "auto";
            const result = await invokeFn<{ transcript?: string }>("xiaomi_mimo_asr_recognize", {
              input: {
                baseUrl: provider?.base_url?.trim() || "https://api.xiaomimimo.com/v1",
                model: provider?.default_model?.trim() || "mimo-v2.5-asr",
                language: apiLanguage,
                audioPath: mediaPath,
              },
            });
            transcript = result.transcript ?? "";
          } else {
            throw new Error(`未対応のASR APIです: ${engineId}`);
          }
          if (!transcript.trim()) {
            throw new Error(`${displayName} から文字起こしテキストが返されませんでした`);
          }
          const now = new Date().toISOString();
          return {
            schemaVersion: 1,
            mediaPath,
            mediaFileName,
            createdAt: now,
            updatedAt: now,
            language,
            sourceEngine: choiceId,
            sourceRunId: currentEngineJobId,
            // Keep text-only output out of timed segments: 0..0 would fabricate a timestamp.
            segments: [],
            transcriptTextWithoutTiming: transcript,
          };
        }
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
        onJobIdChange?.(null, choiceId);
      }
    },
  }));
}

export function createDefaultMultiAsrEngines(
  invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>,
  onJobIdChange?: (jobId: string | null, engineId?: string) => void
): MultiAsrEngineSpec[] {
  return createMultiAsrEnginesByOrder(undefined, invokeFn, onJobIdChange);
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

  const executionMode: MultiAsrExecutionMode = options.executionMode ?? "synthesis";
  const rawGoogleResponses: Record<string, GoogleSttRawResponse> = {};
  const engines =
    options.engines ??
    createMultiAsrEnginesByOrder(
      options.engineOrder,
      invokeFn,
      options.onJobIdChange,
      options.language ?? "ja",
      rawGoogleResponses,
      duration,
    );
  const anchorEngineId = executionMode === "compare" ? (options.anchorEngineId ?? engines[0]?.engineId) : undefined;
  if (executionMode === "compare" && anchorEngineId) {
    const hasGoogle = engines.some((e) => e.engineId === "cloud:google_stt" || e.engineId === "google_stt");
    if (hasGoogle && anchorEngineId !== "cloud:google_stt" && anchorEngineId !== "google_stt") {
      releaseExecutionLock(runId);
      setMultiAsrProgress(null);
      syncMultiAsrUiFromState();
      await showDialog({
        title: "エラー",
        message: "Google Speech-to-Textを比較に含める場合は、Googleをタイムスタンプ基準に選択してください。",
        type: "error",
      });
      return;
    }
    if (anchorEngineId === "cloud:xiaomi_mimo_asr" || anchorEngineId === "xiaomi_mimo_asr") {
      releaseExecutionLock(runId);
      setMultiAsrProgress(null);
      syncMultiAsrUiFromState();
      await showDialog({
        title: "エラー",
        message: "Xiaomi MiMo Speech Recognitionはタイムスタンプを返さないため、基準エンジンに選択できません。",
        type: "error",
      });
      return;
    }
  }
  const isCancelled = options.isCancelled ?? (() => false);

  const isStillCurrentRun = () =>
    runGeneration === getMultiAsrRunGeneration() &&
    initialFileGen === getFileSelectionGeneration();

  try {
    let synthesisProvider: OllamaSynthesisProvider | undefined;
    let compareCorrectionProvider: CompareCorrectionProvider | undefined = options.compareCorrectionProvider;
    let compareCorrectionInitError: string | undefined;
    let correctionMode: CorrectionMode | undefined;
    let dictionary: CorrectionDictionaryEntry[] | undefined;
    let context: CorrectionContext | undefined;

    if (executionMode === "synthesis") {
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

      dictionary = contextLoadResult.dictionary;
      context = contextLoadResult.context;

      if (!isStillCurrentRun() || isCancelled()) {
        return;
      }
    } else if (executionMode === "compare") {
      if (!compareCorrectionProvider) {
        try {
          const resolved = await resolveCorrectionProvider(invokeFn);
          if (!resolved || !resolved.model) {
            throw new Error("LLM補正プロバイダーまたはモデルが設定されていません。設定画面でLLMプロバイダーとモデルを設定してください。");
          }
          correctionMode = resolved.mode;
          compareCorrectionProvider = new OllamaCompareCorrectionProvider({
            baseUrl: resolved.baseUrl,
            model: resolved.model,
            invokeTauri: invokeFn,
          });
        } catch (e) {
          compareCorrectionInitError = e instanceof Error ? e.message : String(e);
        }
      } else {
        const resolved = await resolveCorrectionProvider(invokeFn).catch(() => null);
        if (resolved) {
          correctionMode = resolved.mode;
        }
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

      try {
        const contextLoadResult = await loadCorrectionContext({
          useDictionary,
          useBackground,
          invokeFn,
        });
        if (contextLoadResult.status === "success") {
          dictionary = contextLoadResult.dictionary;
          context = contextLoadResult.context;
        } else if (!compareCorrectionInitError) {
          compareCorrectionInitError = contextLoadResult.message || "用語辞書・背景情報の読み込みに失敗しました";
        }
      } catch (e) {
        if (!compareCorrectionInitError) {
          compareCorrectionInitError = e instanceof Error ? e.message : String(e);
        }
      }

      if (!isStillCurrentRun() || isCancelled()) {
        return;
      }
    }

    const result = await runMultiAsrOrchestration({
      mediaPath: targetFilePath,
      mediaFileName: targetFilePath.split(/[\\/]/).pop() ?? targetFilePath,
      expectedDurationSec: duration,
      engines,
      executionMode,
      anchorEngineId,
      synthesisProvider,
      compareCorrectionProvider,
      compareCorrectionInitError,
      rawGoogleResponses,
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
      if (
        result.status === "success" ||
        result.status === "partial_asr_only" ||
        result.status === "compare_ready"
      ) {
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

