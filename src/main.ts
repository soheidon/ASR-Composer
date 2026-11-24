import "./styles.css";
import { setStatusBadge, classifyFetchError, populateModelSelect, showAppDialog, showAppConfirm } from "./status";
import { asrProviders, llmProviders, cloudLlmProviders } from "./providers";
import type { ProviderDefinition } from "./providers";
import {
  createProviderConfigState,
  saveDirtyProviderConfig,
  prepareProviderForModelFetch,
  getGoogleSttProjectId,
  buildGoogleSttProjectOptions,
  setGoogleSttAdvancedOpen,
  ensureSelectValue,
  setGoogleSttStatus,
  invalidateGoogleSttVerification,
  getGoogleSttConfiguredState,
  setButtonLoading,
  restoreButtonLoading,
} from "./provider-config-save";
import {
  applyGoogleAuthStatusToSection,
  buildGoogleCloudSpeechConsoleUrl,
  canPromptSpeechApiEnable,
  isGoogleAuthResponseCurrent,
  isGoogleSttAvailableForTranscribe,
  parseGoogleApiError,
  shouldAutoRunDefaultOnboarding,
  type EnableSpeechApiResult,
  type GoogleAuthRevokeResult,
  type GoogleAuthStatus,
  type GoogleCloudListProjectsResult,
  type GoogleOnboardingResult,
  type SpeechApiEnableStateResult,
} from "./google-auth";
import {
  renderDockerStatusContent,
  renderHuggingFaceTokenSection,
  renderLocalAsrSection,
  renderLocalAsrInstallCache,
  renderLocalAsrEngineCard,
  getLocalAsrProgressDisplay,
  getLocalAsrDisplayName,
  getLocalAsrOptionPresentation,
  resolveLocalAsrState,
  escapeHtml,
} from "./docker";
import type { DockerStatus, HuggingFaceTokenStatus, HuggingFaceTokenSaveResult, LocalAsrEngineStatus, LocalAsrProgress, LocalAsrInstallState } from "./docker";
import {
  renderEditorPage,
  renderEditor,
  bindEditorEvents,
  confirmDiscardChanges,
  setEditorDocument,
  setEditorDocumentWithProposals,
  setEditorInvoke,
  isEditorDirty,
  formatTimestamp,
} from "./editor";
import {
  convertGoogleRawResponseToTranscriptDocument,
  type GoogleSttRawResponse,
} from "./google-stt";
import type { TranscriptDocument } from "./transcript";
import {
  type SavedAppSettings,
  type SavedProviderSettings,
  resolveCorrectionProvider,
  saveCorrectionSettings,
} from "./correction-settings";
import {
  runCorrectionForDocument,
  formatCorrectionProgress,
  type CorrectionProposal,
  type CorrectionMode,
} from "./correction";
import { OllamaCorrectionProvider } from "./ollama-provider";
import {
  loadCorrectionContext,
  openCorrectionFolder,
  openCorrectionFile,
} from "./correction-context";
import {
  acquireExecutionLock,
  releaseExecutionLock,
  handleAudioFileSelection,
  getSelectedAudioDurationSec,
  getMultiAsrStaging,
  syncMultiAsrUiFromState,
  executeEditorHandoff,
  startMultiAsrFromUi,
  buildCompareExportPayload,
  MULTI_ASR_ENGINE_CATALOG,
} from "./multi-asr-ui";
import type { MultiAsrExecutionMode } from "./multi-asr-orchestrator";

function getAppElement(): HTMLElement | null {
  return document.getElementById("app");
}

// ---- Tauri API Guard ----

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

let tauriWindow: any = null;
let invokeFn: InvokeFn | null = null;

async function initializeTauri(): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) {
    return;
  }
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const core = await import("@tauri-apps/api/core");
  tauriWindow = getCurrentWindow();
  invokeFn = core.invoke;
  setEditorInvoke(invokeFn);
  await setupWindowCloseGuard();
}

async function invokeTauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!invokeFn) {
    throw new Error("この操作はTauriアプリ内でのみ利用できます");
  }
  return invokeFn<T>(command, args);
}

export function setTauriInvokeForTest(fn: InvokeFn | null): void {
  invokeFn = fn;
}

// ---- Template Builders ----

function providerAccordionItem(p: ProviderDefinition, index: number): string {
  let detailBody: string;
  if (p.id === "google_stt") {
    detailBody = buildGoogleSttDetail(p);
  } else if (p.id === "xiaomi_mimo_asr") {
    detailBody = buildXiaomiMimoAsrDetail(p);
  } else {
    detailBody = buildStandardDetail(p);
  }

  return `
    <div class="accordion-item" data-index="${index}" data-provider-id="${p.id}">
      <button class="accordion-header accordion-header-collapsed" type="button" aria-expanded="false">
        <div class="accordion-header-left">
          <span class="material-symbols-outlined accordion-chevron">chevron_right</span>
          <div class="accordion-icon-circle">
            <span class="material-symbols-outlined">${p.icon}</span>
          </div>
          <span class="accordion-title">${p.company}</span>
          <span class="accordion-title-sub">${p.name}</span>
        </div>
        <div class="accordion-header-right">
          <span class="auto-save-status"></span>
          <span class="status-badge status-unconfigured" data-status-badge>
            <span class="status-dot status-dot-unconfigured"></span>未設定
          </span>
        </div>
      </button>
      <div class="accordion-detail" style="display:none">
        <div class="accordion-detail-inner">
          ${detailBody}
        </div>
      </div>
    </div>`;
}

function buildStandardDetail(p: ProviderDefinition): string {
  const modelSection = buildModelSection(p);
  return `
          <div class="api-field-group">
            <label class="api-field-label">環境変数 / APIキー</label>
            <div class="api-key-row">
              <input type="text" class="api-env-input" value="${p.env}" data-default-env="${p.env}" />
              <div class="api-key-input-wrap">
                <input type="password" class="api-key-input" placeholder="APIキーを入力" data-field="api-key" />
                <button class="api-visibility-btn" type="button" title="表示切替">
                  <span class="material-symbols-outlined">visibility</span>
                </button>
              </div>
              <button class="btn-api-save" type="button" data-provider-id="${p.id}">環境変数に保存</button>
            </div>
          </div>
          <div class="api-field-group">
            <label class="api-field-label">Base URL</label>
            <div class="api-baseurl-row">
              <input type="text" class="api-baseurl-input" value="${p.defaultBaseUrl}" data-default-url="${p.defaultBaseUrl}" data-field="base-url" />
              <button class="btn-reset-url" type="button">既定値に戻す</button>
            </div>
          </div>
          ${modelSection}
          <div class="api-actions">
            <button class="btn-test-send" type="button">
              <span class="material-symbols-outlined">cable</span>
              テスト送信
            </button>
          </div>`;
}

function buildGoogleSttDetail(_p: ProviderDefinition): string {
  return `
          <div class="google-stt-oauth-section">
            <div class="google-stt-adc-status-row">
              <span class="google-stt-adc-status" data-field="auth-state">Googleに未接続</span>
              <span class="google-stt-adc-quota" data-field="auth-account" hidden></span>
            </div>
            <p class="google-stt-project-error" data-field="auth-error" style="display:none;"></p>
            <div class="google-stt-oauth-actions">
              <button class="btn-google-auth-login" type="button">
                <span class="material-symbols-outlined">login</span>
                Googleにログイン
              </button>
              <button class="btn-google-auth-retry-consent" type="button" hidden>
                <span class="material-symbols-outlined">refresh</span>
                同意を再取得してログイン
              </button>
              <button class="btn-google-auth-switch" type="button" hidden>
                <span class="material-symbols-outlined">switch_account</span>
                アカウントを切り替える
              </button>
              <button class="btn-google-auth-logout" type="button" hidden>
                <span class="material-symbols-outlined">logout</span>
                ログアウト
              </button>
              <button class="btn-google-auth-revoke" type="button" hidden>
                <span class="material-symbols-outlined">link_off</span>
                Google側のアクセス権も取り消す
              </button>
            </div>
            <p class="google-stt-login-notice" data-field="login-notice">※ ログイン後、短い同梱音声（ja-JP）で接続確認を自動で行います（追加クリック不要）。</p>
            <p class="google-stt-revoke-note">※ アクセス権の取り消しは同じGoogle Cloud OAuthプロジェクトの他クライアントやトークンにも影響する可能性があります。</p>
            <div class="google-stt-onboarding-status" data-field="onboarding-status-panel" hidden>
              <span class="material-symbols-outlined spin">sync</span>
              <span data-field="onboarding-status-text">Google Cloudを準備しています…</span>
            </div>
            <div class="google-stt-api-panel" data-field="onboarding-action-panel" hidden>
              <p class="google-stt-api-panel-title" data-field="onboarding-action-title"></p>
              <p class="google-stt-api-panel-body" data-field="onboarding-action-reason"></p>
              <p class="google-stt-api-panel-meta" data-field="onboarding-action-meta" hidden></p>
              <div class="google-stt-api-panel-actions">
                <button class="btn-google-onboarding-retry" type="button" hidden>再試行</button>
                <button class="btn-google-onboarding-switch" type="button" hidden>アカウントを切り替える</button>
              </div>
            </div>
            <div class="google-stt-diagnostics">
              <span data-field="diag-project-list">Project一覧: 未取得</span>
              <span data-field="diag-project-state">選択Project ID: 未接続</span>
            </div>
            <p class="google-stt-setup-guidance" data-field="setup-guidance"></p>
            <div class="google-stt-legacy-banner" data-field="legacy-project-banner" hidden>
              <span>以前の設定値（<code data-field="legacy-project-value"></code>）があります。現在のGoogleアカウントでは未確認です。</span>
              <button class="btn-google-stt-confirm-legacy-project" type="button">このProject IDを確定</button>
            </div>
          </div>

          <div class="api-field-group">
            <label class="api-field-label">リージョン <span class="api-field-required">*</span></label>
            <select class="google-stt-location" data-field="location">
              <option value="us-central1">us-central1</option>
              <option value="asia-southeast1">asia-southeast1</option>
              <option value="europe-west4">europe-west4</option>
            </select>
          </div>

          <div class="api-field-group">
            <label class="api-field-label">認識言語</label>
            <select class="google-stt-language-code" data-field="language-code">
              <option value="ja-JP" selected>日本語（ja-JP）</option>
              <option value="en-US">英語（en-US）</option>
            </select>
          </div>

          <div class="api-field-group">
            <label class="api-field-label">認識モデル</label>
            <select class="model-select" data-field="model" disabled>
              <option value="chirp_2" selected>chirp_2</option>
            </select>
          </div>

          <div class="google-stt-advanced-toggle">
            <button type="button" class="btn-google-stt-advanced" data-field="advanced-toggle" aria-expanded="false">
              <span class="material-symbols-outlined accordion-chevron">chevron_right</span>
              別のProjectを使う・詳細設定
            </button>
          </div>
          <div class="google-stt-advanced-content" data-field="advanced-content" hidden>
            <div class="api-field-group">
              <label class="api-field-label">Google Cloud プロジェクト <span class="api-field-required">*</span></label>
              <div class="google-stt-project-row">
                <select class="google-stt-project-select" data-field="project-id-select" disabled>
                  <option value="">詳細設定を開くと取得します</option>
                </select>
                <input type="text" class="google-stt-project-input" data-field="project-id-input"
                       placeholder="Project IDを入力" hidden disabled />
                <button class="btn-google-stt-confirm-project" type="button" hidden disabled>
                  このProjectを使う
                </button>
                <button class="btn-google-stt-refresh-projects" type="button" disabled>
                  <span class="material-symbols-outlined">refresh</span>
                  再取得
                </button>
              </div>
              <p class="google-stt-project-error" data-field="project-error" style="display:none;"></p>
            </div>
            <div class="api-field-group">
              <label class="api-field-label">Recognizer ID</label>
              <input type="text" class="google-stt-recognizer-id" data-field="recognizer-id"
                     value="_" />
            </div>
            <div class="api-field-group">
              <label class="api-field-label">詳細な確認</label>
              <p class="google-stt-test-description">同梱された短い日本語音声（ja-JP）で手動接続テストを行います</p>
              <button class="btn-google-stt-builtin-test" type="button">
                <span class="material-symbols-outlined">mic</span>
                準備して接続テスト
              </button>
              <button class="btn-google-stt-select-file" type="button">
                <span class="material-symbols-outlined">folder_open</span>
                別の音声ファイルで試す
              </button>
              <span class="google-stt-selected-file" data-field="selected-file" style="display:none;"></span>
            </div>
          </div>

          <div class="google-stt-recognize-section">
            <div class="google-stt-api-panel" data-field="api-enable-confirm-panel" hidden>
              <p class="google-stt-api-panel-title">Speech-to-Text API がまだ有効化されていません</p>
              <p class="google-stt-api-panel-body">
                対象Project（<code data-field="enable-target-project"></code>）で
                <code data-field="enable-target-service">speech.googleapis.com</code> を有効化してから接続テストを再実行しますか？
              </p>
              <div class="google-stt-api-panel-actions">
                <button class="btn-google-stt-confirm-enable-api" type="button">有効化してテストを続行</button>
                <button class="btn-google-stt-cancel-enable-api" type="button">キャンセル</button>
              </div>
            </div>
            <div class="google-stt-api-panel google-stt-api-fallback" data-field="api-fallback-panel" hidden>
              <p class="google-stt-api-panel-title" data-field="fallback-title">API準備を続行できませんでした</p>
              <p class="google-stt-api-panel-body" data-field="fallback-reason"></p>
              <p class="google-stt-api-panel-meta">
                対象Project: <code data-field="fallback-project"></code>
                <span data-field="fallback-permission-wrap" hidden> / 必要な権限: <code data-field="fallback-permission"></code></span>
              </p>
              <div class="google-stt-api-panel-actions">
                <button class="btn-google-stt-open-console" type="button">Google Cloud Console で開く</button>
                <button class="btn-google-stt-recheck-api" type="button">状態を再確認</button>
              </div>
            </div>
            <div class="google-stt-result" data-field="recognize-result" style="display:none;"></div>
          </div>`;
}

function buildXiaomiMimoAsrDetail(p: ProviderDefinition): string {
  return `
          <div class="api-field-group">
            <label class="api-field-label">環境変数 / APIキー</label>
            <div class="api-key-row">
              <input type="text" class="api-env-input" value="${p.env}" data-default-env="${p.env}" />
              <div class="api-key-input-wrap">
                <input type="password" class="api-key-input" placeholder="APIキーを入力" data-field="api-key" />
                <button class="api-visibility-btn" type="button" title="表示切替">
                  <span class="material-symbols-outlined">visibility</span>
                </button>
              </div>
              <button class="btn-api-save" type="button" data-provider-id="${p.id}">環境変数に保存</button>
            </div>
          </div>
          <div class="api-field-group">
            <label class="api-field-label">Base URL</label>
            <div class="api-baseurl-row">
              <input type="text" class="api-baseurl-input" value="${p.defaultBaseUrl}" data-default-url="${p.defaultBaseUrl}" data-field="base-url" />
              <button class="btn-reset-url" type="button">既定値に戻す</button>
            </div>
          </div>
          <div class="api-field-group">
            <label class="api-field-label">認識言語</label>
            <select class="google-stt-language-code" data-field="language-code">
              <option value="auto" selected>自動検出（auto）</option>
              <option value="en">English（en）</option>
              <option value="zh">Chinese（zh）</option>
            </select>
          </div>
          <div class="api-field-group">
            <label class="api-field-label">認識モデル</label>
            <select class="model-select" data-field="model" disabled>
              <option value="mimo-v2.5-asr" selected>mimo-v2.5-asr</option>
            </select>
          </div>
          <div class="google-stt-advanced-toggle">
            <button type="button" class="btn-google-stt-advanced" data-field="advanced-toggle" aria-expanded="false">
              <span class="material-symbols-outlined accordion-chevron">chevron_right</span>
              詳細設定
            </button>
          </div>
          <div class="google-stt-advanced-content" data-field="advanced-content" hidden>
            <div class="api-field-group">
              <label class="api-field-label">詳細な確認</label>
              <button class="btn-google-stt-select-file btn-mimo-asr-select-file" type="button">
                <span class="material-symbols-outlined">folder_open</span>
                別の音声ファイルで試す
              </button>
            </div>
          </div>
          <div class="google-stt-recognize-section">
            <p class="google-stt-test-description">同梱された短い英語音声（en）で確認します</p>
            <button class="btn-google-stt-builtin-test btn-mimo-asr-builtin-test" type="button">
              <span class="material-symbols-outlined">mic</span>
              接続・認識テスト
            </button>
            <div class="google-stt-result" data-field="recognize-result" hidden></div>
          </div>`;
}

function buildModelSection(p: ProviderDefinition): string {
  if (p.modelSource === "manual" && !p.staticModels?.length) {
    // 手動入力のみ
    return `
    <div class="api-field-group">
      <label class="api-field-label">既定モデル</label>
      <div class="model-manual-row">
        <input type="text" class="model-manual-input" placeholder="モデルIDを入力" value="${p.defaultModel || ""}" data-field="model" />
      </div>
      <p class="model-hint">このプロバイダーはモデル一覧の自動取得に対応していません。モデルIDを直接入力してください。</p>
    </div>`;
  }

  if (p.modelSource === "static" && p.staticModels?.length) {
    // 固定リスト
    const options = p.staticModels.map(m =>
      `<option value="${m}" ${m === p.defaultModel ? "selected" : ""}>${m}</option>`
    ).join("");
    return `
    <div class="api-field-group">
      <label class="api-field-label">既定モデル</label>
      <div class="model-select-row">
        <select class="model-select" data-field="model">
          <option value="">モデルを選択...</option>
          ${options}
          ${p.allowManualModel ? '<option value="__manual__">モデルIDを直接入力...</option>' : ""}
        </select>
      </div>
      ${p.allowManualModel ? '<input type="text" class="model-manual-input" placeholder="モデルIDを入力" style="display:none;" data-field="model-manual" />' : ""}
    </div>`;
  }

  // modelSource === "api"
  const preferredOpts = (p.preferredModels || []).map(m =>
    `<option value="${m}" ${m === p.defaultModel ? "selected" : ""}>${m}</option>`
  ).join("");

  const fetchBtnLabel = "モデル一覧を取得";

  return `
    <div class="api-field-group">
      <label class="api-field-label">既定モデル</label>
      <div class="model-select-row">
        <select class="model-select" data-field="model">
          <option value="">モデルを選択...</option>
          ${preferredOpts ? `<optgroup label="推奨モデル">${preferredOpts}</optgroup>` : ""}
          ${p.allowManualModel ? '<option value="__manual__">モデルIDを直接入力...</option>' : ""}
        </select>
        <button class="btn-fetch-models" type="button" data-provider-id="${p.id}">
          <span class="material-symbols-outlined">refresh</span>
          ${fetchBtnLabel}
        </button>
      </div>
      ${p.allowManualModel ? '<input type="text" class="model-manual-input" placeholder="モデルIDを入力" style="display:none;" data-field="model-manual" />' : ""}
    </div>`;
}

function buildProviderSection(title: string, description: string, providers: ProviderDefinition[]): string {
  const cards = providers.map((p, i) => providerAccordionItem(p, i)).join("");
  return `
    <div class="api-section">
      <div class="api-section-header">
        <h4 class="api-section-title">${title}</h4>
        <p class="api-section-desc">${description}</p>
      </div>
      <div class="accordion-container">
        ${cards}
      </div>
    </div>`;
}

// ---- Page Templates ----

const transcribePage = `
  <main class="main-content">
    <div class="content-wrapper">

      <section class="section-card">
        <h3 class="section-header"><span class="section-title">入力ファイル</span></h3>
        <div class="drop-zone" id="dropZone">
          <div class="drop-zone-icon">
            <span class="material-symbols-outlined">upload_file</span>
          </div>
          <div class="drop-zone-content">
            <p class="drop-zone-text">音声ファイルをドロップするか、クリックして選択</p>
            <p class="drop-zone-hint">対応フォーマット: MP3, WAV, MP4, M4A, FLAC</p>
          </div>
          <button class="btn-ghost" id="selectFileBtn">ファイルを選択</button>
        </div>
      </section>

      <section class="section-card">
        <h3 class="section-header"><span class="section-title">音声認識設定</span></h3>
        <div class="engine-row" id="asrExecutionModeRow">
          <label class="field-label" for="asrExecutionModeSelect">実行方式</label>
          <div class="engine-select-wrap engine-select-wrap-execution-mode">
            <select class="engine-select" id="asrExecutionModeSelect">
              <option value="single" selected>1エンジン</option>
              <option value="compare">2エンジン（比較）</option>
            </select>
            <span class="material-symbols-outlined engine-select-arrow">arrow_drop_down</span>
          </div>
        </div>
        <div class="engine-row" id="singleAsrEngineRow">
          <label class="field-label">ASRエンジン</label>
          <div class="engine-select-wrap engine-select-wrap-mode">
            <select class="engine-select" id="asrModeSelect">
              <option value="cloud">API</option>
              <option value="local">ローカル</option>
            </select>
            <span class="material-symbols-outlined engine-select-arrow">arrow_drop_down</span>
          </div>
          <div class="engine-select-wrap engine-select-wrap-engine">
            <select class="engine-select" id="engineSelect">
              <!-- TypeScriptで動的に生成 -->
            </select>
            <span class="material-symbols-outlined engine-select-arrow">arrow_drop_down</span>
          </div>
          <button class="btn-icon" id="asrEngineSettingsBtn" title="ASRエンジン設定">
            <span class="material-symbols-outlined">tune</span>
          </button>
        </div>
        <div class="dual-asr-engine-group" id="dualAsrEngineRow" style="display:none;">
          <div class="engine-row dual-asr-engine-row">
            <label class="field-label dual-asr-engine-label" for="multiAsrFirstEngineSelect">
              <span>ASRエンジン 1</span>
            </label>
            <div class="engine-select-wrap engine-select-wrap-mode">
              <select class="engine-select" id="multiAsrFirstSourceModeSelect" aria-label="ASRエンジン1の実行先">
                <option value="local">ローカル</option>
                <option value="cloud">API</option>
              </select>
              <span class="material-symbols-outlined engine-select-arrow">arrow_drop_down</span>
            </div>
            <div class="engine-select-wrap engine-select-wrap-dual">
              <select class="engine-select" id="multiAsrFirstEngineSelect"></select>
              <span class="material-symbols-outlined engine-select-arrow">arrow_drop_down</span>
            </div>
          </div>
          <div class="engine-row dual-asr-engine-row">
            <label class="field-label dual-asr-engine-label" for="multiAsrSecondEngineSelect">ASRエンジン 2</label>
            <div class="engine-select-wrap engine-select-wrap-mode">
              <select class="engine-select" id="multiAsrSecondSourceModeSelect" aria-label="ASRエンジン2の実行先">
                <option value="local">ローカル</option>
                <option value="cloud">API</option>
              </select>
              <span class="material-symbols-outlined engine-select-arrow">arrow_drop_down</span>
            </div>
            <div class="engine-select-wrap engine-select-wrap-dual">
              <select class="engine-select" id="multiAsrSecondEngineSelect"></select>
              <span class="material-symbols-outlined engine-select-arrow">arrow_drop_down</span>
            </div>
          </div>
          <div class="engine-row dual-asr-engine-row" id="dualAsrAnchorRow">
            <label class="field-label dual-asr-engine-label" for="multiAsrAnchorSelect">タイムスタンプ基準</label>
            <div class="engine-select-wrap engine-select-wrap-dual">
              <select class="engine-select" id="multiAsrAnchorSelect" aria-label="タイムスタンプ基準エンジン">
                <option value="1">ASRエンジン 1</option>
                <option value="2">ASRエンジン 2</option>
              </select>
              <span class="material-symbols-outlined engine-select-arrow">arrow_drop_down</span>
            </div>
          </div>
          <p class="dual-asr-duplicate-warning" id="dualAsrAnchorWarning" style="display:none;"></p>
          <p class="dual-asr-duplicate-warning" id="dualAsrDuplicateWarning" style="display:none;">
            ASRエンジン1と2に同じエンジンは設定できません（別のエンジンを選択してください）。
          </p>
        </div>
        <div class="engine-row">
          <label class="field-label">音声の言語</label>
          <div class="engine-select-wrap engine-select-wrap-fixed">
            <select class="engine-select" id="langSelect">
              <!-- TypeScriptで動的に生成 -->
            </select>
            <span class="material-symbols-outlined engine-select-arrow">arrow_drop_down</span>
          </div>
          <label class="field-label-inline">話者分離</label>
          <div class="engine-select-wrap engine-select-wrap-compact">
            <select class="engine-select" id="speakerDiarizationSelect">
              <option value="true">する</option>
              <option value="false">しない</option>
            </select>
            <span class="material-symbols-outlined engine-select-arrow">arrow_drop_down</span>
          </div>
          <label class="field-label-inline" id="numSpeakersLabel">話者数</label>
          <div class="engine-select-wrap engine-select-wrap-compact" id="numSpeakersRow">
            <select class="engine-select" id="numSpeakersSelect">
              <option value="auto">自動</option>
              <option value="1">1人</option>
              <option value="2">2人</option>
              <option value="3">3人</option>
              <option value="4">4人</option>
              <option value="5">5人</option>
              <option value="6">6人</option>
              <option value="7">7人</option>
              <option value="8">8人</option>
            </select>
            <span class="material-symbols-outlined engine-select-arrow">arrow_drop_down</span>
          </div>
        </div>
      </section>

      <section class="section-card" id="correctionSection">
        <h3 class="section-header"><span class="section-title">補完</span></h3>
        <div class="engine-row" id="correctionRow" style="display: flex; align-items: center; flex-wrap: wrap; gap: 8px;">
          <label class="checkbox-label" style="margin-right: 12px; white-space: nowrap;">
            <input type="checkbox" id="correctionEnabledCheckbox" />
            <span>LLM補正</span>
          </label>
          <div id="correctionControlsRow" style="display: flex; align-items: center; flex: 1; min-width: 0; gap: 8px;">
            <label class="field-label-inline" style="margin-left: 0; white-space: nowrap;">Provider</label>
            <div class="engine-select-wrap engine-select-wrap-mode" style="flex: 0 0 110px;">
              <select class="engine-select" id="correctionProviderSelect">
                <option value="ollama">Ollama</option>
              </select>
              <span class="material-symbols-outlined engine-select-arrow">arrow_drop_down</span>
            </div>
            <label class="field-label-inline" style="margin-left: 8px; white-space: nowrap;">モデル</label>
            <div class="engine-select-wrap" style="flex: 1; min-width: 140px;">
              <select class="engine-select" id="correctionModelSelect">
                <option value="">（モデル一覧を取得中...）</option>
              </select>
              <span class="material-symbols-outlined engine-select-arrow">arrow_drop_down</span>
            </div>
            <label class="field-label-inline" style="margin-left: 8px; white-space: nowrap;">モード</label>
            <div class="engine-select-wrap engine-select-wrap-mode" style="flex: 0 0 110px;">
              <select class="engine-select" id="correctionModeSelect" title="補正モードを選択">
                <option value="minimal">最小修正</option>
                <option value="standard" selected>標準</option>
                <option value="aggressive">積極修正</option>
              </select>
              <span class="material-symbols-outlined engine-select-arrow">arrow_drop_down</span>
            </div>
            <button class="btn-icon" id="btnRefreshCorrectionModels" title="モデル一覧を再取得" type="button">
              <span class="material-symbols-outlined">refresh</span>
            </button>
            <button class="btn-icon" id="btnCorrectionSettings" title="Ollama設定を開く" type="button">
              <span class="material-symbols-outlined">tune</span>
            </button>
          </div>
        </div>
        <div class="correction-context-section" id="correctionContextSection" style="margin-top: 10px; display: flex; align-items: center; flex-wrap: wrap; gap: 16px;">
          <div class="field-row context-row" id="correctionDictRow" style="display: flex; align-items: center; flex: 1; min-width: 0; gap: 8px;">
            <label class="checkbox-label" style="white-space: nowrap;">
              <input type="checkbox" id="correctionDictCheckbox" checked />
              <span>辞書</span>
            </label>
            <input type="text" class="path-input" id="correctionDictFileInput" value="dictionary.csv" readonly style="flex: 1; min-width: 80px;" />
            <button class="btn-icon" id="btnOpenDictionaryFolder" type="button" title="フォルダを開く: 辞書ファイル（dictionary.csv）の保存先フォルダを開きます">
              <span class="material-symbols-outlined">folder_open</span>
            </button>
            <button class="btn-icon" id="btnOpenDictionaryFile" type="button" title="ファイルを開く: 辞書ファイル（dictionary.csv）をOS既定のアプリで開きます">
              <span class="material-symbols-outlined">description</span>
            </button>
          </div>
          <div class="field-row context-row" id="correctionBgRow" style="display: flex; align-items: center; flex: 1; min-width: 0; gap: 8px;">
            <label class="checkbox-label" style="white-space: nowrap;">
              <input type="checkbox" id="correctionBgCheckbox" checked />
              <span>背景情報</span>
            </label>
            <input type="text" class="path-input" id="correctionBgFileInput" value="background.txt" readonly style="flex: 1; min-width: 80px;" />
            <button class="btn-icon" id="btnOpenBackgroundFolder" type="button" title="フォルダを開く: 背景情報ファイル（background.txt）の保存先フォルダを開きます">
              <span class="material-symbols-outlined">folder_open</span>
            </button>
            <button class="btn-icon" id="btnOpenBackgroundFile" type="button" title="ファイルを開く: 背景情報ファイル（background.txt）をOS既定のテキストエディタで開きます">
              <span class="material-symbols-outlined">description</span>
            </button>
          </div>
        </div>
      </section>

      <section class="section-card">
        <h3 class="section-header"><span class="section-title">出力設定</span></h3>
        <div class="settings-grid">
          <div>
            <div class="path-label-row">
              <label class="field-label">保存先パス</label>
              <p class="path-hint">指定しない場合はデフォルトのダウンロードフォルダに保存されます</p>
            </div>
            <div class="path-row">
              <input type="text" class="path-input" id="outputPathInput" placeholder="/Users/username/Documents/Transcripts" />
              <button class="btn-icon" id="browseOutputPathBtn" title="フォルダを参照" type="button">
                <span class="material-symbols-outlined">folder_open</span>
              </button>
            </div>
          </div>
          <div>
            <label class="field-label">出力形式</label>
            <div class="format-options">
              <label class="format-option"><input type="checkbox" class="output-format-checkbox" value="txt" checked /><span>テキスト</span></label>
              <label class="format-option"><input type="checkbox" class="output-format-checkbox" value="json" /><span>JSON</span></label>
              <label class="format-option"><input type="checkbox" class="output-format-checkbox" value="md" /><span>Markdown</span></label>
              <label class="format-option"><input type="checkbox" class="output-format-checkbox" value="srt" /><span>SRT</span></label>
              <label class="format-option"><input type="checkbox" class="output-format-checkbox" value="csv" /><span>CSV</span></label>
              <label class="format-option"><input type="checkbox" class="output-format-checkbox" value="vtt" /><span>VTT</span></label>
            </div>
          </div>
        </div>
      </section>

      <div class="action-row">
        <button class="btn-primary" id="startBtn">
          <span class="material-symbols-outlined">play_circle</span>
          <span class="btn-primary-text">文字起こしを開始</span>
        </button>
        <button class="btn-danger" id="cancelBtn" style="display:none">
          <span class="material-symbols-outlined">cancel</span>
          <span>中止</span>
        </button>
        <button class="btn-danger" id="cancelMultiAsrBtn" style="display:none">
          <span class="material-symbols-outlined">cancel</span>
          <span>中止</span>
        </button>
      </div>

      <section class="section-card" id="multiAsrProgressSection" style="display:none">
        <h3 class="section-header"><span class="section-title">Multi-ASR 処理中</span></h3>
        <div class="multi-asr-progress-container">
          <div class="multi-asr-progress-text">準備中...</div>
          <div class="progress-bar-container">
            <div class="multi-asr-progress-bar" style="width: 0%;"></div>
          </div>
        </div>
      </section>

      <section class="section-card" id="multiAsrResultSection" style="display:none"></section>

      <section class="section-card" id="transcribeProgressSection" style="display:none">
        <h3 class="section-header"><span class="section-title">文字起こし中</span></h3>
        <div class="progress-stage" id="progressStage">準備中...</div>
      </section>

      <section class="section-card" id="resultSection" style="display:none">
        <h3 class="section-header">
          <span class="section-title">文字起こし結果</span>
          <span id="correctionStatusBadge" style="margin-left: 12px; font-size: 13px; font-weight: normal; color: var(--color-primary, #2563eb); display: none;"></span>
          <button class="btn btn-secondary btn-sm" id="btnCancelAutoCorrection" type="button" style="display: none; margin-left: 8px; font-size: 12px; padding: 2px 8px; height: 26px;">
            <span class="material-symbols-outlined" style="font-size: 16px;">cancel</span>
            キャンセル
          </button>
        </h3>
        <textarea class="result-textarea" id="resultText" readonly rows="15"></textarea>
        <div class="saved-files-info" id="savedFilesInfo" style="display:none"></div>
        <div class="result-actions">
          <button class="btn-ghost" id="copyResultBtn">コピー</button>
          <button class="btn-ghost" id="saveResultBtn">保存</button>
          <button class="btn-primary" id="openEditorBtn" style="display:none">
            <span class="material-symbols-outlined">edit_note</span>
            正本編集を開く
          </button>
        </div>
      </section>

    </div>
  </main>
`;

