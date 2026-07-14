import "./styles.css";
import { setStatusBadge, classifyFetchError, populateModelSelect, showAppDialog } from "./status";
import { asrProviders, llmProviders, cloudLlmProviders } from "./providers";
import type { ProviderDefinition } from "./providers";
import {
  createProviderConfigState,
  saveDirtyProviderConfig,
  prepareProviderForModelFetch,
  getGoogleSttProjectId,
  buildGoogleSttProjectOptions,
  shouldAutoSaveProject,
  setGoogleSttAdvancedOpen,
  ensureSelectValue,
  setGoogleSttStatus,
  invalidateGoogleSttVerification,
  getGoogleSttConfiguredState,
  setButtonLoading,
  restoreButtonLoading,
} from "./provider-config-save";

const app = document.getElementById("app")!;

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
}

async function invokeTauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!invokeFn) {
    throw new Error("この操作はTauriアプリ内でのみ利用できます");
  }
  return invokeFn<T>(command, args);
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
          <div class="google-stt-adc-section">
            <div class="google-stt-adc-status-row">
              <span class="google-stt-adc-status" data-field="adc-status">未確認</span>
              <span class="google-stt-adc-quota" data-field="adc-quota"></span>
            </div>
            <button class="btn-google-stt-check-adc" type="button">
              <span class="material-symbols-outlined">key</span>
              ADC認証チェック
            </button>
          </div>

          <div class="api-field-group">
            <label class="api-field-label">Google Cloud プロジェクト <span class="api-field-required">*</span></label>
            <div class="google-stt-project-row">
              <select class="google-stt-project-select" data-field="project-id-select">
                <option value="">読み込み中...</option>
              </select>
              <input type="text" class="google-stt-project-input" data-field="project-id-input"
                     placeholder="Project IDを入力" hidden />
              <button class="btn-google-stt-refresh-projects" type="button">
                <span class="material-symbols-outlined">refresh</span>
                再取得
              </button>
            </div>
            <p class="google-stt-project-error" data-field="project-error" style="display:none;"></p>
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
              詳細設定
            </button>
          </div>
          <div class="google-stt-advanced-content" data-field="advanced-content" hidden>
            <div class="api-field-group">
              <label class="api-field-label">Recognizer ID</label>
              <input type="text" class="google-stt-recognizer-id" data-field="recognizer-id"
                     value="_" />
            </div>
            <div class="api-field-group">
              <label class="api-field-label">詳細な確認</label>
              <button class="btn-google-stt-select-file" type="button">
                <span class="material-symbols-outlined">folder_open</span>
                別の音声ファイルで試す
              </button>
              <span class="google-stt-selected-file" data-field="selected-file" style="display:none;"></span>
            </div>
          </div>

          <div class="google-stt-recognize-section">
            <p class="google-stt-test-description">同梱された短い日本語音声（ja-JP）で確認します</p>
            <button class="btn-google-stt-builtin-test" type="button">
              <span class="material-symbols-outlined">mic</span>
              接続・認識テスト
            </button>
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
        <h3 class="section-header"><span class="section-title">AIモデルと出力言語の選択</span></h3>
        <div class="engine-row">
          <label class="field-label">ASRエンジン</label>
          <div class="engine-select-wrap">
            <select class="engine-select" id="engineSelect">
              <option value="whisper_v3">Whisper Large v3</option>
              <option value="faster_whisper">Faster Whisper</option>
              <option value="google_speech">Google Speech API</option>
            </select>
            <span class="material-symbols-outlined engine-select-arrow">arrow_drop_down</span>
          </div>
          <button class="btn-icon" title="ASRエンジン設定">
            <span class="material-symbols-outlined">tune</span>
          </button>
        </div>
        <div class="engine-row">
          <label class="field-label">補完LLM</label>
          <div class="engine-select-wrap">
            <select class="engine-select" id="llmSelect">
              <option value="none">なし</option>
              <option value="gpt4">GPT-4</option>
              <option value="claude">Claude</option>
              <option value="gemini">Gemini</option>
            </select>
            <span class="material-symbols-outlined engine-select-arrow">arrow_drop_down</span>
          </div>
          <button class="btn-icon" title="補完LLM設定">
            <span class="material-symbols-outlined">tune</span>
          </button>
        </div>
        <div class="engine-row">
          <label class="field-label">音声の言語</label>
          <div class="engine-select-wrap">
            <select class="engine-select" id="langSelect">
              <option value="auto">自動検出</option>
              <option value="ja" selected>日本語</option>
              <option value="en">英語</option>
              <option value="zh">中国語</option>
              <option value="ko">韓国語</option>
            </select>
            <span class="material-symbols-outlined engine-select-arrow">arrow_drop_down</span>
          </div>
          <div class="btn-icon-placeholder" aria-hidden="true"></div>
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
              <input type="text" class="path-input" placeholder="/Users/username/Documents/Transcripts" />
              <button class="btn-icon" title="フォルダを参照">
                <span class="material-symbols-outlined">folder_open</span>
              </button>
            </div>
          </div>
          <div>
            <label class="field-label">出力形式</label>
            <div class="format-options">
              <label class="format-option"><input type="checkbox" checked /><span>テキスト</span></label>
              <label class="format-option"><input type="checkbox" /><span>JSON</span></label>
              <label class="format-option"><input type="checkbox" /><span>Markdown</span></label>
              <label class="format-option"><input type="checkbox" /><span>SRT</span></label>
              <label class="format-option"><input type="checkbox" /><span>CSV</span></label>
              <label class="format-option"><input type="checkbox" /><span>VTT</span></label>
            </div>
          </div>
        </div>
      </section>

      <div class="action-row">
        <button class="btn-primary" id="startBtn">
          <span class="material-symbols-outlined">play_circle</span>
          <span class="btn-primary-text">文字起こしを開始</span>
        </button>
      </div>

    </div>
  </main>
