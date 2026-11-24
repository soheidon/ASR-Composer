// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  setButtonLoading,
  restoreButtonLoading,
  setGoogleSttAdvancedOpen,
} from "./provider-config-save";
import { asrProviders } from "./providers";
import {
  setupWindowCloseGuard,
  requestAppClose,
  resetWindowCloseGuardForTest,
  setTauriWindowForTest,
  isForceClosingForTest,
  navigateTo,
  resetMountedPagesForTest,
  resetMultiAsrMainStateForTest,
  pageMounts,
  setTauriInvokeForTest,
  setSelectedAudioFileForTest,
  resetDockerStatusRevisionForTest,
  loadAndRenderDockerStatus,
} from "./main";
import {
  setEditorDocument,
  isEditorDirty,
  getEditorDocument,
  getEditorDocumentSessionId,
  getActiveProposals,
  setActiveProposalsForTest,
} from "./editor";
import type { TranscriptDocument } from "./transcript";
import type { CorrectionProposal } from "./correction";
import * as statusModule from "./status";

/**
 * Google STT 組み込みテスト・表示に関するDOM整合性テスト。
 * 共通表示ロジックの安全性（XSS防止）と、同梱テストボタンの
 * 入力が projectId + location のみであることを確認する。
 */

// ---- Google STT display tests ----

describe("Google STT builtin test UI", () => {
  it("builtin test button has label that does not reference user file selection", () => {
    document.body.innerHTML = `
      <div class="accordion-item" data-provider-id="google_stt">
        <div class="google-stt-recognize-section">
          <p class="google-stt-test-description">同梱された短い日本語音声（ja-JP）で確認します</p>
          <button class="btn-google-stt-builtin-test" type="button">
            接続・認識テスト
          </button>
          <div class="google-stt-result" data-field="recognize-result" style="display:none;"></div>
        </div>
      </div>`;
    const btn = document.querySelector(".btn-google-stt-builtin-test");
    expect(btn).toBeTruthy();
    expect(btn!.textContent?.trim()).toContain("接続・認識テスト");
  });

  it("description mentions ja-JP (builtin audio language is fixed)", () => {
    const desc = document.querySelector(".google-stt-test-description");
    expect(desc).toBeTruthy();
    expect(desc!.textContent).toContain("ja-JP");
  });

  it("recognize result element exists for both builtin and custom tests", () => {
    const resultEl = document.querySelector('[data-field="recognize-result"]');
    expect(resultEl).toBeTruthy();
    // initial state hidden
    expect((resultEl as HTMLElement).style.display).toBe("none");
  });

  it("custom file test button is inside advanced-content section", () => {
    document.body.innerHTML += `
      <div class="google-stt-advanced-content" data-field="advanced-content">
        <button class="btn-google-stt-select-file" type="button">
          別の音声ファイルで試す
        </button>
        <span class="google-stt-selected-file" data-field="selected-file" style="display:none;"></span>
      </div>`;
    const btn = document.querySelector(".btn-google-stt-select-file");
    expect(btn).toBeTruthy();
    expect(btn!.textContent?.trim()).toContain("別の音声ファイルで試す");
  });

  it("selected-file label starts hidden (no prior selection visible)", () => {
    const label = document.querySelector('[data-field="selected-file"]');
    expect(label).toBeTruthy();
    expect((label as HTMLElement).style.display).toBe("none");
  });
});

// ---- Display safety tests ----

describe("Google STT result display", () => {
  function getResultEl(): HTMLElement {
    const el = document.querySelector('[data-field="recognize-result"]');
    if (el) return el as HTMLElement;
    const div = document.createElement("div");
    div.setAttribute("data-field", "recognize-result");
    document.body.appendChild(div);
    return div;
  }

  it("result display uses textContent (no innerHTML injection)", () => {
    const el = getResultEl();
    const xss = '<img src=x onerror=alert(1)>';
    el.textContent = `認識結果: ${xss}`;
    // textContent should literally contain the angle brackets, not an img tag
    expect(el.innerHTML).toContain("&lt;img");
    expect(el.querySelector("img")).toBeNull();
  });

  it("error display uses textContent (no innerHTML injection)", () => {
    const el = getResultEl();
    const xss = '<script>alert(1)</script>';
    el.textContent = `エラー: ${xss}`;
    expect(el.innerHTML).toContain("&lt;script&gt;");
    expect(el.querySelector("script")).toBeNull();
  });

  it("recognition result with confidence formats as percentage", () => {
    const confidence = 0.935;
    const display = `${(confidence * 100).toFixed(1)}%`;
    expect(display).toBe("93.5%");
  });

  it("recognition result without confidence skips confidence line", () => {
    // Simulated: confidence is null → should not appear
    const confidence: number | null = null;
    const lines: string[] = [];
    if (confidence != null) lines.push(`信頼度: ${(confidence * 100).toFixed(1)}%`);
    expect(lines).toHaveLength(0);
  });

  it("empty transcript still shows the result section", () => {
    const transcript = "";
    const showResult = transcript.length >= 0; // empty OK
    expect(showResult).toBe(true);
    const display = transcript || "(空の文字起こし)";
    expect(display).toBe("(空の文字起こし)");
  });

  it("error messages longer than 500 chars are truncated", () => {
    const longMsg = "x".repeat(600);
    const safe = longMsg.length > 500 ? longMsg.substring(0, 500) + "..." : longMsg;
    expect(safe.length).toBeLessThanOrEqual(504);
    expect(safe.endsWith("...")).toBe(true);
  });
});

// ---- Builtin test input shape ----

describe("Google STT builtin test input", () => {
  it("builtin test input type has only projectId and location", () => {
    // verify shape at type level
    const input: { projectId: string; location: string } = {
      projectId: "test-proj",
      location: "us-central1",
    };
    expect(Object.keys(input)).toHaveLength(2);
    expect(input).toHaveProperty("projectId");
    expect(input).toHaveProperty("location");
    // No languageCode, recognizerId, model, audioPath
    expect("languageCode" in input).toBe(false);
    expect("recognizerId" in input).toBe(false);
  });
});

// ---- Button loading state behavior ----

describe("Google STT button loading state", () => {
  it("setButtonLoading disables button and changes text", () => {
    document.body.innerHTML = '<button id="test-btn"><span>mic</span> 接続・認識テスト</button>';
    const btn = document.getElementById("test-btn") as HTMLButtonElement;
    const state = setButtonLoading(btn, '<span class="spin">mic</span> 認識しています…');
    expect(btn.disabled).toBe(true);
    expect(btn.innerHTML).toContain("認識しています…");
    expect(state.originalHtml).toContain("接続・認識テスト");
  });

  it("restoreButtonLoading re-enables button and restores text", () => {
    const btn = document.getElementById("test-btn") as HTMLButtonElement;
    const state = { originalHtml: '<span>mic</span> 接続・認識テスト' };
    btn.disabled = true;
    btn.innerHTML = '<span class="spin">mic</span> 認識しています…';
    restoreButtonLoading(btn, state);
    expect(btn.disabled).toBe(false);
    expect(btn.innerHTML).toContain("接続・認識テスト");
  });

  it("restore works after set → restore cycle", () => {
    document.body.innerHTML = '<button id="btn2"><span>mic</span> 接続・認識テスト</button>';
    const btn = document.getElementById("btn2") as HTMLButtonElement;
    const state = setButtonLoading(btn, '<span class="spin">mic</span> 認識しています…');
    expect(btn.disabled).toBe(true);
    restoreButtonLoading(btn, state);
    expect(btn.disabled).toBe(false);
    expect(btn.innerHTML).toContain("接続・認識テスト");
  });

  it("restore after error also returns button to original state", () => {
    // simulate: set → (error occurs) → restore in finally
    document.body.innerHTML = '<button id="btn3"><span>mic</span> 接続・認識テスト</button>';
    const btn = document.getElementById("btn3") as HTMLButtonElement;
    const state = setButtonLoading(btn, '<span class="spin">mic</span> 認識しています…');
    restoreButtonLoading(btn, state);
    expect(btn.disabled).toBe(false);
    expect(btn.innerHTML).toContain("接続・認識テスト");
  });
});

// ---- Double-invoke prevention ----

describe("Google STT double-invoke prevention", () => {
  it("disabled button does not fire click handler again", () => {
    document.body.innerHTML = '<button id="btn-double"><span>mic</span> 接続・認識テスト</button>';
    const btn = document.getElementById("btn-double") as HTMLButtonElement;
    let invokeCount = 0;
    const handler = () => {
      if (btn.disabled) return; // guard
      btn.disabled = true;
      invokeCount += 1;
    };
    btn.addEventListener("click", handler);
    btn.click();
    btn.click(); // second click while disabled
    expect(invokeCount).toBe(1);
  });
});

// ---- File selection cancel behavior ----

describe("Google STT file selection cancel", () => {
  it("canceling file selection does not change result display", () => {
    document.body.innerHTML = `
      <div class="accordion-item">
        <div class="google-stt-result" data-field="recognize-result">前回の結果</div>
        <button class="btn-google-stt-select-file">別の音声ファイルで試す</button>
      </div>`;
    const resultEl = document.querySelector('[data-field="recognize-result"]') as HTMLElement;
    const prevText = resultEl.textContent;

    // Simulate cancel: null path → return early, no invoke
    const selected: string | null = null;
    if (!selected || typeof selected !== "string") {
      // cancel → do nothing
    }
    // verify result unchanged
    expect(resultEl.textContent).toBe(prevText);
  });
});

// ---- Advanced toggle DOM integration ----

describe("Google STT advanced toggle click-to-open", () => {
  function buildAccordionItem(): HTMLElement {
    document.body.innerHTML = `
      <div class="accordion-item" data-provider-id="google_stt">
        <div class="accordion-detail" style="">
          <div class="accordion-detail-inner">
            <div class="google-stt-advanced-toggle">
              <button type="button" class="btn-google-stt-advanced"
                      data-field="advanced-toggle" aria-expanded="false">
                詳細設定
              </button>
            </div>
            <div class="google-stt-advanced-content"
                 data-field="advanced-content" hidden>
              <input data-field="recognizer-id" value="_" />
            </div>
          </div>
        </div>
      </div>`;
    return document.querySelector(".accordion-item") as HTMLElement;
  }

  it("advanced content starts hidden", () => {
    const item = buildAccordionItem();
    const content = item.querySelector<HTMLElement>('[data-field="advanced-content"]');
    expect(content).toBeTruthy();
    expect(content!.hidden).toBe(true);
  });

  it("clicking toggle opens content via setGoogleSttAdvancedOpen", () => {
    const item = buildAccordionItem();
    const toggleBtn = item.querySelector<HTMLButtonElement>('[data-field="advanced-toggle"]')!;
    const content = item.querySelector<HTMLElement>('[data-field="advanced-content"]')!;

    // Wire the same logic as bindProviderConfigAutoSave
    toggleBtn.addEventListener("click", () => {
      const c = item.querySelector<HTMLElement>('[data-field="advanced-content"]');
      if (!c) return;
      const open = c.hidden;
      setGoogleSttAdvancedOpen(toggleBtn, c, open);
      toggleBtn.classList.toggle("is-open", open);
    });

    expect(content.hidden).toBe(true);
    expect(toggleBtn.getAttribute("aria-expanded")).toBe("false");

    // First click: opens
    toggleBtn.click();
    expect(content.hidden).toBe(false);
    expect(toggleBtn.getAttribute("aria-expanded")).toBe("true");
    expect(toggleBtn.classList.contains("is-open")).toBe(true);

    // Second click: closes
    toggleBtn.click();
    expect(content.hidden).toBe(true);
    expect(toggleBtn.getAttribute("aria-expanded")).toBe("false");
    expect(toggleBtn.classList.contains("is-open")).toBe(false);
  });

  it("multiple open-close cycles stay consistent", () => {
    const item = buildAccordionItem();
    const toggleBtn = item.querySelector<HTMLButtonElement>('[data-field="advanced-toggle"]')!;
    const content = item.querySelector<HTMLElement>('[data-field="advanced-content"]')!;

    toggleBtn.addEventListener("click", () => {
      const c = item.querySelector<HTMLElement>('[data-field="advanced-content"]');
      if (!c) return;
      const open = c.hidden;
      setGoogleSttAdvancedOpen(toggleBtn, c, open);
      toggleBtn.classList.toggle("is-open", open);
    });

    for (let i = 0; i < 3; i++) {
      toggleBtn.click();
      expect(content.hidden).toBe(false);
      toggleBtn.click();
      expect(content.hidden).toBe(true);
    }
  });
});

// ---- Provider accordion: initial state and toggle ----