type SettingsPageId = "general" | "dictionary" | "background" | "api" | "ollama" | "docker";

function settingsPageToRoute(page: SettingsPageId): PageName {
  switch (page) {
    case "general": return "settings-general";
    case "dictionary": return "settings-dictionary";
    case "background": return "settings-background";
    case "api": return "settings";
    case "ollama": return "settings-ollama";
    case "docker": return "settings-docker";
  }
}

function buildSettingsSidebar(activePage: SettingsPageId): string {
  const generalActive = activePage === "general" ? " settings-nav-active" : "";
  const dictionaryActive = activePage === "dictionary" ? " settings-nav-active" : "";
  const backgroundActive = activePage === "background" ? " settings-nav-active" : "";
  const apiActive = activePage === "api" ? " settings-nav-active" : "";
  const ollamaActive = activePage === "ollama" ? " settings-nav-active" : "";
  const dockerActive = activePage === "docker" ? " settings-nav-active" : "";
  return `
    <aside class="settings-sidebar">
      <h2 class="settings-sidebar-title">設定</h2>
      <nav class="settings-nav">
        <button class="settings-nav-item${generalActive}" type="button" data-settings-page="general">
          <span class="material-symbols-outlined">tune</span>
          <span>基本設定</span>
        </button>
        <button class="settings-nav-item${dictionaryActive}" type="button" data-settings-page="dictionary">
          <span class="material-symbols-outlined">dictionary</span>
          <span>辞書</span>
        </button>
        <button class="settings-nav-item${backgroundActive}" type="button" data-settings-page="background">
          <span class="material-symbols-outlined">info</span>
          <span>背景情報</span>
        </button>
        <button class="settings-nav-item${apiActive}" type="button" data-settings-page="api">
          <span class="material-symbols-outlined" style="font-variation-settings: 'FILL' ${activePage === "api" ? "1" : "0"};">key</span>
          <span>API設定</span>
        </button>
        <button class="settings-nav-item${ollamaActive}" type="button" data-settings-page="ollama">
          <span class="material-symbols-outlined">smart_toy</span>
          <span>Ollama設定</span>
        </button>
        <button class="settings-nav-item${dockerActive}" type="button" data-settings-page="docker">
          <span class="material-symbols-outlined" style="font-variation-settings: 'FILL' ${activePage === "docker" ? "1" : "0"};">terminal</span>
          <span>ローカルASR環境</span>
        </button>
      </nav>
    </aside>`;
}

const settingsApiPage = `
  <div class="settings-layout">
    ${buildSettingsSidebar("api")}
    <div class="settings-content">
      <div class="settings-content-header">
        <h2 class="settings-content-title">API設定</h2>
      </div>
      <div class="settings-content-body">
        <div class="settings-content-inner">
          ${buildProviderSection("ASR用API連携", "文字起こしエンジン（ASR）の認証情報を管理します。", asrProviders)}
          ${buildProviderSection("補正LLM用API連携", "文字起こしの補正、翻訳、要約、統合処理に使用する言語モデル（LLM）の認証情報を管理します。", cloudLlmProviders)}
        </div>
      </div>
    </div>
  </div>
`;

const settingsOllamaPage = `
  <div class="settings-layout">
    ${buildSettingsSidebar("ollama")}
    <div class="settings-content">
      <div class="settings-content-header">
        <h2 class="settings-content-title">Ollama設定</h2>
      </div>
      <div class="settings-content-body">
        <div class="settings-content-inner">
          <div class="api-section">
            <div class="api-section-header">
              <h4 class="api-section-title">OllamaローカルLLM</h4>
              <p class="api-section-desc">ローカルで動作するOllamaモデルの接続先と既定モデルを設定します。</p>
            </div>
            <div class="accordion-item" data-provider-id="ollama">
              <div class="accordion-header accordion-header-expanded" style="cursor:default;">
                <div class="accordion-header-left">
                  <div class="accordion-icon-circle">
                    <span class="material-symbols-outlined">smart_toy</span>
                  </div>
                  <span class="accordion-title">Ollama</span>
                  <span class="accordion-title-sub">ローカルLLMランタイム</span>
                </div>
                <div class="accordion-header-right">
                  <span class="ollama-save-status" id="ollamaSaveStatus"></span>
                  <span class="status-badge status-unconfigured" data-status-badge>
                    <span class="status-dot status-dot-unconfigured"></span>未設定
                  </span>
                </div>
              </div>
              <div class="accordion-detail">
                <div class="accordion-detail-inner">
                  <div class="api-field-group">
                    <label class="api-field-label">エンドポイントURL</label>
                    <div class="api-baseurl-row">
                      <input type="text" class="api-baseurl-input" id="ollamaBaseUrl" value="http://localhost:11434" data-default-url="http://localhost:11434" data-field="base-url" />
                      <button class="btn-reset-url" type="button">既定値に戻す</button>
                    </div>
                  </div>
                  <div class="api-field-group">
                    <label class="api-field-label">既定モデル</label>
                    <div class="model-select-row">
                      <select class="model-select" id="ollamaModelSelect" data-field="model">
                        <option value="">モデルを選択...</option>
                        <option value="__manual__">モデルIDを直接入力...</option>
                      </select>
                      <button class="btn-fetch-models" type="button" data-provider-id="ollama">
                        <span class="material-symbols-outlined">refresh</span>
                        モデル一覧を取得
                      </button>
                    </div>
                    <input type="text" class="model-manual-input" id="ollamaModelManual" placeholder="モデルIDを入力" style="display:none;" data-field="model-manual" />
                  </div>
                  <div class="api-actions">
                    <button class="btn-test-send" type="button">
                      <span class="material-symbols-outlined">cable</span>
                      接続テスト
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
`;

// renderDockerStatusContent is imported from ./docker

const settingsDockerPage = `
  <div class="settings-layout">
    ${buildSettingsSidebar("docker")}
    <div class="settings-content">
      <div class="settings-content-header">
        <h2 class="settings-content-title">Docker設定</h2>
      </div>
      <div class="settings-content-body">
        <div class="settings-content-inner">
          <div class="api-section">
            <div class="api-section-header">
              <h4 class="api-section-title">Docker Desktop</h4>
              <p class="api-section-desc">話者分離を行う場合、pyannote.audio、PyTorch、TorchAudio、CUDAなどの依存関係を特定の組み合わせに固定する必要があるため、Docker環境を使用します。</p>
            </div>
            <div class="docker-status-container" id="dockerStatusContainer">
              ${renderDockerStatusContent(null)}
            </div>
          </div>
          <div class="api-section">
            <div class="api-section-header">
              <h4 class="api-section-title">Hugging Face認証</h4>
              <p class="api-section-desc">話者分離モデルなど、Hugging Face上のモデルを取得するためのアクセストークンを設定します。pyannoteの話者分離モデルを利用するには、利用条件に同意したアカウントのトークンが必要です。トークンは環境変数に保存されます。</p>
            </div>
            <div class="hf-token-container" id="hfTokenContainer">
              ${renderHuggingFaceTokenSection(null)}
            </div>
          </div>
          <div class="api-section">
            <div class="api-section-header">
              <h4 class="api-section-title">ローカルASR環境</h4>
              <p class="api-section-desc">ローカル音声認識モデルを使用して文字起こしを行うための環境を設定します。</p>
            </div>
            <div class="local-asr-container" id="localAsrContainer">
              ${renderLocalAsrSection({ kind: "loading" })}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>`;

// ---- Render ----

const settingsGeneralPage = `
  <div class="settings-layout">
    ${buildSettingsSidebar("general")}
    <div class="settings-content">
      <div class="settings-content-header">
        <h2 class="settings-content-title">基本設定</h2>
      </div>
      <div class="settings-content-body">
        <div class="settings-content-inner">
          <p>基本設定は今後追加予定です。</p>
        </div>
      </div>
    </div>
  </div>
`;

const settingsDictionaryPage = `
  <div class="settings-layout">
    ${buildSettingsSidebar("dictionary")}
    <div class="settings-content">
      <div class="settings-content-header">
        <h2 class="settings-content-title">辞書</h2>
      </div>
      <div class="settings-content-body">
        <div class="settings-content-inner">
          <p>辞書設定は今後追加予定です。</p>
        </div>
      </div>
    </div>
  </div>
`;

const settingsBackgroundPage = `
  <div class="settings-layout">
    ${buildSettingsSidebar("background")}
    <div class="settings-content">
      <div class="settings-content-header">
        <h2 class="settings-content-title">背景情報</h2>
      </div>
      <div class="settings-content-body">
        <div class="settings-content-inner">
          <p>背景情報は今後追加予定です。</p>
        </div>
      </div>
    </div>
  </div>
`;

export type WorkspacePage = "transcribe" | "editor" | "merge" | "settings";
export type PageName =
  | "transcribe"
  | "editor"
  | "merge"
  | "settings"
  | "settings-ollama"
  | "settings-docker"
  | "settings-dictionary"
  | "settings-background"
  | "settings-general";

const mergePage = `
  <main class="main-content">
    <div class="content-wrapper">
      <section class="section-card">
        <h3 class="section-header"><span class="section-title">統合処理</span></h3>
        <p style="color: var(--on-surface-variant); padding: 16px 0;">複数文字起こし結果の統合・比較機能は今後実装予定です。</p>
      </section>
    </div>
  </main>
`;

function getWorkspaceForPage(page: PageName): WorkspacePage {
  if (page.startsWith("settings")) {
    return "settings";
  }
  if (page === "editor") return "editor";
  if (page === "merge") return "merge";
  return "transcribe";
}

function renderHeader(activePage: PageName): string {
  const ws = getWorkspaceForPage(activePage);
  const transcribeActive = ws === "transcribe" ? "active" : "";
  const editorActive = ws === "editor" ? "active" : "";
  const mergeActive = ws === "merge" ? "active" : "";
  const settingsActive = ws === "settings" ? "active" : "";
  return `
  <header class="app-header">
    <div class="header-left">
      <img class="brand-icon" src="/icon.png" alt="" width="24" height="24" />
      <span class="brand-name">ASR Composer</span>
      <div class="header-divider"></div>
      <nav class="header-nav">
        <a class="nav-link ${transcribeActive}" href="#" data-page="transcribe">文字起こし</a>
        <a class="nav-link ${editorActive}" href="#" data-page="editor">正本編集</a>
        <a class="nav-link ${mergeActive}" href="#" data-page="merge">統合</a>
        <a class="nav-link ${settingsActive}" href="#" data-page="settings-general">設定</a>
      </nav>
    </div>
    <div class="header-drag-area" id="headerDragArea" aria-hidden="true"></div>
    <div class="header-right">
      <button type="button" class="window-btn" id="minimizeBtn" title="最小化" aria-label="最小化">
        <span class="material-symbols-outlined">remove</span>
      </button>
      <button type="button" class="window-btn" id="maximizeBtn" title="最大化" aria-label="最大化">
        <span class="material-symbols-outlined" id="maximizeIcon">crop_square</span>
      </button>
      <button type="button" class="window-btn window-btn-close" id="closeBtn" title="閉じる" aria-label="閉じる">
        <span class="material-symbols-outlined">close</span>
      </button>
    </div>
  </header>`;
}

let currentPage: PageName | null = null;
let sidebarDelegationBound = false;
let dockerPageLoadRevision = 0;

// ---- Local ASR Install State ----
const localAsrInstallStates = new Map<string, LocalAsrInstallState>();
const localAsrInstallPromises = new Map<string, Promise<void>>();
let localAsrProgressListenerPromise: Promise<void> | null = null;
let cachedLocalAsrStatuses: LocalAsrEngineStatus[] = [];
let cachedLocalAsrStatusesValid = false;
let transcribeLocalEnginesNeedRefresh = true;
let localAsrCacheEpoch = 0;
let localAsrTranscribePopulateRevision = 0;

function invalidateLocalAsrStatusCache(): void {
  localAsrCacheEpoch += 1;
  cachedLocalAsrStatusesValid = false;
  transcribeLocalEnginesNeedRefresh = true;
}

function hasTransientLocalAsrFailure(statuses: readonly LocalAsrEngineStatus[]): boolean {
  return statuses.some((s) => {
    const state = resolveLocalAsrState(s);
    return (
      state === "cli_missing" ||
      state === "engine_stopped" ||
      state === "context_error" ||
      state === "image_list_error"
    );
  });
}

function shouldRefreshTranscribeLocalEngines(): boolean {
  return (
    !cachedLocalAsrStatusesValid ||
    transcribeLocalEnginesNeedRefresh ||
    hasTransientLocalAsrFailure(cachedLocalAsrStatuses)
  );
}

// ---- Provider Config: Dirty / Revision / Save Queue ----

const providerConfigState = createProviderConfigState();

function showAutoSaveStatus(item: HTMLElement, message: string): void {
  const el = item.querySelector<HTMLElement>(".auto-save-status");
  if (!el) return;
  el.textContent = message;
  el.classList.add("visible");
  window.setTimeout(() => {
    if (el.isConnected) el.classList.remove("visible");
  }, 2000);
}

async function saveProviderConfigFromSection(
  providerId: string,
  section: HTMLElement,
): Promise<boolean> {
  const envInput = section.querySelector<HTMLInputElement>(".api-env-input");
  const baseUrlInput = section.querySelector<HTMLInputElement>('[data-field="base-url"]');
  const modelSelect = section.querySelector<HTMLSelectElement>('[data-field="model"]');
  const modelManualInput = section.querySelector<HTMLInputElement>('[data-field="model-manual"]');

  const envName = envInput?.value.trim() ?? "";
  const baseUrl = baseUrlInput?.value.trim() ?? "";

  // Google STT: options を読み取る
  const options: Record<string, string> = {};
  const projectId = getGoogleSttProjectId(section);
  const locationSelect = section.querySelector<HTMLSelectElement>('[data-field="location"]');
  const recognizerIdInput = section.querySelector<HTMLInputElement>('[data-field="recognizer-id"]');
  const languageCodeSelect = section.querySelector<HTMLSelectElement>('[data-field="language-code"]');

  if (projectId) options.project_id = projectId;
  if (locationSelect) {
    const v = locationSelect.value.trim();
    if (v) options.location = v;
  }
  if (recognizerIdInput) {
    const v = recognizerIdInput.value.trim();
    if (v) options.recognizer_id = v;
  }
  if (languageCodeSelect) {
    const v = languageCodeSelect.value.trim();
    if (v) options.language_code = v;
  }

  // Google STT 以外は envName が必須
  if (!envName && providerId !== "google_stt") return false;

  const selectedModel = modelSelect?.value.trim() ?? "";
  const defaultModel = selectedModel === "__manual__"
    ? (modelManualInput?.value.trim() ?? "")
    : selectedModel;

  const input: Record<string, unknown> = {
    providerId,
    envName: envName || null,
    baseUrl,
    defaultModel: defaultModel || null,
  };
  if (Object.keys(options).length > 0) {
    input.options = options;
  }

  try {
    await invokeTauri("save_provider_config", { input });

    showAutoSaveStatus(section, "自動保存済み");
    return true;
  } catch (e) {
    console.error("Failed to auto-save provider config:", e);
    showAutoSaveStatus(section, "保存に失敗しました");
    return false;
  }
}

// ---- ASR Engine Selection ----

type AvailableAsrProvider = {
  id: string;
  displayName: string;
};

function isAsrProviderConfigured(
  provider: ProviderDefinition,
  saved: SavedProviderSettings | undefined,
  googleAuthStatus: GoogleAuthStatus | null = currentGoogleAuthStatus,
): boolean {
  if (provider.id === "google_stt") {
    return isGoogleSttAvailableForTranscribe(googleAuthStatus, saved?.options?.location);
  }
  return Boolean(saved?.env_name);
}

let cloudEnginesPopulateGeneration = 0;

function updateCurrentGoogleAuthStatusIfNewer(status: GoogleAuthStatus): GoogleAuthStatus {
  if (
    !currentGoogleAuthStatus ||
    status.oauthClientIdFingerprint !== currentGoogleAuthStatus.oauthClientIdFingerprint ||
    status.state === "revoking" ||
    status.authGeneration >= currentGoogleAuthStatus.authGeneration
  ) {
    currentGoogleAuthStatus = status;
  }
  return currentGoogleAuthStatus;
}

async function loadConfiguredAsrProviders(): Promise<AvailableAsrProvider[]> {
  const settings = await invokeTauri<SavedAppSettings>("load_api_settings");
  const googleAuthStatus = await invokeTauri<GoogleAuthStatus>("google_auth_get_status")
    .then((status) => updateCurrentGoogleAuthStatusIfNewer(status))
    .catch(() => currentGoogleAuthStatus);
  return asrProviders
    .filter((provider) =>
      isAsrProviderConfigured(provider, settings.providers[provider.id], googleAuthStatus),
    )
    .map((provider) => ({
      id: provider.id,
      displayName: `${provider.company} ${provider.name}`,
    }));
}

async function populateCloudEngines(select: HTMLSelectElement): Promise<void> {
  const gen = ++cloudEnginesPopulateGeneration;
  const providers = await loadConfiguredAsrProviders();
  if (gen !== cloudEnginesPopulateGeneration || !select.isConnected) {
    return;
  }
  if (providers.length === 0) {
    select.innerHTML = `
      <option value="" selected disabled>
        設定済みのASR APIがありません
      </option>
    `;
    select.value = "";
    return;
  }
  select.innerHTML = providers
    .map(
      (provider) =>
        `<option value="${escapeHtml(provider.id)}">` +
        `${escapeHtml(provider.displayName)}` +
        `</option>`,
    )
    .join("");
}

async function populateLocalEngines(
  select: HTMLSelectElement,
  expectedNavId?: number,
): Promise<void> {
  const populateRevision = ++localAsrTranscribePopulateRevision;
  const epochAtStart = localAsrCacheEpoch;
  let statuses: LocalAsrEngineStatus[];
  try {
    statuses = await fetchLocalAsrStatuses(epochAtStart);
  } catch (e) {
    console.error("populateLocalEngines error:", e);
    if (
      populateRevision !== localAsrTranscribePopulateRevision ||
      (expectedNavId !== undefined && expectedNavId !== navigationGeneration) ||
      !select.isConnected
    ) {
      return;
    }
    transcribeLocalEnginesNeedRefresh = true;
    cachedLocalAsrStatusesValid = false;
    select.innerHTML = `
      <option value="" selected disabled>
        ローカルASR状態の確認に失敗しました（再試行してください）
      </option>
    `;
    select.value = "";
    return;
  }

  if (
    populateRevision !== localAsrTranscribePopulateRevision ||
    (expectedNavId !== undefined && expectedNavId !== navigationGeneration) ||
    !select.isConnected
  ) {
    return;
  }
  const modeSelect = document.getElementById("asrModeSelect") as HTMLSelectElement | null;
  if (modeSelect && modeSelect.value !== "local") {
    return;
  }

  const presentations = statuses.map((status) => getLocalAsrOptionPresentation(status));
  const available = presentations.filter((p) => p.selectable);
  const optionHtml = presentations
    .map((p) => {
      const disabled = p.selectable ? "" : "disabled";
      const titleAttr = p.reason ? ` title="${escapeHtml(p.reason)}"` : "";
      return (
        `<option value="${escapeHtml(p.engine)}" ${disabled}${titleAttr}>` +
        `${escapeHtml(p.label)}` +
        `</option>`
      );
    })
    .join("");

  if (available.length === 0) {
    const hasFailure = presentations.some(
      (p) =>
        p.state === "cli_missing" ||
        p.state === "engine_stopped" ||
        p.state === "context_error" ||
        p.state === "image_list_error",
    );
    const placeholder = hasFailure
      ? "Docker状態の確認に失敗しました（設定確認・再試行してください）"
      : "利用可能なローカルASRがありません（要インストールまたは更新）";
    select.innerHTML =
      `<option value="" selected disabled>${escapeHtml(placeholder)}</option>` +
      optionHtml;
    select.value = "";
    if (epochAtStart === localAsrCacheEpoch) {
      transcribeLocalEnginesNeedRefresh = hasTransientLocalAsrFailure(statuses);
    }
    return;
  }

  select.innerHTML = optionHtml;
  if (epochAtStart === localAsrCacheEpoch) {
    transcribeLocalEnginesNeedRefresh = hasTransientLocalAsrFailure(statuses);
  }
}

async function refreshTranscribeLocalEnginesIfActive(expectedNavId?: number): Promise<void> {
  const modeSelect = document.getElementById("asrModeSelect") as HTMLSelectElement | null;
  const engineSelect = document.getElementById("engineSelect") as HTMLSelectElement | null;
  if (!modeSelect || !engineSelect || modeSelect.value !== "local") {
    return;
  }
  const previousValue = engineSelect.value || lastLocalEngine;
  await populateLocalEngines(engineSelect, expectedNavId);
  if (
    (expectedNavId !== undefined && expectedNavId !== navigationGeneration) ||
    !engineSelect.isConnected ||
    modeSelect.value !== "local"
  ) {
    return;
  }
  if (hasSelectableOption(engineSelect, previousValue)) {
    engineSelect.value = previousValue;
  }
  lastLocalEngine = engineSelect.value || "";
}

function hasSelectableOption(select: HTMLSelectElement, value: string): boolean {
  if (!value) {
    return false;
  }
  return Array.from(select.options).some(
    (option) => option.value === value && !option.disabled,
  );
}

async function saveAsrSelection(): Promise<void> {
  const modeSelect = document.getElementById("asrModeSelect") as HTMLSelectElement | null;
  const engineSelect = document.getElementById("engineSelect") as HTMLSelectElement | null;
  const languageSelect = document.getElementById("langSelect") as HTMLSelectElement | null;
  const speakerSelect = document.getElementById("speakerDiarizationSelect") as HTMLSelectElement | null;
  const numSpeakersSelect = document.getElementById("numSpeakersSelect") as HTMLSelectElement | null;
  if (!modeSelect || !engineSelect) {
    return;
  }
  try {
    await invokeTauri("save_asr_selection", {
      mode: modeSelect.value,
      engine: engineSelect.value || "",
      language: languageSelect?.value || "",
      speakerDiarization: speakerSelect?.value !== "false",
      numSpeakers: numSpeakersSelect?.value || "auto",
    });
  } catch (error) {
    console.error("save_asr_selection error:", error);
  }
}

let lastCloudEngine = "";
let lastLocalEngine = "";

async function restoreAsrSelection(): Promise<void> {
  const settings = await invokeTauri<SavedAppSettings>("load_api_settings");
  const modeSelect = document.getElementById("asrModeSelect") as HTMLSelectElement | null;
  const engineSelect = document.getElementById("engineSelect") as HTMLSelectElement | null;
  if (!modeSelect || !engineSelect) {
    return;
  }
  const savedMode = settings.asr_mode === "local" ? "local" : "cloud";
  modeSelect.value = savedMode;

  if (savedMode === "local") {
    await populateLocalEngines(engineSelect);
    if (hasSelectableOption(engineSelect, settings.asr_engine)) {
      engineSelect.value = settings.asr_engine;
    }
    lastLocalEngine = engineSelect.value;
  } else {
    await populateCloudEngines(engineSelect);
    if (hasSelectableOption(engineSelect, settings.asr_engine)) {
      engineSelect.value = settings.asr_engine;
    }
    lastCloudEngine = engineSelect.value;
  }

  const restoredEngine = engineSelect.value || "";
  const savedLanguage = settings.asr_languages?.[restoredEngine] ?? "";
  populateLanguagesForEngine(restoredEngine, savedLanguage);

  const speakerSelect = document.getElementById("speakerDiarizationSelect") as HTMLSelectElement | null;
  if (speakerSelect) {
    speakerSelect.value = settings.speaker_diarization !== false ? "true" : "false";
  }

  const numSpeakersSelect = document.getElementById("numSpeakersSelect") as HTMLSelectElement | null;
  const numSpeakersRow = document.getElementById("numSpeakersRow");
  if (numSpeakersSelect) {
    const savedNum = settings.num_speakers || "auto";
    const hasOption = Array.from(numSpeakersSelect.options).some((o) => o.value === savedNum);
    numSpeakersSelect.value = hasOption ? savedNum : "auto";
    const isEnabled = speakerSelect?.value !== "false";
    numSpeakersSelect.disabled = !isEnabled;
    if (numSpeakersRow) {
      numSpeakersRow.style.opacity = isEnabled ? "" : "0.5";
    }
  }

  if (settings.asr_mode !== savedMode || settings.asr_engine !== restoredEngine) {
    await saveAsrSelection();
  }

  if (settings.output_path) {
    const outputInput = document.getElementById("outputPathInput") as HTMLInputElement | null;
    if (outputInput) outputInput.value = settings.output_path;
  }

  const execModeSelect = document.getElementById("asrExecutionModeSelect") as HTMLSelectElement | null;
  if (execModeSelect) {
    execModeSelect.value = settings.asr_execution_mode === "compare" ? "compare" : "single";
  }
  const firstMultiSelect = document.getElementById("multiAsrFirstEngineSelect") as HTMLSelectElement | null;
  const secondMultiSelect = document.getElementById("multiAsrSecondEngineSelect") as HTMLSelectElement | null;
  if (firstMultiSelect && secondMultiSelect) {
    const saved = Array.isArray(settings.multi_asr_engines) ? settings.multi_asr_engines : [];
    await populateDualAsrEngineOptions(saved, settings.multi_asr_source_mode === "cloud" ? "cloud" : "local");
  }
  const anchorSelect = document.getElementById("multiAsrAnchorSelect") as HTMLSelectElement | null;
  if (anchorSelect) {
    anchorSelect.value = settings.multi_asr_anchor_index === 2 ? "2" : "1";
    lastValidAnchorValue = anchorSelect.value;
  }
  syncDualAsrOptionAvailability();
  syncAsrExecutionModeVisibility();
  syncDualAsrAnchorUi();
}

async function loadAsrLanguages(): Promise<Record<string, string>> {
  try {
    const settings = await invokeTauri<SavedAppSettings>("load_api_settings");
    return settings.asr_languages ?? {};
  } catch {
    return {};
  }
}

function bindAsrModeSelect(): void {
  const modeSelect = document.getElementById("asrModeSelect") as HTMLSelectElement | null;
  const engineSelect = document.getElementById("engineSelect") as HTMLSelectElement | null;
  const languageSelect = document.getElementById("langSelect") as HTMLSelectElement | null;
  if (!modeSelect || !engineSelect) {
    return;
  }
  modeSelect.addEventListener("change", async () => {
    try {
      const savedLanguages = await loadAsrLanguages();
      if (modeSelect.value === "local") {
        lastCloudEngine = engineSelect.value || "";
        await populateLocalEngines(engineSelect);
        if (hasSelectableOption(engineSelect, lastLocalEngine)) {
          engineSelect.value = lastLocalEngine;
        }
        lastLocalEngine = engineSelect.value || "";
      } else {
        lastLocalEngine = engineSelect.value || "";
        await populateCloudEngines(engineSelect);
        if (hasSelectableOption(engineSelect, lastCloudEngine)) {
          engineSelect.value = lastCloudEngine;
        }
        lastCloudEngine = engineSelect.value || "";
      }
      const currentEngine = engineSelect.value || "";
      const savedLanguage = savedLanguages[currentEngine] ?? "";
      populateLanguagesForEngine(currentEngine, savedLanguage);
      await saveAsrSelection();
    } catch (e) {
      console.error("bindAsrModeSelect change handler error:", e);
    }
  });
  engineSelect.addEventListener("change", async () => {
    if (modeSelect.value === "local") {
      lastLocalEngine = engineSelect.value || "";
    } else {
      lastCloudEngine = engineSelect.value || "";
    }
    const currentEngine = engineSelect.value || "";
    const savedLanguages = await loadAsrLanguages();
    const savedLanguage = savedLanguages[currentEngine] ?? "";
    populateLanguagesForEngine(currentEngine, savedLanguage);
    void saveAsrSelection();
  });
  if (languageSelect) {
    languageSelect.addEventListener("change", () => {
      void saveAsrSelection();
    });
  }
  const speakerSelectEl = document.getElementById("speakerDiarizationSelect") as HTMLSelectElement | null;
  if (speakerSelectEl) {
    speakerSelectEl.addEventListener("change", () => {
      const numSpeakersSelect = document.getElementById("numSpeakersSelect") as HTMLSelectElement | null;
      const numSpeakersRow = document.getElementById("numSpeakersRow");
      const enabled = speakerSelectEl.value !== "false";
      if (numSpeakersSelect) {
        numSpeakersSelect.disabled = !enabled;
      }
      if (numSpeakersRow) {
        numSpeakersRow.style.opacity = enabled ? "" : "0.5";
      }
      void saveAsrSelection();
    });
  }
  const numSpeakersSelect = document.getElementById("numSpeakersSelect") as HTMLSelectElement | null;
  if (numSpeakersSelect) {
    numSpeakersSelect.addEventListener("change", () => {
      void saveAsrSelection();
    });
  }
}

function bindAsrEngineSettingsButton(): void {
  const button = document.getElementById("asrEngineSettingsBtn");
  button?.addEventListener("click", () => {
    const modeSelect = document.getElementById("asrModeSelect") as HTMLSelectElement | null;
    if (modeSelect?.value === "local") {
      void navigateTo("settings-docker");
    } else {
      void navigateTo("settings");
    }
  });
}

// ---- Correction Selection (補完) ----

export function updateCorrectionUiState(): void {
  const enabledCheckbox = document.getElementById("correctionEnabledCheckbox") as HTMLInputElement | null;
  const isEnabled = enabledCheckbox?.checked ?? false;

  const providerSelect = document.getElementById("correctionProviderSelect") as HTMLSelectElement | null;
  const modelSelect = document.getElementById("correctionModelSelect") as HTMLSelectElement | null;
  const refreshBtn = document.getElementById("btnRefreshCorrectionModels") as HTMLButtonElement | null;
  const settingsBtn = document.getElementById("btnCorrectionSettings") as HTMLButtonElement | null;
  const controlsRow = document.getElementById("correctionControlsRow") as HTMLElement | null;

  const dictCheckbox = document.getElementById("correctionDictCheckbox") as HTMLInputElement | null;
  const bgCheckbox = document.getElementById("correctionBgCheckbox") as HTMLInputElement | null;
  const dictRow = document.getElementById("correctionDictRow") as HTMLElement | null;
  const bgRow = document.getElementById("correctionBgRow") as HTMLElement | null;

  if (providerSelect) providerSelect.disabled = !isEnabled;
  if (modelSelect) modelSelect.disabled = !isEnabled;
  if (refreshBtn) refreshBtn.disabled = !isEnabled;
  if (settingsBtn) settingsBtn.disabled = !isEnabled;
  if (controlsRow) controlsRow.style.opacity = isEnabled ? "" : "0.5";

  if (dictCheckbox) dictCheckbox.disabled = !isEnabled;
  if (bgCheckbox) bgCheckbox.disabled = !isEnabled;
  if (dictRow) dictRow.style.opacity = isEnabled ? "" : "0.5";
  if (bgRow) bgRow.style.opacity = isEnabled ? "" : "0.5";
}

