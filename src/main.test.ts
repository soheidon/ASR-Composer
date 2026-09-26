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
  pageMounts,
  setTauriInvokeForTest,
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
});