`;

type SettingsPageId = "api" | "ollama";

function buildSettingsSidebar(activePage: SettingsPageId): string {
  const apiActive = activePage === "api" ? " settings-nav-active" : "";
  const ollamaActive = activePage === "ollama" ? " settings-nav-active" : "";
  return `
    <aside class="settings-sidebar">
      <h2 class="settings-sidebar-title">設定</h2>
      <span class="settings-sidebar-label">一般設定</span>
      <nav class="settings-nav">
        <button class="settings-nav-item" type="button">
          <span class="material-symbols-outlined">tune</span>
          <span>基本設定</span>
        </button>
        <button class="settings-nav-item" type="button">
          <span class="material-symbols-outlined">hearing</span>
          <span>ASRエンジン</span>
        </button>
        <button class="settings-nav-item" type="button">
          <span class="material-symbols-outlined">psychology</span>
          <span>LLM設定</span>
        </button>
        <div class="settings-nav-divider"></div>
        <span class="settings-sidebar-label">システム</span>
        <button class="settings-nav-item${apiActive}" type="button" data-settings-page="api">
          <span class="material-symbols-outlined" style="font-variation-settings: 'FILL' ${activePage === "api" ? "1" : "0"};">key</span>
          <span>API設定</span>
        </button>
        <button class="settings-nav-item${ollamaActive}" type="button" data-settings-page="ollama">
          <span class="material-symbols-outlined">smart_toy</span>
          <span>Ollama設定</span>
        </button>
        <button class="settings-nav-item" type="button">
          <span class="material-symbols-outlined">terminal</span>
          <span>Docker設定</span>
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

// ---- Render ----

type PageName = "transcribe" | "settings" | "settings-ollama";