let savedCorrectionModel = "";
let correctionModelExplicitlySelected = false;

export function isCorrectionModelExplicitlySelectedForTest(): boolean {
  return correctionModelExplicitlySelected;
}

export function getSavedCorrectionModelForTest(): string {
  return savedCorrectionModel;
}

export function setSavedCorrectionModelForTest(model: string, explicitlySelected = true): void {
  savedCorrectionModel = model;
  correctionModelExplicitlySelected = explicitlySelected;
}

export async function saveCorrectionSelection(): Promise<void> {
  const enabledCheckbox = document.getElementById("correctionEnabledCheckbox") as HTMLInputElement | null;
  const providerSelect = document.getElementById("correctionProviderSelect") as HTMLSelectElement | null;
  const modeSelect = document.getElementById("correctionModeSelect") as HTMLSelectElement | null;
  const dictCheckbox = document.getElementById("correctionDictCheckbox") as HTMLInputElement | null;
  const bgCheckbox = document.getElementById("correctionBgCheckbox") as HTMLInputElement | null;

  const enabled = enabledCheckbox?.checked ?? false;
  const provider = providerSelect?.value || "ollama";
  const model = correctionModelExplicitlySelected ? savedCorrectionModel : "";
  const mode = (modeSelect?.value as CorrectionMode) || "standard";
  const useDictionary = dictCheckbox?.checked ?? true;
  const useBackground = bgCheckbox?.checked ?? true;

  try {
    await saveCorrectionSettings({
      correction_enabled: enabled,
      correction_provider: provider,
      correction_model: model,
      correction_mode: mode,
      correction_use_dictionary: useDictionary,
      correction_use_background: useBackground,
    }, invokeTauri);
  } catch (error) {
    console.error("saveCorrectionSelection error:", error);
  }
}

export function populateCorrectionModelSelect(
  select: HTMLSelectElement,
  models: string[] | null | undefined,
  currentModel?: string,
): void {
  select.innerHTML = "";
  const modelList = Array.isArray(models) ? models : [];
  const targetModel = (currentModel && currentModel.trim().length > 0)
    ? currentModel.trim()
    : (savedCorrectionModel ? savedCorrectionModel.trim() : "");

  // 常に先頭に「Ollamaの既定モデルを使用」を配置
  const defaultOpt = document.createElement("option");
  defaultOpt.value = "";
  defaultOpt.textContent = "Ollamaの既定モデルを使用";
  if (!targetModel) {
    defaultOpt.selected = true;
  }
  select.appendChild(defaultOpt);

  if (modelList.length === 0) {
    if (targetModel) {
      const opt = document.createElement("option");
      opt.value = targetModel;
      opt.textContent = `${targetModel} (一覧取得失敗・未確認)`;
      opt.selected = true;
      select.appendChild(opt);
    }
    return;
  }

  let matched = false;
  for (const m of modelList) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    if (targetModel && m === targetModel) {
      opt.selected = true;
      matched = true;
    }
    select.appendChild(opt);
  }

  if (targetModel && !matched) {
    const opt = document.createElement("option");
    opt.value = targetModel;
    opt.textContent = `${targetModel} (未検出)`;
    opt.selected = true;
    select.insertBefore(opt, defaultOpt.nextSibling);
  }
}

export async function fetchCorrectionModelsForSelect(selectedModel?: string): Promise<void> {
  const modelSelect = document.getElementById("correctionModelSelect") as HTMLSelectElement | null;
  if (!modelSelect) return;

  const modelToPreserve = selectedModel !== undefined ? selectedModel : savedCorrectionModel;

  if (cachedOllamaModels && cachedOllamaModels.length > 0) {
    populateCorrectionModelSelect(modelSelect, cachedOllamaModels, modelToPreserve);
    return;
  }

  modelSelect.innerHTML = '<option value="">（モデル一覧を取得中...）</option>';

  try {
    const models = await invokeTauri<string[]>("fetch_models", { providerId: "ollama" });
    cachedOllamaModels = models;
    populateCorrectionModelSelect(modelSelect, models, modelToPreserve);
  } catch (e) {
    console.error("fetch_models (ollama) error for correction:", e);
    modelSelect.innerHTML = "";
    if (modelToPreserve) {
      const defaultOpt = document.createElement("option");
      defaultOpt.value = "";
      defaultOpt.textContent = "Ollamaの既定モデルを使用";
      selectAppendSafe(modelSelect, defaultOpt);

      const opt = document.createElement("option");
      opt.value = modelToPreserve;
      opt.textContent = `${modelToPreserve} (一覧取得失敗・未確認)`;
      opt.selected = true;
      modelSelect.appendChild(opt);
    } else {
      const defaultOpt = document.createElement("option");
      defaultOpt.value = "";
      defaultOpt.textContent = "Ollamaの既定モデルを使用";
      defaultOpt.selected = true;
      modelSelect.appendChild(defaultOpt);
    }
  }
}

function selectAppendSafe(select: HTMLSelectElement, opt: HTMLOptionElement): void {
  select.appendChild(opt);
}

export async function restoreCorrectionSelection(): Promise<void> {
  let settings: SavedAppSettings;
  try {
    settings = await invokeTauri<SavedAppSettings>("load_api_settings");
  } catch (e) {
    console.error("restoreCorrectionSelection failed to load settings:", e);
    return;
  }

  const enabledCheckbox = document.getElementById("correctionEnabledCheckbox") as HTMLInputElement | null;
  const providerSelect = document.getElementById("correctionProviderSelect") as HTMLSelectElement | null;
  const modelSelect = document.getElementById("correctionModelSelect") as HTMLSelectElement | null;
  const modeSelect = document.getElementById("correctionModeSelect") as HTMLSelectElement | null;
  const dictCheckbox = document.getElementById("correctionDictCheckbox") as HTMLInputElement | null;
  const bgCheckbox = document.getElementById("correctionBgCheckbox") as HTMLInputElement | null;

  if (enabledCheckbox) {
    enabledCheckbox.checked = settings.correction_enabled === true;
  }
  if (providerSelect) {
    providerSelect.value = settings.correction_provider || "ollama";
  }
  if (modeSelect) {
    modeSelect.value = (settings.correction_mode as string) || "standard";
  }
  if (dictCheckbox) {
    dictCheckbox.checked = settings.correction_use_dictionary !== false;
  }
  if (bgCheckbox) {
    bgCheckbox.checked = settings.correction_use_background !== false;
  }

  updateCorrectionUiState();

  const explicitModel = settings.correction_model?.trim() || "";
  savedCorrectionModel = explicitModel;
  correctionModelExplicitlySelected = explicitModel.length > 0;

  await fetchCorrectionModelsForSelect(explicitModel);
  if (modelSelect) {
    modelSelect.value = explicitModel;
  }
}

function bindCorrectionSelection(): void {
  const enabledCheckbox = document.getElementById("correctionEnabledCheckbox") as HTMLInputElement | null;
  const providerSelect = document.getElementById("correctionProviderSelect") as HTMLSelectElement | null;
  const modelSelect = document.getElementById("correctionModelSelect") as HTMLSelectElement | null;
  const modeSelect = document.getElementById("correctionModeSelect") as HTMLSelectElement | null;
  const refreshBtn = document.getElementById("btnRefreshCorrectionModels") as HTMLButtonElement | null;
  const settingsBtn = document.getElementById("btnCorrectionSettings") as HTMLButtonElement | null;
  const dictCheckbox = document.getElementById("correctionDictCheckbox") as HTMLInputElement | null;
  const bgCheckbox = document.getElementById("correctionBgCheckbox") as HTMLInputElement | null;

  enabledCheckbox?.addEventListener("change", async () => {
    updateCorrectionUiState();
    await saveCorrectionSelection();
  });

  providerSelect?.addEventListener("change", async () => {
    await saveCorrectionSelection();
  });

  modeSelect?.addEventListener("change", async () => {
    await saveCorrectionSelection();
  });

  dictCheckbox?.addEventListener("change", async () => {
    await saveCorrectionSelection();
  });

  bgCheckbox?.addEventListener("change", async () => {
    await saveCorrectionSelection();
  });

  modelSelect?.addEventListener("change", async () => {
    if (modelSelect.value && modelSelect.value.trim() !== "") {
      savedCorrectionModel = modelSelect.value.trim();
      correctionModelExplicitlySelected = true;
    } else {
      savedCorrectionModel = "";
      correctionModelExplicitlySelected = false;
    }
    await saveCorrectionSelection();
  });

  refreshBtn?.addEventListener("click", async () => {
    cachedOllamaModels = null;
    await fetchCorrectionModelsForSelect(savedCorrectionModel);
  });

  settingsBtn?.addEventListener("click", () => {
    void navigateTo("settings-ollama");
  });

  const btnOpenDictFolder = document.getElementById("btnOpenDictionaryFolder");
  const btnOpenDictFile = document.getElementById("btnOpenDictionaryFile");
  const btnOpenBgFolder = document.getElementById("btnOpenBackgroundFolder");
  const btnOpenBgFile = document.getElementById("btnOpenBackgroundFile");

  btnOpenDictFolder?.addEventListener("click", async () => {
    try {
      await openCorrectionFolder(invokeTauri);
    } catch (e) {
      console.error("open_correction_folder error:", e);
      const { showAppDialog } = await import("./status");
      await showAppDialog({ title: "フォルダオープン失敗", message: `フォルダを開けませんでした: ${e}`, type: "error" });
    }
  });

  btnOpenDictFile?.addEventListener("click", async () => {
    try {
      await openCorrectionFile("dictionary", invokeTauri);
    } catch (e) {
      console.error("open_correction_file error:", e);
      const { showAppDialog } = await import("./status");
      await showAppDialog({ title: "ファイルオープン失敗", message: `辞書ファイルを開けませんでした: ${e}`, type: "error" });
    }
  });

  btnOpenBgFolder?.addEventListener("click", async () => {
    try {
      await openCorrectionFolder(invokeTauri);
    } catch (e) {
      console.error("open_correction_folder error:", e);
      const { showAppDialog } = await import("./status");
      await showAppDialog({ title: "フォルダオープン失敗", message: `フォルダを開けませんでした: ${e}`, type: "error" });
    }
  });

  btnOpenBgFile?.addEventListener("click", async () => {
    try {
      await openCorrectionFile("background", invokeTauri);
    } catch (e) {
      console.error("open_correction_file error:", e);
      const { showAppDialog } = await import("./status");
      await showAppDialog({ title: "ファイルオープン失敗", message: `背景情報ファイルを開けませんでした: ${e}`, type: "error" });
    }
  });
}

// ---- ASR Language Definitions ----

type AsrLanguageDefinition = {
  code: string;
  label: string;
  engineValue: string | null;
};

const CLOUD_ASR_LANGUAGES: AsrLanguageDefinition[] = [
  { code: "auto", label: "自動検出", engineValue: null },
  { code: "ja", label: "日本語", engineValue: "ja" },
  { code: "en", label: "英語", engineValue: "en" },
  { code: "zh", label: "中国語", engineValue: "zh" },
  { code: "ko", label: "韓国語", engineValue: "ko" },
];

const LOCAL_ASR_LANGUAGES: Record<string, AsrLanguageDefinition[]> = {
  reazonspeech: [
    { code: "ja", label: "日本語", engineValue: "ja" },
  ],
  "kotoba-whisper": [
    { code: "ja", label: "日本語", engineValue: "japanese" },
  ],
  "qwen3-asr": [
    { code: "auto", label: "自動判定", engineValue: null },
    { code: "ja", label: "日本語", engineValue: "Japanese" },
    { code: "en", label: "英語", engineValue: "English" },
    { code: "zh", label: "中国語", engineValue: "Chinese" },
    { code: "yue", label: "広東語", engineValue: "Cantonese" },
    { code: "ko", label: "韓国語", engineValue: "Korean" },
    { code: "fr", label: "フランス語", engineValue: "French" },
    { code: "de", label: "ドイツ語", engineValue: "German" },
    { code: "es", label: "スペイン語", engineValue: "Spanish" },
    { code: "pt", label: "ポルトガル語", engineValue: "Portuguese" },
    { code: "ar", label: "アラビア語", engineValue: "Arabic" },
    { code: "id", label: "インドネシア語", engineValue: "Indonesian" },
    { code: "it", label: "イタリア語", engineValue: "Italian" },
    { code: "ru", label: "ロシア語", engineValue: "Russian" },
    { code: "th", label: "タイ語", engineValue: "Thai" },
    { code: "vi", label: "ベトナム語", engineValue: "Vietnamese" },
    { code: "tr", label: "トルコ語", engineValue: "Turkish" },
    { code: "hi", label: "ヒンディー語", engineValue: "Hindi" },
    { code: "ms", label: "マレー語", engineValue: "Malay" },
    { code: "nl", label: "オランダ語", engineValue: "Dutch" },
    { code: "sv", label: "スウェーデン語", engineValue: "Swedish" },
    { code: "da", label: "デンマーク語", engineValue: "Danish" },
    { code: "fi", label: "フィンランド語", engineValue: "Finnish" },
    { code: "pl", label: "ポーランド語", engineValue: "Polish" },
    { code: "cs", label: "チェコ語", engineValue: "Czech" },
    { code: "fil", label: "フィリピン語", engineValue: "Filipino" },
    { code: "fa", label: "ペルシャ語", engineValue: "Persian" },
    { code: "el", label: "ギリシャ語", engineValue: "Greek" },
    { code: "hu", label: "ハンガリー語", engineValue: "Hungarian" },
    { code: "mk", label: "マケドニア語", engineValue: "Macedonian" },
    { code: "ro", label: "ルーマニア語", engineValue: "Romanian" },
  ],
};

function populateLanguagesForEngine(engineId: string, savedCode?: string): void {
  const languageSelect = document.getElementById("langSelect") as HTMLSelectElement | null;
  if (!languageSelect) {
    return;
  }
  const languages = LOCAL_ASR_LANGUAGES[engineId];
  if (!languages || languages.length === 0) {
    // クラウド/APIモードの既定表示
    languageSelect.innerHTML = CLOUD_ASR_LANGUAGES
      .map(
        (lang) =>
          `<option value="${escapeHtml(lang.code)}">${escapeHtml(lang.label)}</option>`,
      )
      .join("");
    const savedExists = CLOUD_ASR_LANGUAGES.some((lang) => lang.code === savedCode);
    if (savedExists && savedCode) {
      languageSelect.value = savedCode;
    } else {
      languageSelect.value = "ja";
    }
    return;
  }
  languageSelect.innerHTML = languages
    .map(
      (lang) =>
        `<option value="${escapeHtml(lang.code)}">${escapeHtml(lang.label)}</option>`,
    )
    .join("");
  const savedExists = languages.some((lang) => lang.code === savedCode);
  if (savedExists && savedCode) {
    languageSelect.value = savedCode;
    return;
  }
  const japanese = languages.find((lang) => lang.code === "ja");
  languageSelect.value = japanese?.code ?? languages[0].code;
}

export type MountResult = "mounted" | "cancelled";
export const pageMounts = new Map<string, Promise<MountResult>>();
export let navigationGeneration = 0;

export function resetMountedPagesForTest(): void {
  pageMounts.clear();
  currentPage = null;
  navigationGeneration = 0;
}

async function runMountWithRegistry(
  key: string,
  mountFn: () => Promise<MountResult>,
): Promise<MountResult> {
  const existing = pageMounts.get(key);
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    try {
      const res = await mountFn();
      if (res === "cancelled") {
        pageMounts.delete(key);
      }
      return res;
    } catch (err) {
      pageMounts.delete(key);
      throw err;
    }
  })();

  pageMounts.set(key, promise);
  return promise;
}

async function ensureMountedForNavigation(
  key: string,
  mountFn: () => Promise<MountResult>,
  navId: number,
): Promise<boolean> {
  let result = await runMountWithRegistry(key, mountFn);

  if (navId !== navigationGeneration) {
    return false;
  }

  if (result === "mounted") {
    return true;
  }

  // If the shared in-flight mount was cancelled by an earlier navigation,
  // retry once since we are the current navigation.
  result = await runMountWithRegistry(key, mountFn);

  if (navId !== navigationGeneration) {
    return false;
  }

  return result === "mounted";
}

function updateHeaderActiveNav(page: PageName): void {
  const activeWorkspace = getWorkspaceForPage(page);
  const links = document.querySelectorAll<HTMLElement>(".header-nav .nav-link");
  links.forEach((link) => {
    const linkPage = link.dataset.page as PageName | undefined;
    if (!linkPage) return;
    const linkWorkspace = getWorkspaceForPage(linkPage);
    if (linkWorkspace === activeWorkspace) {
      link.classList.add("active");
    } else {
      link.classList.remove("active");
    }
  });
}

function ensureAppShell(activePage: PageName = "transcribe"): void {
  const appEl = getAppElement();
  if (!appEl) return;
  if (!appEl.querySelector(".workspace-viewport")) {
    appEl.innerHTML = `
      ${renderHeader(activePage)}
      <div class="workspace-viewport">
        <div id="page-transcribe" class="workspace-page"></div>
        <div id="page-editor" class="workspace-page hidden"></div>
        <div id="page-merge" class="workspace-page hidden"></div>
        <div id="page-settings" class="workspace-page hidden"></div>
      </div>
    `;
    bindWindowControls();
    bindNavigation();
    bindSettingsSidebarNav();
  }
}

async function mountTranscribeWorkspace(): Promise<MountResult> {
  const container = document.getElementById("page-transcribe");
  if (!container) throw new Error("Missing #page-transcribe container");
  container.innerHTML = transcribePage;
  try {
    await restoreAsrSelection();
  } catch (e) {
    console.error("restoreAsrSelection failed:", e);
  }
  try {
    await restoreCorrectionSelection();
  } catch (e) {
    console.error("restoreCorrectionSelection failed:", e);
  }
  bindAsrModeSelect();
  bindAsrEngineSettingsButton();
  bindCorrectionSelection();
  bindFileSelection();
  bindStartButton();
  bindMultiAsrButtons();
  await bindTranscribeProgress();
  bindResultButtons();
  bindBrowseOutputPath();
  syncMultiAsrUiFromState();
  return "mounted";
}

function mountEditorWorkspace(): MountResult {
  const container = document.getElementById("page-editor");
  if (!container) throw new Error("Missing #page-editor container");
  container.innerHTML = renderEditorPage();
  bindEditorEvents(navigateTo);
  return "mounted";
}

function mountMergeWorkspace(): MountResult {
  const container = document.getElementById("page-merge");
  if (!container) throw new Error("Missing #page-merge container");
  container.innerHTML = mergePage;
  return "mounted";
}

function mountSettingsWorkspace(): MountResult {
  const container = document.getElementById("page-settings");
  if (!container) throw new Error("Missing #page-settings container");
  container.innerHTML = `
    <div id="subpage-settings-general" class="settings-subpage hidden">
      ${settingsGeneralPage}
    </div>
    <div id="subpage-settings-dictionary" class="settings-subpage hidden">
      ${settingsDictionaryPage}
    </div>
    <div id="subpage-settings-background" class="settings-subpage hidden">
      ${settingsBackgroundPage}
    </div>
    <div id="subpage-settings" class="settings-subpage hidden">
      ${settingsApiPage}
    </div>
    <div id="subpage-settings-ollama" class="settings-subpage hidden">
      ${settingsOllamaPage}
    </div>
    <div id="subpage-settings-docker" class="settings-subpage hidden">
      ${settingsDockerPage}
    </div>
  `;
  bindAccordions(container);
  return "mounted";
}

function getSettingsSubpageKey(page: PageName): { key: string; elementId: string } | null {
  switch (page) {
    case "settings":
      return { key: "settings:api", elementId: "subpage-settings" };
    case "settings-ollama":
      return { key: "settings:ollama", elementId: "subpage-settings-ollama" };
    case "settings-docker":
      return { key: "settings:docker", elementId: "subpage-settings-docker" };
    case "settings-general":
      return { key: "settings:general", elementId: "subpage-settings-general" };
    case "settings-dictionary":
      return { key: "settings:dictionary", elementId: "subpage-settings-dictionary" };
    case "settings-background":
      return { key: "settings:background", elementId: "subpage-settings-background" };
    default:
      return null;
  }
}

async function mountSettingsSubpage(
  subpageKey: string,
  subpageElementId: string,
  navGeneration: number,
): Promise<MountResult> {
  const subContainer = document.getElementById(subpageElementId);
  if (!subContainer) throw new Error(`Missing #${subpageElementId} container`);

  if (subpageKey === "settings:api") {
    const loaded = await loadSavedSettings(navGeneration, subContainer);
    if (!loaded) return "cancelled";
    bindApiSaveButtons(subContainer);
    bindVisibilityToggles(subContainer);
    bindResetUrlButtons(subContainer);
    bindModelSelects(subContainer);
    bindProviderConfigAutoSave(subContainer);
    bindFetchModelsButtons(subContainer);
    bindTestSendButtons(subContainer);
    bindGoogleSttHandlers(subContainer);
    bindXiaomiMimoAsrHandlers(subContainer);
    return "mounted";
  } else if (subpageKey === "settings:ollama") {
    const loaded = await loadOllamaSettings(navGeneration, subContainer);
    if (!loaded) return "cancelled";
    bindOllamaAutoSave(subContainer);
    bindResetUrlButtons(subContainer);
    bindModelSelects(subContainer);
    bindOllamaFetchButton(subContainer);
    bindOllamaTestButton(subContainer);
    return "mounted";
  } else if (subpageKey === "settings:docker") {
    void loadAndRenderHuggingFaceToken();
    bindLocalAsrDelegation(subContainer);
    return "mounted";
  } else {
    // general, dictionary, background
    return "mounted";
  }
}

export type NavigationResult = "completed" | "superseded";

export async function navigateTo(page: PageName): Promise<NavigationResult> {
  const navId = ++navigationGeneration;
  currentPage = page;

  ensureAppShell(page);

  const activeWorkspace = getWorkspaceForPage(page);
  const workspaceKey = `workspace:${activeWorkspace}`;
  const wasWorkspaceAlreadyMounted = pageMounts.has(workspaceKey);

  const workspaceMounted = await ensureMountedForNavigation(
    workspaceKey,
    async () => {
      if (activeWorkspace === "transcribe") {
        return await mountTranscribeWorkspace();
      } else if (activeWorkspace === "editor") {
        return mountEditorWorkspace();
      } else if (activeWorkspace === "merge") {
        return mountMergeWorkspace();
      } else if (activeWorkspace === "settings") {
        return mountSettingsWorkspace();
      }
      return "mounted";
    },
    navId,
  );

  if (!workspaceMounted || navId !== navigationGeneration) return "superseded";

  const subpageInfo = getSettingsSubpageKey(page);
  if (subpageInfo) {
    const subpageMounted = await ensureMountedForNavigation(
      subpageInfo.key,
      async () => {
        return await mountSettingsSubpage(subpageInfo.key, subpageInfo.elementId, navId);
      },
      navId,
    );
    if (!subpageMounted || navId !== navigationGeneration) return "superseded";
  }

  if (navId !== navigationGeneration) return "superseded";

  if (page === "settings-docker") {
    invalidateLocalAsrStatusCache();
    void loadDockerPageStatuses();
  } else if (page === "transcribe" && wasWorkspaceAlreadyMounted) {
    if (shouldRefreshTranscribeLocalEngines()) {
      await refreshTranscribeLocalEnginesIfActive(navId);
    }
    await refreshTranscribeGoogleSttSelectors();
  }

  updateHeaderActiveNav(page);

  const workspaces: WorkspacePage[] = ["transcribe", "editor", "merge", "settings"];
  for (const ws of workspaces) {
    const wsEl = document.getElementById(`page-${ws}`);
    if (wsEl) {
      if (ws === activeWorkspace) {
        wsEl.classList.remove("hidden");
      } else {
        wsEl.classList.add("hidden");
      }
    }
  }

  if (activeWorkspace === "settings" && subpageInfo) {
    const allSubpages = [
      "subpage-settings-general",
      "subpage-settings-dictionary",
      "subpage-settings-background",
      "subpage-settings",
      "subpage-settings-ollama",
      "subpage-settings-docker",
    ];
    for (const subId of allSubpages) {
      const subEl = document.getElementById(subId);
      if (subEl) {
        if (subId === subpageInfo.elementId) {
          subEl.classList.remove("hidden");
        } else {
          subEl.classList.add("hidden");
        }
      }
    }
  }

  if (page === "transcribe") {
    syncMultiAsrUiFromState();
  }

  return "completed";
}

function bindSettingsSidebarNav() {
  if (sidebarDelegationBound) return;
  sidebarDelegationBound = true;
  document.addEventListener("click", (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-settings-page]");
    if (!target) return;
    e.preventDefault();
    const settingsPage = target.dataset.settingsPage as SettingsPageId | undefined;
    if (settingsPage) {
      void navigateTo(settingsPageToRoute(settingsPage));
    }
  });
}

// ---- Window Lifecycle & Close Guard ----

let forceClosing = false;
let resizeListenerInitialized = false;
let closeGuardInitialized = false;
let beforeUnloadInitialized = false;
let unlistenResize: (() => void) | undefined;
let unlistenCloseRequest: (() => void) | undefined;

const handleBeforeUnload = (e: BeforeUnloadEvent) => {
  if (!forceClosing && isEditorDirty()) {
    e.preventDefault();
    e.returnValue = "";
  }
};

export function setTauriWindowForTest(win: any): void {
  tauriWindow = win;
}

export function resetWindowCloseGuardForTest(): void {
  forceClosing = false;
  resizeListenerInitialized = false;
  closeGuardInitialized = false;
  if (beforeUnloadInitialized) {
    window.removeEventListener("beforeunload", handleBeforeUnload);
    beforeUnloadInitialized = false;
  }
  unlistenResize?.();
  unlistenCloseRequest?.();
  unlistenResize = undefined;
  unlistenCloseRequest = undefined;
}

export function isForceClosingForTest(): boolean {
  return forceClosing;
}

export async function requestAppClose(): Promise<void> {
  if (forceClosing || !tauriWindow) return;

  if (isEditorDirty()) {
    const confirmed = await confirmDiscardChanges();
    if (!confirmed) return;
  }

  forceClosing = true;
  try {
    await tauriWindow.destroy();
  } catch (err) {
    forceClosing = false;
    console.error("destroy failed:", err);
  }
}

export async function setupWindowCloseGuard(): Promise<void> {
  if (!tauriWindow) return;

  if (!resizeListenerInitialized) {
    try {
      unlistenResize = await tauriWindow.onResized(() => updateMaximizeIcon());
      resizeListenerInitialized = true;
    } catch (err) {
      console.error("Failed to listen onResized:", err);
    }
  }

  if (!closeGuardInitialized) {
    try {
      unlistenCloseRequest = await tauriWindow.onCloseRequested(async (event: any) => {
        if (forceClosing) return;
        if (isEditorDirty()) {
          event.preventDefault();
          const confirmed = await confirmDiscardChanges();
          if (confirmed) {
            forceClosing = true;
            try {
              await tauriWindow.destroy();
            } catch (err) {
              forceClosing = false;
              console.error("destroy failed:", err);
            }
          }
        } else {
          forceClosing = true;
        }
      });
      closeGuardInitialized = true;
    } catch (err) {
      console.error("Failed to listen onCloseRequested:", err);
    }
  }

  if (!beforeUnloadInitialized) {
    window.addEventListener("beforeunload", handleBeforeUnload);
    beforeUnloadInitialized = true;
  }
}

async function updateMaximizeIcon() {
  if (!tauriWindow) return;
  const maximizeBtn = document.getElementById("maximizeBtn");
  const maximizeIcon = document.getElementById("maximizeIcon");
  if (!maximizeBtn || !maximizeIcon) return;
  try {
    const isMaximized = await tauriWindow.isMaximized();
    maximizeIcon.textContent = isMaximized ? "filter_none" : "crop_square";
    maximizeBtn.title = isMaximized ? "元のサイズに戻す" : "最大化";
  } catch (e) {
    console.error("Failed to update maximize icon:", e);
  }
}

// ---- Window Controls Binding (per header render) ----

function bindWindowControls() {
  if (!tauriWindow) return; // browser preview mode

  const minimizeBtn = document.getElementById("minimizeBtn");
  const maximizeBtn = document.getElementById("maximizeBtn");
  const closeBtn = document.getElementById("closeBtn");
  const headerDragArea = document.getElementById("headerDragArea");

  void updateMaximizeIcon();

  minimizeBtn?.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try { await tauriWindow.minimize(); } catch (err) { console.error("minimize failed:", err); }
  });

  maximizeBtn?.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await tauriWindow.toggleMaximize();
      await updateMaximizeIcon();
    } catch (err) { console.error("toggleMaximize failed:", err); }
  });

  closeBtn?.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await requestAppClose();
  });

  headerDragArea?.addEventListener("mousedown", async (event: MouseEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    try {
      if (event.detail === 2) {
        await tauriWindow.toggleMaximize();
        await updateMaximizeIcon();
      } else {
        await tauriWindow.startDragging();
      }
    } catch (error) {
      console.error("Failed to start window dragging:", error);
    }
  });
}

// ---- Navigation ----

function bindNavigation() {
  document.querySelectorAll<HTMLElement>("[data-page]").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const target = link.dataset.page as PageName;
      if (target && target !== currentPage) {
        navigateTo(target);
      }
    });
  });
}

// ---- Accordion ----

function bindAccordions(container: ParentNode = document) {
  container.querySelectorAll<HTMLElement>(".accordion-header").forEach((header) => {
    header.addEventListener("click", () => {
      const item = header.closest(".accordion-item");
      if (!item) return;
      const detail = item.querySelector<HTMLElement>(".accordion-detail");
      const chevron = header.querySelector<HTMLElement>(".accordion-chevron");
      if (!detail || !chevron) return;

      const isOpen = detail.style.display !== "none";
      if (isOpen) {
        detail.style.display = "none";
        chevron.classList.remove("rotate-90");
        header.classList.remove("accordion-header-expanded");
        header.classList.add("accordion-header-collapsed");
        header.setAttribute("aria-expanded", "false");
      } else {
        detail.style.display = "";
        chevron.classList.add("rotate-90");
        header.classList.remove("accordion-header-collapsed");
        header.classList.add("accordion-header-expanded");
        header.setAttribute("aria-expanded", "true");
      }
    });
  });
}

// ---- Transcription Pipeline ----

type SavedOutputFile = {
  format: string;
  path: string;
  fileName: string;
};

type TranscriptionResult = {
  txtContent: string;
  vttContent: string | null;
  engine: string;
  language: string;
  savedFiles: SavedOutputFile[];
  skippedFormats?: string[];
  document?: TranscriptDocument | null;
};

type TranscriptionProgress = {
  jobId: string;
  stage: string;
  message: string;
  logLine?: string;
};

let selectedFilePath: string | null = null;
let activeJobId: string | null = null;
let cancelRequested = false;
let isCommittingOutputs = false;
let unlistenTranscriptionProgress: (() => void) | null = null;
let unlistenFileDragDrop: (() => void) | null = null;

