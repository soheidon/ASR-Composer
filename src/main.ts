import "./styles.css";
import { setStatusBadge, classifyFetchError, populateModelSelect, showAppDialog } from "./status";

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

// ---- Provider Definitions ----

type ModelSource = "api" | "static" | "manual";
type ModelFilter = "asr" | "llm" | "all";

type ProviderDefinition = {
  id: string;
  company: string;
  name: string;
  icon: string;
  env: string;
  defaultBaseUrl: string;
  defaultModel?: string;
  modelSource: ModelSource;
  allowManualModel: boolean;
  modelFilter?: ModelFilter;
  preferredModels?: string[];
  staticModels?: string[];
};

const asrProviders: ProviderDefinition[] = [
  { id: "openai_audio", company: "OpenAI", name: "Whisper / GPT-4o Audio Transcribe", icon: "graphic_eq", env: "OPENAI_API_KEY", defaultBaseUrl: "https://api.openai.com/v1", modelSource: "api", allowManualModel: true, modelFilter: "asr", preferredModels: ["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"] },
  { id: "groq_speech", company: "Groq", name: "Whisper Large V3 / V3 Turbo", icon: "graphic_eq", env: "GROQ_API_KEY", defaultBaseUrl: "https://api.groq.com/openai/v1", modelSource: "api", allowManualModel: true, modelFilter: "asr", preferredModels: ["whisper-large-v3", "whisper-large-v3-turbo"] },
  { id: "deepgram", company: "Deepgram", name: "Nova 3", icon: "graphic_eq", env: "DEEPGRAM_API_KEY", defaultBaseUrl: "https://api.deepgram.com/v1", defaultModel: "nova-3", modelSource: "manual", allowManualModel: true, modelFilter: "asr", staticModels: ["nova-3", "nova-2", "nova"] },
  { id: "assemblyai", company: "AssemblyAI", name: "Universal Streaming", icon: "graphic_eq", env: "ASSEMBLYAI_API_KEY", defaultBaseUrl: "https://api.assemblyai.com/v2", defaultModel: "universal-streaming", modelSource: "manual", allowManualModel: true, modelFilter: "asr" },
  { id: "google_stt", company: "Google Cloud", name: "Cloud Speech-to-Text", icon: "graphic_eq", env: "GOOGLE_CLOUD_API_KEY", defaultBaseUrl: "https://speech.googleapis.com/v2", defaultModel: "chirp_2", modelSource: "manual", allowManualModel: true, modelFilter: "asr" },
  { id: "azure_speech", company: "Azure", name: "Azure AI Speech", icon: "graphic_eq", env: "AZURE_SPEECH_KEY", defaultBaseUrl: "https://{region}.stt.speech.microsoft.com", modelSource: "manual", allowManualModel: true, modelFilter: "asr" },
  { id: "xiaomi_mimo_asr", company: "Xiaomi", name: "MiMo ASR", icon: "graphic_eq", env: "XIAOMI_API_KEY", defaultBaseUrl: "", modelSource: "manual", allowManualModel: true, modelFilter: "asr" },
];