function renderHeader(activePage: PageName): string {
  const transcribeActive = activePage === "transcribe" ? "active" : "";
  const settingsActive = (activePage === "settings" || activePage === "settings-ollama") ? "active" : "";
  return `
  <header class="app-header">
    <div class="header-left">
      <img class="brand-icon" src="/icon.png" alt="" width="24" height="24" />
      <span class="brand-name">ASR Composer</span>
      <div class="header-divider"></div>
      <nav class="header-nav">
        <a class="nav-link ${transcribeActive}" href="#" data-page="transcribe">文字起こし</a>
        <a class="nav-link" href="#">統合</a>
        <a class="nav-link ${settingsActive}" href="#" data-page="settings">設定</a>
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

async function navigateTo(page: PageName) {
  if (currentPage === page) return;
  currentPage = page;

  const body = page === "transcribe" ? transcribePage
    : page === "settings-ollama" ? settingsOllamaPage
    : settingsApiPage;
  app.innerHTML = renderHeader(page) + body;

  bindWindowControls();
  bindNavigation();
  bindAccordions();
  bindSettingsSidebarNav();

  if (page === "settings") {
    loadSavedSettings();
    bindApiSaveButtons();
    bindVisibilityToggles();
    bindResetUrlButtons();
    bindModelSelects();
    bindProviderConfigAutoSave();
    bindFetchModelsButtons();
    bindTestSendButtons();
    bindGoogleSttHandlers();
    bindXiaomiMimoAsrHandlers();
  } else if (page === "settings-ollama") {
    await loadOllamaSettings();
    if (currentPage !== "settings-ollama") return;
    bindOllamaAutoSave();
    bindResetUrlButtons();
    bindModelSelects();
    bindOllamaFetchButton();
    bindOllamaTestButton();
  }
}

function bindSettingsSidebarNav() {
  if (sidebarDelegationBound) return;
  sidebarDelegationBound = true;
  document.addEventListener("click", (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-settings-page]");
    if (!target) return;
    e.preventDefault();
    const settingsPage = target.dataset.settingsPage;
    if (settingsPage === "api") {
      void navigateTo("settings");
    } else if (settingsPage === "ollama") {
      void navigateTo("settings-ollama");
    }
  });
}

// ---- Window Controls ----

function bindWindowControls() {
  if (!tauriWindow) return; // browser preview mode

  const minimizeBtn = document.getElementById("minimizeBtn")!;
  const maximizeBtn = document.getElementById("maximizeBtn")!;
  const closeBtn = document.getElementById("closeBtn")!;
  const maximizeIcon = document.getElementById("maximizeIcon")!;

  async function updateMaximizeIcon() {
    try {
      const isMaximized = await tauriWindow.isMaximized();
      maximizeIcon.textContent = isMaximized ? "filter_none" : "crop_square";
      maximizeBtn.title = isMaximized ? "元のサイズに戻す" : "最大化";
    } catch (e) {
      console.error("Failed to update maximize icon:", e);
    }
  }

  minimizeBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try { await tauriWindow.minimize(); } catch (err) { console.error("minimize failed:", err); }
  });

  maximizeBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await tauriWindow.toggleMaximize();
      await updateMaximizeIcon();
    } catch (err) { console.error("toggleMaximize failed:", err); }
  });

  closeBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try { await tauriWindow.close(); } catch (err) { console.error("close failed:", err); }
  });

  let unlistenResize: (() => void) | undefined;

  async function initWindowControls() {
    await updateMaximizeIcon();
    unlistenResize = await tauriWindow.onResized(() => updateMaximizeIcon());
  }

  initWindowControls();
  window.addEventListener("beforeunload", () => { unlistenResize?.(); });

  const headerDragArea = document.getElementById("headerDragArea");
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

function bindAccordions() {
  document.querySelectorAll<HTMLElement>(".accordion-header").forEach((header) => {
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

// ---- API Settings: Load ----

interface SavedProviderSettings {
  env_name?: string;
  base_url?: string;
  default_model?: string;
  options?: Record<string, string>;
}

interface SaveProviderSecretResult {
  persisted: boolean;
  warning?: string;
}

interface SavedAppSettings {
  providers: Record<string, SavedProviderSettings>;
}

async function loadSavedSettings() {
  try {
    const settings = await invokeTauri<SavedAppSettings>("load_api_settings");
    if (currentPage !== "settings") return;

    document.querySelectorAll<HTMLElement>(".accordion-item[data-provider-id]").forEach((item) => {
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

      // Google STT options の復元
      if (saved?.options) {
        const locationSelect = item.querySelector<HTMLSelectElement>('[data-field="location"]');
        const recognizerInput = item.querySelector<HTMLInputElement>('[data-field="recognizer-id"]');
        const langSelect = item.querySelector<HTMLSelectElement>('[data-field="language-code"]');
        // project-id は data属性経由で loadGoogleSttProjects に渡す
        if (saved.options.project_id) item.dataset.googleSttSavedProjectId = saved.options.project_id;
        if (locationSelect && saved.options.location) locationSelect.value = saved.options.location;
        if (recognizerInput && saved.options.recognizer_id) recognizerInput.value = saved.options.recognizer_id;
        if (langSelect && saved.options.language_code) ensureSelectValue(langSelect, saved.options.language_code);
      }

      // Google STT プロジェクト読み込み起動
      if (providerId === "google_stt") {
        loadGoogleSttProjects(item).finally(() => {
          delete item.dataset.googleSttSavedProjectId;
          // プロジェクト一覧読込完了後、設定状態を再評価
          if (item.dataset.providerId === "google_stt" && item.querySelector("[data-status-badge]")) {
            const configuredState = getGoogleSttConfiguredState(item);
            setGoogleSttStatus(item, configuredState, (el, label) => setStatusBadge(el, label as "未設定" | "設定済み" | "接続確認済み" | "接続エラー"));
          }
        });
      }
    });
  } catch (e) {
    console.error("Failed to load API settings:", e);
  }
}

// ---- API Settings: Save ----

function bindApiSaveButtons() {
  document.querySelectorAll<HTMLElement>(".btn-api-save").forEach((btn) => {
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

function bindVisibilityToggles() {
  document.querySelectorAll<HTMLElement>(".api-visibility-btn").forEach((btn) => {
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

function bindResetUrlButtons() {
  document.querySelectorAll<HTMLElement>(".btn-reset-url").forEach((btn) => {
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

function bindModelSelects() {
  document.querySelectorAll<HTMLSelectElement>('[data-field="model"]').forEach((select) => {
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

function bindProviderConfigAutoSave() {
  document.querySelectorAll<HTMLElement>(".accordion-item[data-provider-id]").forEach((item) => {
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

    // Google STT options: select/input→dirty, blur/change→save
    // project-id-select: change→dirty+save
    item.querySelectorAll<HTMLSelectElement>('[data-field="project-id-select"]').forEach((optSelect) => {
      optSelect.addEventListener("change", () => {
        if (optSelect.value === "__manual__") {
          switchToManualProjectInput(item, "", null);
          const input = item.querySelector<HTMLInputElement>('[data-field="project-id-input"]');
          if (input) input.focus();
          return;
        }
        // 接続確認状態を無効化
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

    // project-id-input: input→dirty, blur→save
    item.querySelectorAll<HTMLInputElement>('[data-field="project-id-input"]').forEach((optInput) => {
      optInput.addEventListener("input", () => providerConfigState.markDirty(providerId));
      optInput.addEventListener("blur", () => {
        // 接続確認状態を無効化
        invalidateGoogleSttVerification(item, (el, label) => setStatusBadge(el, label as "未設定" | "設定済み" | "接続確認済み" | "接続エラー"));
        saveDirtyProviderConfig({
          providerId: providerId!,
          section: item,
          state: providerConfigState,
          saveConfig: saveProviderConfigFromSection,
        });
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

function bindFetchModelsButtons() {
  document.querySelectorAll<HTMLElement>(".btn-fetch-models").forEach((btn) => {
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

async function loadGoogleSttProjects(section: Element): Promise<void> {
  const select = section.querySelector<HTMLSelectElement>(
    '[data-field="project-id-select"]',
  );
  const errorEl = section.querySelector<HTMLElement>(
    '[data-field="project-error"]',
  );
  if (!select) return;

  if (errorEl) errorEl.style.display = "none";
  select.innerHTML = '<option value="">読み込み中...</option>';

  // 保存済みproject_idをdata属性から取得（loadSavedSettingsで設定済み）
  // selectの現在値は使わない（再取得時は「読み込み中...」で上書き済みのため）
  const savedProjectId =
    (section as HTMLElement).dataset.googleSttSavedProjectId || null;

  try {
    const result = await invokeTauri<{
      projects: Array<{ projectId: string; name: string }>;
      currentProject: string | null;
    }>("google_stt_list_projects");

    if (result.projects.length === 0) {
      if (result.currentProject) {
        switchToManualProjectInput(section, result.currentProject, errorEl);
        return;
      }
      switchToManualProjectInput(section, "", errorEl);
      return;
    }

    const optionsResult = buildGoogleSttProjectOptions({
      projects: result.projects,
      currentProject: result.currentProject,
      savedProjectId,
    });

    // DOM構築: innerHTMLを使わずnew Option()で安全に
    select.replaceChildren();
    for (const opt of optionsResult.options) {
      select.add(new Option(opt.label, opt.value));
    }
    if (optionsResult.selectedValue) {
      select.value = optionsResult.selectedValue;
    }

    // 自動保存: 保存値なし + current_project自動選択時のみ
    if (shouldAutoSaveProject({
      selectedBy: optionsResult.selectedBy,
      savedProjectId,
    })) {
      providerConfigState.markDirty("google_stt");
      await saveDirtyProviderConfig({
        providerId: "google_stt",
        section: section as HTMLElement,
        state: providerConfigState,
        saveConfig: saveProviderConfigFromSection,
      });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    switchToManualProjectInput(section, "", errorEl, msg);
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
  if (select) select.hidden = true;
  if (input) {
    input.hidden = false;
    if (fallbackValue) input.value = fallbackValue;
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

function bindTestSendButtons() {
  document.querySelectorAll<HTMLElement>(".accordion-item[data-provider-id]").forEach((item) => {
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

function bindGoogleSttHandlers() {
  // ADC認証チェック
  document.querySelectorAll<HTMLElement>(".btn-google-stt-check-adc").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const item = btn.closest<HTMLElement>(".accordion-item");
      if (!item) return;
      await runAdcCheck(item, btn);
    });
  });

  // 別の音声ファイルで試す（詳細設定内: 選択→即認識）
  document.querySelectorAll<HTMLElement>(".btn-google-stt-select-file").forEach((btn) => {
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

        try {
          const projectId = getGoogleSttProjectId(item);
          const location = item.querySelector<HTMLSelectElement>('[data-field="location"]')?.value || "us-central1";
          const recognizerId = item.querySelector<HTMLInputElement>('[data-field="recognizer-id"]')?.value?.trim() || "_";
          const langSel = item.querySelector<HTMLSelectElement>('[data-field="language-code"]');
          const languageCode = langSel?.value?.trim() || "ja-JP";

          const result = await invokeTauri<GoogleSttRecognizeResult>("google_stt_recognize", {
            input: { projectId, location, recognizerId, languageCode, model: "chirp_2", audioPath: selected },
          });
          renderGoogleSttRecognitionSuccess(resultEl!, result, {
            sourceLabel: `使用ファイル: ${fileName}`,
            languageCode,
            model: "chirp_2",
          });
        } catch (e) {
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
  document.querySelectorAll<HTMLElement>('.accordion-item[data-provider-id="google_stt"] .btn-google-stt-builtin-test').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const item = btn.closest<HTMLElement>(".accordion-item");
      if (!item) return;
      await runBuiltinTest(item, btn);
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

function bindXiaomiMimoAsrHandlers() {
  document.querySelectorAll<HTMLElement>('.accordion-item[data-provider-id="xiaomi_mimo_asr"]').forEach((item) => {
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

async function runAdcCheck(item: HTMLElement, btn: HTMLElement): Promise<void> {
  const originalHtml = btn.innerHTML;
  btn.innerHTML = '<span class="material-symbols-outlined spin">key</span> 確認中...';
  (btn as HTMLButtonElement).disabled = true;
  try {
    const status = await invokeTauri<{ available: boolean; quota_project?: string; current_project?: string; error?: string }>("google_stt_check_adc");
    const statusEl = item.querySelector<HTMLElement>('[data-field="adc-status"]');
    const quotaEl = item.querySelector<HTMLElement>('[data-field="adc-quota"]');
    if (status.available) {
      if (statusEl) { statusEl.textContent = "ADC利用可能"; statusEl.dataset.adcState = "available"; }
      const parts: string[] = [];
      if (status.quota_project) parts.push(`クォータ: ${status.quota_project}`);
      if (status.current_project) parts.push(`プロジェクト: ${status.current_project}`);
      if (quotaEl) quotaEl.textContent = parts.join(" / ") || "プロジェクト情報なし";

      // ADC成功 → ステータスバッジ更新
      setGoogleSttStatus(item, "verified", (el, label) => setStatusBadge(el, label as "未設定" | "設定済み" | "接続確認済み" | "接続エラー"));

      // Project IDが空欄の場合のみcurrent_projectを自動入力
      const currentProjectId = getGoogleSttProjectId(item);
      if (!currentProjectId && status.current_project) {
        const select = item.querySelector<HTMLSelectElement>('[data-field="project-id-select"]');
        const input = item.querySelector<HTMLInputElement>('[data-field="project-id-input"]');
        if (select && !select.hidden) {
          const match = Array.from(select.options).find(o => o.value === status.current_project);
          if (match) {
            select.value = status.current_project;
          } else {
            select.hidden = true;
            if (input) { input.hidden = false; input.value = status.current_project; }
          }
        } else if (input) {
          input.value = status.current_project;
        }
        providerConfigState.markDirty("google_stt");
        saveDirtyProviderConfig({
          providerId: "google_stt",
          section: item,
          state: providerConfigState,
          saveConfig: saveProviderConfigFromSection,
        });
      }
    } else {
      if (statusEl) { statusEl.textContent = "ADC利用不可"; statusEl.dataset.adcState = "unavailable"; }
      if (quotaEl) quotaEl.textContent = status.error || "";
      // ADC失敗: 必須設定あればエラー
      const configuredState = getGoogleSttConfiguredState(item);
      setGoogleSttStatus(item, configuredState === "configured" ? "error" : "unconfigured", (el, label) => setStatusBadge(el, label as "未設定" | "設定済み" | "接続確認済み" | "接続エラー"));
    }
  } catch (e) {
    const statusEl = item.querySelector<HTMLElement>('[data-field="adc-status"]');
    if (statusEl) { statusEl.textContent = "エラー"; statusEl.dataset.adcState = "error"; }
    const configuredState = getGoogleSttConfiguredState(item);
    setGoogleSttStatus(item, configuredState === "configured" ? "error" : "unconfigured", (el, label) => setStatusBadge(el, label as "未設定" | "設定済み" | "接続確認済み" | "接続エラー"));
    console.error("google_stt_check_adc error:", e);
  } finally {
    btn.innerHTML = originalHtml;
    (btn as HTMLButtonElement).disabled = false;
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

function renderGoogleSttRecognitionError(
  resultEl: HTMLElement,
  error: unknown,
  sourceLabel: string,
): void {
  const msg = error instanceof Error ? error.message : String(error);
  const safeMsg = msg.length > 500 ? msg.substring(0, 500) + "..." : msg;
  resultEl.textContent = `✗ 認識に失敗しました\n\n音声: ${sourceLabel}\nエラー: ${safeMsg}`;
  resultEl.style.display = "block";
}

// ---- Google STT: builtin test ----

function markGoogleSttAdcVerifiedByRecognition(item: HTMLElement): void {
  const statusEl = item.querySelector<HTMLElement>('[data-field="adc-status"]');
  const detailEl = item.querySelector<HTMLElement>('[data-field="adc-quota"]');
  if (statusEl) {
    statusEl.textContent = "ADC利用可能";
    statusEl.dataset.adcState = "available";
  }
  if (detailEl) {
    detailEl.textContent = "認識テストで認証を確認しました";
  }
}

async function runBuiltinTest(item: HTMLElement, btn: HTMLElement): Promise<void> {
  const projectId = getGoogleSttProjectId(item);
  if (!projectId) {
    await showAppDialog({ title: "プロジェクト未選択", message: "Google Cloud プロジェクトを選択または入力してください。", type: "error" });
    return;
  }

  const location = item.querySelector<HTMLSelectElement>('[data-field="location"]')?.value || "us-central1";

  const originalHtml = btn.innerHTML;
  btn.innerHTML = '<span class="material-symbols-outlined spin">mic</span> 認識しています…';
  (btn as HTMLButtonElement).disabled = true;

  const resultEl = item.querySelector<HTMLElement>('[data-field="recognize-result"]');
  if (resultEl) { resultEl.style.display = "none"; resultEl.textContent = ""; }

  try {
    const result = await invokeTauri<GoogleSttRecognizeResult>(
      "google_stt_run_builtin_test",
      { input: { projectId, location } },
    );
    if (resultEl) {
      renderGoogleSttRecognitionSuccess(resultEl, result, {
        sourceLabel: "同梱テスト音声",
        languageCode: "ja-JP",
        model: "chirp_2",
      });
    }
    // 成功時ステータス更新
    setGoogleSttStatus(item, "verified", (el, label) => setStatusBadge(el, label as "未設定" | "設定済み" | "接続確認済み" | "接続エラー"));
    markGoogleSttAdcVerifiedByRecognition(item);
  } catch (e) {
    console.error("google_stt_run_builtin_test error:", e);
    if (resultEl) renderGoogleSttRecognitionError(resultEl, e, "同梱テスト音声");
    // 失敗時: 必須設定があればエラー
    const configuredState = getGoogleSttConfiguredState(item);
    setGoogleSttStatus(item, configuredState === "configured" ? "error" : "unconfigured", (el, label) => setStatusBadge(el, label as "未設定" | "設定済み" | "接続確認済み" | "接続エラー"));
  } finally {
    btn.innerHTML = originalHtml;
    (btn as HTMLButtonElement).disabled = false;
  }
}

// ---- Ollama Settings Page ----

async function loadOllamaSettings() {
  if (currentPage !== "settings-ollama") return;
  try {
    const settings = await invokeTauri<SavedAppSettings>("load_api_settings");
    if (currentPage !== "settings-ollama") return;

    const item = document.querySelector<HTMLElement>(".accordion-item[data-provider-id='ollama']");
    if (!item) return;

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
  } catch (e) {
    console.error("Failed to load Ollama settings:", e);
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

function bindOllamaAutoSave() {
  document.getElementById("ollamaBaseUrl")?.addEventListener("change", () => { scheduleOllamaSave(); });
  document.getElementById("ollamaModelSelect")?.addEventListener("change", () => { scheduleOllamaSave(); });
  document.getElementById("ollamaModelManual")?.addEventListener("change", () => { scheduleOllamaSave(); });
}

function bindOllamaFetchButton() {
  document.querySelectorAll<HTMLElement>(".btn-fetch-models").forEach((btn) => {
    if (btn.dataset.providerId !== "ollama") return;
    btn.addEventListener("click", async () => {
      const item = btn.closest(".accordion-item");
      if (!item) return;
      await fetchProviderModels("ollama", item, btn);
    });
  });
}

function bindOllamaTestButton() {
  const item = document.querySelector(".accordion-item[data-provider-id='ollama']");
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

// ---- Init ----
initializeTauri().then(() => {
  void navigateTo("transcribe");
});