async function chooseAudioFile(): Promise<void> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const file = await open({
    multiple: false,
    filters: [{ name: "Audio", extensions: ["mp3", "wav", "mp4", "m4a", "flac"] }],
  });
  if (file) {
    selectedFilePath = file;
    updateFileDisplay(file);
    void handleAudioFileSelection(file);
  }
}

function updateFileDisplay(filePath: string): void {
  const dropZone = document.getElementById("dropZone");
  if (!dropZone) return;
  const name = filePath.split(/[\\/]/).pop() ?? filePath;
  const textEl = dropZone.querySelector(".drop-zone-text");
  if (textEl) {
    textEl.textContent = name;
  }
  const hintEl = dropZone.querySelector(".drop-zone-hint");
  if (hintEl) {
    hintEl.textContent = filePath;
  }
}

const ALLOWED_AUDIO_EXTENSIONS = new Set(["mp3", "wav", "mp4", "m4a", "flac"]);

function bindFileSelection(): void {
  const dropZone = document.getElementById("dropZone");
  const selectFileBtn = document.getElementById("selectFileBtn");
  selectFileBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    void chooseAudioFile();
  });
  dropZone?.addEventListener("click", () => {
    void chooseAudioFile();
  });

  void bindTauriFileDragDrop();
}

async function bindTauriFileDragDrop(): Promise<void> {
  try {
    unlistenFileDragDrop?.();
    unlistenFileDragDrop = null;

    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    const webview = getCurrentWebview();

    unlistenFileDragDrop = await webview.onDragDropEvent((event) => {
      const dz = document.getElementById("dropZone");
      if (!dz) return;

      if (event.payload.type === "leave") {
        dz.classList.remove("is-drag-over");
        return;
      }

      if (event.payload.type === "enter" || event.payload.type === "over") {
        dz.classList.add("is-drag-over");
        return;
      }

      if (event.payload.type !== "drop") return;

      dz.classList.remove("is-drag-over");

      const paths = event.payload.paths;
      if (!paths || paths.length === 0) return;

      const filePath = paths[0];
      const ext = filePath.split(".").pop()?.toLowerCase() ?? "";

      if (!ALLOWED_AUDIO_EXTENSIONS.has(ext)) {
        void showAppDialog({
          title: "対応していないファイル形式",
          message: "対応フォーマット: MP3, WAV, MP4, M4A, FLAC",
          type: "error",
        });
        return;
      }

      selectedFilePath = filePath;
      updateFileDisplay(filePath);
      void handleAudioFileSelection(filePath);
    });

  } catch (error) {
    console.error("[drag-drop] listener registration failed", error);
  }
}

function showProgressSection(stage: string): void {
  const section = document.getElementById("transcribeProgressSection");
  const stageEl = document.getElementById("progressStage");
  if (section) section.style.display = "";
  if (stageEl) stageEl.textContent = stage;
}

function hideProgressSection(): void {
  const section = document.getElementById("transcribeProgressSection");
  if (section) section.style.display = "none";
}

function showResultSection(): void {
  const section = document.getElementById("resultSection");
  if (section) section.style.display = "";
}

function hideResultSection(): void {
  const section = document.getElementById("resultSection");
  if (section) section.style.display = "none";
}

async function bindTranscribeProgress(): Promise<void> {
  try {
    unlistenTranscriptionProgress?.();
    const { listen } = await import("@tauri-apps/api/event");
    unlistenTranscriptionProgress = await listen<TranscriptionProgress>(
      "local-asr-transcription-progress",
      (event) => {
        const { jobId, stage, message } = event.payload;
        if (jobId !== activeJobId) return;
        const stageEl = document.getElementById("progressStage");
        if (stageEl) {
          if (stage === "completed") {
            stageEl.textContent = "完了";
          } else if (message) {
            stageEl.textContent = message;
          }
        }
      },
    );
  } catch (error) {
    // browser preview / test environment
  }
}

function setTranscriptionRunning(running: boolean): void {
  const startBtn = document.getElementById("startBtn") as HTMLButtonElement | null;
  const cancelBtn = document.getElementById("cancelBtn") as HTMLButtonElement | null;
  if (!startBtn || !cancelBtn) return;

  startBtn.disabled = running;
  startBtn.innerHTML = running
    ? `<span class="material-symbols-outlined transcription-hourglass">hourglass_top</span>
       <span class="btn-primary-text">文字起こし中...</span>`
    : `<span class="material-symbols-outlined">play_circle</span>
       <span class="btn-primary-text">文字起こしを開始</span>`;

  cancelBtn.style.display = running ? "inline-flex" : "none";
  cancelBtn.disabled = false;
  const cancelLabel = cancelBtn.querySelector("span:last-child");
  if (cancelLabel) cancelLabel.textContent = "中止";
}

function escapeCsvCell(value: string): string {
  const escaped = value.replace(/"/g, '""');
  return `"${escaped}"`;
}

export function buildGoogleSttFormattedOutputs(
  doc: TranscriptDocument,
  txtContent: string,
  outputFormats: string[],
): {
  files: Array<{ format: string; ext: string; content: string }>;
  vttContent: string | null;
  skippedFormats: string[];
} {
  const vttContent =
    doc.segments.length > 0
      ? [
          "WEBVTT",
          ...doc.segments.map(
            (s, idx) =>
              `${idx + 1}\n${formatTimestamp(s.start)} --> ${formatTimestamp(s.end)}\n${s.text}`,
          ),
        ].join("\n\n")
      : null;

  const files: Array<{ format: string; ext: string; content: string }> = [];
  const skippedFormats: string[] = [];

  for (const fmt of outputFormats) {
    switch (fmt) {
      case "txt":
        files.push({ format: "txt", ext: "txt", content: txtContent });
        break;
      case "json":
        files.push({ format: "json", ext: "json", content: JSON.stringify(doc, null, 2) });
        break;
      case "md": {
        const header = [
          `# ${doc.mediaFileName}`,
          "",
          `- Engine: ${doc.sourceEngine || "cloud:google_stt"}`,
          `- Language: ${doc.language || ""}`,
          "",
        ].join("\n");
        const body =
          doc.segments.length > 0
            ? doc.segments
                .map((s) => `- **[${formatTimestamp(s.start)} - ${formatTimestamp(s.end)}]** ${s.text}`)
                .join("\n")
            : txtContent;
        files.push({ format: "md", ext: "md", content: `${header}${body}\n` });
        break;
      }
      case "csv": {
        const rows =
          doc.segments.length > 0
            ? doc.segments.map(
                (s) =>
                  `${formatTimestamp(s.start)},${formatTimestamp(s.end)},${escapeCsvCell(s.text)}`,
              )
            : [`, ,${escapeCsvCell(txtContent)}`.replace(", ,", ",,")];
        files.push({
          format: "csv",
          ext: "csv",
          content: ["start,end,text", ...rows].join("\n") + "\n",
        });
        break;
      }
      case "srt": {
        if (doc.segments.length === 0) {
          skippedFormats.push("srt");
        } else {
          const srtContent = doc.segments
            .map(
              (s, idx) =>
                `${idx + 1}\n${formatTimestamp(s.start).replace(".", ",")} --> ${formatTimestamp(s.end).replace(".", ",")}\n${s.text}`,
            )
            .join("\n\n");
          files.push({ format: "srt", ext: "srt", content: srtContent });
        }
        break;
      }
      case "vtt": {
        if (vttContent === null) {
          skippedFormats.push("vtt");
        } else {
          files.push({ format: "vtt", ext: "vtt", content: vttContent });
        }
        break;
      }
      default:
        break;
    }
  }

  return { files, vttContent, skippedFormats };
}

async function runSingleGoogleSttTranscription(params: {
  jobId: string;
  audioPath: string;
  language: string;
  outputPath: string;
  outputFormats: string[];
  isCancelled?: () => boolean;
}): Promise<TranscriptionResult> {
  const { jobId, audioPath, language, outputPath, outputFormats, isCancelled } = params;
  const assertNotCancelled = () => {
    if (isCancelled?.()) {
      throw new Error("Transcription cancelled");
    }
  };

  assertNotCancelled();
  const authStatus = await invokeTauri<GoogleAuthStatus>("google_auth_get_status");
  assertNotCancelled();
  if (authStatus.state !== "connected") {
    throw new Error("Googleアカウントにログインしてください");
  }
  const projectId = authStatus.projectId?.trim() ?? "";
  if (!projectId) {
    throw new Error("Google Cloud プロジェクトIDを設定してください");
  }
  const capturedMeta = {
    authGeneration: authStatus.authGeneration,
    sub: authStatus.sub,
    oauthClientIdFingerprint: authStatus.oauthClientIdFingerprint,
  };

  const resolvedOutputDir = await invokeTauri<string>("resolve_output_directory", {
    outputPath,
  });
  assertNotCancelled();

  const settings = await invokeTauri<SavedAppSettings>("load_api_settings");
  assertNotCancelled();
  const googleProvider = settings?.providers?.google_stt;
  const options = googleProvider?.options ?? {};
  const location = options.location?.trim() || "us-central1";
  const recognizerId = options.recognizer_id?.trim() || "_";
  const model = googleProvider?.default_model?.trim() || "chirp_2";
  const langCode = language.toLowerCase().startsWith("en")
    ? "en-US"
    : language.toLowerCase().startsWith("zh")
      ? "cmn-Hans-CN"
      : "ja-JP";

  showProgressSection("Google Speech-to-Text で認識中...");
  const result = await invokeTauri<{
    transcript?: string;
    rawResponse?: GoogleSttRawResponse;
    raw_response?: GoogleSttRawResponse;
    authGeneration?: number;
    sub?: string;
    oauthClientIdFingerprint?: string;
  }>("google_stt_recognize", {
    input: {
      projectId,
      location,
      recognizerId,
      languageCode: langCode,
      model,
      audioPath,
    },
  });
  assertNotCancelled();

  // Verify auth generation/sub/fingerprint did not change while recognition was in flight (fail closed on status error)
  const latestAuthStatus = await invokeTauri<GoogleAuthStatus>("google_auth_get_status")
    .then((s) => updateCurrentGoogleAuthStatusIfNewer(s));
  assertNotCancelled();
  if (
    !isGoogleAuthResponseCurrent(latestAuthStatus, {
      authGeneration: result.authGeneration ?? capturedMeta.authGeneration,
      sub: result.sub ?? capturedMeta.sub,
      oauthClientIdFingerprint:
        result.oauthClientIdFingerprint ?? capturedMeta.oauthClientIdFingerprint,
    })
  ) {
    throw new Error("認証状態が変更されたため、古いGoogle STT認識結果を破棄しました。");
  }

  const mediaFileName = audioPath.split(/[\\/]/).pop() || audioPath;
  const transcript = result.transcript ?? "";
  const rawResponse = result.rawResponse ?? result.raw_response;
  let doc: TranscriptDocument;

  if (rawResponse !== undefined) {
    const converted = convertGoogleRawResponseToTranscriptDocument({
      rawResponse,
      mediaPath: audioPath,
      mediaFileName,
      language,
      sourceRunId: jobId,
      expectedDurationSec: getSelectedAudioDurationSec() ?? undefined,
      transcriptFallback: transcript,
    });
    if (converted.ok) {
      doc = converted.document;
    } else if (
      transcript.trim() ||
      converted.documentWithoutTiming.transcriptTextWithoutTiming?.trim()
    ) {
      doc = converted.documentWithoutTiming;
    } else {
      throw new Error(
        converted.reason || "Google Speech-to-Text から有効な文字起こし結果が返されませんでした",
      );
    }
  } else if (transcript.trim()) {
    const nowIso = new Date().toISOString();
    doc = {
      schemaVersion: 1,
      mediaPath: audioPath,
      mediaFileName,
      createdAt: nowIso,
      updatedAt: nowIso,
      language,
      sourceEngine: "cloud:google_stt",
      sourceRunId: jobId,
      segments: [],
      transcriptTextWithoutTiming: transcript,
    };
  } else {
    throw new Error("Google Speech-to-Text から有効な文字起こし結果が返されませんでした");
  }

  const txtContent =
    doc.segments.length > 0
      ? doc.segments.map((s) => s.text).join("\n")
      : doc.transcriptTextWithoutTiming || transcript;

  const formatted = buildGoogleSttFormattedOutputs(doc, txtContent, outputFormats);
  if (formatted.files.length === 0 && formatted.skippedFormats.length > 0) {
    throw new Error(
      `タイムスタンプ情報が含まれていないため、選択された形式（${formatted.skippedFormats
        .map((f) => f.toUpperCase())
        .join(" / ")}）を出力できませんでした。テキストやJSON等の形式を選択してください。`,
    );
  }

  const savedFiles: SavedOutputFile[] = [];
  const stagedFiles: Array<{
    tempPath: string;
    finalPath: string;
    format: string;
    fileName: string;
  }> = [];
  const sep = resolvedOutputDir.includes("\\") ? "\\" : "/";
  const baseDir = resolvedOutputDir.replace(/[\\/]+$/, "");
  const baseName = mediaFileName.replace(/\.[^.]+$/, "") || "transcript";

  const cleanupStagedFiles = async () => {
    for (const s of stagedFiles) {
      try {
        await invokeTauri("remove_output_file", { path: s.tempPath });
      } catch (cleanupErr) {
        console.warn("remove_output_file cleanup error:", cleanupErr);
      }
    }
  };

  try {
    for (const out of formatted.files) {
      assertNotCancelled();
      const fileName = `${baseName}.${out.ext}`;
      const fullPath = `${baseDir}${sep}${fileName}`;
      const tempPath = `${fullPath}.tmp-${jobId}`;
      stagedFiles.push({ tempPath, finalPath: fullPath, format: out.format, fileName });
      await invokeTauri("save_text_file", { path: tempPath, content: out.content });
      assertNotCancelled();
    }

    assertNotCancelled();
    const asrcFileName = `${baseName}.asrc.json`;
    const asrcPath = `${baseDir}${sep}${asrcFileName}`;
    const tempAsrcPath = `${asrcPath}.tmp-${jobId}`;
    stagedFiles.push({ tempPath: tempAsrcPath, finalPath: asrcPath, format: "asrc", fileName: asrcFileName });
    await invokeTauri("save_transcript_document", { path: tempAsrcPath, document: doc });
    assertNotCancelled();

    // Commit phase: lock out cancellation, indicate committing in UI, and complete atomically
    isCommittingOutputs = true;
    showProgressSection("出力ファイルを確定中...");
    const cancelBtnEl = document.getElementById("cancelBtn") as HTMLButtonElement | null;
    if (cancelBtnEl) {
      cancelBtnEl.disabled = true;
      const cancelLabel = cancelBtnEl.querySelector("span:last-child");
      if (cancelLabel) cancelLabel.textContent = "確定中...";
    }
    try {
      await invokeTauri("commit_staged_output_files", {
        files: stagedFiles.map(({ tempPath, finalPath }) => ({ tempPath, finalPath })),
      });
    } finally {
      isCommittingOutputs = false;
    }
    for (const s of stagedFiles) {
      savedFiles.push({ format: s.format, fileName: s.fileName, path: s.finalPath });
    }
  } catch (err) {
    await cleanupStagedFiles();
    throw err;
  }

  return {
    txtContent,
    vttContent: formatted.vttContent,
    engine: "google_stt",
    language,
    savedFiles,
    skippedFormats: formatted.skippedFormats,
    document: doc,
  };
}

function bindStartButton(): void {
  const startBtn = document.getElementById("startBtn");
  const cancelBtn = document.getElementById("cancelBtn") as HTMLButtonElement | null;

  startBtn?.addEventListener("click", async () => {
    if (!selectedFilePath) {
      const { showAppDialog } = await import("./status");
      showAppDialog({ title: "エラー", message: "音声ファイルを選択してください", type: "error" });
      return;
    }

    const { asrExecutionMode, executionMode, engineOrder, anchorEngineId, anchorError, hasDuplicate, hasTwoEngines } =
      getSelectedMultiAsrOptions();
    if (asrExecutionMode === "compare") {
      if (hasDuplicate || !hasTwoEngines) {
        syncDualAsrOptionAvailability();
        const { showAppDialog } = await import("./status");
        showAppDialog({
          title: "エラー",
          message: hasDuplicate
            ? "第1と第2に同一エンジンは設定できません。別のエンジンを選択してください。"
            : "選択した方式で実行できるエンジンが2つ必要です。API設定を確認してください。",
          type: "error",
        });
        return;
      }
      if (anchorError) {
        syncDualAsrAnchorUi();
        const { showAppDialog } = await import("./status");
        showAppDialog({
          title: "エラー",
          message: anchorError,
          type: "error",
        });
        return;
      }
      multiAsrCancelRequested = false;
      await startMultiAsrFromUi({
        targetFilePath: selectedFilePath ?? undefined,
        duration: getSelectedAudioDurationSec(),
        executionMode,
        engineOrder,
        anchorEngineId,
        language: (document.getElementById("langSelect") as HTMLSelectElement | null)?.value || "ja",
        invokeFn: invokeTauri,
        showDialogFn: async (dialog) => {
          const { showAppDialog } = await import("./status");
          await showAppDialog(dialog);
        },
        onJobIdChange: (jobId, engineId) => {
          activeMultiAsrJobId = engineId?.startsWith("local:") ? jobId : null;
        },
        isCancelled: () => multiAsrCancelRequested,
      });
      return;
    }

    const outputPath =
      (document.getElementById("outputPathInput") as HTMLInputElement | null)
        ?.value.trim() ?? "";
    const outputFormats = Array.from(
      document.querySelectorAll<HTMLInputElement>(".output-format-checkbox:checked"),
    ).map((el) => el.value);

    if (outputFormats.length === 0) {
      const { showAppDialog } = await import("./status");
      showAppDialog({ title: "エラー", message: "出力を1形式以上選択してください", type: "error" });
      return;
    }

    const jobId = crypto.randomUUID();
    if (!acquireExecutionLock("single", jobId)) {
      return;
    }

    activeJobId = jobId;
    asrGeneration++;
    const generationAtStart = asrGeneration;
    activeAutoCorrectionRunId = null;
    activeAutoCorrectionGeneration = asrGeneration;
    cancelRequested = false;
    setTranscriptionRunning(true);
    showProgressSection("準備中...");
    hideResultSection();

    const selectedMode =
      (document.getElementById("asrModeSelect") as HTMLSelectElement | null)?.value || "local";
    const selectedEngine =
      (document.getElementById("engineSelect") as HTMLSelectElement | null)?.value || "";
    const selectedLanguage =
      (document.getElementById("langSelect") as HTMLSelectElement | null)?.value || "ja";

    try {
      const result =
        selectedMode === "cloud" && selectedEngine === "google_stt"
          ? await runSingleGoogleSttTranscription({
              jobId,
              audioPath: selectedFilePath,
              language: selectedLanguage,
              outputPath,
              outputFormats,
              isCancelled: () => cancelRequested || generationAtStart !== asrGeneration,
            })
          : await invokeTauri<TranscriptionResult>("local_asr_transcribe", {
              jobId,
              audioPath: selectedFilePath,
              outputPath,
              outputFormats,
            });
      if (!cancelRequested) {
        displayTranscriptionResult(result);
        if (result.document) {
          const doc = result.document;
          const generationAtCompletion = asrGeneration;
          void invokeTauri<SavedAppSettings>("load_api_settings")
            .then((settings) => {
              if (generationAtCompletion !== asrGeneration || lastTranscriptionDocument !== doc) {
                return;
              }
              if (settings?.correction_enabled && !cancelRequested) {
                void runAsrAutoCorrection(jobId, doc, generationAtCompletion);
              }
            })
            .catch((e) => {
              console.warn("load_api_settings error for auto-correction:", e);
            });
        }
      }
    } catch (error) {
      if (!cancelRequested) {
        const { showAppDialog } = await import("./status");
        showAppDialog({
          title: "文字起こしエラー",
          message: formatGoogleSttErrorMessage(error),
          type: "error",
        });
      }
    } finally {
      isCommittingOutputs = false;
      releaseExecutionLock(jobId);
      setTranscriptionRunning(false);
      hideProgressSection();
      if (cancelRequested) {
        const stageEl = document.getElementById("progressStage");
        if (stageEl) stageEl.textContent = "中止済み";
        hideProgressSection();
      }
      if (activeJobId === jobId) {
        activeJobId = null;
      }
    }
  });

  cancelBtn?.addEventListener("click", async () => {
    if (!activeJobId || isCommittingOutputs) return;
    cancelRequested = true;
    cancelBtn.disabled = true;
    const cancelLabel = cancelBtn.querySelector("span:last-child");
    if (cancelLabel) cancelLabel.textContent = "中止中...";
    try {
      await invokeTauri("cancel_transcription", { jobId: activeJobId });
    } catch (e) {
      console.error("cancel_transcription error:", e);
    }
  });
}

let activeMultiAsrJobId: string | null = null;
let activeMultiAsrRunId: string | null = null;
let multiAsrCancelRequested = false;

export function getActiveMultiAsrRunIdForTest(): string | null {
  return activeMultiAsrRunId;
}

export function getActiveMultiAsrJobIdForTest(): string | null {
  return activeMultiAsrJobId;
}

let dualAsrOptionsGeneration = 0;

export function setSelectedAudioFileForTest(path: string | null): void {
  selectedFilePath = path;
}

export function resetMultiAsrMainStateForTest(): void {
  activeMultiAsrJobId = null;
  activeMultiAsrRunId = null;
  multiAsrCancelRequested = false;
  isCommittingOutputs = false;
  dualAsrOptionsGeneration = 0;
  cloudEnginesPopulateGeneration = 0;
  currentGoogleAuthStatus = null;
  clearPendingSpeechApiEnableContext();
  attemptedOnboardingSessionIds.clear();
  activeOnboardingRunSeq = 0;
  selectedFilePath = null;
}

async function populateDualAsrEngineOptions(
  preferredOrder?: string[],
  legacySourceMode: "local" | "cloud" = "local",
): Promise<void> {
  const generation = ++dualAsrOptionsGeneration;
  const firstSelect = document.getElementById("multiAsrFirstEngineSelect") as HTMLSelectElement | null;
  const secondSelect = document.getElementById("multiAsrSecondEngineSelect") as HTMLSelectElement | null;
  const firstSource = document.getElementById("multiAsrFirstSourceModeSelect") as HTMLSelectElement | null;
  const secondSource = document.getElementById("multiAsrSecondSourceModeSelect") as HTMLSelectElement | null;
  if (!firstSelect || !secondSelect || !firstSource || !secondSource) return;
  const previous = preferredOrder?.length ? preferredOrder : [
    `${firstSource.value}:${firstSelect.value}`,
    `${secondSource.value}:${secondSelect.value}`,
  ];
  const parseChoice = (value: string): { source: "local" | "cloud"; id: string } => {
    const idx = value.indexOf(":");
    if (idx > 0) {
      const source = value.slice(0, idx);
      if ((source === "local" || source === "cloud") && value.slice(idx + 1)) {
        return { source, id: value.slice(idx + 1) };
      }
    }
    const isApi = value === "google_stt" || value === "xiaomi_mimo_asr";
    return { source: isApi || legacySourceMode === "cloud" ? "cloud" : "local", id: value };
  };
  const decoded = previous.map((value) => parseChoice(value ?? ""));
  firstSource.value = decoded[0]?.source ?? "local";
  secondSource.value = decoded[1]?.source ?? "local";

  let configuredApis: Array<{ engineId: string; displayName: string }> = [];
  if (firstSource.value === "cloud" || secondSource.value === "cloud") {
    try {
      configuredApis = (await loadConfiguredAsrProviders())
        .filter((provider) => provider.id === "google_stt" || provider.id === "xiaomi_mimo_asr")
        .map((provider) => ({ engineId: provider.id, displayName: provider.displayName }));
    } catch (error) {
      console.error("Unable to load configured cloud ASR providers:", error);
    }
  }
  if (generation !== dualAsrOptionsGeneration) return;

  const optionsFor = (source: "local" | "cloud") => source === "local"
    ? MULTI_ASR_ENGINE_CATALOG.map(({ engineId, displayName }) => ({ engineId, displayName }))
    : configuredApis;
  const setOptions = (select: HTMLSelectElement, source: "local" | "cloud", preferred: string, fallback: string) => {
    const engines = optionsFor(source);
    select.innerHTML = engines.length
      ? engines.map((engine) => `<option value="${escapeHtml(engine.engineId)}">${escapeHtml(engine.displayName)}</option>`).join("")
      : `<option value="" disabled>設定済みで実行可能なASR APIがありません</option>`;
    const available = new Set(engines.map((engine) => engine.engineId));
    select.value = available.has(preferred) ? preferred : available.has(fallback) ? fallback : engines[0]?.engineId ?? "";
    return engines;
  };
  const firstEngines = setOptions(firstSelect, firstSource.value as "local" | "cloud", decoded[0]?.id ?? "", firstSource.value === "local" ? "kotoba-whisper" : "google_stt");
  const secondEngines = setOptions(secondSelect, secondSource.value as "local" | "cloud", decoded[1]?.id ?? "", secondSource.value === "local" ? "reazonspeech" : "xiaomi_mimo_asr");
  if (secondEngines.length === 0) {
    secondSelect.insertAdjacentHTML("beforeend", '<option value="" disabled>この方式の実行可能なASRを設定してください</option>');
    secondSelect.value = "";
  }
  if (firstEngines.length === 0) firstSelect.value = "";

  syncDualAsrOptionAvailability();
}

function syncDualAsrOptionAvailability(): boolean {
  const firstSelect = document.getElementById("multiAsrFirstEngineSelect") as HTMLSelectElement | null;
  const secondSelect = document.getElementById("multiAsrSecondEngineSelect") as HTMLSelectElement | null;
  const warningEl = document.getElementById("dualAsrDuplicateWarning") as HTMLElement | null;
  if (!firstSelect || !secondSelect) {
    return false;
  }

  const firstVal = firstSelect.value;
  const secondVal = secondSelect.value;
  const hasDuplicate = Boolean(firstVal && secondVal && firstVal === secondVal);

  for (const opt of Array.from(firstSelect.options)) {
    const isTakenBySecond = opt.value === secondVal && opt.value !== firstVal;
    opt.disabled = !opt.value || isTakenBySecond;
    opt.title = isTakenBySecond ? "第2エンジンで選択中のため選択できません" : "";
  }
  for (const opt of Array.from(secondSelect.options)) {
    const isTakenByFirst = opt.value === firstVal && opt.value !== secondVal;
    opt.disabled = !opt.value || isTakenByFirst;
    opt.title = isTakenByFirst ? "第1エンジンで選択中のため選択できません" : "";
  }

  if (warningEl) {
    warningEl.style.display = hasDuplicate ? "" : "none";
  }
  return hasDuplicate;
}

function syncAsrExecutionModeVisibility(): void {
  const execModeSelect = document.getElementById("asrExecutionModeSelect") as HTMLSelectElement | null;
  const singleRow = document.getElementById("singleAsrEngineRow") as HTMLElement | null;
  const dualRow = document.getElementById("dualAsrEngineRow") as HTMLElement | null;
  const isCompare = execModeSelect?.value === "compare";
  if (singleRow) singleRow.style.display = isCompare ? "none" : "";
  if (dualRow) dualRow.style.display = isCompare ? "" : "none";
  syncDualAsrOptionAvailability();
}

let lastValidAnchorValue = "1";

export function validateDualAsrAnchorSelection(
  engineOrder: string[],
  anchorIndex: 1 | 2,
): string | null {
  const anchorEngine = anchorIndex === 2 ? engineOrder[1] : engineOrder[0];
  const hasGoogle = engineOrder.includes("cloud:google_stt");
  if (hasGoogle && anchorEngine !== "cloud:google_stt") {
    return "Google Speech-to-Textを比較に含める場合は、Googleをタイムスタンプ基準に選択してください。";
  }
  if (anchorEngine === "cloud:xiaomi_mimo_asr") {
    return "Xiaomi MiMo Speech Recognitionはタイムスタンプを返さないため、基準エンジンに選択できません。";
  }
  return null;
}

function syncDualAsrAnchorUi(overrideMessage?: string | null): string | null {
  const anchorSelect = document.getElementById("multiAsrAnchorSelect") as HTMLSelectElement | null;
  const warningEl = document.getElementById("dualAsrAnchorWarning") as HTMLElement | null;
  const { engineOrder, anchorIndex, anchorError } = getSelectedMultiAsrOptions();

  if (anchorSelect) {
    const opt1 = anchorSelect.querySelector<HTMLOptionElement>('option[value="1"]');
    const opt2 = anchorSelect.querySelector<HTMLOptionElement>('option[value="2"]');
    const e1IsXiaomi = engineOrder[0] === "cloud:xiaomi_mimo_asr";
    const e2IsXiaomi = engineOrder[1] === "cloud:xiaomi_mimo_asr";
    if (opt1) {
      opt1.disabled = e1IsXiaomi && anchorIndex !== 1;
    }
    if (opt2) {
      opt2.disabled = e2IsXiaomi && anchorIndex !== 2;
    }
  }

  const displayMessage = overrideMessage ?? anchorError;
  if (warningEl) {
    warningEl.textContent = displayMessage ?? "";
    warningEl.style.display = displayMessage ? "" : "none";
  }
  if (!anchorError && anchorSelect) {
    lastValidAnchorValue = anchorSelect.value;
  }
  return anchorError;
}

function getSelectedMultiAsrOptions(): {
  asrExecutionMode: "single" | "compare";
  executionMode: MultiAsrExecutionMode;
  engineOrder: string[];
  anchorIndex: 1 | 2;
  anchorEngineId: string;
  anchorError: string | null;
  hasDuplicate: boolean;
  hasTwoEngines: boolean;
} {
  const execModeSelect = document.getElementById("asrExecutionModeSelect") as HTMLSelectElement | null;
  const firstSelect = document.getElementById("multiAsrFirstEngineSelect") as HTMLSelectElement | null;
  const secondSelect = document.getElementById("multiAsrSecondEngineSelect") as HTMLSelectElement | null;
  const firstSource = document.getElementById("multiAsrFirstSourceModeSelect") as HTMLSelectElement | null;
  const secondSource = document.getElementById("multiAsrSecondSourceModeSelect") as HTMLSelectElement | null;
  const anchorSelect = document.getElementById("multiAsrAnchorSelect") as HTMLSelectElement | null;
  const asrExecutionMode = execModeSelect?.value === "compare" ? "compare" : "single";
  const executionMode: MultiAsrExecutionMode = asrExecutionMode === "compare" ? "compare" : "synthesis";
  const first = firstSelect?.value || "";
  const second = secondSelect?.value || "";
  const source1 = firstSource?.value === "cloud" ? "cloud" : "local";
  const source2 = secondSource?.value === "cloud" ? "cloud" : "local";
  const engineOrder = [first ? `${source1}:${first}` : "", second ? `${source2}:${second}` : ""];
  const anchorIndex: 1 | 2 = anchorSelect?.value === "2" ? 2 : 1;
  const anchorEngineId = anchorIndex === 2 ? engineOrder[1] : engineOrder[0];
  const anchorError = validateDualAsrAnchorSelection(engineOrder, anchorIndex);
  return {
    asrExecutionMode,
    executionMode,
    engineOrder,
    anchorIndex,
    anchorEngineId,
    anchorError,
    hasDuplicate: Boolean(engineOrder[0] && engineOrder[1] && engineOrder[0] === engineOrder[1]),
    hasTwoEngines: Boolean(engineOrder[0] && engineOrder[1] && engineOrder[0] !== engineOrder[1]),
  };
}

let multiAsrSaveQueue: Promise<void> = Promise.resolve();
let multiAsrSaveGeneration = 0;

function saveMultiAsrSelection(): Promise<void> {
  const gen = ++multiAsrSaveGeneration;
  multiAsrSaveQueue = multiAsrSaveQueue
    .catch(() => {})
    .then(async () => {
      if (gen !== multiAsrSaveGeneration) {
        return;
      }
      const { asrExecutionMode, executionMode, engineOrder, anchorIndex, anchorError, hasDuplicate, hasTwoEngines } =
        getSelectedMultiAsrOptions();
      if (hasDuplicate || !hasTwoEngines || anchorError) {
        return;
      }
      try {
        await invokeTauri("save_multi_asr_settings", {
          executionMode: asrExecutionMode,
          mode: executionMode,
          sourceMode: "mixed",
          engines: engineOrder,
          anchorIndex,
        });
      } catch (error) {
        console.error("save_multi_asr_settings error:", error);
      }
    });
  return multiAsrSaveQueue;
}

function bindMultiAsrButtons(): void {
  const cancelMultiBtn = document.getElementById("cancelMultiAsrBtn") as HTMLButtonElement | null;
  const resultSection = document.getElementById("multiAsrResultSection");
  const execModeSelect = document.getElementById("asrExecutionModeSelect") as HTMLSelectElement | null;
  const firstSourceSelect = document.getElementById("multiAsrFirstSourceModeSelect") as HTMLSelectElement | null;
  const secondSourceSelect = document.getElementById("multiAsrSecondSourceModeSelect") as HTMLSelectElement | null;
  const firstSelect = document.getElementById("multiAsrFirstEngineSelect") as HTMLSelectElement | null;
  const secondSelect = document.getElementById("multiAsrSecondEngineSelect") as HTMLSelectElement | null;
  const anchorSelect = document.getElementById("multiAsrAnchorSelect") as HTMLSelectElement | null;

  execModeSelect?.addEventListener("change", () => {
    syncAsrExecutionModeVisibility();
    syncDualAsrAnchorUi();
    void saveMultiAsrSelection();
  });
  const onEngineSourceChange = () => {
    const current = getSelectedMultiAsrOptions();
    void populateDualAsrEngineOptions(current.engineOrder, "local")
      .then(() => {
        syncDualAsrAnchorUi();
        return saveMultiAsrSelection();
      });
  };
  firstSourceSelect?.addEventListener("change", onEngineSourceChange);
  secondSourceSelect?.addEventListener("change", onEngineSourceChange);
  firstSelect?.addEventListener("change", () => {
    const hasDuplicate = syncDualAsrOptionAvailability();
    syncDualAsrAnchorUi();
    if (!hasDuplicate) {
      void saveMultiAsrSelection();
    }
  });
  secondSelect?.addEventListener("change", () => {
    const hasDuplicate = syncDualAsrOptionAvailability();
    syncDualAsrAnchorUi();
    if (!hasDuplicate) {
      void saveMultiAsrSelection();
    }
  });
  anchorSelect?.addEventListener("change", () => {
    const { engineOrder, anchorIndex } = getSelectedMultiAsrOptions();
    const err = validateDualAsrAnchorSelection(engineOrder, anchorIndex);
    if (err) {
      anchorSelect.value = lastValidAnchorValue;
      syncDualAsrAnchorUi(err);
      return;
    }
    lastValidAnchorValue = anchorSelect.value;
    syncDualAsrAnchorUi(null);
    void saveMultiAsrSelection();
  });
  cancelMultiBtn?.addEventListener("click", async () => {
    multiAsrCancelRequested = true;
    cancelMultiBtn.disabled = true;
    const cancelLabel = cancelMultiBtn.querySelector("span:last-child");
    if (cancelLabel) cancelLabel.textContent = "中止中...";

    if (activeMultiAsrJobId) {
      try {
        await invokeTauri("cancel_transcription", { jobId: activeMultiAsrJobId });
      } catch (e) {
        console.error("cancel_transcription for Multi-ASR error:", e);
      }
    }
  });

  resultSection?.addEventListener("click", async (e) => {
    const copyBtn = (e.target as HTMLElement).closest<HTMLElement>("#btnCopyMultiAsrCompareJson");
    if (copyBtn) {
      const staging = getMultiAsrStaging();
      if (staging && staging.result.status === "compare_ready") {
        const payload = buildCompareExportPayload(staging.result);
        try {
          await navigator.clipboard?.writeText(JSON.stringify(payload, null, 2));
        } catch (err) {
          console.error("Failed to copy compare JSON:", err);
        }
      }
      return;
    }

    const target = (e.target as HTMLElement).closest<HTMLElement>("#btnOpenMultiAsrInEditor");
    if (!target) return;
    const staging = getMultiAsrStaging();
    if (!staging) return;

    try {
      await executeEditorHandoff(
        staging,
        navigateTo,
        setEditorDocumentWithProposals,
        setEditorDocument,
        renderEditor
      );
      syncMultiAsrUiFromState();
    } catch (err) {
      console.error("Multi-ASR Editor handoff failed:", err);
    }
  });
}

export interface StagedCorrectionResult {
  asrRunId: string;
  document: TranscriptDocument;
  proposals: Map<string, CorrectionProposal[]>;
  correctionRunId: string;
}

let asrGeneration = 0;
let pendingCorrectionResult: StagedCorrectionResult | null = null;
let activeAutoCorrectionRunId: string | null = null;
let activeAutoCorrectionGeneration = 0;
let cachedOllamaModels: string[] | null = null;
let lastTranscriptionDocument: TranscriptDocument | null = null;

export function getAsrGenerationForTest(): number {
  return asrGeneration;
}

export function setAsrGenerationForTest(gen: number): void {
  asrGeneration = gen;
}

export function getActiveAutoCorrectionGenerationForTest(): number {
  return activeAutoCorrectionGeneration;
}

export function getPendingCorrectionResultForTest(): StagedCorrectionResult | null {
  return pendingCorrectionResult;
}

export function setPendingCorrectionResultForTest(staged: StagedCorrectionResult | null): void {
  pendingCorrectionResult = staged;
}

export function resetCorrectionStateForTest(): void {
  pendingCorrectionResult = null;
  activeAutoCorrectionRunId = null;
  activeAutoCorrectionGeneration = 0;
  cachedOllamaModels = null;
  lastTranscriptionDocument = null;
  savedCorrectionModel = "";
  correctionModelExplicitlySelected = false;
  asrGeneration = 0;
}

export function setLastTranscriptionDocumentForTest(doc: TranscriptDocument | null): void {
  lastTranscriptionDocument = doc;
}

export function getLastTranscriptionDocumentForTest(): TranscriptDocument | null {
  return lastTranscriptionDocument;
}

export function bindResultButtonsForTest(): void {
  bindResultButtons();
}

function isCurrentAutoCorrectionRun(
  correctionRunId: string,
  generation: number,
  doc: TranscriptDocument,
): boolean {
  return (
    generation === asrGeneration &&
    activeAutoCorrectionRunId === correctionRunId &&
    lastTranscriptionDocument === doc
  );
}

export async function runAsrAutoCorrection(
  jobId: string,
  doc: TranscriptDocument,
  generation: number = asrGeneration,
): Promise<void> {
  if (generation !== asrGeneration || lastTranscriptionDocument !== doc) {
    return;
  }

  const correctionRunId = crypto.randomUUID();
  activeAutoCorrectionRunId = correctionRunId;
  activeAutoCorrectionGeneration = generation;

  const badgeEl = document.getElementById("correctionStatusBadge");
  const cancelAutoBtn = document.getElementById("btnCancelAutoCorrection") as HTMLButtonElement | null;

  if (badgeEl && isCurrentAutoCorrectionRun(correctionRunId, generation, doc)) {
    badgeEl.textContent = "LLM補正準備中...";
    badgeEl.style.display = "inline-block";
    badgeEl.style.color = "var(--color-primary, #2563eb)";
  }
  if (cancelAutoBtn && isCurrentAutoCorrectionRun(correctionRunId, generation, doc)) {
    cancelAutoBtn.style.display = "inline-flex";
  }

  try {
    const resolved = await resolveCorrectionProvider(invokeTauri);
    if (!isCurrentAutoCorrectionRun(correctionRunId, generation, doc)) {
      return;
    }

    if (!resolved || !resolved.model) {
      console.warn("自動LLM補正: プロバイダーまたはモデルが解決できないためスキップします");
      if (badgeEl && isCurrentAutoCorrectionRun(correctionRunId, generation, doc)) {
        badgeEl.style.display = "none";
      }
      if (cancelAutoBtn && isCurrentAutoCorrectionRun(correctionRunId, generation, doc)) {
        cancelAutoBtn.style.display = "none";
      }
      return;
    }

    const provider = new OllamaCorrectionProvider({
      baseUrl: resolved.baseUrl,
      model: resolved.model,
      invokeTauri,
      isCancelled: () => !isCurrentAutoCorrectionRun(correctionRunId, generation, doc),
    });

    const dictCheckbox = document.getElementById("correctionDictCheckbox") as HTMLInputElement | null;
    const bgCheckbox = document.getElementById("correctionBgCheckbox") as HTMLInputElement | null;
    const useDictionary = dictCheckbox ? dictCheckbox.checked : resolved.useDictionary;
    const useBackground = bgCheckbox ? bgCheckbox.checked : resolved.useBackground;

    const contextLoadResult = await loadCorrectionContext({
      useDictionary,
      useBackground,
      invokeFn: invokeTauri,
    });

    if (!isCurrentAutoCorrectionRun(correctionRunId, generation, doc)) {
      return;
    }

    if (contextLoadResult.status !== "success") {
      console.warn("自動LLM補正中断:", contextLoadResult.message);
      if (badgeEl && isCurrentAutoCorrectionRun(correctionRunId, generation, doc)) {
        badgeEl.textContent = contextLoadResult.status === "dictionary_syntax_error"
          ? "辞書ファイルの形式に問題があります (手動確認要)"
          : "コンテキスト読込失敗 (手動実行可)";
        badgeEl.style.display = "inline-block";
        badgeEl.style.color = "#dc2626";
      }
      if (cancelAutoBtn && isCurrentAutoCorrectionRun(correctionRunId, generation, doc)) {
        cancelAutoBtn.style.display = "none";
      }
      return;
    }

    const { dictionary, context, warnings } = contextLoadResult;
    if (warnings.length > 0) {
      console.warn("自動LLM補正: コンテキスト読み込み警告:", warnings);
    }
    if (!isCurrentAutoCorrectionRun(correctionRunId, generation, doc)) {
      return;
    }

    const result = await runCorrectionForDocument({
      document: doc,
      provider,
      dictionary,
      context,
      mode: resolved.mode,
      isCancelled: () => !isCurrentAutoCorrectionRun(correctionRunId, generation, doc),
      onProgress: (progress) => {
        if (!isCurrentAutoCorrectionRun(correctionRunId, generation, doc)) return;
        if (badgeEl) {
          badgeEl.textContent = `LLM補正中: ${formatCorrectionProgress(progress)}`;
          badgeEl.style.display = "inline-block";
          badgeEl.style.color = "var(--color-primary, #2563eb)";
        }
      },
    });

    if (result.status === "cancelled" || !isCurrentAutoCorrectionRun(correctionRunId, generation, doc)) {
      return;
    }

    const proposals = result.proposals;
    if (isCurrentAutoCorrectionRun(correctionRunId, generation, doc)) {
      pendingCorrectionResult = {
        asrRunId: jobId,
        document: doc,
        proposals,
        correctionRunId,
      };
      const totalProps = Array.from(proposals.values()).reduce((sum, list) => sum + list.length, 0);
      if (badgeEl && isCurrentAutoCorrectionRun(correctionRunId, generation, doc)) {
        badgeEl.textContent = totalProps > 0 ? `補正候補 (${totalProps}件) を生成しました` : `補正候補はありませんでした (0件)`;
        badgeEl.style.display = "inline-block";
        badgeEl.style.color = "var(--color-primary, #2563eb)";
      }
    }
  } catch (err) {
    if (isCurrentAutoCorrectionRun(correctionRunId, generation, doc)) {
      console.warn("自動LLM補正中にエラーが発生しました (ASR結果は保持されます):", err);
      if (badgeEl && isCurrentAutoCorrectionRun(correctionRunId, generation, doc)) {
        badgeEl.textContent = "LLM補正に失敗しました (手動実行可)";
        badgeEl.style.display = "inline-block";
        badgeEl.style.color = "#dc2626";
      }
    }
  } finally {
    if (cancelAutoBtn && isCurrentAutoCorrectionRun(correctionRunId, generation, doc)) {
      cancelAutoBtn.style.display = "none";
    }
  }
}

function displayTranscriptionResult(result: TranscriptionResult): void {
  showResultSection();
  if (lastTranscriptionDocument !== result.document) {
    pendingCorrectionResult = null;
  }
  lastTranscriptionDocument = result.document ?? null;
  const badgeEl = document.getElementById("correctionStatusBadge");
  if (badgeEl) {
    badgeEl.style.display = "none";
    badgeEl.textContent = "";
  }
  const cancelAutoBtn = document.getElementById("btnCancelAutoCorrection") as HTMLButtonElement | null;
  if (cancelAutoBtn) {
    cancelAutoBtn.style.display = "none";
  }
  const textArea = document.getElementById("resultText") as HTMLTextAreaElement | null;
  if (textArea) {
    textArea.value = result.txtContent;
  }
  const savedFilesEl = document.getElementById("savedFilesInfo");
  if (savedFilesEl && result.savedFiles.length > 0) {
    const dir = result.savedFiles[0].path.replace(/[\\/][^\\/]+$/, "");
    const list = result.savedFiles.map((f) => `・${f.fileName}`).join("\n");
    const skippedNotice =
      result.skippedFormats && result.skippedFormats.length > 0
        ? `\n未出力（タイムスタンプ情報なし）: ${result.skippedFormats.map((f) => f.toUpperCase()).join(", ")}`
        : "";
    savedFilesEl.textContent = `保存済み:\n${list}\n保存先: ${dir}${skippedNotice}`;
    savedFilesEl.style.display = "";
  } else if (savedFilesEl) {
    savedFilesEl.style.display = "none";
  }

  const openEditorBtn = document.getElementById("openEditorBtn");
  if (openEditorBtn) {
    openEditorBtn.style.display = result.document ? "" : "none";
  }
}

function bindBrowseOutputPath(): void {
  const btn = document.getElementById("browseOutputPathBtn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const folder = await open({ directory: true, multiple: false });
      if (folder) {
        const input = document.getElementById("outputPathInput") as HTMLInputElement | null;
        if (input) input.value = folder;
        void invokeTauri("save_output_path", { path: folder }).catch((e: unknown) => {
          console.error("save_output_path error:", e);
        });
      }
    } catch (e) {
      console.error("browseOutputPath error:", e);
    }
  });
}

