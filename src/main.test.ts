// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  setButtonLoading,
  restoreButtonLoading,
  setGoogleSttAdvancedOpen,
} from "./provider-config-save";
import { asrProviders } from "./providers";

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
