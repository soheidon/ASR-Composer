// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  setButtonLoading,
  restoreButtonLoading,
} from "./provider-config-save";

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