function bindResultButtons(): void {
  document.getElementById("copyResultBtn")?.addEventListener("click", async () => {
    const textArea = document.getElementById("resultText") as HTMLTextAreaElement | null;
    if (textArea) {
      await navigator.clipboard.writeText(textArea.value);
    }
  });
  document.getElementById("saveResultBtn")?.addEventListener("click", async () => {
    const textArea = document.getElementById("resultText") as HTMLTextAreaElement | null;
    if (!textArea) return;
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      filters: [{ name: "Text", extensions: ["txt"] }],
      defaultPath: "transcript.txt",
    });
    if (path) {
      await invokeTauri("save_text_file", { path, content: textArea.value });
    }
  });

  document.getElementById("btnCancelAutoCorrection")?.addEventListener("click", () => {
    if (activeAutoCorrectionRunId) {
      activeAutoCorrectionRunId = null;
      const badgeEl = document.getElementById("correctionStatusBadge");
      const cancelAutoBtn = document.getElementById("btnCancelAutoCorrection") as HTMLButtonElement | null;
      if (badgeEl) {
        badgeEl.textContent = "補正をキャンセルしました";
        badgeEl.style.display = "inline-block";
        badgeEl.style.color = "var(--on-surface-variant)";
      }
      if (cancelAutoBtn) {
        cancelAutoBtn.style.display = "none";
      }
    }
  });
  document.getElementById("openEditorBtn")?.addEventListener("click", async () => {
    if (lastTranscriptionDocument) {
      if (isEditorDirty()) {
        const confirmed = await confirmDiscardChanges();
        if (!confirmed) return;
      }
      const targetDoc = lastTranscriptionDocument;
      const staged = (pendingCorrectionResult && pendingCorrectionResult.document === targetDoc)
        ? pendingCorrectionResult
        : null;

      try {
        if (staged) {
          setEditorDocumentWithProposals(targetDoc, staged.proposals, null);
        } else {
          setEditorDocument(targetDoc, null);
        }
        renderEditor(navigateTo);
        const navResult = await navigateTo("editor");

        if (navResult === "completed" && currentPage === "editor") {
          if (staged && pendingCorrectionResult === staged) {
            pendingCorrectionResult = null;
          }
        }
      } catch (err) {
        console.error("Editor handoff failed:", err);
        throw err;
      }
    }
  });
}

// ---- API Settings: Load ----

interface SaveProviderSecretResult {
  persisted: boolean;
  warning?: string;
}

async function loadSavedSettings(navGeneration?: number, container: ParentNode = document): Promise<boolean> {
  if (navGeneration !== undefined && navGeneration !== navigationGeneration) return false;
  try {
    const settings = await invokeTauri<SavedAppSettings>("load_api_settings");
    if (navGeneration !== undefined && navGeneration !== navigationGeneration) return false;

    const targetContainer = container instanceof HTMLElement && container.id === "subpage-settings"
      ? container
      : container.querySelector<HTMLElement>("#subpage-settings") ?? container;

    targetContainer.querySelectorAll<HTMLElement>(".accordion-item[data-provider-id]").forEach((item) => {
      const providerId = item.dataset.providerId;
      if (!providerId) return;
      const saved = settings.providers[providerId];

      const envInput = item.querySelector<HTMLInputElement>(".api-env-input");
      const baseUrlInput = item.querySelector<HTMLInputElement>('[data-field="base-url"]');
      const modelSelect = item.querySelector<HTMLSelectElement>('[data-field="model"]');
      const modelManualInput = item.querySelector<HTMLInputElement>('[data-field="model-manual"]');
      const statusBadgeEl = item.querySelector<HTMLElement>("[data-status-badge]");

      if (saved?.env_name && envInput) {
        envInput.value = saved.env_name;
      }

      if (saved?.base_url && baseUrlInput) {
        baseUrlInput.value = saved.base_url;
      }

      if (saved?.default_model) {
        if (modelSelect) {
          const options = Array.from(modelSelect.options);
          const match = options.find(o => o.value === saved.default_model);
          if (match) {
            modelSelect.value = saved.default_model;
          } else if (modelManualInput) {
            // リストにない場合は手動入力欄にセット
            modelSelect.value = "__manual__";
            modelManualInput.style.display = "";
            modelManualInput.value = saved.default_model;
          }
        } else if (modelManualInput) {
          modelManualInput.value = saved.default_model;
        }
      }

      // ステータスバッジの初期設定
      if (statusBadgeEl) {
        if (providerId === "google_stt") {
          // Google STT: options (project_id + location) で判定、verifiedは永続化しない
          const configuredState = getGoogleSttConfiguredState(item);
          setGoogleSttStatus(item, configuredState, (el, label) => setStatusBadge(el, label as "未設定" | "設定済み" | "接続確認済み" | "接続エラー"));
        } else if (saved?.env_name) {
          setStatusBadge(statusBadgeEl, "設定済み");
        }
      }

      // Google STT options の復元（Project IDはOAuth metadataが唯一の正本のため読まない）
      if (saved?.options) {
        const locationSelect = item.querySelector<HTMLSelectElement>('[data-field="location"]');
        const recognizerInput = item.querySelector<HTMLInputElement>('[data-field="recognizer-id"]');
        const langSelect = item.querySelector<HTMLSelectElement>('[data-field="language-code"]');
        if (locationSelect && saved.options.location) locationSelect.value = saved.options.location;
        if (recognizerInput && saved.options.recognizer_id) recognizerInput.value = saved.options.recognizer_id;
        if (langSelect && saved.options.language_code) ensureSelectValue(langSelect, saved.options.language_code);
      }

      // Google STT OAuth状態取得＆接続済みならプロジェクト一覧読み込み
      if (providerId === "google_stt") {
        refreshGoogleAuthAndProjects(item);
      }
    });
    return true;
  } catch (e) {
    console.error("Failed to load API settings:", e);
    return false;
  }
}

// ---- API Settings: Save ----

function bindApiSaveButtons(container: ParentNode = document) {
  container.querySelectorAll<HTMLElement>(".btn-api-save").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const providerId = btn.dataset.providerId;
      if (!providerId) return;

      const item = btn.closest(".accordion-item");
      if (!item) return;

      const envInput = item.querySelector<HTMLInputElement>(".api-env-input");
      const keyInput = item.querySelector<HTMLInputElement>('[data-field="api-key"]');
      const baseUrlInput = item.querySelector<HTMLInputElement>('[data-field="base-url"]');

      const envName = envInput?.value.trim() ?? "";
      const apiKey = keyInput?.value.trim() ?? "";
      const baseUrl = baseUrlInput?.value.trim() ?? "";

      const isOllama = providerId === "ollama";

      if (!isOllama && !envName) {
        await showAppDialog({ title: "入力エラー", message: "環境変数名を入力してください。", type: "error" });
        return;
      }

      try {
        // 1. APIキーを保存（OllamaはAPIキー不要のためスキップ）
        let secretWarning: string | undefined;
        if (!isOllama && apiKey) {
          const result = await invokeTauri<SaveProviderSecretResult>("save_provider_secret", {
            input: { envName, apiKey }
          });
          secretWarning = result.warning;
        }

        // 2. 設定を保存（OllamaはenvNameをnullで保存）
        const modelValue = getModelValue(item);
        await invokeTauri("save_provider_config", {
          input: {
            providerId,
            envName: isOllama ? null : envName,
            baseUrl,
            defaultModel: modelValue || null,
          }
        });

        // setx失敗時の警告表示
        if (secretWarning) {
          await showAppDialog({ title: "警告", message: secretWarning, type: "error" });
        }

        // ステータスバッジ更新: setx失敗時は「一時設定」、成功時は「設定済み」
        const statusBadgeEl = item.querySelector<HTMLElement>("[data-status-badge]");
        setStatusBadge(statusBadgeEl, secretWarning ? "一時設定" : "設定済み");

        // XIAOMI_API_KEYの場合は、xiaomi_mimoとxiaomi_mimo_asr両方の接続確認状態を無効化
        if (envName === "XIAOMI_API_KEY") {
          const relatedProviders = ["xiaomi_mimo", "xiaomi_mimo_asr"];
          for (const relatedId of relatedProviders) {
            const relatedItem = document.querySelector<HTMLElement>(`.accordion-item[data-provider-id="${relatedId}"]`);
            if (relatedItem) {
              const relatedBadge = relatedItem.querySelector<HTMLElement>("[data-status-badge]");
              const currentState = relatedBadge?.getAttribute("data-connection-state");
              if (currentState === "verified") {
                setStatusBadge(relatedBadge, "設定済み");
                relatedBadge?.setAttribute("data-connection-state", "configured");
              }
            }
          }
        }

        // APIキー入力欄をクリア（セキュリティ上、画面上に残さない）
        if (keyInput) keyInput.value = "";

        // ボタンフィードバック
        const originalText = btn.textContent;
        btn.textContent = "保存済み";
        btn.style.background = "var(--tertiary)";
        setTimeout(() => {
          btn.textContent = originalText;
          btn.style.background = "";
        }, 1500);
      } catch (e) {
        console.error("Failed to save:", e);
        await showAppDialog({ title: "保存エラー", message: "保存に失敗しました: " + String(e), type: "error" });
      }
    });
  });
}

function getModelValue(item: Element): string {
  const modelSelect = item.querySelector<HTMLSelectElement>('[data-field="model"]');
  const modelManualInput = item.querySelector<HTMLInputElement>('[data-field="model-manual"]');

  if (modelSelect) {
    if (modelSelect.value === "__manual__") {
      return modelManualInput?.value.trim() ?? "";
    }
    return modelSelect.value;
  }
  // ドロップダウンがない場合（manual-only）
  return modelManualInput?.value.trim() ?? "";
}

// ---- API Settings: Visibility Toggle ----

function bindVisibilityToggles(container: ParentNode = document) {
  container.querySelectorAll<HTMLElement>(".api-visibility-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const wrap = btn.closest(".api-key-input-wrap");
      if (!wrap) return;
      const input = wrap.querySelector<HTMLInputElement>('[data-field="api-key"]');
      if (!input) return;

      const icon = btn.querySelector<HTMLElement>(".material-symbols-outlined");
      if (input.type === "password") {
        input.type = "text";
        if (icon) icon.textContent = "visibility_off";
      } else {
        input.type = "password";
        if (icon) icon.textContent = "visibility";
      }
    });
  });
}

// ---- API Settings: Reset URL ----

function bindResetUrlButtons(container: ParentNode = document) {
  container.querySelectorAll<HTMLElement>(".btn-reset-url").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest(".api-baseurl-row");
      if (!row) return;
      const input = row.querySelector<HTMLInputElement>('[data-field="base-url"]');
      if (!input) return;
      const defaultUrl = input.dataset.defaultUrl ?? "";
      input.value = defaultUrl;
      if (input.id === "ollamaBaseUrl") {
        input.dispatchEvent(new Event("change"));
      }
    });
  });
}

// ---- Model Select: Manual Input Toggle ----

function bindModelSelects(container: ParentNode = document) {
  container.querySelectorAll<HTMLSelectElement>('[data-field="model"]').forEach((select) => {
    select.addEventListener("change", () => {
      const item = select.closest(".accordion-item");
      if (!item) return;
      const manualInput = item.querySelector<HTMLInputElement>('[data-field="model-manual"]');
      if (!manualInput) return;

      if (select.value === "__manual__") {
        manualInput.style.display = "";
        manualInput.focus();
      } else {
        manualInput.style.display = "none";
      }
    });
  });
}

// ---- Provider Config: Auto Save on blur/change ----

function bindProviderConfigAutoSave(container: ParentNode = document) {
  container.querySelectorAll<HTMLElement>(".accordion-item[data-provider-id]").forEach((item) => {
    const providerId = item.dataset.providerId;
    if (!providerId || providerId === "ollama") return;

    function scheduleSave() {
      saveDirtyProviderConfig({
        providerId: providerId!,
        section: item,
        state: providerConfigState,
        saveConfig: saveProviderConfigFromSection,
      });
    }

    // Google STT options: project_idはOAuth metadataで明示確定、それ以外はprovider settingsへ保存
    item.querySelectorAll<HTMLSelectElement>('[data-field="project-id-select"]').forEach((optSelect) => {
      optSelect.addEventListener("change", () => {
        if (optSelect.value === "__manual__") {
          switchToManualProjectInput(item, currentGoogleAuthStatus?.projectId ?? "", null);
          const input = item.querySelector<HTMLInputElement>('[data-field="project-id-input"]');
          if (input) input.focus();
          return;
        }
        const selectedPid = optSelect.value.trim();
        if (selectedPid) {
          void confirmGoogleSttProject(item, selectedPid);
        }
      });
    });

    item.querySelectorAll<HTMLInputElement>('[data-field="project-id-input"]').forEach((optInput) => {
      optInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          const pid = optInput.value.trim();
          if (pid) void confirmGoogleSttProject(item, pid);
        }
      });
    });

    // recognizer-id: input→dirty, blur→save
    item.querySelectorAll<HTMLInputElement>('[data-field="recognizer-id"]').forEach((optInput) => {
      optInput.addEventListener("input", () => providerConfigState.markDirty(providerId));
      optInput.addEventListener("blur", () => {
        saveDirtyProviderConfig({
          providerId: providerId!,
          section: item,
          state: providerConfigState,
          saveConfig: saveProviderConfigFromSection,
        });
      });
    });

    // location: change→dirty+save+invalidate verification
    item.querySelectorAll<HTMLSelectElement>('[data-field="location"]').forEach((optSelect) => {
      optSelect.addEventListener("change", () => {
        invalidateGoogleSttVerification(item, (el, label) => setStatusBadge(el, label as "未設定" | "設定済み" | "接続確認済み" | "接続エラー"));
        providerConfigState.markDirty(providerId);
        saveDirtyProviderConfig({
          providerId: providerId!,
          section: item,
          state: providerConfigState,
          saveConfig: saveProviderConfigFromSection,
        });
      });
    });

    // language-code: change→dirty+save（verified は維持）
    item.querySelectorAll<HTMLSelectElement>('[data-field="language-code"]').forEach((optSelect) => {
      optSelect.addEventListener("change", () => {
        providerConfigState.markDirty(providerId);
        saveDirtyProviderConfig({
          providerId: providerId!,
          section: item,
          state: providerConfigState,
          saveConfig: saveProviderConfigFromSection,
        });
      });
    });

    // 再取得ボタン
    item.querySelectorAll<HTMLButtonElement>('.btn-google-stt-refresh-projects').forEach((refreshBtn) => {
      refreshBtn.addEventListener("click", () => {
        loadGoogleSttProjects(item);
      });
    });

    // 詳細設定トグル
    item.querySelectorAll<HTMLButtonElement>('[data-field="advanced-toggle"]').forEach((toggleBtn) => {
      toggleBtn.addEventListener("click", () => {
        const content = item.querySelector<HTMLElement>('[data-field="advanced-content"]');
        if (!content) return;
        const open = content.hidden;
        setGoogleSttAdvancedOpen(toggleBtn, content, open);
        toggleBtn.classList.toggle("is-open", open);
        if (open && item.dataset.providerId === "google_stt") {
          ++activeOnboardingRunSeq;
          setGoogleOnboardingBusy(item, false);
          hideGoogleOnboardingPanels(item);
          if (currentGoogleAuthStatus?.state === "connected") {
            void loadGoogleSttProjects(item);
          }
        }
      });
    });

    // envName: input→dirty, blur→save
    const envInput = item.querySelector<HTMLInputElement>(".api-env-input");
    if (envInput) {
      envInput.addEventListener("input", () => providerConfigState.markDirty(providerId));
      envInput.addEventListener("blur", () => {
        if (!envInput.value.trim()) return;
        scheduleSave();
      });
    }

    // baseUrl: input→dirty, blur→save
    const baseUrlInput = item.querySelector<HTMLInputElement>('[data-field="base-url"]');
    if (baseUrlInput) {
      baseUrlInput.addEventListener("input", () => providerConfigState.markDirty(providerId));
      baseUrlInput.addEventListener("blur", scheduleSave);
    }

    // model select: change→dirty+save
    const modelSelect = item.querySelector<HTMLSelectElement>('[data-field="model"]');
    if (modelSelect) {
      modelSelect.addEventListener("change", () => {
        providerConfigState.markDirty(providerId);
        scheduleSave();
      });
    }

    // model manual input: input→dirty, blur→save
    const modelManualInput = item.querySelector<HTMLInputElement>('[data-field="model-manual"]');
    if (modelManualInput) {
      modelManualInput.addEventListener("input", () => providerConfigState.markDirty(providerId));
      modelManualInput.addEventListener("blur", scheduleSave);
    }
  });
}

// ---- Model Fetch Button ----