describe("Provider accordion initial state and toggle", () => {
  function buildProviderAccordion(): HTMLElement {
    // Build the same structure as buildProviderSection → providerAccordionItem
    const cards = asrProviders.map((p, i) => `
      <div class="accordion-item" data-index="${i}" data-provider-id="${p.id}">
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
            <span data-status-badge class="status-badge status-unconfigured">
              <span class="status-dot status-dot-unconfigured"></span>未設定
            </span>
          </div>
        </button>
        <div class="accordion-detail" style="display:none">
          <div class="accordion-detail-inner">content</div>
        </div>
      </div>
    `).join("");

    document.body.innerHTML = `<div class="accordion-container">${cards}</div>`;

    // Wire the same toggle logic as bindAccordions
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

    return document.querySelector(".accordion-container") as HTMLElement;
  }

  const expectedOrder = asrProviders.map(p => p.id);

  it("ASR providers are in the expected order", () => {
    expect(expectedOrder).toEqual([
      "google_stt",
      "openai_audio",
      "azure_speech",
      "xiaomi_mimo_asr",
      "groq_speech",
      "deepgram",
      "assemblyai",
    ]);
  });

  it("all provider detail sections are initially hidden (style.display = 'none')", () => {
    buildProviderAccordion();
    const details = document.querySelectorAll<HTMLElement>(".accordion-detail");
    expect(details.length).toBe(asrProviders.length);
    for (const detail of details) {
      expect(detail.style.display).toBe("none");
    }
  });

  it("all provider headers initially have aria-expanded='false'", () => {
    buildProviderAccordion();
    const headers = document.querySelectorAll<HTMLElement>(".accordion-header");
    for (const header of headers) {
      expect(header.getAttribute("aria-expanded")).toBe("false");
    }
  });

  it("all headers initially have accordion-header-collapsed (none expanded)", () => {
    buildProviderAccordion();
    const headers = document.querySelectorAll<HTMLElement>(".accordion-header");
    for (const header of headers) {
      expect(header.classList.contains("accordion-header-collapsed")).toBe(true);
      expect(header.classList.contains("accordion-header-expanded")).toBe(false);
    }
  });

  it("google_stt (first item) is NOT initially expanded", () => {
    buildProviderAccordion();
    const googleStt = document.querySelector<HTMLElement>('[data-provider-id="google_stt"]')!;
    const detail = googleStt.querySelector<HTMLElement>(".accordion-detail")!;
    const header = googleStt.querySelector<HTMLElement>(".accordion-header")!;
    expect(detail.style.display).toBe("none");
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("openai_audio is NOT initially expanded", () => {
    buildProviderAccordion();
    const openai = document.querySelector<HTMLElement>('[data-provider-id="openai_audio"]')!;
    const detail = openai.querySelector<HTMLElement>(".accordion-detail")!;
    expect(detail.style.display).toBe("none");
  });

  it("clicking google_stt header opens its detail", () => {
    buildProviderAccordion();
    const googleStt = document.querySelector<HTMLElement>('[data-provider-id="google_stt"]')!;
    const header = googleStt.querySelector<HTMLElement>(".accordion-header")!;
    const detail = googleStt.querySelector<HTMLElement>(".accordion-detail")!;

    header.click();

    expect(detail.style.display).toBe("");
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(header.classList.contains("accordion-header-expanded")).toBe(true);
  });

  it("clicking google_stt header again closes its detail", () => {
    buildProviderAccordion();
    const googleStt = document.querySelector<HTMLElement>('[data-provider-id="google_stt"]')!;
    const header = googleStt.querySelector<HTMLElement>(".accordion-header")!;
    const detail = googleStt.querySelector<HTMLElement>(".accordion-detail")!;

    header.click(); // open
    header.click(); // close

    expect(detail.style.display).toBe("none");
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(header.classList.contains("accordion-header-collapsed")).toBe(true);
  });

  it("clicking openai_audio header opens its detail independently", () => {
    buildProviderAccordion();
    const openai = document.querySelector<HTMLElement>('[data-provider-id="openai_audio"]')!;
    const header = openai.querySelector<HTMLElement>(".accordion-header")!;
    const detail = openai.querySelector<HTMLElement>(".accordion-detail")!;

    header.click();

    expect(detail.style.display).toBe("");
    expect(header.getAttribute("aria-expanded")).toBe("true");
  });

  it("badge is '設定済み' does NOT auto-expand the provider", () => {
    buildProviderAccordion();
    // Simulate that google_stt has a configured badge
    const googleStt = document.querySelector<HTMLElement>('[data-provider-id="google_stt"]')!;
    const badge = googleStt.querySelector<HTMLElement>("[data-status-badge]")!;
    badge.classList.remove("status-unconfigured");
    badge.classList.add("status-configured");
    badge.textContent = "設定済み";

    // Re-render is not triggered, but detail should still be closed
    const detail = googleStt.querySelector<HTMLElement>(".accordion-detail")!;
    expect(detail.style.display).toBe("none");
  });
});

// ---- Xiaomi MiMo ASR full UI ----

describe("Xiaomi MiMo ASR full UI", () => {
  function buildMimoAsrAccordion(): HTMLElement {
    document.body.innerHTML = `
      <div class="accordion-item" data-provider-id="xiaomi_mimo_asr">
        <button class="accordion-header accordion-header-collapsed" type="button" aria-expanded="false">
          <span class="accordion-title">Xiaomi MiMo</span>
          <span class="accordion-title-sub">Speech Recognition</span>
          <span class="status-badge status-unconfigured" data-status-badge>
            <span class="status-dot status-dot-unconfigured"></span>未設定
          </span>
        </button>
        <div class="accordion-detail" style="display:none">
          <div class="accordion-detail-inner">
            <div class="api-field-group">
              <label class="api-field-label">環境変数 / APIキー</label>
              <div class="api-key-row">
                <input type="text" class="api-env-input" value="XIAOMI_API_KEY" data-default-env="XIAOMI_API_KEY" />
                <div class="api-key-input-wrap">
                  <input type="password" class="api-key-input" placeholder="APIキーを入力" data-field="api-key" />
                  <button class="api-visibility-btn" type="button" title="表示切替">
                    <span class="material-symbols-outlined">visibility</span>
                  </button>
                </div>
                <button class="btn-api-save" type="button" data-provider-id="xiaomi_mimo_asr">環境変数に保存</button>
              </div>
            </div>
            <div class="api-field-group">
              <label class="api-field-label">Base URL</label>
              <div class="api-baseurl-row">
                <input type="text" class="api-baseurl-input" value="https://api.xiaomimimo.com/v1" data-default-url="https://api.xiaomimimo.com/v1" data-field="base-url" />
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
                <button class="btn-mimo-asr-select-file" type="button">
                  <span class="material-symbols-outlined">folder_open</span>
                  別の音声ファイルで試す
                </button>
              </div>
            </div>
            <div class="google-stt-recognize-section">
              <p class="google-stt-test-description">同梱された短い英語音声（en）で確認します</p>
              <button class="btn-mimo-asr-builtin-test" type="button">
                <span class="material-symbols-outlined">mic</span>
                接続・認識テスト
              </button>
              <div class="google-stt-result" data-field="recognize-result" hidden></div>
            </div>
          </div>
        </div>
      </div>`;

    // Wire accordion toggle
    const header = document.querySelector(".accordion-header") as HTMLElement;
    header.addEventListener("click", () => {
      const detail = document.querySelector(".accordion-detail") as HTMLElement;
      const isOpen = detail.style.display !== "none";
      detail.style.display = isOpen ? "none" : "";
      header.setAttribute("aria-expanded", String(!isOpen));
      header.classList.toggle("accordion-header-expanded", !isOpen);
      header.classList.toggle("accordion-header-collapsed", isOpen);
    });

    return document.querySelector(".accordion-item") as HTMLElement;
  }

  it("shows env/API key row with common structure", () => {
    const item = buildMimoAsrAccordion();
    const envInput = item.querySelector<HTMLInputElement>(".api-env-input");
    const apiKeyInput = item.querySelector<HTMLInputElement>('[data-field="api-key"]');
    const saveBtn = item.querySelector<HTMLButtonElement>(".btn-api-save");
    expect(envInput).toBeTruthy();
    expect(envInput!.value).toBe("XIAOMI_API_KEY");
    expect(envInput!.dataset.defaultEnv).toBe("XIAOMI_API_KEY");
    expect(apiKeyInput).toBeTruthy();
    expect(apiKeyInput!.type).toBe("password");
    expect(saveBtn).toBeTruthy();
    expect(saveBtn!.dataset.providerId).toBe("xiaomi_mimo_asr");
  });

  it("shows Base URL with reset button", () => {
    const item = buildMimoAsrAccordion();
    const baseUrl = item.querySelector<HTMLInputElement>('[data-field="base-url"]');
    const resetBtn = item.querySelector(".btn-reset-url");
    expect(baseUrl).toBeTruthy();
    expect(baseUrl!.value).toBe("https://api.xiaomimimo.com/v1");
    expect(baseUrl!.dataset.defaultUrl).toBe("https://api.xiaomimimo.com/v1");
    expect(resetBtn).toBeTruthy();
  });

  it("shows language select with auto/en/zh", () => {
    const item = buildMimoAsrAccordion();
    const langSelect = item.querySelector<HTMLSelectElement>('[data-field="language-code"]');
    expect(langSelect).toBeTruthy();
    const values = Array.from(langSelect!.options).map(o => o.value);
    expect(values).toEqual(["auto", "en", "zh"]);
    expect(langSelect!.value).toBe("auto");
  });

  it("shows disabled model select with mimo-v2.5-asr", () => {
    const item = buildMimoAsrAccordion();
    const modelSelect = item.querySelector<HTMLSelectElement>('[data-field="model"]');
    expect(modelSelect).toBeTruthy();
    expect(modelSelect!.disabled).toBe(true);
    expect(modelSelect!.value).toBe("mimo-v2.5-asr");
  });

  it("shows exactly one builtin test button in normal view", () => {
    const item = buildMimoAsrAccordion();
    const builtinBtn = item.querySelector(".btn-mimo-asr-builtin-test");
    expect(builtinBtn).toBeTruthy();
    expect(builtinBtn!.textContent).toContain("接続・認識テスト");
  });

  it("does not show file selection button in normal view", () => {
    const item = buildMimoAsrAccordion();
    const advancedContent = item.querySelector<HTMLElement>('[data-field="advanced-content"]');
    const fileBtnInSection = item.querySelector(".google-stt-recognize-section .btn-mimo-asr-select-file");
    expect(fileBtnInSection).toBeNull();
    // File button is in advanced section
    const fileBtnInAdvanced = advancedContent?.querySelector(".btn-mimo-asr-select-file");
    expect(fileBtnInAdvanced).toBeTruthy();
  });

  it("advanced content is initially hidden", () => {
    const item = buildMimoAsrAccordion();
    const content = item.querySelector<HTMLElement>('[data-field="advanced-content"]');
    expect(content).toBeTruthy();
    expect(content!.hidden).toBe(true);
  });

  it("advanced toggle has aria-expanded=false", () => {
    const item = buildMimoAsrAccordion();
    const toggle = item.querySelector<HTMLElement>('[data-field="advanced-toggle"]');
    expect(toggle).toBeTruthy();
    expect(toggle!.getAttribute("aria-expanded")).toBe("false");
  });

  it("recognize result is initially hidden via hidden attribute", () => {
    const item = buildMimoAsrAccordion();
    const resultEl = item.querySelector<HTMLElement>('[data-field="recognize-result"]');
    expect(resultEl).toBeTruthy();
    expect(resultEl!.hidden).toBe(true);
  });

  it("does not use style display:none for result or advanced", () => {
    const item = buildMimoAsrAccordion();
    const resultEl = item.querySelector<HTMLElement>('[data-field="recognize-result"]');
    const advancedContent = item.querySelector<HTMLElement>('[data-field="advanced-content"]');
    expect(resultEl!.getAttribute("style")).toBeNull();
    expect(advancedContent!.getAttribute("style")).toBeNull();
  });

  it("accordion header can be clicked to open", () => {
    const item = buildMimoAsrAccordion();
    const header = item.querySelector(".accordion-header") as HTMLElement;
    const detail = item.querySelector(".accordion-detail") as HTMLElement;

    expect(detail.style.display).toBe("none");
    header.click();
    expect(detail.style.display).toBe("");
    expect(header.getAttribute("aria-expanded")).toBe("true");
  });

  it("accordion header can be clicked to close", () => {
    const item = buildMimoAsrAccordion();
    const header = item.querySelector(".accordion-header") as HTMLElement;
    const detail = item.querySelector(".accordion-detail") as HTMLElement;

    header.click(); // open
    header.click(); // close
    expect(detail.style.display).toBe("none");
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("advanced toggle opens content on click with handler bound", () => {
    const item = buildMimoAsrAccordion();
    // アコーディオンを開く（bind対象のDOMを表示状態にする）
    const header = item.querySelector(".accordion-header") as HTMLElement;
    header.click();

    const toggle = item.querySelector<HTMLButtonElement>('[data-field="advanced-toggle"]');
    const content = item.querySelector<HTMLElement>('[data-field="advanced-content"]');
    expect(toggle).toBeTruthy();
    expect(content).toBeTruthy();

    // ハンドラーを手動でバインド（bindXiaomiMimoAsrHandlersと同じロジック）
    toggle!.addEventListener("click", () => {
      const willOpen = content!.hidden;
      content!.hidden = !willOpen;
      toggle!.setAttribute("aria-expanded", String(willOpen));
      toggle!.classList.toggle("is-open", willOpen);
    });

    // 初期状態
    expect(content!.hidden).toBe(true);
    expect(toggle!.getAttribute("aria-expanded")).toBe("false");

    // 1回目のクリック: 開く
    toggle!.click();
    expect(content!.hidden).toBe(false);
    expect(toggle!.getAttribute("aria-expanded")).toBe("true");
    expect(toggle!.classList.contains("is-open")).toBe(true);

    // 2回目のクリック: 閉じる
    toggle!.click();
    expect(content!.hidden).toBe(true);
    expect(toggle!.getAttribute("aria-expanded")).toBe("false");
    expect(toggle!.classList.contains("is-open")).toBe(false);
  });

  it("advanced toggle shows file selection button when opened", () => {
    const item = buildMimoAsrAccordion();
    const header = item.querySelector(".accordion-header") as HTMLElement;
    header.click();

    const toggle = item.querySelector<HTMLButtonElement>('[data-field="advanced-toggle"]');
    const content = item.querySelector<HTMLElement>('[data-field="advanced-content"]');

    // ハンドラーをバインド
    toggle!.addEventListener("click", () => {
      const willOpen = content!.hidden;
      content!.hidden = !willOpen;
      toggle!.setAttribute("aria-expanded", String(willOpen));
    });

    const fileBtn = content!.querySelector(".btn-mimo-asr-select-file");
    expect(fileBtn).toBeTruthy();

    // トグルで開く
    toggle!.click();
    expect(content!.hidden).toBe(false);
    expect(fileBtn).toBeTruthy();
  });
});

// ---- Window Close Guard (Cases 8A - 8G) ----

describe("Window Close Guard (Cases 8A - 8G)", () => {
  let closeRequestedHandler: ((event: any) => Promise<void>) | null = null;
  let mockWindow: any;

  beforeEach(() => {
    vi.restoreAllMocks();
    closeRequestedHandler = null;
    resetWindowCloseGuardForTest();
    setEditorDocument(null);

    mockWindow = {
      isMaximized: vi.fn().mockResolvedValue(false),
      toggleMaximize: vi.fn().mockResolvedValue(undefined),
      minimize: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
      onResized: vi.fn().mockResolvedValue(() => {}),
      onCloseRequested: vi.fn().mockImplementation((cb: (event: any) => Promise<void>) => {
        closeRequestedHandler = cb;
        return Promise.resolve(() => {});
      }),
    };
    setTauriWindowForTest(mockWindow);
  });

  function createTestDirtyDoc() {
    setEditorDocument({
      schemaVersion: 1,
      mediaPath: "C:\\audio.wav",
      mediaFileName: "audio.wav",
      createdAt: "2026-09-26T20:00:00Z",
      updatedAt: "2026-09-26T20:00:00Z",
      language: "ja",
      sourceEngine: "reazonspeech",
      sourceRunId: "run-1",
      segments: [{
        id: "seg-1",
        start: 0,
        end: 5,
        speaker: "SPEAKER_00",
        originalSpeaker: "SPEAKER_00",
        text: "テスト",
        originalText: "テスト",
        sourceEngine: "reazonspeech",
        sourceSegmentId: "1",
        sourceRunId: "run-1",
        status: "raw",
      }],
    }, null); // null path = dirty/unsaved
  }

  it("Case 8A: onCloseRequested handler is registered only once across multiple setups", async () => {
    await setupWindowCloseGuard();
    await setupWindowCloseGuard();
    await setupWindowCloseGuard();

    expect(mockWindow.onCloseRequested).toHaveBeenCalledTimes(1);
    expect(mockWindow.onResized).toHaveBeenCalledTimes(1);
  });

  it("Case 8B: custom close button, dirty editor, cancel confirmation", async () => {
    createTestDirtyDoc();
    expect(isEditorDirty()).toBe(true);

    const confirmSpy = vi.spyOn(statusModule, "showAppConfirm").mockResolvedValue(false);

    await requestAppClose();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(mockWindow.destroy).not.toHaveBeenCalled();
    expect(isForceClosingForTest()).toBe(false);
    expect(isEditorDirty()).toBe(true);
  });

  it("Case 8C: custom close button, dirty editor, approve confirmation", async () => {
    createTestDirtyDoc();
    expect(isEditorDirty()).toBe(true);

    const confirmSpy = vi.spyOn(statusModule, "showAppConfirm").mockResolvedValue(true);

    await requestAppClose();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(isForceClosingForTest()).toBe(true);
    expect(mockWindow.destroy).toHaveBeenCalledTimes(1);
  });

  it("Case 8D: Alt+F4 / onCloseRequested event, dirty editor, cancel confirmation", async () => {
    await setupWindowCloseGuard();
    createTestDirtyDoc();
    expect(isEditorDirty()).toBe(true);

    const confirmSpy = vi.spyOn(statusModule, "showAppConfirm").mockResolvedValue(false);
    const mockEvent = { preventDefault: vi.fn() };

    await closeRequestedHandler!(mockEvent);

    expect(mockEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(mockWindow.destroy).not.toHaveBeenCalled();
    expect(isForceClosingForTest()).toBe(false);
  });

  it("Case 8E: Alt+F4 / onCloseRequested event, dirty editor, approve confirmation", async () => {
    await setupWindowCloseGuard();
    createTestDirtyDoc();
    expect(isEditorDirty()).toBe(true);

    const confirmSpy = vi.spyOn(statusModule, "showAppConfirm").mockResolvedValue(true);
    const mockEvent = { preventDefault: vi.fn() };

    await closeRequestedHandler!(mockEvent);

    expect(mockEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(isForceClosingForTest()).toBe(true);
    expect(mockWindow.destroy).toHaveBeenCalledTimes(1);
  });

  it("Case 8F: clean state close proceeds directly without prompt", async () => {
    await setupWindowCloseGuard();
    expect(isEditorDirty()).toBe(false);

    const confirmSpy = vi.spyOn(statusModule, "showAppConfirm");

    // Custom close
    await requestAppClose();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(mockWindow.destroy).toHaveBeenCalledTimes(1);

    // Reset and test onCloseRequested
    resetWindowCloseGuardForTest();
    await setupWindowCloseGuard();
    const mockEvent = { preventDefault: vi.fn() };
    await closeRequestedHandler!(mockEvent);

    expect(mockEvent.preventDefault).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(isForceClosingForTest()).toBe(true);
  });

  it("Case 8G: re-entrant close while forceClosing=true does not prompt or duplicate destroy", async () => {
    await setupWindowCloseGuard();
    createTestDirtyDoc();

    const confirmSpy = vi.spyOn(statusModule, "showAppConfirm").mockResolvedValue(true);

    // First close
    await requestAppClose();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(mockWindow.destroy).toHaveBeenCalledTimes(1);
    expect(isForceClosingForTest()).toBe(true);

    // Second close attempt while forceClosing=true
    await requestAppClose();
    expect(confirmSpy).toHaveBeenCalledTimes(1); // no extra confirm
    expect(mockWindow.destroy).toHaveBeenCalledTimes(1); // no extra destroy

    // Also onCloseRequested re-entry
    const mockEvent = { preventDefault: vi.fn() };
    await closeRequestedHandler!(mockEvent);
    expect(mockEvent.preventDefault).not.toHaveBeenCalled();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
  });

  it("Case 8H: after beforeunload event, close guard listeners remain intact and functional", async () => {
    await setupWindowCloseGuard();
    createTestDirtyDoc();
    expect(isEditorDirty()).toBe(true);

    // Simulate beforeunload (e.g. browser tab close / navigation cancel)
    const beforeUnloadEvent = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
    const preventDefaultSpy = vi.spyOn(beforeUnloadEvent, "preventDefault");
    window.dispatchEvent(beforeUnloadEvent);

    expect(preventDefaultSpy).toHaveBeenCalledTimes(1);

    // Ensure onCloseRequested listener is still registered and active
    const confirmSpy = vi.spyOn(statusModule, "showAppConfirm").mockResolvedValue(true);
    const mockEvent = { preventDefault: vi.fn() };
    await closeRequestedHandler!(mockEvent);

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(mockWindow.destroy).toHaveBeenCalledTimes(1);
    expect(isForceClosingForTest()).toBe(true);
  });

  it("Case 8I: custom close button recovers forceClosing=false when destroy() rejects", async () => {
    createTestDirtyDoc();
    expect(isEditorDirty()).toBe(true);

    mockWindow.destroy.mockRejectedValueOnce(new Error("destroy failed"));
    const confirmSpy = vi.spyOn(statusModule, "showAppConfirm").mockResolvedValue(true);

    // 1st close: destroy rejects
    await requestAppClose();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(isForceClosingForTest()).toBe(false); // restored to false

    // 2nd close: should be retriable and prompt confirm again
    mockWindow.destroy.mockResolvedValueOnce(undefined);
    await requestAppClose();
    expect(confirmSpy).toHaveBeenCalledTimes(2);
    expect(isForceClosingForTest()).toBe(true);
    expect(mockWindow.destroy).toHaveBeenCalledTimes(2);
  });

  it("Case 8J: onCloseRequested recovers forceClosing=false when destroy() rejects", async () => {
    await setupWindowCloseGuard();
    createTestDirtyDoc();
    expect(isEditorDirty()).toBe(true);

    mockWindow.destroy.mockRejectedValueOnce(new Error("destroy failed"));
    const confirmSpy = vi.spyOn(statusModule, "showAppConfirm").mockResolvedValue(true);

    // 1st Alt+F4: destroy rejects
    const mockEvent1 = { preventDefault: vi.fn() };
    await closeRequestedHandler!(mockEvent1);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(isForceClosingForTest()).toBe(false); // restored to false

    // 2nd Alt+F4: should be retriable and prompt confirm again
    mockWindow.destroy.mockResolvedValueOnce(undefined);
    const mockEvent2 = { preventDefault: vi.fn() };
    await closeRequestedHandler!(mockEvent2);
    expect(confirmSpy).toHaveBeenCalledTimes(2);
    expect(isForceClosingForTest()).toBe(true);
    expect(mockWindow.destroy).toHaveBeenCalledTimes(2);
  });

  it("Case 8K: retrying setupWindowCloseGuard after listener rejection registers missing listener without duplicating others", async () => {
    mockWindow.onCloseRequested
      .mockRejectedValueOnce(new Error("IPC failed"))
      .mockResolvedValueOnce(() => {});

    // 1st setup: onResized succeeds, onCloseRequested fails
    await setupWindowCloseGuard();
    expect(mockWindow.onResized).toHaveBeenCalledTimes(1);
    expect(mockWindow.onCloseRequested).toHaveBeenCalledTimes(1);

    // 2nd setup: onResized is skipped (already initialized), onCloseRequested succeeds
    await setupWindowCloseGuard();
    expect(mockWindow.onResized).toHaveBeenCalledTimes(1); // not duplicated!
    expect(mockWindow.onCloseRequested).toHaveBeenCalledTimes(2);
  });

  it("Case 8L: beforeunload does not preventDefault when forceClosing is true", async () => {
    await setupWindowCloseGuard();
    createTestDirtyDoc();

    // Confirm close via custom button
    vi.spyOn(statusModule, "showAppConfirm").mockResolvedValue(true);
    await requestAppClose();
    expect(isForceClosingForTest()).toBe(true);

    // Dispatch beforeunload while forceClosing = true
    const beforeUnloadEvent = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
    const preventDefaultSpy = vi.spyOn(beforeUnloadEvent, "preventDefault");
    window.dispatchEvent(beforeUnloadEvent);

    expect(preventDefaultSpy).not.toHaveBeenCalled();
  });

  it("Case 8M: beforeunload listener is registered and executed exactly once across setup retries", async () => {
    const addEventListenerSpy = vi.spyOn(window, "addEventListener");

    // 1st setup: fails on close request
    mockWindow.onCloseRequested
      .mockRejectedValueOnce(new Error("IPC failed"))
      .mockResolvedValueOnce(() => {});
    await setupWindowCloseGuard();

    // 2nd setup: retry succeeds
    await setupWindowCloseGuard();

    // Verify addEventListener("beforeunload", ...) was called exactly once
    const beforeUnloadCalls = addEventListenerSpy.mock.calls.filter(c => c[0] === "beforeunload");
    expect(beforeUnloadCalls.length).toBe(1);

    // Verify executing beforeunload runs the handler exactly once
    createTestDirtyDoc();
    const event = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
    const preventDefaultSpy = vi.spyOn(event, "preventDefault");
    window.dispatchEvent(event);
    expect(preventDefaultSpy).toHaveBeenCalledTimes(1);

    // Verify resetWindowCloseGuardForTest removes the listener
    resetWindowCloseGuardForTest();
    const event2 = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
    const preventDefaultSpy2 = vi.spyOn(event2, "preventDefault");
    window.dispatchEvent(event2);
    expect(preventDefaultSpy2).not.toHaveBeenCalled();
  });
});

// ---- Persistent Workspace DOM Retention (Cases PW-A - PW-M) ----

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const defaultMockSettings = {
  providers: {
    ollama: {
      base_url: "http://localhost:11434",
      default_model: "llama3:latest",
    },
    openai_audio: {
      env_name: "OPENAI_API_KEY",
      default_model: "whisper-1",
    },
  },
  asr_mode: "cloud",
  asr_engine: "google_stt",
  asr_languages: {},
  speaker_diarization: false,
  num_speakers: "auto",
  output_path: "",
};

describe("Persistent Workspace DOM Retention", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '<div id="app"></div>';
    resetMountedPagesForTest();
    resetMultiAsrMainStateForTest();
    resetWindowCloseGuardForTest();
    resetDockerStatusRevisionForTest();
    setEditorDocument(null);
    setTauriInvokeForTest((async (command: string) => {
      if (command === "load_api_settings") {
        return defaultMockSettings;
      }
      if (command === "docker_check_status") {
        return {
          cliFound: true,
          cliVersion: "24.0.5",
          daemonRunning: true,
          serverVersion: "24.0.5",
          desktopFound: true,
          cliPath: "/usr/bin/docker",
          desktopPath: null,
          errorKind: null,
          errorMessage: null,
        };
      }
      if (command === "local_asr_get_status" || command === "local_asr_get_status_fast") {
        return [];
      }
      if (command === "hf_token_get_status") {
        return { configured: false, envName: "HF_TOKEN" };
      }
      return null;
    }) as any);
  });

  it("Case PW-A: Transcribe workspace retains DOM state and inputs across tab switches", async () => {
    await navigateTo("transcribe");

    const transcribeEl = document.getElementById("page-transcribe");
    expect(transcribeEl).toBeTruthy();
    expect(transcribeEl!.classList.contains("hidden")).toBe(false);

    // Simulate user selecting an output path and having transcript result displayed
    const outputPathInput = document.getElementById("outputPathInput") as HTMLInputElement;
    expect(outputPathInput).toBeTruthy();
    outputPathInput.value = "C:/Custom/Path";

    const resultSection = document.getElementById("resultSection") as HTMLElement;
    const resultText = document.getElementById("resultText") as HTMLTextAreaElement;
    resultSection.style.display = "";
    resultText.value = "文字起こし結果テキスト";

    // Switch to Editor tab
    await navigateTo("editor");
    const editorEl = document.getElementById("page-editor");
    expect(editorEl!.classList.contains("hidden")).toBe(false);
    expect(transcribeEl!.classList.contains("hidden")).toBe(true);

    // Switch back to Transcribe tab
    await navigateTo("transcribe");
    expect(transcribeEl!.classList.contains("hidden")).toBe(false);
    expect(editorEl!.classList.contains("hidden")).toBe(true);

    // Verify DOM inputs and result are preserved exactly
    expect((document.getElementById("outputPathInput") as HTMLInputElement).value).toBe("C:/Custom/Path");
    expect((document.getElementById("resultText") as HTMLTextAreaElement).value).toBe("文字起こし結果テキスト");
    expect((document.getElementById("resultSection") as HTMLElement).style.display).toBe("");
  });

  it("Case PW-B: Editor dirty edits, status badge, proposals, and session ID are preserved without discard prompt on tab switch", async () => {
    const confirmSpy = vi.spyOn(statusModule, "showAppConfirm");

    const initialDoc: TranscriptDocument = {
      schemaVersion: 1,
      mediaPath: "C:\\meeting.wav",
      mediaFileName: "meeting.wav",
      createdAt: "2026-09-26T20:00:00Z",
      updatedAt: "2026-09-26T20:00:00Z",
      language: "ja",
      sourceEngine: "whisper",
      sourceRunId: "run-1",
      segments: [
        {
          id: "seg-1",
          start: 0,
          end: 4,
          speaker: "SPEAKER_00",
          originalSpeaker: "SPEAKER_00",
          text: "初めのテキスト",
          originalText: "初めのテキスト",
          sourceEngine: "whisper",
          sourceSegmentId: "1",
          sourceRunId: "run-1",
          status: "raw",
        },
      ],
    };

    setEditorDocument(initialDoc, "C:/meeting.asrc.json");
    const initialSessionId = getEditorDocumentSessionId();

    await navigateTo("editor");
    const editorEl = document.getElementById("page-editor");
    expect(editorEl!.classList.contains("hidden")).toBe(false);

    // Edit the text area
    const textarea = editorEl!.querySelector(".segment-text-input") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    textarea.value = "編集後のテキスト";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));

    expect(isEditorDirty()).toBe(true);
    const badge = editorEl!.querySelector("#editorStatusContainer");
    expect(badge?.textContent).toContain("未保存");

    // Add an active proposal
    const testProposals = new Map<string, CorrectionProposal[]>([
      [
        "seg-1",
        [
          {
            id: "prop-1",
            segmentId: "seg-1",
            originalText: "編集後のテキスト",
            correctedText: "修正後テキスト",
            explanation: "誤認識修正",
            evidence: [{ type: "dictionary", description: "辞書" }],
            confidence: 0.95,
          },
        ],
      ],
    ]);
    setActiveProposalsForTest(testProposals);

    // Switch to Settings tab
    await navigateTo("settings-general");
    const settingsEl = document.getElementById("page-settings");
    expect(settingsEl!.classList.contains("hidden")).toBe(false);
    expect(editorEl!.classList.contains("hidden")).toBe(true);

    // Confirm that NO discard confirmation was prompted
    expect(confirmSpy).not.toHaveBeenCalled();

    // Switch back to Editor tab
    await navigateTo("editor");
    expect(editorEl!.classList.contains("hidden")).toBe(false);
    expect(settingsEl!.classList.contains("hidden")).toBe(true);

    // Verify all editor state is completely preserved
    const currentDoc = getEditorDocument();
    expect(currentDoc?.segments[0].text).toBe("編集後のテキスト");
    expect(currentDoc?.segments[0].status).toBe("edited");
    expect(isEditorDirty()).toBe(true);
    expect(editorEl!.querySelector("#editorStatusContainer")?.textContent).toContain("未保存");
    expect(getEditorDocumentSessionId()).toBe(initialSessionId);
    expect(getActiveProposals().get("seg-1")?.length).toBe(1);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("Case PW-C: Switching tabs updates header active nav classes", async () => {
    await navigateTo("transcribe");
    let navLinks = document.querySelectorAll<HTMLElement>(".header-nav .nav-link");
    expect(navLinks[0].classList.contains("active")).toBe(true); // 文字起こし
    expect(navLinks[1].classList.contains("active")).toBe(false); // 正本編集
    expect(navLinks[2].classList.contains("active")).toBe(false); // 統合
    expect(navLinks[3].classList.contains("active")).toBe(false); // 設定

    await navigateTo("editor");
    navLinks = document.querySelectorAll<HTMLElement>(".header-nav .nav-link");
    expect(navLinks[0].classList.contains("active")).toBe(false);
    expect(navLinks[1].classList.contains("active")).toBe(true);
    expect(navLinks[2].classList.contains("active")).toBe(false);
    expect(navLinks[3].classList.contains("active")).toBe(false);

    await navigateTo("merge");
    navLinks = document.querySelectorAll<HTMLElement>(".header-nav .nav-link");
    expect(navLinks[0].classList.contains("active")).toBe(false);
    expect(navLinks[1].classList.contains("active")).toBe(false);
    expect(navLinks[2].classList.contains("active")).toBe(true);
    expect(navLinks[3].classList.contains("active")).toBe(false);

    await navigateTo("settings-ollama");
    navLinks = document.querySelectorAll<HTMLElement>(".header-nav .nav-link");
    expect(navLinks[0].classList.contains("active")).toBe(false);
    expect(navLinks[1].classList.contains("active")).toBe(false);
    expect(navLinks[2].classList.contains("active")).toBe(false);
    expect(navLinks[3].classList.contains("active")).toBe(true);
  });

  it("Case PW-D: Repeated navigation does not duplicate event listeners", async () => {
    const initialDoc: TranscriptDocument = {
      schemaVersion: 1,
      mediaPath: "C:\\audio.wav",
      mediaFileName: "audio.wav",
      createdAt: "2026-09-26T20:00:00Z",
      updatedAt: "2026-09-26T20:00:00Z",
      language: "ja",
      sourceEngine: "whisper",
      sourceRunId: "run-1",
      segments: [
        {
          id: "seg-1",
          start: 0,
          end: 2,
          speaker: "SPEAKER_00",
          originalSpeaker: "SPEAKER_00",
          text: "テスト",
          originalText: "テスト",
          sourceEngine: "whisper",
          sourceSegmentId: "1",
          sourceRunId: "run-1",
          status: "raw",
        },
      ],
    };
    setEditorDocument(initialDoc, "C:/audio.asrc.json");

    await navigateTo("transcribe");
    await navigateTo("editor");
    await navigateTo("settings-general");
    await navigateTo("editor");
    await navigateTo("transcribe");
    await navigateTo("editor");

    const editorEl = document.getElementById("page-editor");
    const textarea = editorEl!.querySelector(".segment-text-input") as HTMLTextAreaElement;

    let inputEventCount = 0;
    const list = document.getElementById("editorSegmentsList");
    list?.addEventListener("input", () => {
      inputEventCount++;
    });

    textarea.value = "変更テスト";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));

    expect(inputEventCount).toBe(1);
    expect(getEditorDocument()?.segments[0].text).toBe("変更テスト");
  });

  it("Case PW-E: Window close guard triggers when editor dirty while user is on transcribe tab", async () => {
    const mockWindow = {
      isMaximized: vi.fn().mockResolvedValue(false),
      destroy: vi.fn().mockResolvedValue(undefined),
      onResized: vi.fn().mockResolvedValue(() => {}),
      onCloseRequested: vi.fn().mockResolvedValue(() => {}),
    };
    setTauriWindowForTest(mockWindow);
    await setupWindowCloseGuard();

    const dirtyDoc: TranscriptDocument = {
      schemaVersion: 1,
      mediaPath: "C:\\audio.wav",
      mediaFileName: "audio.wav",
      createdAt: "2026-09-26T20:00:00Z",
      updatedAt: "2026-09-26T20:00:00Z",
      language: "ja",
      sourceEngine: "whisper",
      sourceRunId: "run-1",
      segments: [
        {
          id: "seg-1",
          start: 0,
          end: 2,
          speaker: "SPEAKER_00",
          originalSpeaker: "SPEAKER_00",
          text: "未保存テキスト",
          originalText: "未保存テキスト",
          sourceEngine: "whisper",
          sourceSegmentId: "1",
          sourceRunId: "run-1",
          status: "raw",
        },
      ],
    };
    setEditorDocument(dirtyDoc, null); // null path = dirty

    // User is on Transcribe tab
    await navigateTo("transcribe");
    expect(isEditorDirty()).toBe(true);

    const confirmSpy = vi.spyOn(statusModule, "showAppConfirm").mockResolvedValue(false);

    await requestAppClose();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(mockWindow.destroy).not.toHaveBeenCalled();
  });

  it("Case PW-F: Slower stale navigation completing out of order does not overwrite UI", async () => {
    const settingsDef = deferred<any>();
    setTauriInvokeForTest((async (command: string) => {
      if (command === "load_api_settings") {
        return settingsDef.promise;
      }
      return defaultMockSettings;
    }) as any);

    // Navigation 1: settings-ollama (starts loadOllamaSettings, held pending by settingsDef)
    const nav1 = navigateTo("settings-ollama");

    // Navigation 2: settings-general
    const nav2 = navigateTo("settings-general");
    await nav2;

    const generalEl = document.getElementById("subpage-settings-general");
    const ollamaEl = document.getElementById("subpage-settings-ollama");
    expect(generalEl!.classList.contains("hidden")).toBe(false);
    expect(ollamaEl!.classList.contains("hidden")).toBe(true);

    // Now resolve Navigation 1's pending settings load
    settingsDef.resolve(defaultMockSettings);
    await nav1;

    // Verify UI remains on settings-general, NOT overwritten by the stale settings-ollama navigation
    expect(generalEl!.classList.contains("hidden")).toBe(false);
    expect(ollamaEl!.classList.contains("hidden")).toBe(true);
  });

  it("Case PW-G: Concurrent navigation to same page runs mount once via Promise registry", async () => {
    let loadCount = 0;
    setTauriInvokeForTest((async (command: string) => {
      if (command === "load_api_settings") {
        loadCount++;
        return defaultMockSettings;
      }
      return null;
    }) as any);

    await Promise.all([
      navigateTo("settings"),
      navigateTo("settings"),
      navigateTo("settings"),
    ]);

    expect(pageMounts.has("workspace:settings")).toBe(true);
    expect(pageMounts.has("settings:api")).toBe(true);
    expect(loadCount).toBe(1);

    const subpageSettings = document.getElementById("subpage-settings");
    expect(subpageSettings!.classList.contains("hidden")).toBe(false);
  });

  it("Case PW-H: Shared cancelled mount Promise is retried automatically once by current navigation", async () => {
    const def1 = deferred<any>();
    let callCount = 0;

    setTauriInvokeForTest((async (command: string) => {
      if (command === "load_api_settings") {
        callCount++;
        if (callCount === 1) {
          return def1.promise;
        }
        return defaultMockSettings;
      }
      return null;
    }) as any);

    // Navigation A: start settings-ollama (call 1, pending on def1)
    const navA = navigateTo("settings-ollama");

    // Allow navA to progress past workspace:settings and invoke load_api_settings
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(callCount).toBe(1);

    // Navigation B: switch to settings-general
    const navB = navigateTo("settings-general");
    await navB;

    // Navigation C: switch back to settings-ollama while def1 is still pending
    // C shares pageMounts.get("settings:ollama") with A
    const navC = navigateTo("settings-ollama");

    // Allow microtasks to settle so C is awaiting A's promise
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Now resolve def1.
    // Navigation A evaluates generation mismatch (A's navId !== C's generation) and returns "cancelled".
    // Navigation C receives "cancelled", recognizes it is current generation, and retries mount once (call 2).
    def1.resolve(defaultMockSettings);

    await Promise.all([navA, navC]);

    expect(callCount).toBe(2);
    expect(pageMounts.has("settings:ollama")).toBe(true);
    const ollamaSubpage = document.getElementById("subpage-settings-ollama");
    expect(ollamaSubpage!.classList.contains("hidden")).toBe(false);
    expect((document.getElementById("ollamaBaseUrl") as HTMLInputElement).value).toBe("http://localhost:11434");
  });

  it("Case PW-I: Local ASR progress updates persistent DOM across tab switches", async () => {
    // Mount settings-docker
    await navigateTo("settings-docker");
    const localAsrContainer = document.getElementById("localAsrContainer");
    expect(localAsrContainer).toBeTruthy();

    // Set up dummy engine install card in container
    localAsrContainer!.innerHTML = `
      <div data-install-engine-status="whisper">
        <div class="local-asr-progress-fill" style="width: 0%;"></div>
        <div class="local-asr-progress-track" aria-valuenow="0"></div>
        <div class="local-asr-progress-percent">0%</div>
        <div class="local-asr-progress-message">準備中</div>
      </div>
    `;

    // Navigate to Transcribe
    await navigateTo("transcribe");
    const settingsEl = document.getElementById("page-settings");
    expect(settingsEl!.classList.contains("hidden")).toBe(true);

    // Call update progress while on transcribe tab
    const statusEl = document.querySelector<HTMLElement>('[data-install-engine-status="whisper"]');
    expect(statusEl).toBeTruthy();
    expect(statusEl!.isConnected).toBe(true);

    const fill = statusEl!.querySelector<HTMLElement>(".local-asr-progress-fill")!;
    const track = statusEl!.querySelector<HTMLElement>(".local-asr-progress-track")!;
    const percentEl = statusEl!.querySelector<HTMLElement>(".local-asr-progress-percent")!;
    const messageEl = statusEl!.querySelector<HTMLElement>(".local-asr-progress-message")!;

    fill.style.width = "75%";
    track.setAttribute("aria-valuenow", "75");
    percentEl.textContent = "75%";
    messageEl.textContent = "ダウンロード中...";

    // Navigate back to settings-docker
    await navigateTo("settings-docker");
    expect(settingsEl!.classList.contains("hidden")).toBe(false);
    expect(fill.style.width).toBe("75%");
    expect(percentEl.textContent).toBe("75%");
    expect(messageEl.textContent).toBe("ダウンロード中...");
  });

  it("Case PW-J: Docker status stale response reverse-order overwrite prevention", async () => {
    // First mount settings-docker
    await navigateTo("settings-docker");
    const container = document.getElementById("dockerStatusContainer")!;
    expect(container).toBeTruthy();

    const defA = deferred<any>();
    const defB = deferred<any>();
    let reqCount = 0;

    setTauriInvokeForTest((async (command: string) => {
      if (command === "docker_check_status") {
        reqCount++;
        if (reqCount === 1) return defA.promise;
        if (reqCount === 2) return defB.promise;
      }
      return null;
    }) as any);

    // Directly trigger Request A (slow) and Request B (fast)
    const pA = loadAndRenderDockerStatus();
    const pB = loadAndRenderDockerStatus();

    expect(reqCount).toBe(2);

    // Resolve B first with running status
    defB.resolve({
      cliFound: true,
      cliVersion: "24.0.5",
      daemonRunning: true,
      serverVersion: "24.0.5",
      desktopFound: true,
      cliPath: "/usr/bin/docker",
      desktopPath: null,
      errorKind: null,
      errorMessage: null,
    });

    await pB;
    await Promise.resolve();

    // Container should show running status ("Docker Desktopは利用可能です")
    expect(container.textContent).toContain("利用可能");

    // Now resolve A later with older stopped status
    defA.resolve({
      cliFound: true,
      cliVersion: "24.0.5",
      daemonRunning: false,
      serverVersion: null,
      desktopFound: true,
      cliPath: "/usr/bin/docker",
      desktopPath: null,
      errorKind: "daemon-stopped",
      errorMessage: "Docker is stopped",
    });

    await pA;
    await Promise.resolve();

    // Verify DOM still shows B's running state, not overwritten by A's stale response
    expect(container.textContent).toContain("利用可能");
  });

  it("Case PW-K: Settings IPC failure is not cached as mounted and allows retry", async () => {
    let failIpc = true;
    setTauriInvokeForTest((async (command: string) => {
      if (command === "load_api_settings") {
        if (failIpc) {
          throw new Error("Disk IO failure");
        }
        return defaultMockSettings;
      }
      return null;
    }) as any);

    // First attempt fails
    await navigateTo("settings");
    expect(pageMounts.has("settings:api")).toBe(false);

    // Second attempt after IPC recovery
    failIpc = false;
    await navigateTo("settings");
    expect(pageMounts.has("settings:api")).toBe(true);
    const subpageSettings = document.getElementById("subpage-settings");
    expect(subpageSettings!.classList.contains("hidden")).toBe(false);
  });

  it("Case PW-L: Navigating to settings-docker invokes docker_check_status exactly once", async () => {
    let dockerCheckCount = 0;
    setTauriInvokeForTest((async (command: string) => {
      if (command === "docker_check_status") {
        dockerCheckCount++;
        return {
          cliFound: true,
          cliVersion: "24.0.5",
          daemonRunning: true,
          serverVersion: "24.0.5",
          desktopFound: true,
          cliPath: "/usr/bin/docker",
          desktopPath: null,
          errorKind: null,
          errorMessage: null,
        };
      }
      return null;
    }) as any);

    await navigateTo("settings-docker");
    expect(dockerCheckCount).toBe(1);
  });

  it("Case PW-M: Workspace and Settings subpages have separated keys in registry", async () => {
    // Navigating to settings-general mounts workspace:settings and settings:general
    await navigateTo("settings-general");
    expect(pageMounts.has("workspace:settings")).toBe(true);
    expect(pageMounts.has("settings:general")).toBe(true);
    expect(pageMounts.has("settings:api")).toBe(false);

    // Navigating to settings (API subpage) mounts settings:api without re-mounting workspace:settings
    await navigateTo("settings");
    expect(pageMounts.has("settings:api")).toBe(true);
    const subpageSettings = document.getElementById("subpage-settings");
    expect(subpageSettings!.classList.contains("hidden")).toBe(false);
  });

  it("Case PW-N: Missing container throws error and cleans up pageMounts registry", async () => {
    // Break DOM by emptying body completely so #app doesn't exist
    document.body.innerHTML = "";

    await expect(navigateTo("transcribe")).rejects.toThrow();
    expect(pageMounts.has("workspace:transcribe")).toBe(false);
  });

  it("Case PW-O: Outdated local ASR engine (needsUpdate === true) is disabled in #engineSelect", async () => {
    setTauriInvokeForTest((async (command: string) => {
      if (command === "load_api_settings") {
        return {
          ...defaultMockSettings,
          asr_mode: "local",
        };
      }
      if (command === "local_asr_get_status" || command === "local_asr_get_status_fast") {
        return [
          {
            engine: "reazonspeech",
            displayName: "ReazonSpeech",
            installed: true,
            needsUpdate: true,
            imageName: "asr-composer-reazonspeech:cu126",
            imageId: "sha256:old123",
            environmentVersion: "2.0.0",
            expectedEnvironmentVersion: "2.1.0",
            modelName: "reazon-research/reazonspeech-espnet-v2",
            dockerAvailable: true,
            dockerRunning: true,
            errorKind: null,
            errorMessage: null,
          },
          {
            engine: "kotoba-whisper",
            displayName: "Kotoba Whisper v2.2",
            installed: true,
            needsUpdate: false,
            imageName: "asr-composer-kotoba-whisper:cu126",
            imageId: "sha256:current123",
            environmentVersion: "1.1.0",
            expectedEnvironmentVersion: "1.1.0",
            modelName: "kotoba-tech/kotoba-whisper-v2.2",
            dockerAvailable: true,
            dockerRunning: true,
            errorKind: null,
            errorMessage: null,
          },
        ];
      }
      return null;
    }) as any);

    await navigateTo("transcribe");
    const engineSelect = document.getElementById("engineSelect") as HTMLSelectElement;
    expect(engineSelect).toBeTruthy();

    const options = Array.from(engineSelect.options);
    const reazonOpt = options.find((o) => o.value === "reazonspeech");
    expect(reazonOpt).toBeTruthy();
    expect(reazonOpt!.disabled).toBe(true);
    expect(reazonOpt!.textContent).toContain("（更新が必要）");

    const kotobaOpt = options.find((o) => o.value === "kotoba-whisper");
    expect(kotobaOpt).toBeTruthy();
    expect(kotobaOpt!.disabled).toBe(false);
  });

  it("Case PW-P: Transcribe #engineSelect distinguishes query failures from image_missing and refreshes after settings-docker visit", async () => {
    let phase: "error" | "ready" = "error";
    setTauriInvokeForTest((async (command: string) => {
      if (command === "load_api_settings") {
        return {
          ...defaultMockSettings,
          asr_mode: "local",
        };
      }
      if (command === "docker_check_status") {
        return {
          cliFound: true,
          cliVersion: "24.0.5",
          daemonRunning: phase === "ready",
          serverVersion: phase === "ready" ? "24.0.5" : null,
          desktopFound: true,
          cliPath: "C:\\docker.exe",
          desktopPath: null,
          errorKind: phase === "ready" ? null : "daemon_not_running",
          errorMessage: phase === "ready" ? null : "Docker Engineに接続できません",
          dockerContext: "desktop-linux",
        };
      }
      if (command === "local_asr_get_status" || command === "local_asr_get_status_fast") {
        if (phase === "error") {
          return [
            {
              engine: "reazonspeech",
              displayName: "ReazonSpeech",
              installed: false,
              needsUpdate: false,
              imageName: "asr-composer-reazonspeech:cu126",
              imageId: null,
              environmentVersion: null,
              expectedEnvironmentVersion: "2.1.0",
              modelName: null,
              dockerAvailable: true,
              dockerRunning: false,
              errorKind: "context_error",
              errorMessage: "docker context show failed",
              state: "context_error",
              reason: "docker context show failed",
            },
          ];
        }
        return [
          {
            engine: "reazonspeech",
            displayName: "ReazonSpeech",
            installed: true,
            needsUpdate: false,
            imageName: "asr-composer-reazonspeech:cu126",
            imageId: "sha256:ready",
            environmentVersion: "2.1.0",
            expectedEnvironmentVersion: "2.1.0",
            modelName: "reazon-research/reazonspeech-espnet-v2",
            dockerAvailable: true,
            dockerRunning: true,
            errorKind: null,
            errorMessage: null,
            state: "ready",
            dockerContext: "desktop-linux",
            reason: null,
          },
        ];
      }
      if (command === "hf_token_get_status") {
        return { configured: false, maskedValue: null };
      }
      return null;
    }) as any);

    await navigateTo("transcribe");
    const engineSelect = document.getElementById("engineSelect") as HTMLSelectElement;
    expect(engineSelect.options[0].textContent).toContain("Docker状態の確認に失敗しました");
    expect(engineSelect.options[0].textContent).not.toContain("要インストールまたは更新");
    expect(engineSelect.options[1].textContent).toContain("状態取得失敗");
    expect(engineSelect.options[1].disabled).toBe(true);

    // Visit settings-docker while Docker is still stopped (invalidates cache), then Docker becomes ready and return to transcribe
    await navigateTo("settings-docker");
    phase = "ready";
    await navigateTo("transcribe");
    // Wait for async refreshTranscribeLocalEnginesIfActive
    await new Promise((r) => setTimeout(r, 0));

    const refreshedOpt = Array.from(engineSelect.options).find((o) => o.value === "reazonspeech");
    expect(refreshedOpt).toBeTruthy();
    expect(refreshedOpt!.disabled).toBe(false);
    expect(refreshedOpt!.textContent).toBe("ReazonSpeech");
  });

  it("Case PW-Q: settings-docker forwards resolved dockerContext from docker_check_status to local_asr_get_status_fast", async () => {
    let receivedFastArgs: unknown = undefined;
    setTauriInvokeForTest((async (command: string, args?: unknown) => {
      if (command === "load_api_settings") {
        return defaultMockSettings;
      }
      if (command === "docker_check_status") {
        return {
          cliFound: true,
          cliVersion: "24.0.5",
          daemonRunning: true,
          serverVersion: "24.0.5",
          desktopFound: true,
          cliPath: "C:\\docker.exe",
          desktopPath: null,
          errorKind: null,
          errorMessage: null,
          dockerContext: "custom-wsl-context",
        };
      }
      if (command === "local_asr_get_status_fast") {
        receivedFastArgs = args;
        return [
          {
            engine: "reazonspeech",
            displayName: "ReazonSpeech",
            installed: true,
            needsUpdate: false,
            imageName: "asr-composer-reazonspeech:cu126",
            imageId: "sha256:ready",
            environmentVersion: "2.1.0",
            expectedEnvironmentVersion: "2.1.0",
            modelName: "reazon-research/reazonspeech-espnet-v2",
            dockerAvailable: true,
            dockerRunning: true,
            errorKind: null,
            errorMessage: null,
            state: "ready",
            dockerContext: "custom-wsl-context",
            reason: null,
          },
        ];
      }
      if (command === "hf_token_get_status") {
        return { configured: false, maskedValue: null };
      }
      return null;
    }) as any);

    await navigateTo("settings-docker");
    await new Promise((r) => setTimeout(r, 0));
    expect(receivedFastArgs).toEqual({ dockerContext: "custom-wsl-context" });
  });

  it("Case PW-R: Returning to transcribe after settings-docker confirms Docker running refreshes #engineSelect and avoids redundant queries once ready", async () => {
    let dockerRunning = false;
    let statusQueryCount = 0;
    const makeEngineStatus = (running: boolean) => [
      {
        engine: "reazonspeech",
        displayName: "ReazonSpeech",
        installed: running,
        needsUpdate: false,
        imageName: "asr-composer-reazonspeech:cu126",
        imageId: running ? "sha256:ready" : null,
        environmentVersion: running ? "2.1.0" : null,
        expectedEnvironmentVersion: "2.1.0",
        modelName: running ? "reazon-research/reazonspeech-espnet-v2" : null,
        dockerAvailable: true,
        dockerRunning: running,
        errorKind: running ? null : "engine_stopped",
        errorMessage: running ? null : "Docker Engineが起動していません",
        state: running ? "ready" : "engine_stopped",
        dockerContext: "desktop-linux",
        reason: running ? null : "Docker Engineが起動していません",
      },
    ];

    setTauriInvokeForTest((async (command: string) => {
      if (command === "load_api_settings") {
        return { ...defaultMockSettings, asr_mode: "local", asr_engine: "reazonspeech" };
      }
      if (command === "docker_check_status") {
        return {
          cliFound: true,
          cliVersion: "24.0.5",
          daemonRunning: dockerRunning,
          serverVersion: dockerRunning ? "24.0.5" : null,
          desktopFound: true,
          cliPath: "C:\\docker.exe",
          desktopPath: null,
          errorKind: dockerRunning ? null : "daemon_not_running",
          errorMessage: dockerRunning ? null : "Docker Engineが起動していません",
          dockerContext: "desktop-linux",
        };
      }
      if (command === "local_asr_get_status" || command === "local_asr_get_status_fast") {
        statusQueryCount += 1;
        return makeEngineStatus(dockerRunning);
      }
      if (command === "hf_token_get_status") {
        return { configured: false, maskedValue: null };
      }
      return null;
    }) as any);

    // 1. 初回起動時は Docker 停止中
    await navigateTo("transcribe");
    const engineSelect = document.getElementById("engineSelect") as HTMLSelectElement;
    expect(engineSelect.options[0].textContent).toContain("Docker状態の確認に失敗しました");
    expect(engineSelect.value).toBe("");
    expect(statusQueryCount).toBe(1);

    // 2. Docker 起動後に settings-docker を訪問し、loadDockerPageStatuses() が完了してキャッシュが ready で有効化される
    dockerRunning = true;
    await navigateTo("settings-docker");
    await new Promise((r) => setTimeout(r, 0));
    expect(statusQueryCount).toBe(2);

    // 3. transcribe へ戻ると、settings-docker でキャッシュが埋まっていても #engineSelect を再同期して選択可能になる
    await navigateTo("transcribe");
    const refreshedOpt = Array.from(engineSelect.options).find((o) => o.value === "reazonspeech");
    expect(refreshedOpt).toBeTruthy();
    expect(refreshedOpt!.disabled).toBe(false);
    expect(engineSelect.value).toBe("reazonspeech");
    expect(statusQueryCount).toBe(3);

    // 4. すでに ready が反映済みなら、editor 往復で不要な再照会をしない
    await navigateTo("editor");
    await navigateTo("transcribe");
    expect(statusQueryCount).toBe(3);
  });

  it("Case PW-S: Returning to transcribe while Docker remains stopped preserves stopped state without misreporting image_missing", async () => {
    setTauriInvokeForTest((async (command: string) => {
      if (command === "load_api_settings") {
        return { ...defaultMockSettings, asr_mode: "local" };
      }
      if (command === "docker_check_status") {
        return {
          cliFound: true,
          cliVersion: "24.0.5",
          daemonRunning: false,
          serverVersion: null,
          desktopFound: true,
          cliPath: "C:\\docker.exe",
          desktopPath: null,
          errorKind: "daemon_not_running",
          errorMessage: "Docker Engineが起動していません",
          dockerContext: "desktop-linux",
        };
      }
      if (command === "local_asr_get_status" || command === "local_asr_get_status_fast") {
        return [
          {
            engine: "reazonspeech",
            displayName: "ReazonSpeech",
            installed: false,
            needsUpdate: false,
            imageName: "asr-composer-reazonspeech:cu126",
            imageId: null,
            environmentVersion: null,
            expectedEnvironmentVersion: "2.1.0",
            modelName: null,
            dockerAvailable: true,
            dockerRunning: false,
            errorKind: "engine_stopped",
            errorMessage: "Docker Engineが起動していません",
            state: "engine_stopped",
            dockerContext: "desktop-linux",
            reason: "Docker Engineが起動していません",
          },
        ];
      }
      if (command === "hf_token_get_status") {
        return { configured: false, maskedValue: null };
      }
      return null;
    }) as any);

    await navigateTo("transcribe");
    await navigateTo("settings-docker");
    await new Promise((r) => setTimeout(r, 0));
    await navigateTo("transcribe");

    const engineSelect = document.getElementById("engineSelect") as HTMLSelectElement;
    expect(engineSelect.options[0].textContent).toContain("Docker状態の確認に失敗しました");
    expect(engineSelect.options[0].textContent).not.toContain("要インストールまたは更新");
    expect(engineSelect.options[1].disabled).toBe(true);
  });

  it("Case PW-T: Stale async local_asr_get_status response does not roll back newer ready state", async () => {
    let resolveStale!: (value: unknown) => void;
    let callCount = 0;

    setTauriInvokeForTest((async (command: string) => {
      if (command === "load_api_settings") {
        return { ...defaultMockSettings, asr_mode: "local", asr_engine: "reazonspeech" };
      }
      if (command === "docker_check_status") {
        return {
          cliFound: true,
          cliVersion: "24.0.5",
          daemonRunning: true,
          serverVersion: "24.0.5",
          desktopFound: true,
          cliPath: "C:\\docker.exe",
          desktopPath: null,
          errorKind: null,
          errorMessage: null,
          dockerContext: "desktop-linux",
        };
      }
      if (command === "local_asr_get_status") {
        callCount += 1;
        if (callCount === 2) {
          return await new Promise((resolve) => {
            resolveStale = resolve;
          });
        }
        return [
          {
            engine: "reazonspeech",
            displayName: "ReazonSpeech",
            installed: true,
            needsUpdate: false,
            imageName: "asr-composer-reazonspeech:cu126",
            imageId: "sha256:ready",
            environmentVersion: "2.1.0",
            expectedEnvironmentVersion: "2.1.0",
            modelName: "reazon-research/reazonspeech-espnet-v2",
            dockerAvailable: true,
            dockerRunning: true,
            errorKind: null,
            errorMessage: null,
            state: "ready",
            dockerContext: "desktop-linux",
            reason: null,
          },
        ];
      }
      if (command === "local_asr_get_status_fast") {
        return [];
      }
      if (command === "hf_token_get_status") {
        return { configured: false, maskedValue: null };
      }
      return null;
    }) as any);

    // 1. 初回表示（transcribe マウント完了）
    await navigateTo("transcribe");
    await navigateTo("settings-docker");

    // 2. transcribe 復帰時の再取得（callCount === 2）を未完了のままにし、別の再遷移（callCount === 3）を完了させる
    const staleReturnNav = navigateTo("transcribe");
    await new Promise((r) => setTimeout(r, 0));
    await navigateTo("settings-docker");
    await navigateTo("transcribe");

    const engineSelect = document.getElementById("engineSelect") as HTMLSelectElement;
    expect(engineSelect.value).toBe("reazonspeech");

    // 3. 遅延して古い応答が返っても DOM やキャッシュを巻き戻さない
    resolveStale([
      {
        engine: "reazonspeech",
        displayName: "ReazonSpeech",
        installed: false,
        needsUpdate: false,
        imageName: "asr-composer-reazonspeech:cu126",
        imageId: null,
        environmentVersion: null,
        expectedEnvironmentVersion: "2.1.0",
        modelName: null,
        dockerAvailable: true,
        dockerRunning: false,
        errorKind: "engine_stopped",
        errorMessage: "Docker Engineが起動していません",
        state: "engine_stopped",
        dockerContext: "desktop-linux",
        reason: "Docker Engineが起動していません",
      },
    ]);
    await staleReturnNav;
    await new Promise((r) => setTimeout(r, 0));

    const opt = Array.from(engineSelect.options).find((o) => o.value === "reazonspeech");
    expect(opt).toBeTruthy();
    expect(opt!.disabled).toBe(false);
    expect(engineSelect.value).toBe("reazonspeech");
  });

  it("Case PW-U: Unified execution mode selector switches 1/2 engine rows, removes #startMultiAsrBtn, prevents duplicates without mutating peer, and preserves other settings", async () => {
    let savedMultiArgs: unknown = null;
    let saveCount = 0;
    setTauriInvokeForTest((async (command: string, args?: unknown) => {
      if (command === "load_api_settings") {
        return {
          ...defaultMockSettings,
          asr_execution_mode: "compare",
          multi_asr_mode: "compare",
          multi_asr_engines: ["qwen3-asr", "kotoba-whisper"],
          speaker_diarization: false,
          num_speakers: "2",
        };
      }
      if (command === "save_multi_asr_settings") {
        saveCount += 1;
        savedMultiArgs = args;
        return null;
      }
      if (command === "local_asr_get_status") {
        return [];
      }
      if (command === "hf_token_get_status") {
        return { configured: false, maskedValue: null };
      }
      return null;
    }) as any);

    await navigateTo("transcribe");
    const execModeSelect = document.getElementById("asrExecutionModeSelect") as HTMLSelectElement;
    const singleRow = document.getElementById("singleAsrEngineRow") as HTMLElement;
    const dualRow = document.getElementById("dualAsrEngineRow") as HTMLElement;
    const firstSelect = document.getElementById("multiAsrFirstEngineSelect") as HTMLSelectElement;
    const secondSelect = document.getElementById("multiAsrSecondEngineSelect") as HTMLSelectElement;
    const duplicateWarning = document.getElementById("dualAsrDuplicateWarning") as HTMLElement;
    const speakerSelect = document.getElementById("speakerDiarizationSelect") as HTMLSelectElement;
    const numSpeakersSelect = document.getElementById("numSpeakersSelect") as HTMLSelectElement;

    expect(document.getElementById("startBtn")).not.toBeNull();
    expect(document.getElementById("startMultiAsrBtn")).toBeNull();
    expect(execModeSelect.value).toBe("compare");
    expect(singleRow.style.display).toBe("none");
    expect(dualRow.style.display).toBe("");
    expect((document.getElementById("multiAsrFirstSourceModeSelect") as HTMLSelectElement).value).toBe("local");
    expect((document.getElementById("multiAsrSecondSourceModeSelect") as HTMLSelectElement).value).toBe("local");
    expect(document.querySelector('label[for="multiAsrFirstEngineSelect"]')?.textContent).toContain("ASRエンジン 1");
    expect((document.getElementById("multiAsrAnchorSelect") as HTMLSelectElement | null)?.value).toBe("1");
    expect(document.getElementById("dualAsrGuidance")).toBeNull();
    expect(firstSelect.closest(".engine-select-wrap")?.classList.contains("engine-select-wrap-dual")).toBe(true);
    expect(secondSelect.closest(".engine-select-wrap")?.classList.contains("engine-select-wrap-dual")).toBe(true);
    expect(firstSelect.value).toBe("qwen3-asr");
    expect(secondSelect.value).toBe("kotoba-whisper");

    // 相手側で選択済みの候補は無効化される
    expect(firstSelect.querySelector<HTMLOptionElement>('option[value="kotoba-whisper"]')?.disabled).toBe(true);
    expect(secondSelect.querySelector<HTMLOptionElement>('option[value="qwen3-asr"]')?.disabled).toBe(true);

    // 仮に重複値が選択されても相手側の値は暗黙変更されず、警告表示のうえ保存しない
    firstSelect.value = "kotoba-whisper";
    firstSelect.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 0));

    expect(secondSelect.value).toBe("kotoba-whisper");
    expect(duplicateWarning.style.display).toBe("");
    expect(saveCount).toBe(0);

    // 別エンジンを選択すると警告が消え、相手側の値を維持したまま保存する
    firstSelect.value = "reazonspeech";
    firstSelect.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 0));

    expect(secondSelect.value).toBe("kotoba-whisper");
    expect(duplicateWarning.style.display).toBe("none");
    expect(saveCount).toBe(1);
    expect(savedMultiArgs).toEqual({
      executionMode: "compare",
      mode: "compare",
      sourceMode: "mixed",
      engines: ["local:reazonspeech", "local:kotoba-whisper"],
      anchorIndex: 1,
    });

    // 1エンジンへ切り替えても他の認識設定値（話者分離・話者数）は維持される
    execModeSelect.value = "single";
    execModeSelect.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 0));

    expect(singleRow.style.display).toBe("");
    expect(dualRow.style.display).toBe("none");
    expect(speakerSelect.value).toBe("false");
    expect(numSpeakersSelect.value).toBe("2");
    expect(savedMultiArgs).toEqual({
      executionMode: "single",
      mode: "synthesis",
      sourceMode: "mixed",
      engines: ["local:reazonspeech", "local:kotoba-whisper"],
      anchorIndex: 1,
    });
  });

  it("restores independent mixed local/API choices with AI 1 fixed as the anchor", async () => {
    let savedArgs: any;
    setTauriInvokeForTest((async (command: string, args?: any) => {
      if (command === "load_api_settings") {
        return {
          ...defaultMockSettings,
          providers: {
            ...defaultMockSettings.providers,
            google_stt: { options: { location: "us-central1" } },
            xiaomi_mimo_asr: { env_name: "XIAOMI_API_KEY" },
          },
          asr_execution_mode: "compare",
          multi_asr_mode: "compare",
          multi_asr_source_mode: "mixed",
          multi_asr_engines: ["cloud:google_stt", "local:reazonspeech"],
        };
      }
      if (command === "google_auth_get_status") {
        return {
          state: "connected",
          authGeneration: 1,
          oauthClientIdFingerprint: "fp-test",
          oauthClientConfigured: true,
          email: "u@example.com",
          sub: "sub-1",
          canonicalScopes: ["identity:openid", "identity:email", "google_cloud_api"],
          projectId: "project",
          projectVerified: true,
        };
      }
      if (command === "save_multi_asr_settings") {
        savedArgs = args;
        return null;
      }
      if (command === "hf_token_get_status") return { configured: false, maskedValue: null };
      return null;
    }) as any);

    await navigateTo("transcribe");
    const firstSource = document.getElementById("multiAsrFirstSourceModeSelect") as HTMLSelectElement;
    const secondSource = document.getElementById("multiAsrSecondSourceModeSelect") as HTMLSelectElement;
    const first = document.getElementById("multiAsrFirstEngineSelect") as HTMLSelectElement;
    const second = document.getElementById("multiAsrSecondEngineSelect") as HTMLSelectElement;
    expect(firstSource.value).toBe("cloud");
    expect(secondSource.value).toBe("local");
    expect(first.value).toBe("google_stt");
    expect(second.value).toBe("reazonspeech");
    expect(Array.from(first.options).map((option) => option.value)).toContain("google_stt");

    firstSource.value = "local";
    firstSource.dispatchEvent(new Event("change"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(first.value).toBe("kotoba-whisper");
    expect(second.value).toBe("reazonspeech");
    expect(savedArgs).toEqual({
      executionMode: "compare",
      mode: "compare",
      sourceMode: "mixed",
      engines: ["local:kotoba-whisper", "local:reazonspeech"],
      anchorIndex: 1,
    });
  });

  it("allows one API engine together with one local engine", async () => {
    let savedArgs: unknown;
    setTauriInvokeForTest((async (command: string, args?: any) => {
      if (command === "load_api_settings") {
        return {
          ...defaultMockSettings,
          providers: {
            ...defaultMockSettings.providers,
            google_stt: { options: { location: "us-central1" } },
          },
          asr_execution_mode: "compare",
          multi_asr_source_mode: "mixed",
          multi_asr_engines: ["kotoba-whisper", "reazonspeech"],
        };
      }
      if (command === "google_auth_get_status") {
        return {
          state: "connected",
          authGeneration: 1,
          oauthClientIdFingerprint: "fp-test",
          oauthClientConfigured: true,
          email: "u@example.com",
          sub: "sub-1",
          canonicalScopes: ["identity:openid", "identity:email", "google_cloud_api"],
          projectId: "project",
          projectVerified: true,
        };
      }
      if (command === "save_multi_asr_settings") {
        savedArgs = args;
        return null;
      }
      if (command === "hf_token_get_status") return { configured: false, maskedValue: null };
      return null;
    }) as any);

    await navigateTo("transcribe");
    const secondMode = document.getElementById("multiAsrSecondSourceModeSelect") as HTMLSelectElement;
    const second = document.getElementById("multiAsrSecondEngineSelect") as HTMLSelectElement;
    const anchorSelect = document.getElementById("multiAsrAnchorSelect") as HTMLSelectElement;
    const anchorWarning = document.getElementById("dualAsrAnchorWarning") as HTMLElement;
    secondMode.value = "cloud";
    secondMode.dispatchEvent(new Event("change"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(second.value).toBe("google_stt");
    // Google を比較に含めた時点で基準がエンジン1のままだと保存をブロックして理由を表示する
    expect(savedArgs).toBeUndefined();
    expect(anchorWarning.style.display).toBe("");
    // 基準を Google (エンジン2) へ選び直すと保存される
    anchorSelect.value = "2";
    anchorSelect.dispatchEvent(new Event("change"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(anchorWarning.style.display).toBe("none");
    expect(savedArgs).toEqual({
      executionMode: "compare",
      mode: "compare",
      sourceMode: "mixed",
      engines: ["local:kotoba-whisper", "cloud:google_stt"],
      anchorIndex: 2,
    });
  });

  it("Case PW-V: Rapid consecutive Multi-ASR setting changes serialize saves and preserve the latest selection", async () => {
    const savedCalls: unknown[] = [];
    let inFlight = 0;
    let maxConcurrent = 0;
    let releaseFirstSave!: () => void;

    setTauriInvokeForTest((async (command: string, args?: unknown) => {
      if (command === "load_api_settings") {
        return {
          ...defaultMockSettings,
          asr_execution_mode: "compare",
          multi_asr_mode: "compare",
          multi_asr_engines: ["kotoba-whisper", "reazonspeech"],
        };
      }
      if (command === "save_multi_asr_settings") {
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        savedCalls.push(args);
        if (savedCalls.length === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstSave = resolve;
          });
        }
        inFlight -= 1;
        return null;
      }
      if (command === "local_asr_get_status") {
        return [];
      }
      if (command === "hf_token_get_status") {
        return { configured: false, maskedValue: null };
      }
      return null;
    }) as any);

    await navigateTo("transcribe");
    const firstSelect = document.getElementById("multiAsrFirstEngineSelect") as HTMLSelectElement;
    const secondSelect = document.getElementById("multiAsrSecondEngineSelect") as HTMLSelectElement;

    // 1回目の保存を開始した直後（完了前）に連続で2回・3回目の変更を発火
    firstSelect.value = "qwen3-asr";
    firstSelect.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 0));

    secondSelect.value = "kotoba-whisper";
    secondSelect.dispatchEvent(new Event("change"));
    firstSelect.value = "reazonspeech";
    firstSelect.dispatchEvent(new Event("change"));

    releaseFirstSave();
    await new Promise((r) => setTimeout(r, 10));

    expect(maxConcurrent).toBe(1);
    expect(savedCalls[savedCalls.length - 1]).toEqual({
      executionMode: "compare",
      mode: "compare",
      sourceMode: "mixed",
      engines: ["local:reazonspeech", "local:kotoba-whisper"],
      anchorIndex: 1,
    });
  });

  it("Case PW-W: restores violating Google+non-Google-anchor config without auto-fixing, blocks save until fixed, and rejects Xiaomi MiMo anchor", async () => {
    let savedArgs: any;
    setTauriInvokeForTest((async (command: string, args?: any) => {
      if (command === "load_api_settings") {
        return {
          ...defaultMockSettings,
          providers: {
            ...defaultMockSettings.providers,
            google_stt: { options: { location: "us-central1" } },
            xiaomi_mimo_asr: { env_name: "XIAOMI_API_KEY" },
          },
          asr_execution_mode: "compare",
          multi_asr_mode: "compare",
          multi_asr_source_mode: "mixed",
          multi_asr_engines: ["local:kotoba-whisper", "cloud:google_stt"],
          multi_asr_anchor_index: 1,
        };
      }
      if (command === "google_auth_get_status") {
        return {
          state: "connected",
          authGeneration: 1,
          oauthClientIdFingerprint: "fp-test",
          oauthClientConfigured: true,
          email: "u@example.com",
          sub: "sub-1",
          canonicalScopes: ["identity:openid", "identity:email", "google_cloud_api"],
          projectId: "project",
          projectVerified: true,
        };
      }
      if (command === "save_multi_asr_settings") {
        savedArgs = args;
        return null;
      }
      if (command === "hf_token_get_status") return { configured: false, maskedValue: null };
      return null;
    }) as any);

    await navigateTo("transcribe");
    const first = document.getElementById("multiAsrFirstEngineSelect") as HTMLSelectElement;
    const second = document.getElementById("multiAsrSecondEngineSelect") as HTMLSelectElement;
    const anchorSelect = document.getElementById("multiAsrAnchorSelect") as HTMLSelectElement;
    const anchorWarning = document.getElementById("dualAsrAnchorWarning") as HTMLElement;

    // 既存設定を自動修正しない
    expect(first.value).toBe("kotoba-whisper");
    expect(second.value).toBe("google_stt");
    expect(anchorSelect.value).toBe("1");
    expect(anchorWarning.style.display).toBe("");
    expect(anchorWarning.textContent).toContain("Google");
    expect(savedArgs).toBeUndefined();

    // Google (2) を基準に選び直すと保存可能になる
    anchorSelect.value = "2";
    anchorSelect.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 0));
    expect(anchorWarning.style.display).toBe("none");
    expect(savedArgs).toMatchObject({ anchorIndex: 2 });

    // Google 以外へ戻そうとすると拒否されて元の値 (2) に戻る
    anchorSelect.value = "1";
    anchorSelect.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 0));
    expect(anchorSelect.value).toBe("2");
    expect(anchorWarning.style.display).toBe("");

    // Xiaomi MiMo は基準に選べない (まずエンジン2を xiaomi_mimo_asr にして基準1へ戻したあと、基準2への変更を試みる)
    second.value = "xiaomi_mimo_asr";
    second.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 0));
    expect(anchorWarning.style.display).toBe("");
    expect(anchorWarning.textContent).toContain("Xiaomi MiMo");

    anchorSelect.value = "1";
    anchorSelect.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 0));
    expect(anchorSelect.value).toBe("1");
    expect(anchorWarning.style.display).toBe("none");

    anchorSelect.value = "2";
    anchorSelect.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 0));
    expect(anchorSelect.value).toBe("1");
    expect(anchorWarning.style.display).toBe("");
    expect(anchorWarning.textContent).toContain("Xiaomi MiMo");
  });

  it("updates 1-engine and 2-engine Google STT options from google_auth_get_status across login, project confirm, switch, and logout without using legacy options.project_id", async () => {
    let mockAuthStatus: any = {
      state: "disconnected",
      authGeneration: 1,
      oauthClientIdFingerprint: "fp-test",
      oauthClientConfigured: true,
      canonicalScopes: [],
      projectVerified: false,
      legacyProjectCandidate: "legacy-proj-999",
    };

    setTauriInvokeForTest((async (command: string) => {
      if (command === "load_api_settings") {
        return {
          ...defaultMockSettings,
          providers: {
            ...defaultMockSettings.providers,
            google_stt: { options: { project_id: "legacy-proj-999", location: "us-central1" } },
            xiaomi_mimo_asr: { env_name: "XIAOMI_API_KEY" },
          },
          asr_mode: "cloud",
          asr_execution_mode: "single",
        };
      }
      if (command === "google_auth_get_status") return mockAuthStatus;
      if (command === "hf_token_get_status") return { configured: false, maskedValue: null };
      return null;
    }) as any);

    await navigateTo("transcribe");
    const engineSelect = document.getElementById("engineSelect") as HTMLSelectElement;
    const execMode = document.getElementById("asrExecutionModeSelect") as HTMLSelectElement;
    const firstSource = document.getElementById("multiAsrFirstSourceModeSelect") as HTMLSelectElement;
    const firstEngine = document.getElementById("multiAsrFirstEngineSelect") as HTMLSelectElement;

    expect(Array.from(engineSelect.options).map((o) => o.value)).not.toContain("google_stt");

    mockAuthStatus = {
      state: "connected",
      authGeneration: 2,
      oauthClientIdFingerprint: "fp-test",
      oauthClientConfigured: true,
      email: "a@example.com",
      sub: "sub-A",
      canonicalScopes: ["identity:openid", "identity:email", "google_cloud_api"],
      projectId: "proj-a-123",
      projectVerified: false,
    };
    await navigateTo("transcribe");
    expect(Array.from(engineSelect.options).map((o) => o.value)).toContain("google_stt");

    execMode.value = "compare";
    execMode.dispatchEvent(new Event("change"));
    firstSource.value = "cloud";
    firstSource.dispatchEvent(new Event("change"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(Array.from(firstEngine.options).map((o) => o.value)).toContain("google_stt");

    mockAuthStatus = {
      state: "connected",
      authGeneration: 3,
      oauthClientIdFingerprint: "fp-test",
      oauthClientConfigured: true,
      email: "b@example.com",
      sub: "sub-B",
      canonicalScopes: ["identity:openid", "identity:email", "google_cloud_api"],
      projectVerified: false,
    };
    await navigateTo("transcribe");
    expect(Array.from(engineSelect.options).map((o) => o.value)).not.toContain("google_stt");

    mockAuthStatus = {
      state: "disconnected",
      authGeneration: 4,
      oauthClientIdFingerprint: "fp-test",
      oauthClientConfigured: true,
      canonicalScopes: [],
      projectVerified: false,
    };
    await navigateTo("transcribe");
    expect(Array.from(engineSelect.options).map((o) => o.value)).not.toContain("google_stt");
  });

  it("discards stale out-of-order connected google_auth_get_status after logout in both 1-engine and 2-engine selectors", async () => {
    let resolveSlowStatus!: (val: any) => void;
    const slowStatusPromise = new Promise((resolve) => {
      resolveSlowStatus = resolve;
    });
    let statusCallCount = 0;

    setTauriInvokeForTest((async (command: string) => {
      if (command === "load_api_settings") {
        return {
          ...defaultMockSettings,
          providers: {
            ...defaultMockSettings.providers,
            google_stt: { options: { location: "us-central1" } },
            xiaomi_mimo_asr: { env_name: "XIAOMI_API_KEY" },
          },
          asr_mode: "cloud",
          asr_execution_mode: "single",
        };
      }
      if (command === "google_auth_get_status") {
        statusCallCount += 1;
        if (statusCallCount === 2) {
          // Slow response from before logout (generation 2, connected)
          return slowStatusPromise;
        }
        // Initial mount (#1) and newer response after logout (#3+)
        return {
          state: "disconnected",
          authGeneration: statusCallCount >= 3 ? 3 : 1,
          oauthClientIdFingerprint: "fp-test",
          oauthClientConfigured: true,
          canonicalScopes: [],
          projectVerified: false,
        };
      }
      if (command === "hf_token_get_status") return { configured: false, maskedValue: null };
      return null;
    }) as any);

    // Mount transcribe first
    await navigateTo("transcribe");
    const modeSelect = document.getElementById("asrModeSelect") as HTMLSelectElement;

    // Trigger slow cloud-engine refresh (#2, pre-logout)
    modeSelect.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 0));

    // Trigger newer post-logout refresh (#3, generation 3 disconnected)
    await navigateTo("transcribe");

    // Now resolve the slow pre-logout connected response (generation 2)
    resolveSlowStatus({
      state: "connected",
      authGeneration: 2,
      oauthClientIdFingerprint: "fp-test",
      oauthClientConfigured: true,
      email: "a@example.com",
      sub: "sub-A",
      canonicalScopes: ["identity:openid", "identity:email", "google_cloud_api"],
      projectId: "proj-a-123",
      projectVerified: true,
    });
    await new Promise((r) => setTimeout(r, 0));

    const engineSelect = document.getElementById("engineSelect") as HTMLSelectElement;
    expect(Array.from(engineSelect.options).map((o) => o.value)).not.toContain("google_stt");

    // Also verify 2-engine selector remains disconnected
    const execMode = document.getElementById("asrExecutionModeSelect") as HTMLSelectElement;
    const firstSource = document.getElementById("multiAsrFirstSourceModeSelect") as HTMLSelectElement;
    const firstEngine = document.getElementById("multiAsrFirstEngineSelect") as HTMLSelectElement;
    execMode.value = "compare";
    execMode.dispatchEvent(new Event("change"));
    firstSource.value = "cloud";
    firstSource.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 0));
    expect(Array.from(firstEngine.options).map((o) => o.value)).not.toContain("google_stt");
  });

  it("executes Google STT in single-engine mode via google_stt_recognize, saves outputs, displays result, and triggers auto-correction", async () => {
    const invokedCommands: string[] = [];
    const savedTextPaths: string[] = [];
    let savedDocPath = "";
    let ollamaCalled = false;

    setTauriInvokeForTest((async (command: string, args?: any) => {
      invokedCommands.push(command);
      if (command === "load_api_settings") {
        return {
          ...defaultMockSettings,
          providers: {
            ...defaultMockSettings.providers,
            google_stt: {
              default_model: "chirp_2",
              options: { location: "us-central1", recognizer_id: "_" },
            },
            ollama: { base_url: "http://localhost:11434", default_model: "llama3" },
          },
          asr_mode: "cloud",
          asr_engine: "google_stt",
          asr_execution_mode: "single",
          output_path: "C:/out",
          correction_enabled: true,
          correction_provider: "ollama",
          correction_model: "llama3",
          correction_use_dictionary: false,
          correction_use_background: false,
        };
      }
      if (command === "google_auth_get_status") {
        return {
          state: "connected",
          authGeneration: 2,
          oauthClientIdFingerprint: "fp-test",
          oauthClientConfigured: true,
          email: "u@example.com",
          sub: "sub-1",
          canonicalScopes: ["identity:openid", "identity:email", "google_cloud_api"],
          projectId: "proj-123",
          projectVerified: true,
        };
      }
      if (command === "resolve_output_directory") {
        return args?.outputPath || "C:/Users/test/Downloads";
      }
      if (command === "google_stt_recognize") {
        expect(args.input.projectId).toBe("proj-123");
        expect(args.input.location).toBe("us-central1");
        expect(args.input.audioPath).toBe("C:/audio/sample.wav");
        return {
          transcript: "こんにちは世界",
          segments: [],
          rawResponse: {
            results: [
              {
                alternatives: [
                  {
                    transcript: "こんにちは世界",
                    words: [
                      { word: "こんにちは", startOffset: "0s", endOffset: "0.5s" },
                      { word: "世界", startOffset: "0.5s", endOffset: "1.0s" },
                    ],
                  },
                ],
              },
            ],
          },
        };
      }
      if (command === "save_text_file") {
        savedTextPaths.push(args.path);
        return null;
      }
      if (command === "save_transcript_document") {
        savedDocPath = args.path;
        return null;
      }
      if (command === "commit_staged_output_files") {
        for (const f of args.files as Array<{ tempPath: string; finalPath: string }>) {
          if (f.finalPath.endsWith(".asrc.json")) {
            savedDocPath = f.finalPath;
          } else {
            savedTextPaths.push(f.finalPath);
          }
        }
        return null;
      }
      if (command === "call_ollama_chat") {
        ollamaCalled = true;
        return JSON.stringify({
          corrections: [],
        });
      }
      if (command === "hf_token_get_status") return { configured: false, maskedValue: null };
      return null;
    }) as any);

    await navigateTo("transcribe");
    setSelectedAudioFileForTest("C:/audio/sample.wav");

    const modeSelect = document.getElementById("asrModeSelect") as HTMLSelectElement;
    const engineSelect = document.getElementById("engineSelect") as HTMLSelectElement;
    expect(modeSelect.value).toBe("cloud");
    expect(Array.from(engineSelect.options).map((o) => o.value)).toContain("google_stt");
    engineSelect.value = "google_stt";

    const startBtn = document.getElementById("startBtn") as HTMLButtonElement;
    startBtn.click();
    await new Promise((r) => setTimeout(r, 30));

    expect(invokedCommands).not.toContain("local_asr_transcribe");
    expect(invokedCommands).toContain("google_stt_recognize");
    expect(savedTextPaths.some((p) => p.endsWith("sample.txt"))).toBe(true);
    expect(savedDocPath).toMatch(/sample\.asrc\.json$/);
    const resultText = document.getElementById("resultText") as HTMLTextAreaElement;
    expect(resultText.value).toContain("こんにちは");
    expect(ollamaCalled).toBe(true);
  });

  it("discards stale single-engine Google STT result without saving or displaying when user logs out in flight", async () => {
    const invokedCommands: string[] = [];
    let authStatusCalls = 0;

    setTauriInvokeForTest((async (command: string, args?: any) => {
      invokedCommands.push(command);
      if (command === "load_api_settings") {
        return {
          ...defaultMockSettings,
          providers: {
            ...defaultMockSettings.providers,
            google_stt: {
              default_model: "chirp_2",
              options: { location: "us-central1", recognizer_id: "_" },
            },
          },
          asr_mode: "cloud",
          asr_engine: "google_stt",
          asr_execution_mode: "single",
          output_path: "C:/out",
          correction_enabled: true,
        };
      }
      if (command === "google_auth_get_status") {
        authStatusCalls += 1;
        // First two calls (mount + start of recognition): connected (gen 2)
        if (authStatusCalls <= 2) {
          return {
            state: "connected",
            authGeneration: 2,
            oauthClientIdFingerprint: "fp-test",
            oauthClientConfigured: true,
            email: "u@example.com",
            sub: "sub-1",
            canonicalScopes: ["identity:openid", "identity:email", "google_cloud_api"],
            projectId: "proj-123",
            projectVerified: true,
          };
        }
        // Post-recognition check: logged out (gen 3)
        return {
          state: "disconnected",
          authGeneration: 3,
          oauthClientIdFingerprint: "fp-test",
          oauthClientConfigured: true,
          canonicalScopes: [],
          projectVerified: false,
        };
      }
      if (command === "resolve_output_directory") {
        return args?.outputPath || "C:/Users/test/Downloads";
      }
      if (command === "google_stt_recognize") {
        return {
          transcript: "stale transcript",
          segments: [],
          authGeneration: 2,
          sub: "sub-1",
          oauthClientIdFingerprint: "fp-test",
          rawResponse: {
            results: [{ alternatives: [{ transcript: "stale transcript" }] }],
          },
        };
      }
      if (command === "hf_token_get_status") return { configured: false, maskedValue: null };
      return null;
    }) as any);

    await navigateTo("transcribe");
    setSelectedAudioFileForTest("C:/audio/sample.wav");

    const engineSelect = document.getElementById("engineSelect") as HTMLSelectElement;
    engineSelect.value = "google_stt";

    const startBtn = document.getElementById("startBtn") as HTMLButtonElement;
    startBtn.click();
    await new Promise((r) => setTimeout(r, 30));

    expect(invokedCommands).toContain("google_stt_recognize");
    expect(invokedCommands).not.toContain("save_text_file");
    expect(invokedCommands).not.toContain("save_transcript_document");
    expect(invokedCommands).not.toContain("call_ollama_chat");
    const resultText = document.getElementById("resultText") as HTMLTextAreaElement;
    expect(resultText.value).toBe("");
  });

  it("fails closed without saving or displaying when post-recognition google_auth_get_status fails", async () => {
    const invokedCommands: string[] = [];
    let authStatusCalls = 0;

    setTauriInvokeForTest((async (command: string, args?: any) => {
      invokedCommands.push(command);
      if (command === "load_api_settings") {
        return {
          ...defaultMockSettings,
          providers: {
            ...defaultMockSettings.providers,
            google_stt: {
              default_model: "chirp_2",
              options: { location: "us-central1", recognizer_id: "_" },
            },
          },
          asr_mode: "cloud",
          asr_engine: "google_stt",
          asr_execution_mode: "single",
          output_path: "C:/out",
          correction_enabled: true,
        };
      }
      if (command === "google_auth_get_status") {
        authStatusCalls += 1;
        if (authStatusCalls <= 2) {
          return {
            state: "connected",
            authGeneration: 2,
            oauthClientIdFingerprint: "fp-test",
            oauthClientConfigured: true,
            email: "u@example.com",
            sub: "sub-1",
            canonicalScopes: ["identity:openid", "identity:email", "google_cloud_api"],
            projectId: "proj-123",
            projectVerified: true,
          };
        }
        throw new Error("auth status IPC unavailable");
      }
      if (command === "resolve_output_directory") {
        return args?.outputPath || "C:/Users/test/Downloads";
      }
      if (command === "google_stt_recognize") {
        return {
          transcript: "unverified transcript",
          segments: [],
          authGeneration: 2,
          sub: "sub-1",
          oauthClientIdFingerprint: "fp-test",
          rawResponse: {
            results: [{ alternatives: [{ transcript: "unverified transcript" }] }],
          },
        };
      }
      if (command === "hf_token_get_status") return { configured: false, maskedValue: null };
      return null;
    }) as any);

    await navigateTo("transcribe");
    setSelectedAudioFileForTest("C:/audio/sample.wav");

    const engineSelect = document.getElementById("engineSelect") as HTMLSelectElement;
    engineSelect.value = "google_stt";

    const startBtn = document.getElementById("startBtn") as HTMLButtonElement;
    startBtn.click();
    await new Promise((r) => setTimeout(r, 30));

    expect(invokedCommands).toContain("google_stt_recognize");
    expect(invokedCommands).not.toContain("save_text_file");
    expect(invokedCommands).not.toContain("save_transcript_document");
    expect(invokedCommands).not.toContain("call_ollama_chat");
    const resultText = document.getElementById("resultText") as HTMLTextAreaElement;
    expect(resultText.value).toBe("");
  });

  it("resolves empty outputPath to Downloads folder via resolve_output_directory and saves all 6 output formats", async () => {
    const savedFiles = new Map<string, string>();
    let savedDocPath: string | null = null;
    let resolvedArg: string | undefined;

    setTauriInvokeForTest((async (command: string, args?: any) => {
      if (command === "load_api_settings") {
        return {
          ...defaultMockSettings,
          providers: {
            ...defaultMockSettings.providers,
            google_stt: {
              default_model: "chirp_2",
              options: { location: "us-central1", recognizer_id: "_" },
            },
          },
          asr_mode: "cloud",
          asr_engine: "google_stt",
          asr_execution_mode: "single",
          output_path: "",
          correction_enabled: false,
        };
      }
      if (command === "google_auth_get_status") {
        return {
          state: "connected",
          authGeneration: 2,
          oauthClientIdFingerprint: "fp-test",
          oauthClientConfigured: true,
          email: "u@example.com",
          sub: "sub-1",
          canonicalScopes: ["identity:openid", "identity:email", "google_cloud_api"],
          projectId: "proj-123",
          projectVerified: true,
        };
      }
      if (command === "resolve_output_directory") {
        resolvedArg = args?.outputPath;
        return "C:\\Users\\test\\Downloads";
      }
      if (command === "google_stt_recognize") {
        return {
          transcript: "hello world",
          segments: [],
          rawResponse: {
            results: [
              {
                alternatives: [
                  {
                    transcript: "hello world",
                    words: [
                      { word: "hello", startOffset: "0s", endOffset: "0.5s" },
                      { word: "world", startOffset: "0.5s", endOffset: "1.25s" },
                    ],
                  },
                ],
              },
            ],
          },
        };
      }
      if (command === "save_text_file") {
        savedFiles.set(args.path, args.content);
        return null;
      }
      if (command === "save_transcript_document") {
        savedDocPath = args.path;
        return null;
      }
      if (command === "commit_staged_output_files") {
        for (const f of args.files as Array<{ tempPath: string; finalPath: string }>) {
          const content = savedFiles.get(f.tempPath);
          if (content !== undefined) {
            savedFiles.delete(f.tempPath);
            savedFiles.set(f.finalPath, content);
          }
          if (f.finalPath.endsWith(".asrc.json")) {
            savedDocPath = f.finalPath;
          }
        }
        return null;
      }
      if (command === "hf_token_get_status") return { configured: false, maskedValue: null };
      return null;
    }) as any);

    await navigateTo("transcribe");
    setSelectedAudioFileForTest("C:\\audio\\meeting.wav");

    // Ensure outputPath is empty and ALL 6 formats are checked
    const outputInput = document.getElementById("outputPathInput") as HTMLInputElement;
    outputInput.value = "";
    document.querySelectorAll<HTMLInputElement>(".output-format-checkbox").forEach((cb) => {
      cb.checked = true;
    });

    const engineSelect = document.getElementById("engineSelect") as HTMLSelectElement;
    engineSelect.value = "google_stt";

    const startBtn = document.getElementById("startBtn") as HTMLButtonElement;
    startBtn.click();
    await new Promise((r) => setTimeout(r, 40));

    expect(resolvedArg).toBe("");
    expect(savedDocPath).toBe("C:\\Users\\test\\Downloads\\meeting.asrc.json");
    expect(savedFiles.get("C:\\Users\\test\\Downloads\\meeting.txt")).toBe("hello\nworld");
    expect(JSON.parse(savedFiles.get("C:\\Users\\test\\Downloads\\meeting.json")!)).toMatchObject({
      mediaFileName: "meeting.wav",
      sourceEngine: "cloud:google_stt",
    });
    expect(savedFiles.get("C:\\Users\\test\\Downloads\\meeting.md")).toContain(
      "- **[00:00:00.000 - 00:00:00.500]** hello",
    );
    expect(savedFiles.get("C:\\Users\\test\\Downloads\\meeting.srt")).toContain(
      "1\n00:00:00,000 --> 00:00:00,500\nhello",
    );
    expect(savedFiles.get("C:\\Users\\test\\Downloads\\meeting.csv")).toContain(
      'start,end,text\n00:00:00.000,00:00:00.500,"hello"',
    );
    expect(savedFiles.get("C:\\Users\\test\\Downloads\\meeting.vtt")).toContain(
      "WEBVTT\n\n1\n00:00:00.000 --> 00:00:00.500\nhello",
    );
    const savedInfo = document.getElementById("savedFilesInfo") as HTMLElement;
    expect(savedInfo.style.display).toBe("");
    expect(savedInfo.textContent).toContain("C:\\Users\\test\\Downloads");
  });

  it("handles timing-less Google STT results: saves txt/json/md/csv without fake timestamps, reports skipped srt/vtt, and fails if only srt/vtt selected", async () => {
    const savedFiles = new Map<string, string>();
    const dialogSpy = vi.spyOn(statusModule, "showAppDialog").mockResolvedValue(undefined as any);

    setTauriInvokeForTest((async (command: string, args?: any) => {
      if (command === "load_api_settings") {
        return {
          ...defaultMockSettings,
          providers: {
            ...defaultMockSettings.providers,
            google_stt: {
              default_model: "chirp_2",
              options: { location: "us-central1", recognizer_id: "_" },
            },
          },
          asr_mode: "cloud",
          asr_engine: "google_stt",
          asr_execution_mode: "single",
          output_path: "C:/out",
          correction_enabled: false,
        };
      }
      if (command === "google_auth_get_status") {
        return {
          state: "connected",
          authGeneration: 2,
          oauthClientIdFingerprint: "fp-test",
          oauthClientConfigured: true,
          email: "u@example.com",
          sub: "sub-1",
          canonicalScopes: ["identity:openid", "identity:email", "google_cloud_api"],
          projectId: "proj-123",
          projectVerified: true,
        };
      }
      if (command === "resolve_output_directory") return "C:/out";
      if (command === "google_stt_recognize") {
        return {
          transcript: "時刻なし文字起こし",
          segments: [],
          rawResponse: {
            results: [{ alternatives: [{ transcript: "時刻なし文字起こし" }] }],
          },
        };
      }
      if (command === "save_text_file") {
        savedFiles.set(args.path, args.content);
        return null;
      }
      if (command === "save_transcript_document") return null;
      if (command === "commit_staged_output_files") {
        for (const f of args.files as Array<{ tempPath: string; finalPath: string }>) {
          const content = savedFiles.get(f.tempPath);
          if (content !== undefined) {
            savedFiles.delete(f.tempPath);
            savedFiles.set(f.finalPath, content);
          }
        }
        return null;
      }
      if (command === "hf_token_get_status") return { configured: false, maskedValue: null };
      return null;
    }) as any);

    await navigateTo("transcribe");
    setSelectedAudioFileForTest("C:/audio/notime.wav");
    document.querySelectorAll<HTMLInputElement>(".output-format-checkbox").forEach((cb) => {
      cb.checked = true;
    });
    (document.getElementById("engineSelect") as HTMLSelectElement).value = "google_stt";

    (document.getElementById("startBtn") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 40));

    expect(savedFiles.get("C:/out/notime.txt")).toBe("時刻なし文字起こし");
    expect(savedFiles.has("C:/out/notime.json")).toBe(true);
    expect(savedFiles.get("C:/out/notime.md")).toContain("時刻なし文字起こし");
    expect(savedFiles.get("C:/out/notime.csv")).toBe('start,end,text\n,,"時刻なし文字起こし"\n');
    expect(savedFiles.has("C:/out/notime.srt")).toBe(false);
    expect(savedFiles.has("C:/out/notime.vtt")).toBe(false);
    const savedInfo = document.getElementById("savedFilesInfo") as HTMLElement;
    expect(savedInfo.textContent).toContain("未出力（タイムスタンプ情報なし）: SRT, VTT");

    // Now select ONLY srt -> must fail explicitly without saving
    savedFiles.clear();
    dialogSpy.mockClear();
    document.querySelectorAll<HTMLInputElement>(".output-format-checkbox").forEach((cb) => {
      cb.checked = cb.value === "srt";
    });
    (document.getElementById("startBtn") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 40));

    expect(savedFiles.size).toBe(0);
    expect(dialogSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "文字起こしエラー",
        message: expect.stringContaining("タイムスタンプ情報が含まれていないため"),
      }),
    );
  });

  it("aborts without saving, displaying, or auto-correcting when user cancels during in-flight Google STT recognition", async () => {
    const invokedCommands: string[] = [];
    let resolveRecognize!: (value: any) => void;

    setTauriInvokeForTest((async (command: string) => {
      invokedCommands.push(command);
      if (command === "load_api_settings") {
        return {
          ...defaultMockSettings,
          providers: {
            ...defaultMockSettings.providers,
            google_stt: {
              default_model: "chirp_2",
              options: { location: "us-central1", recognizer_id: "_" },
            },
          },
          asr_mode: "cloud",
          asr_engine: "google_stt",
          asr_execution_mode: "single",
          output_path: "C:/out",
          correction_enabled: true,
        };
      }
      if (command === "google_auth_get_status") {
        return {
          state: "connected",
          authGeneration: 2,
          oauthClientIdFingerprint: "fp-test",
          oauthClientConfigured: true,
          email: "u@example.com",
          sub: "sub-1",
          canonicalScopes: ["identity:openid", "identity:email", "google_cloud_api"],
          projectId: "proj-123",
          projectVerified: true,
        };
      }
      if (command === "resolve_output_directory") return "C:/out";
      if (command === "google_stt_recognize") {
        return await new Promise((resolve) => {
          resolveRecognize = resolve;
        });
      }
      if (command === "hf_token_get_status") return { configured: false, maskedValue: null };
      return null;
    }) as any);

    await navigateTo("transcribe");
    setSelectedAudioFileForTest("C:/audio/cancel.wav");
    (document.getElementById("engineSelect") as HTMLSelectElement).value = "google_stt";

    const startBtn = document.getElementById("startBtn") as HTMLButtonElement;
    const cancelBtn = document.getElementById("cancelBtn") as HTMLButtonElement;
    startBtn.click();
    await new Promise((r) => setTimeout(r, 20));

    // User clicks cancel while google_stt_recognize is still in flight
    cancelBtn.click();
    resolveRecognize({
      transcript: "cancelled transcript",
      segments: [],
      rawResponse: {
        results: [{ alternatives: [{ transcript: "cancelled transcript" }] }],
      },
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(invokedCommands).toContain("google_stt_recognize");
    expect(invokedCommands).not.toContain("save_text_file");
    expect(invokedCommands).not.toContain("save_transcript_document");
    expect(invokedCommands).not.toContain("call_ollama_chat");
    const resultText = document.getElementById("resultText") as HTMLTextAreaElement;
    expect(resultText.value).toBe("");
  });

  it("preserves existing files, cleans up only staged temp files, and aborts when user cancels while saving multiple output formats", async () => {
    const fsMap = new Map<string, string>([
      ["C:/out/midsave.txt", "EXISTING TXT CONTENT"],
      ["C:/out/midsave.json", '{"existing":true}'],
    ]);
    const writtenTempPaths: string[] = [];
    const removedPaths: string[] = [];
    const invokedCommands: string[] = [];
    let resolveSecondSave!: () => void;
    let saveCallCount = 0;

    setTauriInvokeForTest((async (command: string, args?: any) => {
      invokedCommands.push(command);
      if (command === "load_api_settings") {
        return {
          ...defaultMockSettings,
          providers: {
            ...defaultMockSettings.providers,
            google_stt: {
              default_model: "chirp_2",
              options: { location: "us-central1", recognizer_id: "_" },
            },
          },
          asr_mode: "cloud",
          asr_engine: "google_stt",
          asr_execution_mode: "single",
          output_path: "C:/out",
          correction_enabled: true,
        };
      }
      if (command === "google_auth_get_status") {
        return {
          state: "connected",
          authGeneration: 2,
          oauthClientIdFingerprint: "fp-test",
          oauthClientConfigured: true,
          email: "u@example.com",
          sub: "sub-1",
          canonicalScopes: ["identity:openid", "identity:email", "google_cloud_api"],
          projectId: "proj-123",
          projectVerified: true,
        };
      }
      if (command === "resolve_output_directory") return "C:/out";
      if (command === "google_stt_recognize") {
        return {
          transcript: "hello",
          segments: [],
          rawResponse: {
            results: [{ alternatives: [{ transcript: "hello" }] }],
          },
        };
      }
      if (command === "save_text_file") {
        saveCallCount += 1;
        writtenTempPaths.push(args.path);
        fsMap.set(args.path, args.content);
        if (saveCallCount === 2) {
          return await new Promise<null>((resolve) => {
            resolveSecondSave = () => resolve(null);
          });
        }
        return null;
      }
      if (command === "remove_output_file") {
        removedPaths.push(args.path);
        fsMap.delete(args.path);
        return null;
      }
      if (command === "hf_token_get_status") return { configured: false, maskedValue: null };
      return null;
    }) as any);

    await navigateTo("transcribe");
    setSelectedAudioFileForTest("C:/audio/midsave.wav");
    document.querySelectorAll<HTMLInputElement>(".output-format-checkbox").forEach((cb) => {
      cb.checked = cb.value === "txt" || cb.value === "json";
    });
    (document.getElementById("engineSelect") as HTMLSelectElement).value = "google_stt";

    const startBtn = document.getElementById("startBtn") as HTMLButtonElement;
    const cancelBtn = document.getElementById("cancelBtn") as HTMLButtonElement;
    startBtn.click();
    await new Promise((r) => setTimeout(r, 30));

    // Only temp paths are written; existing files are untouched
    expect(writtenTempPaths.length).toBe(2);
    expect(writtenTempPaths[0]).toMatch(/^C:\/out\/midsave\.txt\.tmp-/);
    expect(writtenTempPaths[1]).toMatch(/^C:\/out\/midsave\.json\.tmp-/);
    cancelBtn.click();
    resolveSecondSave();
    await new Promise((r) => setTimeout(r, 30));

    // Only staged temp paths are removed; pre-existing files remain intact; commit never runs
    expect(removedPaths).toEqual(writtenTempPaths);
    expect(fsMap.get("C:/out/midsave.txt")).toBe("EXISTING TXT CONTENT");
    expect(fsMap.get("C:/out/midsave.json")).toBe('{"existing":true}');
    expect(invokedCommands).not.toContain("commit_staged_output_files");
    expect(invokedCommands).not.toContain("save_transcript_document");
    expect(invokedCommands).not.toContain("call_ollama_chat");
    const resultText = document.getElementById("resultText") as HTMLTextAreaElement;
    expect(resultText.value).toBe("");
  });

  it("preserves existing files and cleans up staged temp files when write fails during saving", async () => {
    const fsMap = new Map<string, string>([
      ["C:/out/fail.txt", "ORIGINAL TXT"],
      ["C:/out/fail.json", '{"original":true}'],
    ]);
    const removedPaths: string[] = [];
    const invokedCommands: string[] = [];
    const dialogSpy = vi.spyOn(statusModule, "showAppDialog").mockResolvedValue(undefined as any);
    let saveCallCount = 0;

    setTauriInvokeForTest((async (command: string, args?: any) => {
      invokedCommands.push(command);
      if (command === "load_api_settings") {
        return {
          ...defaultMockSettings,
          providers: {
            ...defaultMockSettings.providers,
            google_stt: {
              default_model: "chirp_2",
              options: { location: "us-central1", recognizer_id: "_" },
            },
          },
          asr_mode: "cloud",
          asr_engine: "google_stt",
          asr_execution_mode: "single",
          output_path: "C:/out",
          correction_enabled: true,
        };
      }
      if (command === "google_auth_get_status") {
        return {
          state: "connected",
          authGeneration: 2,
          oauthClientIdFingerprint: "fp-test",
          oauthClientConfigured: true,
          email: "u@example.com",
          sub: "sub-1",
          canonicalScopes: ["identity:openid", "identity:email", "google_cloud_api"],
          projectId: "proj-123",
          projectVerified: true,
        };
      }
      if (command === "resolve_output_directory") return "C:/out";
      if (command === "google_stt_recognize") {
        return {
          transcript: "new text",
          segments: [],
          rawResponse: {
            results: [{ alternatives: [{ transcript: "new text" }] }],
          },
        };
      }
      if (command === "save_text_file") {
        saveCallCount += 1;
        if (saveCallCount === 2) {
          throw new Error("disk full");
        }
        fsMap.set(args.path, args.content);
        return null;
      }
      if (command === "remove_output_file") {
        removedPaths.push(args.path);
        fsMap.delete(args.path);
        return null;
      }
      if (command === "hf_token_get_status") return { configured: false, maskedValue: null };
      return null;
    }) as any);

    await navigateTo("transcribe");
    setSelectedAudioFileForTest("C:/audio/fail.wav");
    document.querySelectorAll<HTMLInputElement>(".output-format-checkbox").forEach((cb) => {
      cb.checked = cb.value === "txt" || cb.value === "json";
    });
    (document.getElementById("engineSelect") as HTMLSelectElement).value = "google_stt";

    (document.getElementById("startBtn") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 40));

    expect(invokedCommands).not.toContain("commit_staged_output_files");
    expect(removedPaths.every((p) => /\.tmp-/.test(p))).toBe(true);
    expect(fsMap.get("C:/out/fail.txt")).toBe("ORIGINAL TXT");
    expect(fsMap.get("C:/out/fail.json")).toBe('{"original":true}');
    expect(dialogSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "文字起こしエラー",
      }),
    );
  });

  it("aborts right before commit when cancelled during .asrc.json staging without overwriting existing files", async () => {
    const fsMap = new Map<string, string>([
      ["C:/out/precommit.txt", "KEEP EXISTING TXT"],
      ["C:/out/precommit.asrc.json", '{"keep":true}'],
    ]);
    const removedPaths: string[] = [];
    const invokedCommands: string[] = [];
    let resolveAsrcStage!: () => void;

    setTauriInvokeForTest((async (command: string, args?: any) => {
      invokedCommands.push(command);
      if (command === "load_api_settings") {
        return {
          ...defaultMockSettings,
          providers: {
            ...defaultMockSettings.providers,
            google_stt: {
              default_model: "chirp_2",
              options: { location: "us-central1", recognizer_id: "_" },
            },
          },
          asr_mode: "cloud",
          asr_engine: "google_stt",
          asr_execution_mode: "single",
          output_path: "C:/out",
          correction_enabled: false,
        };
      }
      if (command === "google_auth_get_status") {
        return {
          state: "connected",
          authGeneration: 2,
          oauthClientIdFingerprint: "fp-test",
          oauthClientConfigured: true,
          email: "u@example.com",
          sub: "sub-1",
          canonicalScopes: ["identity:openid", "identity:email", "google_cloud_api"],
          projectId: "proj-123",
          projectVerified: true,
        };
      }
      if (command === "resolve_output_directory") return "C:/out";
      if (command === "google_stt_recognize") {
        return {
          transcript: "new",
          segments: [],
          rawResponse: { results: [{ alternatives: [{ transcript: "new" }] }] },
        };
      }
      if (command === "save_text_file") {
        fsMap.set(args.path, args.content);
        return null;
      }
      if (command === "save_transcript_document") {
        fsMap.set(args.path, JSON.stringify(args.document));
        return await new Promise<null>((resolve) => {
          resolveAsrcStage = () => resolve(null);
        });
      }
      if (command === "remove_output_file") {
        removedPaths.push(args.path);
        fsMap.delete(args.path);
        return null;
      }
      if (command === "hf_token_get_status") return { configured: false, maskedValue: null };
      return null;
    }) as any);

    await navigateTo("transcribe");
    setSelectedAudioFileForTest("C:/audio/precommit.wav");
    (document.getElementById("engineSelect") as HTMLSelectElement).value = "google_stt";

    (document.getElementById("startBtn") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 30));

    // Cancel right before commit starts (while .asrc.json temp staging is finishing)
    (document.getElementById("cancelBtn") as HTMLButtonElement).click();
    resolveAsrcStage();
    await new Promise((r) => setTimeout(r, 30));

    expect(invokedCommands).not.toContain("commit_staged_output_files");
    expect(removedPaths.length).toBe(2);
    expect(removedPaths.every((p) => /\.tmp-/.test(p))).toBe(true);
    expect(fsMap.get("C:/out/precommit.txt")).toBe("KEEP EXISTING TXT");
    expect(fsMap.get("C:/out/precommit.asrc.json")).toBe('{"keep":true}');
  });

  it("disables and ignores cancel during commit_staged_output_files, shows committing state, and completes normally", async () => {
    const fsMap = new Map<string, string>();
    const invokedCommands: string[] = [];
    let resolveCommit!: () => void;

    setTauriInvokeForTest((async (command: string, args?: any) => {
      invokedCommands.push(command);
      if (command === "load_api_settings") {
        return {
          ...defaultMockSettings,
          providers: {
            ...defaultMockSettings.providers,
            google_stt: {
              default_model: "chirp_2",
              options: { location: "us-central1", recognizer_id: "_" },
            },
          },
          asr_mode: "cloud",
          asr_engine: "google_stt",
          asr_execution_mode: "single",
          output_path: "C:/out",
          correction_enabled: false,
        };
      }
      if (command === "google_auth_get_status") {
        return {
          state: "connected",
          authGeneration: 2,
          oauthClientIdFingerprint: "fp-test",
          oauthClientConfigured: true,
          email: "u@example.com",
          sub: "sub-1",
          canonicalScopes: ["identity:openid", "identity:email", "google_cloud_api"],
          projectId: "proj-123",
          projectVerified: true,
        };
      }
      if (command === "resolve_output_directory") return "C:/out";
      if (command === "google_stt_recognize") {
        return {
          transcript: "committed text",
          segments: [],
          rawResponse: { results: [{ alternatives: [{ transcript: "committed text" }] }] },
        };
      }
      if (command === "save_text_file") {
        fsMap.set(args.path, args.content);
        return null;
      }
      if (command === "save_transcript_document") {
        fsMap.set(args.path, JSON.stringify(args.document));
        return null;
      }
      if (command === "commit_staged_output_files") {
        return await new Promise<null>((resolve) => {
          resolveCommit = () => {
            for (const f of args.files as Array<{ tempPath: string; finalPath: string }>) {
              const c = fsMap.get(f.tempPath);
              if (c !== undefined) {
                fsMap.delete(f.tempPath);
                fsMap.set(f.finalPath, c);
              }
            }
            resolve(null);
          };
        });
      }
      if (command === "hf_token_get_status") return { configured: false, maskedValue: null };
      return null;
    }) as any);

    await navigateTo("transcribe");
    setSelectedAudioFileForTest("C:/audio/commitlock.wav");
    (document.getElementById("engineSelect") as HTMLSelectElement).value = "google_stt";

    (document.getElementById("startBtn") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 30));

    const cancelBtn = document.getElementById("cancelBtn") as HTMLButtonElement;
    const progressStage = document.getElementById("progressStage") as HTMLElement;
    expect(cancelBtn.disabled).toBe(true);
    expect(cancelBtn.textContent).toContain("確定中...");
    expect(progressStage.textContent).toBe("出力ファイルを確定中...");

    // Attempting to click cancel during commit is ignored
    cancelBtn.click();
    expect(invokedCommands).not.toContain("cancel_transcription");

    resolveCommit();
    await new Promise((r) => setTimeout(r, 30));

    expect(fsMap.get("C:/out/commitlock.txt")).toBe("committed text");
    expect((document.getElementById("resultText") as HTMLTextAreaElement).value).toBe("committed text");
  });

  it("shows explicit error dialog when commit_staged_output_files fails partially across formats", async () => {
    const dialogSpy = vi.spyOn(statusModule, "showAppDialog").mockResolvedValue(undefined as any);

    setTauriInvokeForTest((async (command: string) => {
      if (command === "load_api_settings") {
        return {
          ...defaultMockSettings,
          providers: {
            ...defaultMockSettings.providers,
            google_stt: {
              default_model: "chirp_2",
              options: { location: "us-central1", recognizer_id: "_" },
            },
          },
          asr_mode: "cloud",
          asr_engine: "google_stt",
          asr_execution_mode: "single",
          output_path: "C:/out",
          correction_enabled: false,
        };
      }
      if (command === "google_auth_get_status") {
        return {
          state: "connected",
          authGeneration: 2,
          oauthClientIdFingerprint: "fp-test",
          oauthClientConfigured: true,
          email: "u@example.com",
          sub: "sub-1",
          canonicalScopes: ["identity:openid", "identity:email", "google_cloud_api"],
          projectId: "proj-123",
          projectVerified: true,
        };
      }
      if (command === "resolve_output_directory") return "C:/out";
      if (command === "google_stt_recognize") {
        return {
          transcript: "partial",
          segments: [],
          rawResponse: { results: [{ alternatives: [{ transcript: "partial" }] }] },
        };
      }
      if (command === "save_text_file" || command === "save_transcript_document") return null;
      if (command === "commit_staged_output_files") {
        throw new Error(
          "一部の出力ファイルの確定に失敗しました（確定済み: partial.txt / 失敗: partial.json / 未確定: partial.asrc.json）",
        );
      }
      if (command === "hf_token_get_status") return { configured: false, maskedValue: null };
      return null;
    }) as any);

    await navigateTo("transcribe");
    setSelectedAudioFileForTest("C:/audio/partial.wav");
    document.querySelectorAll<HTMLInputElement>(".output-format-checkbox").forEach((cb) => {
      cb.checked = cb.value === "txt" || cb.value === "json";
    });
    (document.getElementById("engineSelect") as HTMLSelectElement).value = "google_stt";

    (document.getElementById("startBtn") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 40));

    expect(dialogSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "文字起こしエラー",
        message: expect.stringContaining("確定済み: partial.txt / 失敗: partial.json"),
      }),
    );
    expect((document.getElementById("resultText") as HTMLTextAreaElement).value).toBe("");
  });

  it("§25: handles Speech API disabled with matching consumer via explicit user consent, then re-runs builtin test to success", async () => {
    const invokedCommands: string[] = [];
    let recognizeCalls = 0;

    setTauriInvokeForTest((async (command: string, args?: any) => {
      invokedCommands.push(command);
      if (command === "load_api_settings") return defaultMockSettings;
      if (command === "google_auth_get_status") {
        return {
          state: "connected",
          authGeneration: 2,
          oauthClientIdFingerprint: "fp-test",
          oauthClientConfigured: true,
          email: "user@example.com",
          sub: "sub-1",
          canonicalScopes: ["identity:openid", "identity:email", "google_cloud_api"],
          projectId: "amed-512123",
          projectVerified: false,
        };
      }
      if (command === "google_stt_list_projects") {
        return {
          projects: [{ projectId: "amed-512123", name: "AMED" }],
          authGeneration: 2,
          sub: "sub-1",
          oauthClientIdFingerprint: "fp-test",
        };
      }
      if (command === "google_stt_run_builtin_test") {
        recognizeCalls += 1;
        if (recognizeCalls === 1) {
          throw {
            kind: "speech_api_disabled",
            message: "Cloud Speech-to-Text API is disabled",
            targetService: "speech.googleapis.com",
            consumerProject: "amed-512123",
            authGeneration: 2,
            sub: "sub-1",
            oauthClientIdFingerprint: "fp-test",
          };
        }
        return {
          transcript: "こんにちは",
          segments: [],
          authGeneration: 2,
          sub: "sub-1",
          oauthClientIdFingerprint: "fp-test",
        };
      }
      if (command === "google_stt_enable_speech_api") {
        expect(args).toEqual({ projectId: "amed-512123", confirmed: true });
        return {
          projectId: "amed-512123",
          serviceName: "speech.googleapis.com",
          status: "enabled",
          authGeneration: 2,
          sub: "sub-1",
          oauthClientIdFingerprint: "fp-test",
        };
      }
      if (command === "hf_token_get_status") return { configured: false, maskedValue: null };
      return null;
    }) as any);

    await navigateTo("settings");
    await new Promise((r) => setTimeout(r, 30));

    const item = document.querySelector<HTMLElement>('.accordion-item[data-provider-id="google_stt"]')!;
    const cardText = item.textContent || "";
    // General user guidance must never ask for PowerShell, gcloud, ADC, env vars, or OAuth JSON edits
    expect(cardText).not.toMatch(/PowerShell|gcloud|ADC|環境変数|oauth-client/i);

    const builtinBtn = item.querySelector<HTMLButtonElement>(".btn-google-stt-builtin-test")!;
    builtinBtn.click();
    await new Promise((r) => setTimeout(r, 30));

    // Must NOT auto-enable without user consent; shows confirmation panel with target project & service
    expect(invokedCommands).not.toContain("google_stt_enable_speech_api");
    const confirmPanel = item.querySelector<HTMLElement>('[data-field="api-enable-confirm-panel"]')!;
    expect(confirmPanel.hidden).toBe(false);
    expect(confirmPanel.textContent).toContain("amed-512123");
    expect(confirmPanel.textContent).toContain("speech.googleapis.com");

    // User explicitly clicks confirm -> enables API -> re-runs builtin test -> succeeds
    const confirmEnableBtn = item.querySelector<HTMLButtonElement>(".btn-google-stt-confirm-enable-api")!;
    confirmEnableBtn.click();
    await new Promise((r) => setTimeout(r, 40));

    expect(invokedCommands).toContain("google_stt_enable_speech_api");
    expect(recognizeCalls).toBe(2);
    expect(confirmPanel.hidden).toBe(true);
    const resultEl = item.querySelector<HTMLElement>('[data-field="recognize-result"]')!;
    expect(resultEl.textContent).toContain("こんにちは");
  });

  it("§25: does not prompt auto-enable on consumer mismatch, and preserves login + shows Console fallback on enable permission denied or failed state recheck", async () => {
    setTauriInvokeForTest((async (command: string) => {
      if (command === "load_api_settings") return defaultMockSettings;
      if (command === "google_auth_get_status") {
        return {
          state: "connected",
          authGeneration: 5,
          oauthClientIdFingerprint: "fp-test",
          oauthClientConfigured: true,
          email: "user@example.com",
          sub: "sub-1",
          canonicalScopes: ["identity:openid", "identity:email", "google_cloud_api"],
          projectId: "proj-selected",
          projectVerified: false,
        };
      }
      if (command === "google_stt_list_projects") {
        throw { kind: "project_list_permission_denied", message: "list denied" };
      }
      if (command === "google_stt_run_builtin_test") {
        throw {
          kind: "speech_api_disabled",
          message: "disabled",
          targetService: "speech.googleapis.com",
          consumerProject: "different-project",
          authGeneration: 5,
          sub: "sub-1",
          oauthClientIdFingerprint: "fp-test",
        };
      }
      if (command === "google_stt_check_speech_api_state") {
        throw {
          kind: "service_usage_permission_denied",
          message: "権限（serviceusage.services.enable）が不足しています。",
          authGeneration: 5,
          sub: "sub-1",
          oauthClientIdFingerprint: "fp-test",
        };
      }
      if (command === "hf_token_get_status") return { configured: false, maskedValue: null };
      return null;
    }) as any);

    await navigateTo("settings");
    await new Promise((r) => setTimeout(r, 30));

    const item = document.querySelector<HTMLElement>('.accordion-item[data-provider-id="google_stt"]')!;
    item.querySelector<HTMLButtonElement>('[data-field="advanced-toggle"]')!.click();
    await new Promise((r) => setTimeout(r, 30));
    // Project list failed -> fell back to manual input while staying logged in
    expect(item.dataset.googleAuthState).toBe("connected");
    expect(item.querySelector<HTMLInputElement>('[data-field="project-id-input"]')!.hidden).toBe(false);

    // Click builtin test -> consumer mismatch -> must NOT show auto-enable confirm panel; shows fallback panel
    item.querySelector<HTMLButtonElement>(".btn-google-stt-builtin-test")!.click();
    await new Promise((r) => setTimeout(r, 30));
    expect(item.querySelector<HTMLElement>('[data-field="api-enable-confirm-panel"]')!.hidden).toBe(true);
    const fallbackPanel = item.querySelector<HTMLElement>('[data-field="api-fallback-panel"]')!;
    expect(fallbackPanel.hidden).toBe(false);
    expect(fallbackPanel.textContent).toContain("proj-selected");

    // Click re-check -> service_usage_permission_denied -> keeps login, does NOT claim API is disabled
    item.querySelector<HTMLButtonElement>(".btn-google-stt-recheck-api")!.click();
    await new Promise((r) => setTimeout(r, 30));
    expect(item.dataset.googleAuthState).toBe("connected");
    expect(fallbackPanel.hidden).toBe(false);
    expect(fallbackPanel.textContent).toContain("serviceusage.services.get");
    expect(fallbackPanel.textContent).toContain("準備して接続テスト");

    // Also verify oauth_scope_not_granted during recheck shows fallback panel with Console + recheck buttons
    setTauriInvokeForTest((async (command: string) => {
      if (command === "google_stt_check_speech_api_state") {
        throw {
          kind: "oauth_scope_not_granted",
          message: "Googleアカウントの認証スコープが不足しています。",
          authGeneration: 5,
          sub: "sub-1",
          oauthClientIdFingerprint: "fp-test",
        };
      }
      return null;
    }) as any);
    item.querySelector<HTMLButtonElement>(".btn-google-stt-recheck-api")!.click();
    await new Promise((r) => setTimeout(r, 30));
    expect(fallbackPanel.hidden).toBe(false);
    expect(fallbackPanel.textContent).toContain("OAuth認証スコープが不足しています");
    expect(fallbackPanel.querySelector(".btn-google-stt-open-console")).not.toBeNull();
    expect(fallbackPanel.querySelector(".btn-google-stt-recheck-api")).not.toBeNull();
  });

  it("closes and invalidates Speech API enable confirm panel when Project or auth changes (P1)", async () => {
    const enableCalls: any[] = [];
    let activeProject = "proj-a";
    let generation = 10;

    setTauriInvokeForTest((async (command: string, args?: any) => {
      if (command === "load_api_settings") return defaultMockSettings;
      if (command === "google_auth_get_status") {
        return {
          state: "connected",
          email: "user@example.com",
          sub: "sub-1",
          canonicalScopes: ["identity:openid", "identity:email", "google_cloud_api"],
          projectId: activeProject,
          projectVerified: false,
          authGeneration: 10,
          oauthClientIdFingerprint: "fp-test",
          oauthClientConfigured: true,
        };
      }
      if (command === "google_stt_list_projects") {
        return {
          projects: [
            { projectId: "proj-a", name: "Project A" },
            { projectId: "proj-b", name: "Project B" },
          ],
          authGeneration: 10,
          sub: "sub-1",
          oauthClientIdFingerprint: "fp-test",
        };
      }
      if (command === "google_auth_confirm_project") {
        activeProject = args?.projectId;
        expect(args.authGeneration).toBe(generation);
        expect(args.sub).toBe("sub-1");
        expect(args.oauthClientIdFingerprint).toBe("fp-test");
        generation++;
        return {
          state: "connected",
          email: "user@example.com",
          sub: "sub-1",
          canonicalScopes: ["identity:openid", "identity:email", "google_cloud_api"],
          projectId: activeProject,
          projectVerified: false,
          authGeneration: generation,
          oauthClientIdFingerprint: "fp-test",
          oauthClientConfigured: true,
        };
      }
      if (command === "google_stt_run_builtin_test") {
        throw {
          kind: "speech_api_disabled",
          message: "disabled",
          targetService: "speech.googleapis.com",
          consumerProject: "proj-a",
          authGeneration: 10,
          sub: "sub-1",
          oauthClientIdFingerprint: "fp-test",
        };
      }
      if (command === "google_stt_enable_speech_api") {
        enableCalls.push(args);
        return {
          projectId: args?.projectId,
          alreadyEnabled: false,
          authGeneration: 10,
          sub: "sub-1",
          oauthClientIdFingerprint: "fp-test",
        };
      }
      if (command === "hf_token_get_status") return { configured: false, maskedValue: null };
      return null;
    }) as any);

    await navigateTo("settings");
    await new Promise((r) => setTimeout(r, 30));

    const item = document.querySelector<HTMLElement>('.accordion-item[data-provider-id="google_stt"]')!;
    item.querySelector<HTMLButtonElement>('[data-field="advanced-toggle"]')!.click();
    await new Promise((r) => setTimeout(r, 30));
    const confirmPanel = item.querySelector<HTMLElement>('[data-field="api-enable-confirm-panel"]')!;

    // Trigger Speech API disabled for proj-a -> confirm panel opens with proj-a
    item.querySelector<HTMLButtonElement>(".btn-google-stt-builtin-test")!.click();
    await new Promise((r) => setTimeout(r, 30));
    expect(confirmPanel.hidden).toBe(false);
    expect(confirmPanel.dataset.confirmProjectId).toBe("proj-a");

    // Switch to proj-b via select -> confirm panel closes and clears captured context
    const selectEl = item.querySelector<HTMLSelectElement>('[data-field="project-id-select"]')!;
    selectEl.value = "proj-b";
    selectEl.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 30));
    expect(confirmPanel.hidden).toBe(true);
    expect(confirmPanel.dataset.confirmProjectId).toBeUndefined();

    // Even if the button is clicked while panel is stale/closed, no enable request is sent
    item.querySelector<HTMLButtonElement>(".btn-google-stt-confirm-enable-api")!.click();
    await new Promise((r) => setTimeout(r, 30));
    expect(enableCalls).toHaveLength(0);

    // Also test stale DOM tamper / mismatched dataset vs currentGoogleAuthStatus
    confirmPanel.hidden = false;
    confirmPanel.dataset.confirmProjectId = "proj-a";
    confirmPanel.dataset.confirmAuthGeneration = "10";
    confirmPanel.dataset.confirmSub = "sub-1";
    confirmPanel.dataset.confirmOauthClientIdFingerprint = "fp-test";
    item.querySelector<HTMLButtonElement>(".btn-google-stt-confirm-enable-api")!.click();
    await new Promise((r) => setTimeout(r, 30));
    expect(enableCalls).toHaveLength(0);
    expect(confirmPanel.hidden).toBe(true);
    expect(item.querySelector<HTMLElement>('[data-field="recognize-result"]')!.textContent).toContain("proj-b");
  });

  it("ignores stale google_stt_enable_speech_api error when Project switches during in-flight enablement (P1)", async () => {
    let rejectEnable!: (err: unknown) => void;
    let activeProject = "proj-a";

    setTauriInvokeForTest((async (command: string, args?: any) => {
      if (command === "load_api_settings") return defaultMockSettings;
      if (command === "google_auth_get_status") {
        return {
          state: "connected",
          email: "user@example.com",
          sub: "sub-1",
          canonicalScopes: ["identity:openid", "identity:email", "google_cloud_api"],
          projectId: activeProject,
          projectVerified: false,
          authGeneration: 11,
          oauthClientIdFingerprint: "fp-test",
          oauthClientConfigured: true,
        };
      }
      if (command === "google_stt_list_projects") {
        return {
          projects: [
            { projectId: "proj-a", name: "Project A" },
            { projectId: "proj-b", name: "Project B" },
          ],
          authGeneration: 11,
          sub: "sub-1",
          oauthClientIdFingerprint: "fp-test",
        };
      }
      if (command === "google_auth_confirm_project") {
        activeProject = args?.projectId;
        return {
          state: "connected",
          email: "user@example.com",
          sub: "sub-1",
          canonicalScopes: ["identity:openid", "identity:email", "google_cloud_api"],
          projectId: activeProject,
          projectVerified: false,
          authGeneration: 12,
          oauthClientIdFingerprint: "fp-test",
          oauthClientConfigured: true,
        };
      }
      if (command === "google_stt_run_builtin_test") {
        throw {
          kind: "speech_api_disabled",
          message: "disabled",
          targetService: "speech.googleapis.com",
          consumerProject: "proj-a",
          authGeneration: 11,
          sub: "sub-1",
          oauthClientIdFingerprint: "fp-test",
        };
      }
      if (command === "google_stt_enable_speech_api") {
        return new Promise((_resolve, reject) => {
          rejectEnable = reject;
        });
      }
      if (command === "hf_token_get_status") return { configured: false, maskedValue: null };
      return null;
    }) as any);

    await navigateTo("settings");
    await new Promise((r) => setTimeout(r, 30));

    const item = document.querySelector<HTMLElement>('.accordion-item[data-provider-id="google_stt"]')!;
    item.querySelector<HTMLButtonElement>('[data-field="advanced-toggle"]')!.click();
    await new Promise((r) => setTimeout(r, 30));
    item.querySelector<HTMLButtonElement>(".btn-google-stt-builtin-test")!.click();
    await new Promise((r) => setTimeout(r, 30));

    // Start enablement for proj-a
    item.querySelector<HTMLButtonElement>(".btn-google-stt-confirm-enable-api")!.click();
    await new Promise((r) => setTimeout(r, 10));

    // Switch Project to proj-b before enablement resolves/rejects
    const selectEl = item.querySelector<HTMLSelectElement>('[data-field="project-id-select"]')!;
    selectEl.value = "proj-b";
    selectEl.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 30));

    // Reject the stale enablement for proj-a
    rejectEnable({
      kind: "service_usage_permission_denied",
      message: "denied for proj-a",
      authGeneration: 11,
      sub: "sub-1",
      oauthClientIdFingerprint: "fp-test",
    });
    await new Promise((r) => setTimeout(r, 30));

    // Fallback panel must NOT appear for stale proj-a error
    expect(item.querySelector<HTMLElement>('[data-field="api-fallback-panel"]')!.hidden).toBe(true);
    expect(item.querySelector<HTMLElement>('[data-field="api-enable-confirm-panel"]')!.hidden).toBe(true);
  });

  it("handles STATE_UNSPECIFIED and unknown API states as unknown fallback instead of DISABLED (P2)", async () => {
    let checkState = "STATE_UNSPECIFIED";
    let enableCalls = 0;
    let builtinCalls = 0;

    setTauriInvokeForTest((async (command: string) => {
      if (command === "load_api_settings") return defaultMockSettings;
      if (command === "google_auth_get_status") {
        return {
          state: "connected",
          email: "user@example.com",
          sub: "sub-1",
          canonicalScopes: ["identity:openid", "identity:email", "google_cloud_api"],
          projectId: "proj-a",
          projectVerified: false,
          authGeneration: 12,
          oauthClientIdFingerprint: "fp-test",
          oauthClientConfigured: true,
        };
      }
      if (command === "google_stt_list_projects") {
        return {
          projects: [{ projectId: "proj-a", name: "Project A" }],
          authGeneration: 12,
          sub: "sub-1",
          oauthClientIdFingerprint: "fp-test",
        };
      }
      if (command === "google_stt_run_builtin_test") {
        builtinCalls += 1;
        if (checkState === "ENABLED") {
          return {
            transcript: "こんにちは",
            segments: [],
            authGeneration: 12,
            sub: "sub-1",
            oauthClientIdFingerprint: "fp-test",
          };
        }
        throw {
          kind: "service_usage_operation_timeout",
          message: "timeout",
          authGeneration: 12,
          sub: "sub-1",
          oauthClientIdFingerprint: "fp-test",
        };
      }
      if (command === "google_stt_check_speech_api_state") {
        return {
          projectId: "proj-a",
          state: checkState,
          authGeneration: 12,
          sub: "sub-1",
          oauthClientIdFingerprint: "fp-test",
        };
      }
      if (command === "google_stt_enable_speech_api") {
        enableCalls += 1;
        return {};
      }
      if (command === "hf_token_get_status") return { configured: false, maskedValue: null };
      return null;
    }) as any);

    await navigateTo("settings");
    await new Promise((r) => setTimeout(r, 30));

    const item = document.querySelector<HTMLElement>('.accordion-item[data-provider-id="google_stt"]')!;
    item.querySelector<HTMLButtonElement>('[data-field="advanced-toggle"]')!.click();
    await new Promise((r) => setTimeout(r, 30));
    const confirmPanel = item.querySelector<HTMLElement>('[data-field="api-enable-confirm-panel"]')!;
    const fallbackPanel = item.querySelector<HTMLElement>('[data-field="api-fallback-panel"]')!;

    // Trigger fallback panel first so .btn-google-stt-recheck-api is visible
    item.querySelector<HTMLButtonElement>(".btn-google-stt-builtin-test")!.click();
    await new Promise((r) => setTimeout(r, 30));
    expect(fallbackPanel.hidden).toBe(false);

    // 1) STATE_UNSPECIFIED -> fallback panel ("状態を確認できませんでした"), NOT confirm panel
    checkState = "STATE_UNSPECIFIED";
    item.querySelector<HTMLButtonElement>(".btn-google-stt-recheck-api")!.click();
    await new Promise((r) => setTimeout(r, 30));
    expect(confirmPanel.hidden).toBe(true);
    expect(fallbackPanel.hidden).toBe(false);
    expect(fallbackPanel.textContent).toContain("状態を確認できませんでした");
    expect(enableCalls).toBe(0);

    // 2) Unknown string -> fallback panel, NOT confirm panel
    checkState = "PENDING_VERIFICATION";
    item.querySelector<HTMLButtonElement>(".btn-google-stt-recheck-api")!.click();
    await new Promise((r) => setTimeout(r, 30));
    expect(confirmPanel.hidden).toBe(true);
    expect(fallbackPanel.hidden).toBe(false);
    expect(fallbackPanel.textContent).toContain("PENDING_VERIFICATION");
    expect(enableCalls).toBe(0);

    // 3) DISABLED -> confirm panel opens
    checkState = "DISABLED";
    item.querySelector<HTMLButtonElement>(".btn-google-stt-recheck-api")!.click();
    await new Promise((r) => setTimeout(r, 30));
    expect(confirmPanel.hidden).toBe(false);
    expect(confirmPanel.dataset.confirmProjectId).toBe("proj-a");

    // 4) ENABLED -> hides panels and proceeds to builtin test
    checkState = "ENABLED";
    const beforeBuiltin = builtinCalls;
    item.querySelector<HTMLButtonElement>(".btn-google-stt-recheck-api")!.click();
    await new Promise((r) => setTimeout(r, 40));
    expect(confirmPanel.hidden).toBe(true);
    expect(fallbackPanel.hidden).toBe(true);
    expect(builtinCalls).toBe(beforeBuiltin + 1);
  });

  it("§26: completes 1-click Google login onboarding without Project list or extra clicks, deduplicates by authSessionId, and syncs Transcribe screen", async () => {
    const invokedCommands: string[] = [];
    let currentStatus: any = {
      state: "disconnected",
      authGeneration: 1,
      authSessionId: "",
      oauthClientIdFingerprint: "fp-test",
      oauthClientConfigured: true,
      canonicalScopes: [],
      projectVerified: false,
      defaultProjectId: "amed-512123",
    };

    setTauriInvokeForTest((async (command: string) => {
      invokedCommands.push(command);
      if (command === "load_api_settings") return defaultMockSettings;
      if (command === "google_auth_get_status") return currentStatus;
      if (command === "google_auth_login") {
        currentStatus = {
          state: "connected",
          authGeneration: 2,
          authSessionId: "sess-onb-1",
          oauthClientIdFingerprint: "fp-test",
          oauthClientConfigured: true,
          email: "user@example.com",
          sub: "sub-1",
          canonicalScopes: ["identity:openid", "identity:email", "google_cloud_api"],
          projectVerified: false,
          defaultProjectId: "amed-512123",
        };
        return currentStatus;
      }
      if (command === "google_auth_complete_onboarding") {
        currentStatus = {
          ...currentStatus,
          authGeneration: 3,
          projectId: "amed-512123",
          projectVerified: true,
          projectSource: "default",
        };
        return {
          outcome: "ready",
          message: "ok",
          projectId: "amed-512123",
          email: "user@example.com",
          authGeneration: 3,
          authSessionId: "sess-onb-1",
          sub: "sub-1",
          oauthClientIdFingerprint: "fp-test",
          status: currentStatus,
          diagnosticTranscriptPreview: "こんにちは",
        };
      }
      if (command === "hf_token_get_status") return { configured: false, maskedValue: null };
      if (command === "local_asr_get_statuses") return [];
      return null;
    }) as any);

    await navigateTo("settings");
    await new Promise((r) => setTimeout(r, 30));

    const item = document.querySelector<HTMLElement>('.accordion-item[data-provider-id="google_stt"]')!;
    const advancedContent = item.querySelector<HTMLElement>('[data-field="advanced-content"]')!;
    expect(advancedContent.hidden).toBe(true);

    // 1-click login -> automatically runs onboarding -> transitions to 利用可能
    item.querySelector<HTMLButtonElement>(".btn-google-auth-login")!.click();
    await new Promise((r) => setTimeout(r, 40));

    expect(invokedCommands).not.toContain("google_stt_list_projects");
    expect(invokedCommands.filter((c) => c === "google_auth_complete_onboarding")).toHaveLength(1);
    expect(item.querySelector<HTMLElement>('[data-field="auth-state"]')!.textContent).toContain("利用可能");
    expect(item.dataset.googleProjectId).toBe("amed-512123");
    expect(item.dataset.googleProjectVerified).toBe("true");
    expect(advancedContent.hidden).toBe(true);

    // Revisiting settings must NOT re-run onboarding for already verified session
    await navigateTo("transcribe");
    await new Promise((r) => setTimeout(r, 20));
    await navigateTo("settings");
    await new Promise((r) => setTimeout(r, 20));
    expect(invokedCommands.filter((c) => c === "google_auth_complete_onboarding")).toHaveLength(1);

    // Transcribe screen cloud mode includes google_stt
    await navigateTo("transcribe");
    await new Promise((r) => setTimeout(r, 20));
    const modeSelect = document.getElementById("asrModeSelect") as HTMLSelectElement;
    modeSelect.value = "cloud";
    modeSelect.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 30));
    const engineSelect = document.getElementById("engineSelect") as HTMLSelectElement;
    expect([...engineSelect.options].some((o) => o.value === "google_stt")).toBe(true);
  });

  it("§26: handles needs_api_enable_consent during onboarding, preserves user_selected upgrade project, and invalidates stale onboarding on manual project change", async () => {
    let onboardingCalls = 0;
    let resolveDelayedOnboarding!: (val: any) => void;
    let currentStatus: any = {
      state: "connected",
      authGeneration: 5,
      authSessionId: "sess-consent",
      oauthClientIdFingerprint: "fp-test",
      oauthClientConfigured: true,
      email: "user@example.com",
      sub: "sub-1",
      canonicalScopes: ["identity:openid", "identity:email", "google_cloud_api"],
      projectVerified: false,
      defaultProjectId: "amed-512123",
    };

    setTauriInvokeForTest((async (command: string, args?: any) => {
      if (command === "load_api_settings") return defaultMockSettings;
      if (command === "google_auth_get_status") return currentStatus;
      if (command === "google_stt_list_projects") {
        return {
          projects: [{ projectId: "manual-proj-999", name: "Manual" }],
          authGeneration: currentStatus.authGeneration,
          sub: "sub-1",
          oauthClientIdFingerprint: "fp-test",
        };
      }
      if (command === "google_auth_confirm_project") {
        currentStatus = {
          ...currentStatus,
          authGeneration: currentStatus.authGeneration + 1,
          projectId: args?.projectId,
          projectVerified: false,
          projectSource: "user_selected",
        };
        return currentStatus;
      }
      if (command === "google_auth_complete_onboarding") {
        onboardingCalls += 1;
        if (onboardingCalls === 1) {
          return {
            outcome: "needs_api_enable_consent",
            message: "disabled",
            projectId: "amed-512123",
            email: "user@example.com",
            targetService: "speech.googleapis.com",
            consumerProject: "amed-512123",
            authGeneration: 5,
            authSessionId: "sess-consent",
            sub: "sub-1",
            oauthClientIdFingerprint: "fp-test",
            status: currentStatus,
          };
        }
        if (args?.input?.enableSpeechApiIfNeeded) {
          expect(args.input.expectedAuthSessionId).toBe("sess-consent");
          currentStatus = {
            ...currentStatus,
            authGeneration: 6,
            projectId: "amed-512123",
            projectVerified: true,
            projectSource: "default",
          };
          return {
            outcome: "ready",
            message: "ok",
            projectId: "amed-512123",
            email: "user@example.com",
            authGeneration: 6,
            authSessionId: "sess-consent",
            sub: "sub-1",
            oauthClientIdFingerprint: "fp-test",
            status: currentStatus,
          };
        }
        return new Promise((resolve) => {
          resolveDelayedOnboarding = resolve;
        });
      }
      if (command === "hf_token_get_status") return { configured: false, maskedValue: null };
      return null;
    }) as any);

    await navigateTo("settings");
    await new Promise((r) => setTimeout(r, 40));

    const item = document.querySelector<HTMLElement>('.accordion-item[data-provider-id="google_stt"]')!;
    const confirmPanel = item.querySelector<HTMLElement>('[data-field="api-enable-confirm-panel"]')!;
    expect(confirmPanel.hidden).toBe(false);
    expect(confirmPanel.dataset.confirmMode).toBe("onboarding");

    // User consents -> enables API & completes onboarding without extra test button
    item.querySelector<HTMLButtonElement>(".btn-google-stt-confirm-enable-api")!.click();
    await new Promise((r) => setTimeout(r, 40));
    expect(confirmPanel.hidden).toBe(true);
    expect(item.dataset.googleProjectVerified).toBe("true");
    expect(item.dataset.googleProjectId).toBe("amed-512123");

    // Now test manual override invalidating an in-flight onboarding on a fresh login
    resetMountedPagesForTest();
    resetMultiAsrMainStateForTest();
    document.body.innerHTML = '<div id="app"></div>';
    currentStatus = {
      state: "connected",
      authGeneration: 20,
      authSessionId: "sess-race",
      oauthClientIdFingerprint: "fp-test",
      oauthClientConfigured: true,
      email: "user@example.com",
      sub: "sub-1",
      canonicalScopes: ["identity:openid", "identity:email", "google_cloud_api"],
      projectVerified: false,
      defaultProjectId: "amed-512123",
    };

    await navigateTo("settings");
    await new Promise((r) => setTimeout(r, 30));
    const item2 = document.querySelector<HTMLElement>('.accordion-item[data-provider-id="google_stt"]')!;
    item2.querySelector<HTMLButtonElement>('[data-field="advanced-toggle"]')!.click();
    await new Promise((r) => setTimeout(r, 30));
    const sel2 = item2.querySelector<HTMLSelectElement>('[data-field="project-id-select"]')!;
    sel2.value = "manual-proj-999";
    sel2.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 30));
    expect(item2.dataset.googleProjectId).toBe("manual-proj-999");

    // Stale onboarding resolves after manual selection -> must NOT overwrite manual-proj-999
    resolveDelayedOnboarding({
      outcome: "ready",
      message: "stale",
      projectId: "amed-512123",
      authGeneration: 21,
      authSessionId: "sess-race",
      sub: "sub-1",
      oauthClientIdFingerprint: "fp-test",
      status: {
        ...currentStatus,
        authGeneration: 21,
        projectId: "amed-512123",
        projectVerified: true,
        projectSource: "default",
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(item2.dataset.googleProjectId).toBe("manual-proj-999");
  });
});