const llmProviders: ProviderDefinition[] = [
  { id: "openai", company: "OpenAI", name: "OpenAI", icon: "auto_awesome", env: "OPENAI_API_KEY", defaultBaseUrl: "https://api.openai.com/v1", modelSource: "api", allowManualModel: true, modelFilter: "llm", preferredModels: ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4.1-mini"] },
  { id: "anthropic", company: "Anthropic", name: "Claude / Anthropic", icon: "auto_awesome", env: "ANTHROPIC_API_KEY", defaultBaseUrl: "https://api.anthropic.com", modelSource: "api", allowManualModel: true, modelFilter: "llm", preferredModels: ["claude-sonnet-4-20250514", "claude-haiku-4-5-20251001", "claude-opus-4-8"] },
  { id: "gemini", company: "Google DeepMind", name: "Gemini / Google", icon: "auto_awesome", env: "GOOGLE_API_KEY", defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta", modelSource: "api", allowManualModel: true, modelFilter: "llm", preferredModels: ["gemini-2.5-pro", "gemini-2.5-flash"] },
  { id: "deepseek", company: "DeepSeek", name: "DeepSeek", icon: "auto_awesome", env: "DEEPSEEK_API_KEY", defaultBaseUrl: "https://api.deepseek.com", modelSource: "api", allowManualModel: true, modelFilter: "llm", preferredModels: ["deepseek-chat", "deepseek-reasoner"] },
  { id: "openrouter", company: "OpenRouter", name: "OpenRouter", icon: "auto_awesome", env: "OPENROUTER_API_KEY", defaultBaseUrl: "https://openrouter.ai/api/v1", modelSource: "api", allowManualModel: true, modelFilter: "llm" },
  { id: "mistral", company: "Mistral AI", name: "Mistral AI", icon: "auto_awesome", env: "MISTRAL_API_KEY", defaultBaseUrl: "https://api.mistral.ai/v1", modelSource: "api", allowManualModel: true, modelFilter: "llm", preferredModels: ["mistral-large-latest", "mistral-small-latest"] },
  { id: "groq", company: "Groq", name: "Groq LLM", icon: "auto_awesome", env: "GROQ_API_KEY", defaultBaseUrl: "https://api.groq.com/openai/v1", modelSource: "api", allowManualModel: true, modelFilter: "llm", preferredModels: ["llama-3.3-70b-versatile", "qwen-qwq-32b"] },
  { id: "ollama", company: "Ollama", name: "ローカルLLMランタイム", icon: "auto_awesome", env: "", defaultBaseUrl: "http://localhost:11434", modelSource: "api", allowManualModel: true, modelFilter: "llm" },
  { id: "xiaomi_mimo", company: "Xiaomi", name: "MiMo / Xiaomi", icon: "auto_awesome", env: "XIAOMI_API_KEY", defaultBaseUrl: "", modelSource: "manual", allowManualModel: true, modelFilter: "llm" },
  { id: "moonshot", company: "Moonshot AI", name: "Kimi / Moonshot AI", icon: "auto_awesome", env: "MOONSHOT_API_KEY", defaultBaseUrl: "https://api.moonshot.cn/v1", modelSource: "api", allowManualModel: true, modelFilter: "llm", preferredModels: ["kimi-k2"] },
  { id: "minimax", company: "MiniMax", name: "MiniMax", icon: "auto_awesome", env: "MINIMAX_API_KEY", defaultBaseUrl: "https://api.minimax.io/v1", modelSource: "api", allowManualModel: true, modelFilter: "llm", preferredModels: ["MiniMax-M1.2"] },
  { id: "zai_glm", company: "Z.AI", name: "GLM / Z.AI", icon: "auto_awesome", env: "ZAI_API_KEY", defaultBaseUrl: "https://api.z.ai/api/paas/v4", modelSource: "manual", allowManualModel: true, modelFilter: "llm" },
];

const cloudLlmProviders = llmProviders.filter(p => p.id !== "ollama");

// ---- Template Builders ----

function providerAccordionItem(p: ProviderDefinition, index: number, isFirst: boolean): string {
  const chevronRotate = isFirst ? "rotate-90" : "";
  const headerBg = isFirst ? "accordion-header-expanded" : "accordion-header-collapsed";
  const detailDisplay = isFirst ? "" : 'style="display:none"';

  const modelSection = buildModelSection(p);

  return `
    <div class="accordion-item" data-index="${index}" data-provider-id="${p.id}">
      <button class="accordion-header ${headerBg}" type="button">
        <div class="accordion-header-left">
          <span class="material-symbols-outlined accordion-chevron ${chevronRotate}">chevron_right</span>
          <div class="accordion-icon-circle">
            <span class="material-symbols-outlined">${p.icon}</span>
          </div>
          <span class="accordion-title">${p.company}</span>
          <span class="accordion-title-sub">${p.name}</span>
        </div>
        <div class="accordion-header-right">
          <span class="status-badge status-unconfigured" data-status-badge>
            <span class="status-dot status-dot-unconfigured"></span>未設定
          </span>
        </div>
      </button>
      <div class="accordion-detail" ${detailDisplay}>
        <div class="accordion-detail-inner">
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
          </div>
        </div>
      </div>
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

function buildProviderSection(title: string, description: string, providers: ProviderDefinition[], expandFirst: boolean): string {
  const cards = providers.map((p, i) => providerAccordionItem(p, i, expandFirst && i === 0)).join("");
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
          ${buildProviderSection("ASR用API連携", "文字起こしエンジン（ASR）の認証情報を管理します。", asrProviders, true)}
          ${buildProviderSection("補正LLM用API連携", "翻訳や要約、統合処理に使用する言語モデル（LLM）の認証情報を管理します。", cloudLlmProviders, false)}
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
    bindFetchModelsButtons();
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
      } else {
        detail.style.display = "";
        chevron.classList.add("rotate-90");
        header.classList.remove("accordion-header-collapsed");
        header.classList.add("accordion-header-expanded");
      }
    });
  });
}

// ---- API Settings: Load ----

interface SavedProviderSettings {
  env_name?: string;
  base_url?: string;
  default_model?: string;
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

      // ステータスバッジの初期設定: env_nameが保存済み → 設定済み（APIキーの実値はフロントに返さない）
      if (statusBadgeEl && saved?.env_name) {
        setStatusBadge(statusBadgeEl, "設定済み");
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

// ---- Model Fetch Button ----

function bindFetchModelsButtons() {
  document.querySelectorAll<HTMLElement>(".btn-fetch-models").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const providerId = btn.dataset.providerId;
      if (!providerId) return;

      const item = btn.closest(".accordion-item");
      if (!item) return;

      // ボタンをローディング状態に
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
        await showAppDialog({ title: "モデル取得エラー", message: "モデル一覧の取得に失敗しました。\n" + classified.message, type: "error" });
        btn.innerHTML = originalHtml;
      } finally {
        (btn as HTMLButtonElement).disabled = false;
      }
    });
  });
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