function bindFetchModelsButtons(container: ParentNode = document) {
  container.querySelectorAll<HTMLElement>(".btn-fetch-models").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const providerId = btn.dataset.providerId;
      if (!providerId) return;

      const item = btn.closest<HTMLElement>(".accordion-item");
      if (!item) return;

      // 1. envName検証（最優先）
      const envInput = item.querySelector<HTMLInputElement>(".api-env-input");
      if (envInput && !envInput.value.trim()) {
        await showAppDialog({
          title: "環境変数名が必要です",
          message: "APIキーの保存先となる環境変数名を入力してください。",
          type: "error",
        });
        envInput.focus();
        return;
      }

      // 2. 進行中の保存を待ち、dirtyなら保存する
      const prepareResult = await prepareProviderForModelFetch({
        providerId,
        section: item,
        state: providerConfigState,
        saveConfig: saveProviderConfigFromSection,
      });
      if (!prepareResult.ok) {
        if (prepareResult.reason === "save-failed") {
          showAutoSaveStatus(item, "保存に失敗しました");
        }
        return;
      }

      // 4. ボタンをローディング状態に
      const originalHtml = btn.innerHTML;
      btn.innerHTML = '<span class="material-symbols-outlined spin">refresh</span> 取得中...';
      (btn as HTMLButtonElement).disabled = true;

      try {
        const models = await invokeTauri<string[]>("fetch_models", { providerId });

        // 成功: ステータスバッジを「接続確認済み」に更新
        setStatusBadge(item.querySelector<HTMLElement>("[data-status-badge]"), "接続確認済み");

        // select にオプションを追加
        const select = item.querySelector<HTMLSelectElement>('[data-field="model"]');
        if (select) {
          const provider = [...asrProviders, ...llmProviders].find(p => p.id === providerId);
          const currentModel = select.value === "__manual__" ? null : select.value || null;
          populateModelSelect(
            select,
            models,
            provider?.preferredModels || [],
            currentModel,
            provider?.allowManualModel ?? true,
          );
        }

        // ボタンラベルを「再取得」に変更
        btn.innerHTML = '<span class="material-symbols-outlined">refresh</span> 一覧を再取得';
      } catch (e) {
        console.error("fetch_models error:", e);

        const classified = classifyFetchError(e);
        setStatusBadge(item.querySelector<HTMLElement>("[data-status-badge]"), classified.status);

        let message = "モデル一覧を取得できませんでした。\n\n推奨モデルまたはモデルIDの直接入力は引き続き利用できます。";
        if (classified.status === "認証エラー") {
          const providerName = providerId === "moonshot" ? "Moonshot" : "";
          if (providerName) {
            message = `${providerName} APIキーが認証されませんでした。\n\n推奨モデルまたはモデルIDの直接入力は引き続き利用できます。`;
          }
        }
        await showAppDialog({ title: "モデル取得エラー", message, type: "error" });
        btn.innerHTML = originalHtml;
      } finally {
        (btn as HTMLButtonElement).disabled = false;
      }
    });
  });
}

// ---- Google STT: loadGoogleSttProjects ----

function formatGoogleSttErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== "[object Object]") {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message : "";
    const kind = typeof record.kind === "string" ? record.kind : "";
    if (message && kind) return `${message} (${kind})`;
    if (message) return message;
    try {
      return JSON.stringify(error);
    } catch {
      // Fall through to a stable generic message for cyclic/unserializable objects.
    }
  }
  return String(error);
}

let currentGoogleAuthStatus: GoogleAuthStatus | null = null;

function getGoogleAuthSessionKey(status: GoogleAuthStatus): string {
  // New backend versions always provide the random persisted session ID. Keep a
  // deterministic fallback for older test fixtures / mixed-version UI payloads.
  return status.authSessionId || `legacy:${status.oauthClientIdFingerprint}:${status.sub ?? ""}`;
}

async function refreshTranscribeGoogleSttSelectors(): Promise<void> {
  const modeSelect = document.getElementById("asrModeSelect") as HTMLSelectElement | null;
  const engineSelect = document.getElementById("engineSelect") as HTMLSelectElement | null;
  if (modeSelect?.value === "cloud" && engineSelect) {
    await populateCloudEngines(engineSelect);
  }
  const firstSource = document.getElementById("multiAsrFirstSourceModeSelect") as HTMLSelectElement | null;
  const secondSource = document.getElementById("multiAsrSecondSourceModeSelect") as HTMLSelectElement | null;
  if (firstSource?.value === "cloud" || secondSource?.value === "cloud") {
    await populateDualAsrEngineOptions();
  }
}

function applyAndSyncGoogleAuthStatus(
  item: HTMLElement,
  status: GoogleAuthStatus,
  options: { restoreProjectControls?: boolean } = {},
): void {
  const effective = updateCurrentGoogleAuthStatusIfNewer(status);
  if (!isPendingSpeechApiEnableContextCurrent(effective, pendingSpeechApiEnableContext)) {
    hideSpeechApiPanels(item);
  }
  applyGoogleAuthStatusToSection(item, effective, options);
  if (effective.state === "connected" && effective.projectId && effective.projectVerified) {
    setGoogleSttStatus(item, "verified", (el, label) =>
      setStatusBadge(el, label as "未設定" | "設定済み" | "接続確認済み" | "接続エラー"),
    );
  } else {
    const configuredState = getGoogleSttConfiguredState(item);
    setGoogleSttStatus(item, configuredState, (el, label) =>
      setStatusBadge(el, label as "未設定" | "設定済み" | "接続確認済み" | "接続エラー"),
    );
  }
  void refreshTranscribeGoogleSttSelectors();
}

async function refreshGoogleAuthAndProjects(item: HTMLElement): Promise<void> {
  try {
    const status = await invokeTauri<GoogleAuthStatus>("google_auth_get_status");
    applyAndSyncGoogleAuthStatus(item, status);
    const advancedContent = item.querySelector<HTMLElement>('[data-field="advanced-content"]');
    if (status.state === "connected" && advancedContent && !advancedContent.hidden) {
      await loadGoogleSttProjects(item);
    } else if (status.state !== "connected") {
      const diagList = item.querySelector<HTMLElement>('[data-field="diag-project-list"]');
      if (diagList) diagList.textContent = "Project一覧: 未取得";
    }
    if (shouldAutoRunDefaultOnboarding(currentGoogleAuthStatus, attemptedOnboardingSessionIds)) {
      await runGoogleDefaultOnboarding(item);
    }
  } catch (e) {
    console.error("google_auth_get_status error:", e);
  }
}

let confirmGoogleSttProjectQueue: Promise<void> = Promise.resolve();

async function confirmGoogleSttProject(item: HTMLElement, projectId: string): Promise<void> {
  const errorEl = item.querySelector<HTMLElement>('[data-field="project-error"]');
  if (errorEl) errorEl.style.display = "none";
  ++activeOnboardingRunSeq;
  hideGoogleOnboardingPanels(item);
  hideSpeechApiPanels(item);
  const requestedProjectId = projectId.trim();
  const projectInput = item.querySelector<HTMLInputElement>('[data-field="project-id-input"]');
  const projectSelect = item.querySelector<HTMLSelectElement>('[data-field="project-id-select"]');
  const requestedControlValue = projectInput && !projectInput.hidden
    ? projectInput.value
    : projectSelect?.value ?? "";
  const requestedBy = currentGoogleAuthStatus;
  if (!requestedBy || requestedBy.state !== "connected" || !requestedBy.sub) return;
  const requestedIdentity = {
    sub: requestedBy.sub,
    oauthClientIdFingerprint: requestedBy.oauthClientIdFingerprint,
    authSessionId: getGoogleAuthSessionKey(requestedBy),
  };
  const operation = confirmGoogleSttProjectQueue.then(async () => {
    const snapshot = currentGoogleAuthStatus;
    if (
      !snapshot || snapshot.state !== "connected" || !snapshot.sub ||
      snapshot.sub !== requestedIdentity.sub ||
      snapshot.oauthClientIdFingerprint !== requestedIdentity.oauthClientIdFingerprint ||
      getGoogleAuthSessionKey(snapshot) !== requestedIdentity.authSessionId
    ) return;
    const capturedMeta = {
      authGeneration: snapshot.authGeneration,
      sub: snapshot.sub,
      oauthClientIdFingerprint: snapshot.oauthClientIdFingerprint,
      authSessionId: getGoogleAuthSessionKey(snapshot),
    };
    try {
      const status = await invokeTauri<GoogleAuthStatus>("google_auth_confirm_project", {
        projectId: requestedProjectId,
        ...capturedMeta,
      });
      if (
        !isGoogleAuthResponseCurrent(currentGoogleAuthStatus, capturedMeta) ||
        status.authGeneration !== capturedMeta.authGeneration + 1 ||
        status.state !== "connected" || status.projectId?.trim() !== requestedProjectId ||
        (status.sub ?? "") !== capturedMeta.sub ||
        status.oauthClientIdFingerprint !== capturedMeta.oauthClientIdFingerprint ||
        getGoogleAuthSessionKey(status) !== capturedMeta.authSessionId ||
        getGoogleAuthSessionKey(currentGoogleAuthStatus!) !== capturedMeta.authSessionId
      ) return;
      // The CAS response can become stale immediately after the backend releases its lock
      // (for example, another app instance switches accounts). Only render a fresh status.
      const latest = await invokeTauri<GoogleAuthStatus>("google_auth_get_status").catch(() => null);
      if (!latest) {
        if (errorEl) {
          errorEl.textContent = "Projectは確定しましたが、最新のGoogle認証状態を再取得できませんでした。状態を再確認してください。";
          errorEl.style.display = "";
        }
        return;
      }
      applyAndSyncGoogleAuthStatus(item, latest);
      if (
        latest.state !== "connected" ||
        getGoogleAuthSessionKey(latest) !== capturedMeta.authSessionId ||
        latest.projectId?.trim() !== requestedProjectId
      ) {
        if (errorEl) {
          errorEl.textContent = "確定後にGoogle認証状態またはProjectが変更されました。現在の状態を確認してください。";
          errorEl.style.display = "";
        }
      }
    } catch (e) {
      // A CAS rejection may mean another window/process changed auth or Project state.
      // Refresh and apply the authoritative status before reporting the failed selection.
      const latest = await invokeTauri<GoogleAuthStatus>("google_auth_get_status").catch(() => null);
      const controlsUnchanged = projectInput && !projectInput.hidden
        ? projectInput.value === requestedControlValue
        : (projectSelect?.value ?? "") === requestedControlValue;
      const isCasConflict = parseGoogleApiError(e).message.includes("認証状態が変更されたためProjectの確定を中止しました");
      if (latest) {
        applyAndSyncGoogleAuthStatus(item, latest, {
          restoreProjectControls: isCasConflict && controlsUnchanged,
        });
      }
      const active = currentGoogleAuthStatus;
      if (!active) return;
      const sameSession = getGoogleAuthSessionKey(active) === capturedMeta.authSessionId;
      const msg = sameSession
        ? formatGoogleSttErrorMessage(e)
        : "Google認証状態が変更されたため、Projectの確定を中止しました。現在の認証状態を確認してください。";
      if (errorEl) { errorEl.textContent = msg; errorEl.style.display = ""; }
    }
  });
  confirmGoogleSttProjectQueue = operation.catch(() => undefined);
  await operation;
}

async function loadGoogleSttProjects(section: Element): Promise<void> {
  const select = section.querySelector<HTMLSelectElement>(
    '[data-field="project-id-select"]',
  );
  const input = section.querySelector<HTMLInputElement>(
    '[data-field="project-id-input"]',
  );
  const confirmBtn = section.querySelector<HTMLButtonElement>(
    ".btn-google-stt-confirm-project",
  );
  const errorEl = section.querySelector<HTMLElement>(
    '[data-field="project-error"]',
  );
  const diagListEl = section.querySelector<HTMLElement>(
    '[data-field="diag-project-list"]',
  );
  if (!select) return;

  const snapshot = currentGoogleAuthStatus;
  if (!snapshot || snapshot.state !== "connected") {
    return;
  }
  const capturedMeta = {
    authGeneration: snapshot.authGeneration,
    sub: snapshot.sub,
    oauthClientIdFingerprint: snapshot.oauthClientIdFingerprint,
  };

  if (errorEl) errorEl.style.display = "none";
  select.hidden = false;
  if (input) input.hidden = true;
  if (confirmBtn) confirmBtn.hidden = true;
  select.innerHTML = '<option value="">読み込み中...</option>';

  try {
    const result = await invokeTauri<GoogleCloudListProjectsResult>("google_stt_list_projects");

    // Stale check: discard if generation/sub/fingerprint changed or revoking
    if (!isGoogleAuthResponseCurrent(currentGoogleAuthStatus, result)) {
      return;
    }

    if (diagListEl) {
      diagListEl.textContent = `Project一覧: 取得済み（${result.projects.length}件）`;
    }

    if (result.projects.length === 0) {
      switchToManualProjectInput(section, currentGoogleAuthStatus?.projectId ?? "", errorEl);
      return;
    }

    const savedProjectId = currentGoogleAuthStatus?.projectId ?? null;
    const optionsResult = buildGoogleSttProjectOptions({
      projects: result.projects,
      currentProject: null,
      savedProjectId,
    });

    select.replaceChildren();
    if (!savedProjectId) {
      select.add(new Option("プロジェクトを選択してください...", ""));
    }
    for (const opt of optionsResult.options) {
      select.add(new Option(opt.label, opt.value));
    }
    if (optionsResult.selectedValue) {
      select.value = optionsResult.selectedValue;
    } else {
      select.value = "";
    }
  } catch (e: unknown) {
    const parsed = parseGoogleApiError(e);
    const metaToCheck = {
      authGeneration: parsed.authGeneration ?? capturedMeta.authGeneration,
      sub: parsed.sub ?? capturedMeta.sub,
      oauthClientIdFingerprint:
        parsed.oauthClientIdFingerprint ?? capturedMeta.oauthClientIdFingerprint,
    };
    if (!isGoogleAuthResponseCurrent(currentGoogleAuthStatus, metaToCheck)) {
      return;
    }
    if (diagListEl) {
      diagListEl.textContent = "Project一覧: 取得失敗（手入力可能）";
    }
    const msg = formatGoogleSttErrorMessage(e);
    switchToManualProjectInput(section, currentGoogleAuthStatus?.projectId ?? "", errorEl, msg);
  }
}

function switchToManualProjectInput(
  section: Element,
  fallbackValue: string,
  errorEl: HTMLElement | null,
  errorMsg?: string,
): void {
  const select = section.querySelector<HTMLSelectElement>(
    '[data-field="project-id-select"]',
  );
  const input = section.querySelector<HTMLInputElement>(
    '[data-field="project-id-input"]',
  );
  const confirmBtn = section.querySelector<HTMLButtonElement>(
    ".btn-google-stt-confirm-project",
  );
  if (select) select.hidden = true;
  if (input) {
    input.hidden = false;
    input.value = fallbackValue;
  }
  if (confirmBtn) {
    confirmBtn.hidden = false;
  }
  if (errorEl) {
    if (errorMsg) {
      errorEl.textContent = errorMsg;
      errorEl.style.display = "";
    } else {
      errorEl.style.display = "none";
    }
  }
}

// ---- Common: fetchProviderModels ----

async function fetchProviderModels(providerId: string, item: Element, btn: HTMLElement): Promise<boolean> {
  const originalHtml = btn.innerHTML;
  btn.innerHTML = '<span class="material-symbols-outlined spin">refresh</span> 取得中...';
  (btn as HTMLButtonElement).disabled = true;

  try {
    const models = await invokeTauri<string[]>("fetch_models", { providerId });

    setStatusBadge(item.querySelector<HTMLElement>("[data-status-badge]"), "接続確認済み");

    const select = item.querySelector<HTMLSelectElement>('[data-field="model"]');
    if (select) {
      const provider = [...asrProviders, ...llmProviders].find(p => p.id === providerId);
      const currentModel = select.value === "__manual__" ? null : select.value || null;
      populateModelSelect(
        select,
        models,
        provider?.preferredModels || [],
        currentModel,
        provider?.allowManualModel ?? true,
      );
    }

    btn.innerHTML = '<span class="material-symbols-outlined">refresh</span> 一覧を再取得';
    return true;
  } catch (e) {
    console.error("fetch_models error:", e);

    const classified = classifyFetchError(e);
    setStatusBadge(item.querySelector<HTMLElement>("[data-status-badge]"), classified.status);
    await showAppDialog({ title: "モデル取得エラー", message: "モデル一覧の取得に失敗しました。\n" + classified.message, type: "error" });
    btn.innerHTML = originalHtml;
    return false;
  } finally {
    (btn as HTMLButtonElement).disabled = false;
  }
}

// ---- Google STT ----

// ---- LLM Test Send ----

function bindTestSendButtons(container: ParentNode = document) {
  container.querySelectorAll<HTMLElement>(".accordion-item[data-provider-id]").forEach((item) => {
    const providerId = item.dataset.providerId;
    if (!providerId || providerId === "ollama" || providerId === "google_stt") return;

    const btn = item.querySelector<HTMLButtonElement>(".btn-test-send");
    if (!btn) return;

    btn.addEventListener("click", async () => {
      const originalHtml = btn.innerHTML;
      btn.innerHTML = '<span class="material-symbols-outlined spin">cable</span> テスト中...';
      btn.disabled = true;

      try {
        const result = await invokeTauri<{ message: string; model: string; responseText: string }>(
          "test_llm_connection",
          { input: { providerId } },
        );
        if (!item.isConnected) return;
        setStatusBadge(item.querySelector<HTMLElement>("[data-status-badge]"), "接続確認済み");
        const detail = result.responseText ? `\n\n応答: ${result.responseText}` : "";
        await showAppDialog({ title: "接続テスト", message: `${result.message}${detail}`, type: "success" });
      } catch (e) {
        console.error("test_llm_connection error:", e);
        if (!item.isConnected) return;
        const classified = classifyFetchError(e);
        setStatusBadge(item.querySelector<HTMLElement>("[data-status-badge]"), classified.status);
        await showAppDialog({ title: "接続テストに失敗しました", message: classified.message, type: "error" });
      } finally {
        if (item.isConnected) {
          btn.disabled = false;
          btn.innerHTML = originalHtml;
        }
      }
    });
  });
}

function bindGoogleSttHandlers(container: ParentNode = document) {
  // Googleにログイン
  container.querySelectorAll<HTMLButtonElement>(".btn-google-auth-login").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const item = btn.closest<HTMLElement>(".accordion-item");
      if (!item) return;
      await runGoogleOAuthLogin(item, btn, "google_auth_login", false);
    });
  });

  // 同意を再取得してログイン（refresh token未返却時の明示的再試行）
  container.querySelectorAll<HTMLButtonElement>(".btn-google-auth-retry-consent").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const item = btn.closest<HTMLElement>(".accordion-item");
      if (!item) return;
      const command =
        currentGoogleAuthStatus?.state === "connected"
          ? "google_auth_switch_account"
          : "google_auth_login";
      await runGoogleOAuthLogin(item, btn, command, true);
    });
  });

  // アカウントを切り替える
  container.querySelectorAll<HTMLButtonElement>(".btn-google-auth-switch").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const item = btn.closest<HTMLElement>(".accordion-item");
      if (!item) return;
      await runGoogleOAuthLogin(item, btn, "google_auth_switch_account", false);
    });
  });

  // 通常ログアウト
  container.querySelectorAll<HTMLButtonElement>(".btn-google-auth-logout").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const item = btn.closest<HTMLElement>(".accordion-item");
      if (!item) return;
      btn.disabled = true;
      try {
        const status = await invokeTauri<GoogleAuthStatus>("google_auth_logout");
        applyAndSyncGoogleAuthStatus(item, status);
        const diagList = item.querySelector<HTMLElement>('[data-field="diag-project-list"]');
        if (diagList) diagList.textContent = "Project一覧: 未取得";
      } catch (e) {
        const errorEl = item.querySelector<HTMLElement>('[data-field="auth-error"]');
        if (errorEl) {
          errorEl.textContent = formatGoogleSttErrorMessage(e);
          errorEl.style.display = "";
        }
      } finally {
        btn.disabled = false;
      }
    });
  });

  // Google側のアクセス権も取り消す
  container.querySelectorAll<HTMLButtonElement>(".btn-google-auth-revoke").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const item = btn.closest<HTMLElement>(".accordion-item");
      if (!item) return;
      const confirmed = await showAppConfirm({
        title: "Googleアクセス権の取り消し",
        message:
          "このPCからログアウトし、Google側のアクセス権も取り消します。同じGoogle Cloud OAuthプロジェクトの他クライアントやトークンにも影響する可能性があります。続行しますか？",
      });
      if (!confirmed) return;

      if (currentGoogleAuthStatus) {
        applyAndSyncGoogleAuthStatus(item, {
          ...currentGoogleAuthStatus,
          state: "revoking",
        });
      }

      try {
        const res = await invokeTauri<GoogleAuthRevokeResult>("google_auth_revoke");
        applyAndSyncGoogleAuthStatus(item, res.status);
        const diagList = item.querySelector<HTMLElement>('[data-field="diag-project-list"]');
        if (diagList) diagList.textContent = "Project一覧: 未取得";
        const authErrorEl = item.querySelector<HTMLElement>('[data-field="auth-error"]');
        if (authErrorEl && !res.revokedOnGoogle) {
          authErrorEl.textContent = res.message;
          authErrorEl.style.display = "";
        }
      } catch (e) {
        await refreshGoogleAuthAndProjects(item);
        const authErrorEl = item.querySelector<HTMLElement>('[data-field="auth-error"]');
        if (authErrorEl) {
          authErrorEl.textContent = formatGoogleSttErrorMessage(e);
          authErrorEl.style.display = "";
        }
      }
    });
  });

  // オンボーディング再試行 / アカウント切替（例外時パネル）
  container.querySelectorAll<HTMLButtonElement>(".btn-google-onboarding-retry").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const item = btn.closest<HTMLElement>(".accordion-item");
      if (!item) return;
      await runGoogleDefaultOnboarding(item, { allowRetrySameSession: true });
    });
  });

  container.querySelectorAll<HTMLButtonElement>(".btn-google-onboarding-switch").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const item = btn.closest<HTMLElement>(".accordion-item");
      if (!item) return;
      await runGoogleOAuthLogin(item, btn, "google_auth_switch_account", false);
    });
  });

  // 手入力 Project ID 確定
  container.querySelectorAll<HTMLButtonElement>(".btn-google-stt-confirm-project").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const item = btn.closest<HTMLElement>(".accordion-item");
      if (!item) return;
      const input = item.querySelector<HTMLInputElement>('[data-field="project-id-input"]');
      const pid = input?.value.trim() ?? "";
      await confirmGoogleSttProject(item, pid);
    });
  });

  // 旧 provider settings の Project ID 候補を明示確定
  container.querySelectorAll<HTMLButtonElement>(".btn-google-stt-confirm-legacy-project").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const item = btn.closest<HTMLElement>(".accordion-item");
      if (!item) return;
      const candidate = item.querySelector<HTMLElement>('[data-field="legacy-project-value"]')?.textContent?.trim() ?? "";
      if (!candidate) return;
      await confirmGoogleSttProject(item, candidate);
      await loadGoogleSttProjects(item);
    });
  });

  // 別の音声ファイルで試す（詳細設定内: 選択→即認識）
  container.querySelectorAll<HTMLElement>(".btn-google-stt-select-file").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const item = btn.closest<HTMLElement>(".accordion-item");
      if (!item) return;
      const resultEl = item.querySelector<HTMLElement>('[data-field="recognize-result"]');
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({
          multiple: false,
          filters: [{ name: "音声ファイル", extensions: ["wav", "mp3", "ogg", "flac", "m4a", "webm", "opus", "aac", "wma"] }],
        });
        if (!selected || typeof selected !== "string") return; // キャンセル時は何もしない

        const fileName = selected.split(/[/\\]/).pop() || selected;
        const fileLabel = item.querySelector<HTMLElement>('[data-field="selected-file"]');
        if (fileLabel) {
          fileLabel.textContent = fileName;
          fileLabel.style.display = "";
        }

        if (resultEl) { resultEl.style.display = "none"; resultEl.textContent = ""; }

        const origHtml = btn.innerHTML;
        btn.innerHTML = '<span class="material-symbols-outlined spin">mic</span> 認識中...';
        (btn as HTMLButtonElement).disabled = true;

        const snapshot = currentGoogleAuthStatus;
        if (!snapshot || snapshot.state !== "connected" || !snapshot.projectId) {
          throw new Error("Googleアカウントにログインし、Project IDを確定してください。");
        }
        const capturedMeta = {
          authGeneration: snapshot.authGeneration,
          sub: snapshot.sub,
          oauthClientIdFingerprint: snapshot.oauthClientIdFingerprint,
        };
        try {
          const projectId = snapshot.projectId;
          const location = item.querySelector<HTMLSelectElement>('[data-field="location"]')?.value || "us-central1";
          const recognizerId = item.querySelector<HTMLInputElement>('[data-field="recognizer-id"]')?.value?.trim() || "_";
          const langSel = item.querySelector<HTMLSelectElement>('[data-field="language-code"]');
          const languageCode = langSel?.value?.trim() || "ja-JP";

          const result = await invokeTauri<GoogleSttRecognizeResult & {
            authGeneration?: number;
            sub?: string;
            oauthClientIdFingerprint?: string;
          }>("google_stt_recognize", {
            input: { projectId, location, recognizerId, languageCode, model: "chirp_2", audioPath: selected },
          });
          if (!isGoogleAuthResponseCurrent(currentGoogleAuthStatus, {
            authGeneration: result.authGeneration ?? capturedMeta.authGeneration,
            sub: result.sub ?? capturedMeta.sub,
            oauthClientIdFingerprint: result.oauthClientIdFingerprint ?? capturedMeta.oauthClientIdFingerprint,
          })) {
            return;
          }
          renderGoogleSttRecognitionSuccess(resultEl!, result, {
            sourceLabel: `使用ファイル: ${fileName}`,
            languageCode,
            model: "chirp_2",
          });
        } catch (e) {
          const parsed = parseGoogleApiError(e);
          if (!isGoogleAuthResponseCurrent(currentGoogleAuthStatus, {
            authGeneration: parsed.authGeneration ?? capturedMeta.authGeneration,
            sub: parsed.sub ?? capturedMeta.sub,
            oauthClientIdFingerprint: parsed.oauthClientIdFingerprint ?? capturedMeta.oauthClientIdFingerprint,
          })) {
            return;
          }
          renderGoogleSttRecognitionError(resultEl!, e, `使用ファイル: ${fileName}`);
        } finally {
          btn.innerHTML = origHtml;
          (btn as HTMLButtonElement).disabled = false;
        }
      } catch (e) {
        console.error("open_audio_file_dialog error:", e);
      }
    });
  });

  // 接続・認識テスト（同梱音声）- Google STTプロバイダー内のみ
  container.querySelectorAll<HTMLElement>('.accordion-item[data-provider-id="google_stt"] .btn-google-stt-builtin-test').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const item = btn.closest<HTMLElement>(".accordion-item");
      if (!item) return;
      await runBuiltinTest(item, btn);
    });
  });

  container.querySelectorAll<HTMLElement>('.accordion-item[data-provider-id="google_stt"] .btn-google-stt-confirm-enable-api').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const item = btn.closest<HTMLElement>(".accordion-item");
      if (!item) return;
      await runSpeechApiEnablementAndRetest(item, btn as HTMLButtonElement);
    });
  });

  container.querySelectorAll<HTMLElement>('.accordion-item[data-provider-id="google_stt"] .btn-google-stt-cancel-enable-api').forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = btn.closest<HTMLElement>(".accordion-item");
      if (!item) return;
      hideSpeechApiPanels(item);
    });
  });

  container.querySelectorAll<HTMLElement>('.accordion-item[data-provider-id="google_stt"] .btn-google-stt-open-console').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const item = btn.closest<HTMLElement>(".accordion-item");
      const projectId = currentGoogleAuthStatus?.projectId?.trim() || "";
      if (!item || !projectId) return;
      try {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(buildGoogleCloudSpeechConsoleUrl(projectId));
      } catch (e) {
        console.error("openUrl error:", e);
      }
    });
  });

  container.querySelectorAll<HTMLElement>('.accordion-item[data-provider-id="google_stt"] .btn-google-stt-recheck-api').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const item = btn.closest<HTMLElement>(".accordion-item");
      if (!item) return;
      await recheckSpeechApiStateAndContinue(item, btn as HTMLButtonElement);
    });
  });
}

// ---- Xiaomi MiMo ASR ----

type XiaomiMimoAsrResult = {
  transcript: string;
  language: string;
  model: string;
  provider: string;
  endpoint: string;
  httpStatus: number;
  requestId?: string;
};

function markXiaomiMimoAsrVerified(item: HTMLElement): void {
  setStatusBadge(item.querySelector<HTMLElement>("[data-status-badge]"), "接続確認済み");
  item.querySelector<HTMLElement>("[data-status-badge]")?.setAttribute("data-connection-state", "verified");
}

function invalidateXiaomiMimoAsrVerification(item: HTMLElement): void {
  const badge = item.querySelector<HTMLElement>("[data-status-badge]");
  const currentState = badge?.getAttribute("data-connection-state");
  if (currentState === "verified") {
    setStatusBadge(badge, "設定済み");
    badge?.setAttribute("data-connection-state", "configured");
  }
}

function renderXiaomiMimoAsrSuccess(
  resultEl: HTMLElement,
  result: XiaomiMimoAsrResult,
  context: { sourceLabel: string },
): void {
  const lines: string[] = [`✓ ${result.provider} APIへの接続と音声認識に成功しました`, ""];
  lines.push("認識結果:");
  lines.push(result.transcript || "(空の文字起こし)");
  lines.push("");
  lines.push(`接続先: ${result.endpoint}`);
  lines.push(`HTTP: ${result.httpStatus}`);
  lines.push(`音声: ${context.sourceLabel}`);
  lines.push(`認識言語: ${result.language}`);
  lines.push(`モデル: ${result.model}`);
  if (result.requestId) {
    lines.push(`Request ID: ${result.requestId}`);
  }
  resultEl.textContent = lines.join("\n");
  resultEl.className = "google-stt-result google-stt-result-success";
  resultEl.hidden = false;
}

function renderXiaomiMimoAsrError(resultEl: HTMLElement, error: unknown, sourceLabel: string): void {
  const msg = error instanceof Error ? error.message
    : typeof error === "object" && error !== null && "message" in error ? String((error as { message: unknown }).message)
    : String(error);
  const lines = [
    "✗ 音声認識に失敗しました",
    "",
    msg,
    "",
    `音声: ${sourceLabel}`,
  ];
  resultEl.textContent = lines.join("\n");
  resultEl.className = "google-stt-result google-stt-result-error";
  resultEl.hidden = false;
}

async function runXiaomiMimoAsrBuiltinTest(item: HTMLElement, btn: HTMLButtonElement): Promise<void> {
  const baseUrl = item.querySelector<HTMLInputElement>('[data-field="base-url"]')?.value?.trim() || "https://api.xiaomimimo.com/v1";
  const resultEl = item.querySelector<HTMLElement>('[data-field="recognize-result"]');

  const loadingState = setButtonLoading(btn, '<span class="material-symbols-outlined spin">mic</span> 認識しています…');
  if (resultEl) { resultEl.hidden = true; resultEl.textContent = ""; }

  try {
    const result = await invokeTauri<XiaomiMimoAsrResult>(
      "xiaomi_mimo_asr_run_builtin_test",
      { input: { baseUrl } },
    );

    if (resultEl) {
      renderXiaomiMimoAsrSuccess(resultEl, result, {
        sourceLabel: "同梱テスト音声（en）",
      });
    }
    markXiaomiMimoAsrVerified(item);
  } catch (e) {
    if (resultEl) {
      renderXiaomiMimoAsrError(resultEl, e, "同梱テスト音声（en）");
    }
  } finally {
    restoreButtonLoading(btn, loadingState);
  }
}

async function runXiaomiMimoAsrFileTest(item: HTMLElement, btn: HTMLButtonElement): Promise<void> {
  const resultEl = item.querySelector<HTMLElement>('[data-field="recognize-result"]');

  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      filters: [{ name: "音声ファイル", extensions: ["wav", "mp3"] }],
    });
    if (!selected || typeof selected !== "string") return;

    const fileName = selected.split(/[/\\]/).pop() || selected;
    const baseUrl = item.querySelector<HTMLInputElement>('[data-field="base-url"]')?.value?.trim() || "https://api.xiaomimimo.com/v1";
    const language = item.querySelector<HTMLSelectElement>('[data-field="language-code"]')?.value || "auto";

    if (resultEl) { resultEl.hidden = true; resultEl.textContent = ""; }

    const loadingState = setButtonLoading(btn, '<span class="material-symbols-outlined spin">mic</span> 認識しています…');
    try {
      const result = await invokeTauri<XiaomiMimoAsrResult>("xiaomi_mimo_asr_recognize", {
        input: { baseUrl, model: "mimo-v2.5-asr", language, audioPath: selected },
      });
      if (resultEl) {
        renderXiaomiMimoAsrSuccess(resultEl, result, { sourceLabel: `使用ファイル: ${fileName}` });
      }
    } catch (e) {
      if (resultEl) {
        renderXiaomiMimoAsrError(resultEl, e, `使用ファイル: ${fileName}`);
      }
    } finally {
      restoreButtonLoading(btn, loadingState);
    }
  } catch (e) {
    console.error("open_audio_file_dialog error:", e);
  }
}

function bindXiaomiMimoAsrHandlers(container: ParentNode = document) {
  container.querySelectorAll<HTMLElement>('.accordion-item[data-provider-id="xiaomi_mimo_asr"]').forEach((item) => {
    // 注意: 詳細設定トグルは bindProviderConfigAutoSave() で全プロバイダー共通に登録済み
    // ここでは重複登録しない

    // 接続・認識テスト（同梱音声）
    item.querySelectorAll<HTMLButtonElement>(".btn-mimo-asr-builtin-test").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await runXiaomiMimoAsrBuiltinTest(item, btn);
      });
    });

    // 別の音声ファイルで試す（詳細設定内）
    item.querySelectorAll<HTMLButtonElement>(".btn-mimo-asr-select-file").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await runXiaomiMimoAsrFileTest(item, btn);
      });
    });

    // Base URL変更時に接続確認状態を無効化
    item.querySelectorAll<HTMLInputElement>('[data-field="base-url"]').forEach((input) => {
      input.addEventListener("change", () => {
        invalidateXiaomiMimoAsrVerification(item);
      });
    });
  });
}

async function runGoogleOAuthLogin(
  item: HTMLElement,
  btn: HTMLButtonElement,
  command: "google_auth_login" | "google_auth_switch_account",
  forceConsent: boolean = false,
): Promise<void> {
  const originalHtml = btn.innerHTML;
  btn.innerHTML = '<span class="material-symbols-outlined spin">login</span> ブラウザーで認証中...';
  btn.disabled = true;
  const authErrorEl = item.querySelector<HTMLElement>('[data-field="auth-error"]');
  if (authErrorEl) authErrorEl.style.display = "none";

  try {
    const status = await invokeTauri<GoogleAuthStatus>(command, { forceConsent });
    applyAndSyncGoogleAuthStatus(item, status);
    const advancedContent = item.querySelector<HTMLElement>('[data-field="advanced-content"]');
    if (status.state === "connected" && advancedContent && !advancedContent.hidden) {
      await loadGoogleSttProjects(item);
    }
    if (shouldAutoRunDefaultOnboarding(currentGoogleAuthStatus, attemptedOnboardingSessionIds)) {
      await runGoogleDefaultOnboarding(item);
    }
  } catch (e) {
    const parsed = parseGoogleApiError(e);
    if (authErrorEl) {
      authErrorEl.textContent = parsed.isUserCancel
        ? "ログインがキャンセルされました。"
        : formatGoogleSttErrorMessage(e);
      authErrorEl.style.display = "";
    }
    const retryConsentBtn = item.querySelector<HTMLButtonElement>(".btn-google-auth-retry-consent");
    if (retryConsentBtn) {
      retryConsentBtn.hidden = parsed.kind !== "oauth_refresh_token_missing";
    }
    // Keep existing active account (if any) intact on pre-commit failure!
    const latest = await invokeTauri<GoogleAuthStatus>("google_auth_get_status").catch(() => null);
    if (latest) {
      applyAndSyncGoogleAuthStatus(item, latest);
    }
  } finally {
    btn.innerHTML = originalHtml;
    btn.disabled = false;
  }
}

// ---- Google STT: common display functions ----

type GoogleSttRecognizeResult = {
  transcript: string;
  segments: Array<{
    transcript: string;
    confidence?: number;
    languageCode?: string;
  }>;
};

function renderGoogleSttRecognitionSuccess(
  resultEl: HTMLElement,
  result: GoogleSttRecognizeResult,
  context: { sourceLabel: string; languageCode?: string; model: string },
): void {
  const lines: string[] = ["✓ API接続と音声認識に成功しました", "", `認識結果:`];
  lines.push(result.transcript || "(空の文字起こし)");
  lines.push("");
  lines.push(`音声: ${context.sourceLabel}`);
  if (context.languageCode) lines.push(`認識言語: ${context.languageCode}`);
  if (result.segments.length > 0) {
    for (const seg of result.segments) {
      if (seg.confidence != null) {
        lines.push(`信頼度: ${(seg.confidence * 100).toFixed(1)}%`);
        break;
      }
    }
  }
  lines.push(`モデル: ${context.model}`);
  resultEl.textContent = lines.join("\n");
  resultEl.style.display = "block";
}

const attemptedOnboardingSessionIds = new Set<string>();
let activeOnboardingRunSeq = 0;

function hideGoogleOnboardingPanels(item: HTMLElement): void {
  const statusPanel = item.querySelector<HTMLElement>('[data-field="onboarding-status-panel"]');
  const actionPanel = item.querySelector<HTMLElement>('[data-field="onboarding-action-panel"]');
  if (statusPanel) statusPanel.hidden = true;
  if (actionPanel) actionPanel.hidden = true;
}

function setGoogleOnboardingBusy(item: HTMLElement, busy: boolean, statusText?: string): void {
  const statusPanel = item.querySelector<HTMLElement>('[data-field="onboarding-status-panel"]');
  const statusTextEl = item.querySelector<HTMLElement>('[data-field="onboarding-status-text"]');
  if (statusPanel) {
    statusPanel.hidden = !busy;
  }
  if (statusTextEl && statusText) {
    statusTextEl.textContent = statusText;
  }
  const controls = item.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(
    ".btn-google-auth-login, .btn-google-auth-switch, .btn-google-stt-builtin-test",
  );
  controls.forEach((el) => {
    if (busy) {
      el.dataset.onboardingPrevDisabled = String(el.disabled);
      el.disabled = true;
    } else if (el.dataset.onboardingPrevDisabled !== undefined) {
      el.disabled = el.dataset.onboardingPrevDisabled === "true";
      delete el.dataset.onboardingPrevDisabled;
    }
  });
}

function showGoogleOnboardingActionPanel(
  item: HTMLElement,
  opts: {
    title: string;
    reason: string;
    email?: string;
    projectId?: string;
    requiredPermission?: string;
    showRetry?: boolean;
    showSwitchAccount?: boolean;
  },
): void {
  const panel = item.querySelector<HTMLElement>('[data-field="onboarding-action-panel"]');
  if (!panel) return;
  const titleEl = panel.querySelector<HTMLElement>('[data-field="onboarding-action-title"]');
  const reasonEl = panel.querySelector<HTMLElement>('[data-field="onboarding-action-reason"]');
  const metaEl = panel.querySelector<HTMLElement>('[data-field="onboarding-action-meta"]');
  const retryBtn = panel.querySelector<HTMLButtonElement>(".btn-google-onboarding-retry");
  const switchBtn = panel.querySelector<HTMLButtonElement>(".btn-google-onboarding-switch");
  if (titleEl) titleEl.textContent = opts.title;
  if (reasonEl) reasonEl.textContent = opts.reason;
  const metaParts: string[] = [];
  if (opts.email) metaParts.push(`アカウント: ${opts.email}`);
  if (opts.projectId) metaParts.push(`対象Project: ${opts.projectId}`);
  if (opts.requiredPermission) metaParts.push(`必要な権限: ${opts.requiredPermission}`);
  if (metaEl) {
    metaEl.textContent = metaParts.join(" / ");
    metaEl.hidden = metaParts.length === 0;
  }
  if (retryBtn) retryBtn.hidden = !opts.showRetry;
  if (switchBtn) switchBtn.hidden = !opts.showSwitchAccount;
  panel.hidden = false;
}

async function runGoogleDefaultOnboarding(
  item: HTMLElement,
  opts: {
    enableSpeechApiIfNeeded?: boolean;
    allowRetrySameSession?: boolean;
    confirmContext?: PendingSpeechApiEnableContext;
  } = {},
): Promise<void> {
  const snapshot = currentGoogleAuthStatus;
  if (!snapshot || snapshot.state !== "connected") return;
  const authSessionId = snapshot.authSessionId ?? "";
  if (!opts.allowRetrySameSession && authSessionId && attemptedOnboardingSessionIds.has(authSessionId)) {
    return;
  }
  const targetProject = opts.confirmContext?.projectId || snapshot.defaultProjectId?.trim() || "";
  if (!targetProject) return;

  if (authSessionId) {
    attemptedOnboardingSessionIds.add(authSessionId);
  }
  const runSeq = ++activeOnboardingRunSeq;
  const capturedIdentity = {
    authGeneration: snapshot.authGeneration,
    authSessionId,
    sub: snapshot.sub,
    oauthClientIdFingerprint: snapshot.oauthClientIdFingerprint,
  };

  hideGoogleOnboardingPanels(item);
  hideSpeechApiPanels(item);
  setGoogleOnboardingBusy(
    item,
    true,
    opts.enableSpeechApiIfNeeded
      ? `Google Cloudを準備しています（${snapshot.email || ""} / ${targetProject}: API有効化と接続確認中…）`
      : `Google Cloudを準備しています（${snapshot.email || ""} / ${targetProject}: 接続確認中…）`,
  );

  try {
    const res = await invokeTauri<GoogleOnboardingResult>("google_auth_complete_onboarding", {
      input: opts.enableSpeechApiIfNeeded && opts.confirmContext
        ? {
            enableSpeechApiIfNeeded: true,
            expectedAuthSessionId: opts.confirmContext.authSessionId ?? capturedIdentity.authSessionId,
            expectedAuthGeneration: opts.confirmContext.authGeneration,
            expectedSub: opts.confirmContext.sub,
            expectedOauthClientIdFingerprint: opts.confirmContext.oauthClientIdFingerprint,
            expectedProjectId: opts.confirmContext.projectId,
          }
        : { enableSpeechApiIfNeeded: false },
    });

    const latest = currentGoogleAuthStatus;
    if (
      runSeq !== activeOnboardingRunSeq ||
      !latest ||
      latest.state !== "connected" ||
      (latest.authSessionId ?? "") !== capturedIdentity.authSessionId ||
      (latest.sub ?? "") !== (capturedIdentity.sub ?? "") ||
      latest.oauthClientIdFingerprint !== capturedIdentity.oauthClientIdFingerprint ||
      latest.projectSource === "user_selected"
    ) {
      return;
    }

    setGoogleOnboardingBusy(item, false);
    applyAndSyncGoogleAuthStatus(item, res.status);

    const resultEl = item.querySelector<HTMLElement>('[data-field="recognize-result"]');
    switch (res.outcome) {
      case "ready":
      case "already_ready_user_project": {
        hideGoogleOnboardingPanels(item);
        if (resultEl) {
          resultEl.textContent = `✓ 利用可能: ${res.email || res.status.email || ""} / Project: ${res.projectId || res.status.projectId || ""}`;
          resultEl.style.display = "block";
        }
        break;
      }
      case "needs_api_enable_consent": {
        const pid = res.consumerProject || res.projectId || targetProject;
        showSpeechApiEnableConfirmPanel(item, pid, {
          authGeneration: res.authGeneration,
          sub: res.sub,
          oauthClientIdFingerprint: res.oauthClientIdFingerprint,
          authSessionId: res.authSessionId,
          mode: "onboarding",
        });
        break;
      }
      case "project_access_denied":
        showGoogleOnboardingActionPanel(item, {
          title: "既定の Google Cloud プロジェクトにアクセスできません（利用者対応が必要）",
          reason: res.message,
          email: res.email || res.status.email,
          projectId: res.projectId || targetProject,
          requiredPermission: res.requiredPermission,
          showRetry: true,
          showSwitchAccount: true,
        });
        break;
      case "workspace_denied":
        showGoogleOnboardingActionPanel(item, {
          title: "Google Workspace 管理ポリシーにより利用できません（利用者対応が必要）",
          reason: res.message,
          email: res.email || res.status.email,
          projectId: res.projectId || targetProject,
          showSwitchAccount: true,
        });
        break;
      case "billing_or_quota_error":
        showGoogleOnboardingActionPanel(item, {
          title: "課金設定または利用上限を確認してください（利用者対応が必要）",
          reason: res.message,
          email: res.email || res.status.email,
          projectId: res.projectId || targetProject,
          showRetry: true,
          showSwitchAccount: true,
        });
        break;
      case "network_or_timeout":
        showGoogleOnboardingActionPanel(item, {
          title: "接続確認がタイムアウトまたは通信エラーになりました",
          reason: res.message,
          email: res.email || res.status.email,
          projectId: res.projectId || targetProject,
          showRetry: true,
          showSwitchAccount: false,
        });
        break;
      case "reauth_required":
        showGoogleOnboardingActionPanel(item, {
          title: "Googleアカウントの再認証が必要です",
          reason: res.message,
          email: res.email || res.status.email,
          projectId: res.projectId || targetProject,
          showRetry: false,
          showSwitchAccount: true,
        });
        break;
      case "configuration_error":
        showGoogleOnboardingActionPanel(item, {
          title: "アプリの Google Cloud 設定が不完全です",
          reason: res.message,
          showRetry: false,
          showSwitchAccount: false,
        });
        break;
      case "cancelled_or_stale":
        hideGoogleOnboardingPanels(item);
        break;
      default:
        showGoogleOnboardingActionPanel(item, {
          title: "Google Cloud の準備を完了できませんでした",
          reason: res.message,
          email: res.email || res.status.email,
          projectId: res.projectId || targetProject,
          showRetry: true,
          showSwitchAccount: true,
        });
        break;
    }
  } catch (e) {
    setGoogleOnboardingBusy(item, false);
    const latest = currentGoogleAuthStatus;
    if (
      runSeq !== activeOnboardingRunSeq ||
      !latest ||
      latest.state !== "connected" ||
      (latest.authSessionId ?? "") !== capturedIdentity.authSessionId
    ) {
      return;
    }
    showGoogleOnboardingActionPanel(item, {
      title: "Google Cloud の準備に失敗しました",
      reason: formatGoogleSttErrorMessage(e),
      email: latest.email,
      projectId: targetProject,
      showRetry: true,
      showSwitchAccount: true,
    });
  } finally {
    if (runSeq === activeOnboardingRunSeq) {
      setGoogleOnboardingBusy(item, false);
    }
  }
}

interface PendingSpeechApiEnableContext {
  projectId: string;
  authGeneration: number;
  sub?: string;
  oauthClientIdFingerprint: string;
  authSessionId?: string;
  mode: "manual" | "onboarding";
}

let pendingSpeechApiEnableContext: PendingSpeechApiEnableContext | null = null;

function clearPendingSpeechApiEnableContext(): void {
  pendingSpeechApiEnableContext = null;
}

function isPendingSpeechApiEnableContextCurrent(
  status: GoogleAuthStatus | null,
  ctx: PendingSpeechApiEnableContext | null,
): boolean {
  if (!ctx || !status || status.state !== "connected") return false;
  if (ctx.mode === "onboarding") {
    const defaultPid = status.defaultProjectId?.trim() || "";
    return (
      defaultPid !== "" &&
      defaultPid === ctx.projectId &&
      !status.projectVerified &&
      status.projectSource !== "user_selected" &&
      (status.authSessionId ?? "") === (ctx.authSessionId ?? "") &&
      status.authGeneration === ctx.authGeneration &&
      (status.sub ?? "") === (ctx.sub ?? "") &&
      status.oauthClientIdFingerprint === ctx.oauthClientIdFingerprint
    );
  }
  const currentProjectId = status.projectId?.trim() || "";
  return (
    currentProjectId !== "" &&
    currentProjectId === ctx.projectId &&
    status.authGeneration === ctx.authGeneration &&
    (status.sub ?? "") === (ctx.sub ?? "") &&
    status.oauthClientIdFingerprint === ctx.oauthClientIdFingerprint
  );
}

function hideSpeechApiPanels(item: HTMLElement): void {
  clearPendingSpeechApiEnableContext();
  const confirmPanel = item.querySelector<HTMLElement>('[data-field="api-enable-confirm-panel"]');
  const fallbackPanel = item.querySelector<HTMLElement>('[data-field="api-fallback-panel"]');
  if (confirmPanel) {
    confirmPanel.hidden = true;
    delete confirmPanel.dataset.confirmProjectId;
    delete confirmPanel.dataset.confirmAuthGeneration;
    delete confirmPanel.dataset.confirmSub;
    delete confirmPanel.dataset.confirmOauthClientIdFingerprint;
    delete confirmPanel.dataset.confirmMode;
    delete confirmPanel.dataset.confirmAuthSessionId;
  }
  if (fallbackPanel) fallbackPanel.hidden = true;
}

function showSpeechApiEnableConfirmPanel(
  item: HTMLElement,
  projectId: string,
  meta?: {
    authGeneration: number;
    sub?: string;
    oauthClientIdFingerprint: string;
    authSessionId?: string;
    mode?: "manual" | "onboarding";
  },
): void {
  hideSpeechApiPanels(item);
  const snapshot = currentGoogleAuthStatus;
  const mode = meta?.mode ?? "manual";
  const resolvedMeta =
    meta ??
    (snapshot && snapshot.state === "connected"
      ? {
          authGeneration: snapshot.authGeneration,
          sub: snapshot.sub,
          oauthClientIdFingerprint: snapshot.oauthClientIdFingerprint,
          authSessionId: snapshot.authSessionId,
          mode: "manual" as const,
        }
      : null);
  const normalizedProjectId = projectId.trim();
  const expectedSnapshotProject =
    mode === "onboarding"
      ? snapshot?.defaultProjectId?.trim()
      : snapshot?.projectId?.trim();
  if (
    !resolvedMeta ||
    !normalizedProjectId ||
    !snapshot ||
    snapshot.state !== "connected" ||
    expectedSnapshotProject !== normalizedProjectId ||
    snapshot.authGeneration !== resolvedMeta.authGeneration ||
    (snapshot.sub ?? "") !== (resolvedMeta.sub ?? "") ||
    snapshot.oauthClientIdFingerprint !== resolvedMeta.oauthClientIdFingerprint ||
    (mode === "onboarding" &&
      (snapshot.authSessionId ?? "") !== (resolvedMeta.authSessionId ?? ""))
  ) {
    return;
  }
  pendingSpeechApiEnableContext = {
    projectId: normalizedProjectId,
    authGeneration: resolvedMeta.authGeneration,
    sub: resolvedMeta.sub,
    oauthClientIdFingerprint: resolvedMeta.oauthClientIdFingerprint,
    authSessionId: resolvedMeta.authSessionId ?? snapshot.authSessionId,
    mode,
  };
  const confirmPanel = item.querySelector<HTMLElement>('[data-field="api-enable-confirm-panel"]');
  const projectEl = confirmPanel?.querySelector<HTMLElement>('[data-field="enable-target-project"]');
  const serviceEl = confirmPanel?.querySelector<HTMLElement>('[data-field="enable-target-service"]');
  if (projectEl) projectEl.textContent = normalizedProjectId;
  if (serviceEl) serviceEl.textContent = "speech.googleapis.com";
  if (confirmPanel) {
    confirmPanel.dataset.confirmProjectId = normalizedProjectId;
    confirmPanel.dataset.confirmAuthGeneration = String(resolvedMeta.authGeneration);
    confirmPanel.dataset.confirmSub = resolvedMeta.sub ?? "";
    confirmPanel.dataset.confirmOauthClientIdFingerprint = resolvedMeta.oauthClientIdFingerprint;
    confirmPanel.dataset.confirmMode = mode;
    confirmPanel.dataset.confirmAuthSessionId = resolvedMeta.authSessionId ?? snapshot.authSessionId ?? "";
    confirmPanel.hidden = false;
  }
}

function showSpeechApiFallbackPanel(
  item: HTMLElement,
  opts: {
    title: string;
    reason: string;
    projectId: string;
    requiredPermission?: string;
  },
): void {
  hideSpeechApiPanels(item);
  const panel = item.querySelector<HTMLElement>('[data-field="api-fallback-panel"]');
  if (!panel) return;
  const titleEl = panel.querySelector<HTMLElement>('[data-field="fallback-title"]');
  const reasonEl = panel.querySelector<HTMLElement>('[data-field="fallback-reason"]');
  const projectEl = panel.querySelector<HTMLElement>('[data-field="fallback-project"]');
  const permWrap = panel.querySelector<HTMLElement>('[data-field="fallback-permission-wrap"]');
  const permEl = panel.querySelector<HTMLElement>('[data-field="fallback-permission"]');
  if (titleEl) titleEl.textContent = opts.title;
  if (reasonEl) reasonEl.textContent = opts.reason;
  if (projectEl) projectEl.textContent = opts.projectId;
  if (permWrap && permEl) {
    if (opts.requiredPermission) {
      permEl.textContent = opts.requiredPermission;
      permWrap.hidden = false;
    } else {
      permEl.textContent = "";
      permWrap.hidden = true;
    }
  }
  panel.hidden = false;
}

function renderGoogleSttRecognitionError(
  resultEl: HTMLElement,
  error: unknown,
  sourceLabel: string,
): void {
  const msg = formatGoogleSttErrorMessage(error);
  const safeMsg = msg.length > 500 ? msg.substring(0, 500) + "..." : msg;
  resultEl.textContent =
    `✗ 認識に失敗しました\n\n音声: ${sourceLabel}\nエラー: ${safeMsg}\n\n次の手段: 対象Projectやリージョンを確認して再テストするか、Google Cloud Console で API・権限の状態を確認してください。`;
  resultEl.style.display = "block";
}

function handleGoogleSpeechPreparationError(
  item: HTMLElement,
  projectId: string,
  error: unknown,
  resultEl: HTMLElement | null,
  sourceLabel: string,
  meta?: {
    authGeneration: number;
    sub?: string;
    oauthClientIdFingerprint: string;
  },
): void {
  const parsed = parseGoogleApiError(error);
  if (canPromptSpeechApiEnable(parsed, projectId)) {
    showSpeechApiEnableConfirmPanel(item, projectId, meta);
    return;
  }

  switch (parsed.kind) {
    case "speech_api_disabled":
      showSpeechApiFallbackPanel(item, {
        title: "Speech-to-Text API の有効化先を自動特定できませんでした",
        reason:
          "Googleの応答から有効化対象Projectの一致を確認できなかったため、自動有効化を行いませんでした。Consoleで確認するか「状態を再確認」を実行してください。",
        projectId,
      });
      return;
    case "service_usage_permission_denied":
      showSpeechApiFallbackPanel(item, {
        title: "APIを有効化する権限が不足しています",
        reason: parsed.message,
        projectId,
        requiredPermission: "serviceusage.services.enable",
      });
      return;
    case "service_usage_api_disabled":
      showSpeechApiFallbackPanel(item, {
        title: "Service Usage API が無効です",
        reason: parsed.message,
        projectId,
      });
      return;
    case "oauth_admin_policy_enforced":
      showSpeechApiFallbackPanel(item, {
        title: "Workspace管理ポリシーにより制限されています",
        reason: parsed.message,
        projectId,
      });
      return;
    case "oauth_scope_not_granted":
      showSpeechApiFallbackPanel(item, {
        title: "OAuth認証スコープが不足しています",
        reason: parsed.message,
        projectId,
      });
      return;
    case "service_usage_operation_timeout":
      showSpeechApiFallbackPanel(item, {
        title: "API有効化の結果を確認中です（タイムアウト）",
        reason: parsed.message,
        projectId,
      });
      return;
    case "service_usage_operation_failed":
      showSpeechApiFallbackPanel(item, {
        title: "API有効化に失敗しました",
        reason: parsed.message,
        projectId,
      });
      return;
    default:
      if (resultEl) renderGoogleSttRecognitionError(resultEl, error, sourceLabel);
  }
}

async function runSpeechApiEnablementAndRetest(
  item: HTMLElement,
  btn: HTMLButtonElement,
): Promise<void> {
  const snapshot = currentGoogleAuthStatus;
  const confirmPanel = item.querySelector<HTMLElement>('[data-field="api-enable-confirm-panel"]');
  const panelProjectId = confirmPanel?.dataset.confirmProjectId?.trim() || "";
  const panelGenRaw = confirmPanel?.dataset.confirmAuthGeneration;
  const panelSub = confirmPanel?.dataset.confirmSub ?? "";
  const panelFingerprint = confirmPanel?.dataset.confirmOauthClientIdFingerprint ?? "";
  const ctx = pendingSpeechApiEnableContext;
  const matchesDom =
    !!confirmPanel &&
    !confirmPanel.hidden &&
    !!ctx &&
    panelProjectId === ctx.projectId &&
    panelGenRaw === String(ctx.authGeneration) &&
    panelSub === (ctx.sub ?? "") &&
    panelFingerprint === ctx.oauthClientIdFingerprint;

  const resultEl = item.querySelector<HTMLElement>('[data-field="recognize-result"]');

  if (!matchesDom || !isPendingSpeechApiEnableContextCurrent(snapshot, ctx)) {
    hideSpeechApiPanels(item);
    const currentProjectId = snapshot?.projectId?.trim() || "";
    if (resultEl) {
      resultEl.textContent = currentProjectId
        ? `Projectまたは認証状態が変更されたため、確認パネルを閉じました。現在のProject（${currentProjectId}）で再度「準備して接続テスト」を実行してください。`
        : "Projectまたは認証状態が変更されたため、確認パネルを閉じました。Projectを選択して再度「準備して接続テスト」を実行してください。";
      resultEl.style.display = "block";
    }
    return;
  }

  if (ctx?.mode === "onboarding" && matchesDom && isPendingSpeechApiEnableContextCurrent(snapshot, ctx)) {
    const onboardingCtx = { ...ctx };
    await runGoogleDefaultOnboarding(item, {
      enableSpeechApiIfNeeded: true,
      allowRetrySameSession: true,
      confirmContext: onboardingCtx,
    });
    return;
  }

  const projectId = ctx.projectId;
  const capturedMeta = {
    authGeneration: ctx.authGeneration,
    sub: ctx.sub,
    oauthClientIdFingerprint: ctx.oauthClientIdFingerprint,
  };

  const originalText = btn.textContent || "有効化してテストを続行";
  btn.disabled = true;
  btn.textContent = "有効化中…";
  if (resultEl) {
    resultEl.textContent = `Project ${projectId} で speech.googleapis.com を有効化しています…`;
    resultEl.style.display = "block";
  }

  try {
    const res = await invokeTauri<EnableSpeechApiResult>("google_stt_enable_speech_api", {
      projectId,
      confirmed: true,
    });
    if (
      !isGoogleAuthResponseCurrent(currentGoogleAuthStatus, {
        authGeneration: res.authGeneration ?? capturedMeta.authGeneration,
        sub: res.sub ?? capturedMeta.sub,
        oauthClientIdFingerprint:
          res.oauthClientIdFingerprint ?? capturedMeta.oauthClientIdFingerprint,
      }) ||
      currentGoogleAuthStatus?.projectId?.trim() !== projectId
    ) {
      return;
    }

    hideSpeechApiPanels(item);
    const builtinBtn = item.querySelector<HTMLElement>(".btn-google-stt-builtin-test");
    if (builtinBtn) {
      await runBuiltinTest(item, builtinBtn);
    }
  } catch (e) {
    const parsed = parseGoogleApiError(e);
    if (
      !isGoogleAuthResponseCurrent(currentGoogleAuthStatus, {
        authGeneration: parsed.authGeneration ?? capturedMeta.authGeneration,
        sub: parsed.sub ?? capturedMeta.sub,
        oauthClientIdFingerprint:
          parsed.oauthClientIdFingerprint ?? capturedMeta.oauthClientIdFingerprint,
      }) ||
      currentGoogleAuthStatus?.projectId?.trim() !== projectId
    ) {
      return;
    }
    if (resultEl) {
      resultEl.style.display = "none";
      resultEl.textContent = "";
    }
    handleGoogleSpeechPreparationError(item, projectId, e, resultEl, "同梱テスト音声", capturedMeta);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

async function recheckSpeechApiStateAndContinue(
  item: HTMLElement,
  btn: HTMLButtonElement,
): Promise<void> {
  const snapshot = currentGoogleAuthStatus;
  const projectId = snapshot?.projectId?.trim() || "";
  if (!snapshot || snapshot.state !== "connected" || !projectId) {
    return;
  }
  const capturedMeta = {
    authGeneration: snapshot.authGeneration,
    sub: snapshot.sub,
    oauthClientIdFingerprint: snapshot.oauthClientIdFingerprint,
  };

  const resultEl = item.querySelector<HTMLElement>('[data-field="recognize-result"]');
  const originalText = btn.textContent || "状態を再確認";
  btn.disabled = true;
  btn.textContent = "確認中…";

  try {
    const res = await invokeTauri<SpeechApiEnableStateResult>(
      "google_stt_check_speech_api_state",
      { projectId },
    );
    if (
      !isGoogleAuthResponseCurrent(currentGoogleAuthStatus, {
        authGeneration: res.authGeneration ?? capturedMeta.authGeneration,
        sub: res.sub ?? capturedMeta.sub,
        oauthClientIdFingerprint:
          res.oauthClientIdFingerprint ?? capturedMeta.oauthClientIdFingerprint,
      }) ||
      currentGoogleAuthStatus?.projectId?.trim() !== projectId
    ) {
      return;
    }

    if (res.state === "ENABLED") {
      hideSpeechApiPanels(item);
      const builtinBtn = item.querySelector<HTMLElement>(".btn-google-stt-builtin-test");
      if (builtinBtn) {
        await runBuiltinTest(item, builtinBtn);
      }
    } else if (res.state === "DISABLED") {
      showSpeechApiEnableConfirmPanel(item, projectId, capturedMeta);
    } else {
      showSpeechApiFallbackPanel(item, {
        title: "Speech-to-Text API の状態を確認できませんでした",
        reason: `Googleから返されたAPI状態が不明（${res.state || "空"}）のため、自動有効化を行いませんでした。「準備して接続テスト」を直接試すか、Google Cloud Consoleで確認してください。`,
        projectId,
      });
    }
  } catch (e) {
    const parsed = parseGoogleApiError(e);
    if (
      !isGoogleAuthResponseCurrent(currentGoogleAuthStatus, {
        authGeneration: parsed.authGeneration ?? capturedMeta.authGeneration,
        sub: parsed.sub ?? capturedMeta.sub,
        oauthClientIdFingerprint:
          parsed.oauthClientIdFingerprint ?? capturedMeta.oauthClientIdFingerprint,
      }) ||
      currentGoogleAuthStatus?.projectId?.trim() !== projectId
    ) {
      return;
    }
    // State lookup failure must NOT claim the API is disabled: show permission/fallback info and allow direct test.
    if (
      parsed.kind === "service_usage_permission_denied" ||
      parsed.kind === "service_usage_api_disabled" ||
      parsed.kind === "oauth_admin_policy_enforced" ||
      parsed.kind === "oauth_scope_not_granted"
    ) {
      showSpeechApiFallbackPanel(item, {
        title:
          parsed.kind === "oauth_scope_not_granted"
            ? "OAuth認証スコープが不足しています（「準備して接続テスト」も試せます）"
            : "API状態を確認できませんでした（「準備して接続テスト」を直接試せます）",
        reason: parsed.message,
        projectId,
        requiredPermission:
          parsed.kind === "service_usage_permission_denied"
            ? "serviceusage.services.get"
            : undefined,
      });
    } else if (resultEl) {
      renderGoogleSttRecognitionError(resultEl, e, "同梱テスト音声");
    }
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// ---- Google STT: builtin test ----

async function runBuiltinTest(item: HTMLElement, btn: HTMLElement): Promise<void> {
  const snapshot = currentGoogleAuthStatus;
  if (!snapshot || snapshot.state !== "connected") {
    await showAppDialog({ title: "Google未接続", message: "Googleアカウントにログインしてください。", type: "error" });
    return;
  }
  const projectId = snapshot.projectId?.trim() || "";
  if (!projectId) {
    await showAppDialog({ title: "プロジェクト未確定", message: "Google Cloud プロジェクトを選択または入力して「このProjectを使う」を押してください。", type: "error" });
    return;
  }

  const capturedMeta = {
    authGeneration: snapshot.authGeneration,
    sub: snapshot.sub,
    oauthClientIdFingerprint: snapshot.oauthClientIdFingerprint,
  };
  const location = item.querySelector<HTMLSelectElement>('[data-field="location"]')?.value || "us-central1";

  hideSpeechApiPanels(item);
  const originalHtml = btn.innerHTML;
  btn.innerHTML = '<span class="material-symbols-outlined spin">mic</span> 準備・認識テスト中…';
  (btn as HTMLButtonElement).disabled = true;

  const resultEl = item.querySelector<HTMLElement>('[data-field="recognize-result"]');
  if (resultEl) { resultEl.style.display = "none"; resultEl.textContent = ""; }

  try {
    const result = await invokeTauri<GoogleSttRecognizeResult & {
      authGeneration?: number;
      sub?: string;
      oauthClientIdFingerprint?: string;
    }>(
      "google_stt_run_builtin_test",
      { input: { projectId, location } },
    );
    if (
      !isGoogleAuthResponseCurrent(currentGoogleAuthStatus, {
        authGeneration: result.authGeneration ?? capturedMeta.authGeneration,
        sub: result.sub ?? capturedMeta.sub,
        oauthClientIdFingerprint: result.oauthClientIdFingerprint ?? capturedMeta.oauthClientIdFingerprint,
      }) ||
      currentGoogleAuthStatus?.projectId?.trim() !== projectId
    ) {
      return;
    }
    const latest = await invokeTauri<GoogleAuthStatus>("google_auth_get_status").catch(() => null);
    if (
      !latest ||
      !isGoogleAuthResponseCurrent(latest, capturedMeta) ||
      latest.projectId?.trim() !== projectId ||
      !isGoogleAuthResponseCurrent(currentGoogleAuthStatus, capturedMeta) ||
      currentGoogleAuthStatus?.projectId?.trim() !== projectId
    ) {
      return;
    }
    if (resultEl) {
      renderGoogleSttRecognitionSuccess(resultEl, result, {
        sourceLabel: "同梱テスト音声",
        languageCode: "ja-JP",
        model: "chirp_2",
      });
    }
    applyAndSyncGoogleAuthStatus(item, latest);
  } catch (e) {
    console.error("google_stt_run_builtin_test error:", e);
    const parsed = parseGoogleApiError(e);
    if (
      !isGoogleAuthResponseCurrent(currentGoogleAuthStatus, {
        authGeneration: parsed.authGeneration ?? capturedMeta.authGeneration,
        sub: parsed.sub ?? capturedMeta.sub,
        oauthClientIdFingerprint: parsed.oauthClientIdFingerprint ?? capturedMeta.oauthClientIdFingerprint,
      }) ||
      currentGoogleAuthStatus?.projectId?.trim() !== projectId
    ) {
      return;
    }
    handleGoogleSpeechPreparationError(item, projectId, e, resultEl, "同梱テスト音声", capturedMeta);
    const configuredState = getGoogleSttConfiguredState(item);
    setGoogleSttStatus(item, configuredState === "configured" ? "error" : "unconfigured", (el, label) => setStatusBadge(el, label as "未設定" | "設定済み" | "接続確認済み" | "接続エラー"));
  } finally {
    btn.innerHTML = originalHtml;
    (btn as HTMLButtonElement).disabled = false;
  }
}

// ---- Ollama Settings Page ----

async function loadOllamaSettings(navGeneration?: number, container: ParentNode = document): Promise<boolean> {
  if (navGeneration !== undefined && navGeneration !== navigationGeneration) return false;
  try {
    const settings = await invokeTauri<SavedAppSettings>("load_api_settings");
    if (navGeneration !== undefined && navGeneration !== navigationGeneration) return false;

    const targetContainer = container instanceof HTMLElement && container.id === "subpage-settings-ollama"
      ? container
      : container.querySelector<HTMLElement>("#subpage-settings-ollama") ?? container;

    const item = targetContainer.querySelector<HTMLElement>(".accordion-item[data-provider-id='ollama']");
    if (!item) return true;

    const saved = settings.providers["ollama"];

    const baseUrlInput = item.querySelector<HTMLInputElement>('[data-field="base-url"]');
    if (baseUrlInput) {
      const baseUrl = saved?.base_url?.trim() || "http://localhost:11434";
      baseUrlInput.value = baseUrl;
    }

    const modelSelect = item.querySelector<HTMLSelectElement>('[data-field="model"]');
    const modelManualInput = item.querySelector<HTMLInputElement>('[data-field="model-manual"]');

    if (saved?.default_model) {
      if (modelSelect) {
        const options = Array.from(modelSelect.options);
        const match = options.find(o => o.value === saved.default_model);
        if (match) {
          modelSelect.value = saved.default_model;
        } else if (modelManualInput) {
          modelSelect.value = "__manual__";
          modelManualInput.style.display = "";
          modelManualInput.value = saved.default_model;
        }
      } else if (modelManualInput) {
        modelManualInput.value = saved.default_model;
      }
    }

    const statusBadgeEl = item.querySelector<HTMLElement>("[data-status-badge]");
    if (statusBadgeEl && saved) {
      setStatusBadge(statusBadgeEl, "設定済み");
    }
    return true;
  } catch (e) {
    console.error("Failed to load Ollama settings:", e);
    return false;
  }
}

let ollamaSaveTimer: number | null = null;
let ollamaSaveQueue: Promise<void> = Promise.resolve();
let ollamaMessageTimer: number | null = null;

function showOllamaSaveMessage(message: string) {
  const el = document.getElementById("ollamaSaveStatus");
  if (!el) return;
  if (ollamaMessageTimer !== null) {
    window.clearTimeout(ollamaMessageTimer);
  }
  el.textContent = message;
  el.classList.add("visible");
  ollamaMessageTimer = window.setTimeout(() => {
    if (el.isConnected) {
      el.classList.remove("visible");
    }
  }, 2000);
}

async function saveOllamaSettings() {
  const baseUrl = document.getElementById("ollamaBaseUrl") as HTMLInputElement | null;
  const modelSelect = document.getElementById("ollamaModelSelect") as HTMLSelectElement | null;
  const modelManual = document.getElementById("ollamaModelManual") as HTMLInputElement | null;

  const baseUrlValue = baseUrl?.value.trim() ?? "";
  let modelValue = "";
  if (modelSelect) {
    if (modelSelect.value === "__manual__") {
      modelValue = modelManual?.value.trim() ?? "";
    } else {
      modelValue = modelSelect.value;
    }
  }

  try {
    await invokeTauri("save_provider_config", {
      input: {
        providerId: "ollama",
        envName: null,
        baseUrl: baseUrlValue,
        defaultModel: modelValue || null,
      }
    });

    showOllamaSaveMessage("自動保存済み");
    const statusBadgeEl = document.querySelector<HTMLElement>("[data-provider-id='ollama'] [data-status-badge]");
    setStatusBadge(statusBadgeEl, "設定済み");
  } catch (e) {
    console.error("Failed to save Ollama config:", e);
    showOllamaSaveMessage("保存に失敗しました");
  }
}

function scheduleOllamaSave() {
  if (ollamaSaveTimer !== null) {
    window.clearTimeout(ollamaSaveTimer);
  }
  ollamaSaveTimer = window.setTimeout(() => {
    ollamaSaveQueue = ollamaSaveQueue.catch(() => undefined).then(() => saveOllamaSettings());
  }, 300);
}

function bindOllamaAutoSave(container: ParentNode = document) {
  const c = container instanceof HTMLElement ? container : document;
  c.querySelector("#ollamaBaseUrl")?.addEventListener("change", () => { scheduleOllamaSave(); });
  c.querySelector("#ollamaModelSelect")?.addEventListener("change", () => { scheduleOllamaSave(); });
  c.querySelector("#ollamaModelManual")?.addEventListener("change", () => { scheduleOllamaSave(); });
}

function bindOllamaFetchButton(container: ParentNode = document) {
  container.querySelectorAll<HTMLElement>(".btn-fetch-models").forEach((btn) => {
    if (btn.dataset.providerId !== "ollama") return;
    btn.addEventListener("click", async () => {
      const item = btn.closest(".accordion-item");
      if (!item) return;
      await fetchProviderModels("ollama", item, btn);
    });
  });
}

function bindOllamaTestButton(container: ParentNode = document) {
  const c = container instanceof HTMLElement ? container : document;
  const item = c.querySelector(".accordion-item[data-provider-id='ollama']");
  if (!item) return;
  const btn = item.querySelector<HTMLButtonElement>(".btn-test-send");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    const baseUrl =
      document.querySelector<HTMLInputElement>("#ollamaBaseUrl")?.value.trim() ||
      "http://localhost:11434";

    const originalHtml = btn.innerHTML;
    btn.innerHTML = '<span class="material-symbols-outlined spin">cable</span> テスト中...';
    btn.disabled = true;

    try {
      const result = await invokeTauri<{ version: string; message: string }>(
        "test_connection_ollama",
        { input: { baseUrl } },
      );
      if (!item.isConnected) return;
      setStatusBadge(item.querySelector<HTMLElement>("[data-status-badge]"), "接続確認済み");
      await showAppDialog({ title: "接続テスト", message: result.message, type: "success" });
    } catch (e) {
      console.error("test_connection_ollama error:", e);
      if (!item.isConnected) return;
      const classified = classifyFetchError(e);
      setStatusBadge(item.querySelector<HTMLElement>("[data-status-badge]"), classified.status);
      await showAppDialog({ title: "接続テストに失敗しました", message: classified.message, type: "error" });
    } finally {
      if (item.isConnected) {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
      }
    }
  });
}

// ---- Docker Event Handlers ----

let dockerStatusRequestRevision = 0;

export function resetDockerStatusRevisionForTest(): void {
  dockerStatusRequestRevision = 0;
}

export async function loadAndRenderDockerStatus(): Promise<DockerStatus | null> {
  const container = document.getElementById("dockerStatusContainer");
  if (!container) return null;

  const reqRevision = ++dockerStatusRequestRevision;

  container.innerHTML = renderDockerStatusContent(null);
  bindDockerRefreshBtn();
  try {
    const status = await invokeTauri<DockerStatus>("docker_check_status");
    if (reqRevision !== dockerStatusRequestRevision) return null;
    if (!container.isConnected) return null;
    container.innerHTML = renderDockerStatusContent(status);
    bindDockerRefreshBtn();
    bindDockerStartBtn();
    bindDockerDownloadBtn();
    return status;
  } catch (e) {
    console.error("docker_check_status error:", e);
    if (reqRevision !== dockerStatusRequestRevision) return null;
    if (!container.isConnected) return null;
    const errorStatus: DockerStatus = {
      cliFound: false,
      cliVersion: null,
      daemonRunning: false,
      serverVersion: null,
      desktopFound: false,
      cliPath: null,
      desktopPath: null,
      errorKind: "unknown",
      errorMessage: `状態確認中にエラーが発生しました: ${e}`,
    };
    container.innerHTML = renderDockerStatusContent(errorStatus);
    bindDockerRefreshBtn();
    return null;
  }
}

function bindDockerRefreshBtn(): void {
  document.querySelectorAll<HTMLButtonElement>(".btn-docker-refresh").forEach((btn) => {
    btn.addEventListener("click", () => {
      void loadAndRenderDockerStatus();
    }, { once: true });
  });
}

function bindDockerStartBtn(): void {
  document.querySelectorAll<HTMLButtonElement>(".btn-docker-start").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const originalHtml = btn.innerHTML;
      btn.innerHTML = '<span class="material-symbols-outlined spin">progress_activity</span> 起動中…';
      btn.disabled = true;
      try {
        const result = await invokeTauri<{ launched: boolean; message: string }>("docker_start_desktop");
        if (!btn.isConnected) return;
        if (!result.launched) {
          await showAppDialog({ title: "Docker Desktop", message: result.message, type: "error" });
          btn.disabled = false;
          btn.innerHTML = originalHtml;
          return;
        }
        // 起動要求成功 → daemon起動をポーリング
        const statusRow = btn.closest(".docker-status-card")?.querySelector(".docker-status-row");
        if (statusRow) {
          statusRow.innerHTML = '<span class="material-symbols-outlined spin" style="font-size:18px;color:var(--color-text-secondary);">progress_activity</span><span>Docker Desktopを起動しています…</span>';
        }
        for (let i = 0; i < 18; i++) {
          await new Promise(r => setTimeout(r, 5000));
          if (!btn.isConnected) return;
          try {
            const status = await invokeTauri<DockerStatus>("docker_check_status");
            if (status.daemonRunning) {
              await loadDockerPageStatuses();
              return;
            }
          } catch { /* retry */ }
        }
        // タイムアウト: 手動再確認を促す
        await loadDockerPageStatuses();
      } catch (e) {
        console.error("docker_start_desktop error:", e);
        if (!btn.isConnected) return;
        await showAppDialog({ title: "Docker Desktop", message: `起動に失敗しました: ${e}`, type: "error" });
        btn.disabled = false;
        btn.innerHTML = originalHtml;
      }
    }, { once: true });
  });
}

async function openDockerDownloadPage(): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl("https://www.docker.com/products/docker-desktop/");
  } catch (e) {
    console.error("openUrl failed, falling back to window.open:", e);
    window.open("https://www.docker.com/products/docker-desktop/", "_blank");
  }
}

function bindDockerDownloadBtn(): void {
  document.querySelectorAll<HTMLButtonElement>(".btn-docker-download").forEach((btn) => {
    btn.addEventListener("click", () => {
      void openDockerDownloadPage();
    }, { once: true });
  });
}

// ---- HuggingFace Token Event Handlers ----

async function loadAndRenderHuggingFaceToken(): Promise<void> {
  const container = document.getElementById("hfTokenContainer");
  if (!container) return;

  try {
    const status = await invokeTauri<HuggingFaceTokenStatus>("hf_token_get_status");
    if (!container.isConnected) return;
    container.innerHTML = renderHuggingFaceTokenSection(status);
    bindHfTokenButtons();
  } catch (e) {
    console.error("hf_token_get_status error:", e);
    if (!container.isConnected) return;
    container.innerHTML = renderHuggingFaceTokenSection(null);
    bindHfTokenButtons();
  }
}

function bindHfTokenButtons(): void {
  bindHfTokenSaveBtn();
  bindHfTokenEditBtn();
  bindHfTokenDeleteBtn();
  bindHfTokenVisibility();
}

function bindHfTokenSaveBtn(): void {
  document.querySelectorAll<HTMLButtonElement>(".btn-hf-token-save").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const input = document.querySelector<HTMLInputElement>(".hf-token-input");
      if (!input) return;
      const token = input.value.trim();
      if (!token) {
        await showAppDialog({ title: "Hugging Face", message: "アクセストークンを入力してください", type: "error" });
        return;
      }
      btn.disabled = true;
      try {
        const result = await invokeTauri<HuggingFaceTokenSaveResult>("hf_token_save", { input: { token } });
        if (!btn.isConnected) return;
        if (result.success) {
          input.value = "";
          await showAppDialog({ title: "Hugging Face", message: result.message, type: "success" });
          void loadAndRenderHuggingFaceToken();
        } else {
          await showAppDialog({ title: "Hugging Face", message: result.message, type: "error" });
        }
      } catch (e) {
        console.error("hf_token_save error:", e);
        if (!btn.isConnected) return;
        await showAppDialog({ title: "Hugging Face", message: `保存に失敗しました: ${e}`, type: "error" });
      } finally {
        if (btn.isConnected) btn.disabled = false;
      }
    }, { once: true });
  });
}

function bindHfTokenEditBtn(): void {
  document.querySelectorAll<HTMLButtonElement>(".btn-hf-token-edit").forEach((btn) => {
    btn.addEventListener("click", () => {
      const container = document.getElementById("hfTokenContainer");
      if (!container) return;
      container.innerHTML = renderHuggingFaceTokenSection(null);
      bindHfTokenButtons();
    }, { once: true });
  });
}

function bindHfTokenDeleteBtn(): void {
  document.querySelectorAll<HTMLButtonElement>(".btn-hf-token-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      const confirmed = await ask(
        "保存済みのHF_TOKENを削除しますか？\n\n削除後は、pyannoteモデルの新規取得や、認証が必要なモデルの実行ができなくなる場合があります。",
        { title: "HF_TOKENの削除", kind: "warning" },
      );
      if (!confirmed) return;
      btn.disabled = true;
      try {
        const result = await invokeTauri<HuggingFaceTokenSaveResult>("hf_token_delete");
        if (!btn.isConnected) return;
        if (result.success) {
          await showAppDialog({ title: "Hugging Face", message: result.message, type: "success" });
          void loadAndRenderHuggingFaceToken();
        } else {
          await showAppDialog({ title: "Hugging Face", message: result.message, type: "error" });
        }
      } catch (e) {
        console.error("hf_token_delete error:", e);
        if (!btn.isConnected) return;
        await showAppDialog({ title: "Hugging Face", message: `削除に失敗しました: ${e}`, type: "error" });
      } finally {
        if (btn.isConnected) btn.disabled = false;
      }
    }, { once: true });
  });
}

function bindHfTokenVisibility(): void {
  document.querySelectorAll<HTMLButtonElement>(".hf-token-visibility").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = btn.closest(".api-key-input-wrap")?.querySelector<HTMLInputElement>(".hf-token-input");
      if (!input) return;
      const icon = btn.querySelector(".material-symbols-outlined");
      if (input.type === "password") {
        input.type = "text";
        if (icon) icon.textContent = "visibility_off";
      } else {
        input.type = "password";
        if (icon) icon.textContent = "visibility";
      }
    });
  });
}

// ---- Local ASR Event Handlers ----

function bindLocalAsrDelegation(container: ParentNode = document): void {
  const targetContainer = container instanceof HTMLElement && container.id === "localAsrContainer"
    ? container
    : container.querySelector<HTMLElement>("#localAsrContainer");
  if (!targetContainer) return;

  if (targetContainer.dataset.delegationBound === "true") return;
  targetContainer.dataset.delegationBound = "true";

  targetContainer.addEventListener("click", (e) => {
    const target = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!target || !targetContainer.contains(target)) return;

    if (target.classList.contains("btn-local-asr-install")) {
      const engine = target.dataset.installEngine;
      if (engine) {
        target.disabled = true;
        void handleLocalAsrInstall(engine, target);
      }
      return;
    }

    if (target.hasAttribute("data-local-asr-refresh")) {
      const card = target.closest<HTMLElement>("[data-local-asr-engine]");
      const engine = card?.dataset.localAsrEngine;
      if (engine) {
        void refreshLocalAsrEngineStatus(engine);
      } else {
        // カード外の再確認ボタン（セクション全体）
        target.disabled = true;
        void loadDockerPageStatuses().finally(() => {
          if (target.isConnected) target.disabled = false;
        });
      }
      return;
    }

    if (target.hasAttribute("data-uninstall-engine")) {
      const engine = target.dataset.uninstallEngine;
      if (engine) {
        void handleLocalAsrUninstall(engine, target);
      }
    }
  });
}

async function handleLocalAsrInstall(engine: string, _btn: HTMLButtonElement): Promise<void> {
  // 二重実行防止
  if (localAsrInstallPromises.has(engine)) return;
  if (localAsrInstallStates.get(engine)?.status === "installing") return;

  const promise = doLocalAsrInstall(engine);
  localAsrInstallPromises.set(engine, promise);
  try {
    await promise;
  } finally {
    localAsrInstallPromises.delete(engine);
  }
}

async function doLocalAsrInstall(engine: string): Promise<void> {
  await ensureLocalAsrProgressListener();

  localAsrInstallStates.set(engine, {
    engine,
    status: "installing",
    progress: 0,
    message: "インストールを準備しています…",
  });

  // ページが表示中なら再描画
  if (currentPage === "settings-docker") {
    await loadAndRenderLocalAsrStatus();
  }

  try {
    await invokeTauri<LocalAsrEngineStatus>("local_asr_install", { engine });

    // succeeded を保持（installed 確認前）
    localAsrInstallStates.set(engine, {
      engine,
      status: "succeeded",
      progress: 100,
      message: "インストールを完了しました",
    });

    // installed=true を短時間ポーリングで確認
    invalidateLocalAsrStatusCache();
    const confirmed = await confirmLocalAsrInstalled(engine);
    if (confirmed) {
      localAsrInstallStates.delete(engine);
    }

    if (currentPage === "settings-docker") {
      await loadAndRenderLocalAsrStatus();
    } else {
      await refreshTranscribeLocalEnginesIfActive();
    }
  } catch (e) {
    console.error("Local ASR installation failed:", e);
    invalidateLocalAsrStatusCache();

    localAsrInstallStates.set(engine, {
      engine,
      status: "failed",
      progress: localAsrInstallStates.get(engine)?.progress ?? 0,
      message: "インストールに失敗しました",
    });

    if (currentPage === "settings-docker") {
      await loadAndRenderLocalAsrStatus();
    }
  }
}

async function handleLocalAsrUninstall(
  engine: string,
  button: HTMLButtonElement,
): Promise<void> {
  const originalHtml = button.innerHTML;
  const displayName = getLocalAsrDisplayName(engine);

  const confirmed = await showAppConfirm({
    title: `${displayName}環境を削除`,
    message: "Dockerイメージを削除します。モデルキャッシュや出力ファイルは削除されません。",
    confirmText: "削除する",
    cancelText: "キャンセル",
    variant: "danger",
  });

  if (!confirmed) return;

  button.disabled = true;
  button.innerHTML =
    '<span class="material-symbols-outlined spin">progress_activity</span> 削除中…';

  try {
    await invokeTauri("local_asr_uninstall", { engine });
    invalidateLocalAsrStatusCache();
    await loadAndRenderLocalAsrStatus();
    await refreshTranscribeLocalEnginesIfActive();
  } catch (e) {
    console.error("local_asr_uninstall error:", e);

    if (button.isConnected) {
      button.disabled = false;
      button.innerHTML = originalHtml;
    }

    const message = e instanceof Error ? e.message : String(e);

    await showAppDialog({
      title: `${displayName}環境の削除`,
      message: `削除に失敗しました: ${message}`,
      type: "error",
    });
  }
}

// ---- Local ASR Install Helpers ----

function ensureLocalAsrProgressListener(): Promise<void> {
  if (localAsrProgressListenerPromise) return localAsrProgressListenerPromise;

  localAsrProgressListenerPromise = (async () => {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<LocalAsrProgress>(
      "local-asr-progress",
      ({ payload }) => {
        const state = localAsrInstallStates.get(payload.engine);
        if (!state || state.status !== "installing") return;
        const display = getLocalAsrProgressDisplay(payload.stage, payload.engine);
        state.progress = display.percent;
        state.message = display.message;
        updateVisibleLocalAsrProgress(payload.engine, display.percent, display.message);
      },
    );
  })().catch((error) => {
    localAsrProgressListenerPromise = null;
    console.error("Failed to install local-asr-progress listener:", error);
  });

  return localAsrProgressListenerPromise;
}

function updateVisibleLocalAsrProgress(engine: string, percent: number, message: string): void {
  const container = document.getElementById("localAsrContainer");
  const statusEl = container?.querySelector<HTMLElement>(
    `[data-install-engine-status="${CSS.escape(engine)}"]`,
  );
  if (!statusEl?.isConnected) return;

  const fill = statusEl.querySelector<HTMLElement>(".local-asr-progress-fill");
  const track = statusEl.querySelector<HTMLElement>(".local-asr-progress-track");
  const percentEl = statusEl.querySelector<HTMLElement>(".local-asr-progress-percent");
  const messageEl = statusEl.querySelector<HTMLElement>(".local-asr-progress-message");

  const current = Number(track?.getAttribute("aria-valuenow") ?? "0");
  const next = Math.max(current, percent);

  if (fill) fill.style.width = `${next}%`;
  if (track) track.setAttribute("aria-valuenow", String(next));
  if (percentEl) percentEl.textContent = `${next}%`;
  if (messageEl) messageEl.textContent = message;
}

function reconcileConfirmedInstalls(statuses: LocalAsrEngineStatus[]): void {
  for (const status of statuses) {
    if (status.installed && !status.needsUpdate && localAsrInstallStates.get(status.engine)?.status === "succeeded") {
      localAsrInstallStates.delete(status.engine);
    }
  }
}

async function fetchLocalAsrStatuses(expectedEpoch?: number): Promise<LocalAsrEngineStatus[]> {
  const epochAtStart = expectedEpoch ?? localAsrCacheEpoch;
  const statuses = await invokeTauri<LocalAsrEngineStatus[]>("local_asr_get_status");
  if (epochAtStart === localAsrCacheEpoch) {
    cachedLocalAsrStatuses = statuses;
    cachedLocalAsrStatusesValid = true;
    reconcileConfirmedInstalls(statuses);
  }
  return statuses;
}

async function fetchLocalAsrStatusesFast(
  dockerContext?: string | null,
  expectedEpoch?: number,
): Promise<LocalAsrEngineStatus[]> {
  const epochAtStart = expectedEpoch ?? localAsrCacheEpoch;
  const args = dockerContext !== undefined && dockerContext !== null ? { dockerContext } : undefined;
  const statuses = await invokeTauri<LocalAsrEngineStatus[]>("local_asr_get_status_fast", args);
  if (epochAtStart === localAsrCacheEpoch) {
    cachedLocalAsrStatuses = statuses;
    cachedLocalAsrStatusesValid = true;
    reconcileConfirmedInstalls(statuses);
  }
  return statuses;
}

function updateCachedLocalAsrStatus(nextStatus: LocalAsrEngineStatus): void {
  const index = cachedLocalAsrStatuses.findIndex(s => s.engine === nextStatus.engine);
  if (index >= 0) {
    cachedLocalAsrStatuses[index] = nextStatus;
  } else {
    cachedLocalAsrStatuses.push(nextStatus);
  }
  reconcileConfirmedInstalls([nextStatus]);
}

async function fetchLocalAsrEngineStatus(engine: string): Promise<LocalAsrEngineStatus> {
  const status = await invokeTauri<LocalAsrEngineStatus>("local_asr_get_engine_status", { engine });
  updateCachedLocalAsrStatus(status);
  return status;
}

async function refreshLocalAsrEngineStatus(engine: string): Promise<void> {
  const container = document.getElementById("localAsrContainer");
  const card = container?.querySelector<HTMLElement>(`[data-local-asr-engine="${CSS.escape(engine)}"]`);
  if (!card) return;

  const refreshBtn = card.querySelector<HTMLButtonElement>("[data-local-asr-refresh]");
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "確認中…";
  }

  const previousStatus = cachedLocalAsrStatuses.find(s => s.engine === engine);

  try {
    const status = await fetchLocalAsrEngineStatus(engine);
    const latestCard = container?.querySelector<HTMLElement>(`[data-local-asr-engine="${CSS.escape(engine)}"]`);
    if (!latestCard?.isConnected) return;

    latestCard.outerHTML = renderLocalAsrEngineCard(status, localAsrInstallStates.get(engine));
  } catch (e) {
    console.error(`local_asr_get_engine_status error (${engine}):`, e);
    const latestCard = container?.querySelector<HTMLElement>(`[data-local-asr-engine="${CSS.escape(engine)}"]`);
    if (!latestCard?.isConnected) return;

    // invoke失敗時は前の状態を保持し、エラーメッセージだけ表示
    if (previousStatus) {
      latestCard.outerHTML = renderLocalAsrEngineCard(
        { ...previousStatus, errorKind: "inspect-error", errorMessage: "状態を確認できませんでした" },
        localAsrInstallStates.get(engine),
      );
    }
  }
}

async function confirmLocalAsrInstalled(engine: string): Promise<boolean> {
  for (let i = 0; i < 5; i++) {
    try {
      const status = await fetchLocalAsrEngineStatus(engine);
      if (status.installed && !status.needsUpdate) return true;
      // daemon-unavailableやinspect-errorは即時終了
      if (status.errorKind && status.errorKind !== "timeout") return false;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

// ---- Docker Page Status Loading ----

async function loadDockerPageStatuses(): Promise<void> {
  const revision = ++dockerPageLoadRevision;
  invalidateLocalAsrStatusCache();
  const container = document.getElementById("localAsrContainer");
  if (!container) return;

  // 1. 保存済みのキャッシュで即時描画
  const hasActiveInstall = [...localAsrInstallStates.values()]
    .some(s => s.status === "installing" || s.status === "succeeded");

  if (hasActiveInstall && cachedLocalAsrStatuses.length > 0) {
    container.innerHTML = renderLocalAsrSection({
      kind: "engines",
      statuses: cachedLocalAsrStatuses,
      installStates: localAsrInstallStates,
    });
  } else if (hasActiveInstall) {
    container.innerHTML = renderLocalAsrInstallCache([...localAsrInstallStates.values()]);
  } else {
    container.innerHTML = renderLocalAsrSection({ kind: "loading" });
  }

  // 2. Docker状態を取得
  const dockerStatus = await loadAndRenderDockerStatus();
  if (revision !== dockerPageLoadRevision || currentPage !== "settings-docker") return;

  if (!dockerStatus) {
    container.innerHTML = renderLocalAsrSection({
      kind: "load-error",
      message: "Dockerの状態を取得できませんでした。",
    });
    return;
  }

  if (!dockerStatus.cliFound) {
    invalidateLocalAsrStatusCache();
    container.innerHTML = renderLocalAsrSection({ kind: "docker-unavailable" });
    return;
  }

  if (!dockerStatus.daemonRunning) {
    invalidateLocalAsrStatusCache();
    container.innerHTML = renderLocalAsrSection({ kind: "docker-stopped" });
    return;
  }

  // 3. Local ASR状態を取得し、キャッシュ更新 + ストアと統合（docker_check_statusで解決した同一contextを引き継ぐ）
  await loadAndRenderLocalAsrStatus(revision, true, dockerStatus.dockerContext);
}

async function loadAndRenderLocalAsrStatus(
  revision?: number,
  useFast: boolean = false,
  dockerContext?: string | null,
): Promise<void> {
  const container = document.getElementById("localAsrContainer");
  if (!container?.isConnected) return;

  // 1. checking状態を表示
  container.innerHTML = renderLocalAsrSection({ kind: "loading" });

  const epochAtStart = localAsrCacheEpoch;
  try {
    const engines = useFast
      ? await fetchLocalAsrStatusesFast(dockerContext, epochAtStart)
      : await fetchLocalAsrStatuses(epochAtStart);

    if (revision !== undefined && (revision !== dockerPageLoadRevision || currentPage !== "settings-docker")) return;
    if (!container?.isConnected) return;

    container.innerHTML = renderLocalAsrSection({
      kind: "engines",
      statuses: engines,
      installStates: localAsrInstallStates,
    });
  } catch (e) {
    console.error("local_asr_get_status error:", e);

    if (revision !== undefined && (revision !== dockerPageLoadRevision || currentPage !== "settings-docker")) return;
    if (!container?.isConnected) return;

    container.innerHTML = renderLocalAsrSection({
      kind: "load-error",
      message: "ローカルASRの状態を取得できませんでした。",
    });
  }
}

// ---- Init ----
initializeTauri().then(() => {
  if (getAppElement()) {
    void navigateTo("transcribe");
  }
});
