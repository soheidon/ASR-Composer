import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { classifyFetchError, populateModelSelect, showAppDialog, showAppConfirm } from "./status";

// ---- classifyFetchError ----

describe("classifyFetchError", () => {
  it("returns 認証エラー for { kind: 'auth_error' }", () => {
    const result = classifyFetchError({ kind: "auth_error", message: "401 Unauthorized" });
    expect(result.status).toBe("認証エラー");
    expect(result.message).toBe("401 Unauthorized");
  });

  it("returns 未設定 for { kind: 'not_configured' }", () => {
    const result = classifyFetchError({ kind: "not_configured", message: "OPENAI_API_KEY が設定されていません" });
    expect(result.status).toBe("未設定");
    expect(result.message).toBe("OPENAI_API_KEY が設定されていません");
  });

  it("returns 接続エラー for { kind: 'connection_error' }", () => {
    const result = classifyFetchError({ kind: "connection_error", message: "リクエスト失敗" });
    expect(result.status).toBe("接続エラー");
    expect(result.message).toBe("リクエスト失敗");
  });

  it("returns 接続エラー for { kind: 'unsupported' }", () => {
    const result = classifyFetchError({ kind: "unsupported", message: "未対応" });
    expect(result.status).toBe("接続エラー");
    expect(result.message).toBe("未対応");
  });

  it("returns 未設定 for Error with env message", () => {
    const result = classifyFetchError(new Error("OPENAI_API_KEY が設定されていません"));
    expect(result.status).toBe("未設定");
    expect(result.message).toBe("OPENAI_API_KEY が設定されていません");
  });

  it("returns 未設定 for Error with 環境変数名 message", () => {
    const result = classifyFetchError(new Error("環境変数名が設定されていません"));
    expect(result.status).toBe("未設定");
    expect(result.message).toBe("環境変数名が設定されていません");
  });

  it("returns 接続エラー for plain Error", () => {
    const result = classifyFetchError(new Error("network timeout"));
    expect(result.status).toBe("接続エラー");
    expect(result.message).toBe("network timeout");
  });

  it("returns 接続エラー for string error", () => {
    const result = classifyFetchError("something went wrong");
    expect(result.status).toBe("接続エラー");
    expect(result.message).toBe("something went wrong");
  });

  it("returns 接続エラー for object without kind", () => {
    const result = classifyFetchError({ message: "unknown" });
    expect(result.status).toBe("接続エラー");
    expect(result.message).toBe("unknown");
  });

  it("returns 接続エラー for null", () => {
    const result = classifyFetchError(null);
    expect(result.status).toBe("接続エラー");
    expect(result.message).toBe("不明なエラーが発生しました。");
  });

  it("returns 接続エラー for undefined", () => {
    const result = classifyFetchError(undefined);
    expect(result.status).toBe("接続エラー");
    expect(result.message).toBe("不明なエラーが発生しました。");
  });

  it("returns default message for connection_error without message", () => {
    const result = classifyFetchError({ kind: "connection_error" });
    expect(result.status).toBe("接続エラー");
    expect(result.message).toBe("サーバーに接続できませんでした。");
  });

  it("returns default message for auth_error without message", () => {
    const result = classifyFetchError({ kind: "auth_error" });
    expect(result.status).toBe("認証エラー");
    expect(result.message).toBe("認証に失敗しました。");
  });
});

// ---- populateModelSelect ----

function createSelect(options: { value: string; text: string; selected?: boolean }[]): HTMLSelectElement {
  const select = document.createElement("select");
  for (const o of options) {
    const opt = new Option(o.text, o.value, o.selected, o.selected);
    select.appendChild(opt);
  }
  return select;
}

function getOptionValues(select: HTMLSelectElement): string[] {
  return Array.from(select.options).map(o => o.value);
}

describe("populateModelSelect", () => {
  it("populates models into an empty select with placeholder", () => {
    const select = createSelect([{ value: "", text: "モデルを選択..." }]);
    populateModelSelect(select, ["model-a", "model-b"], [], null, false);
    const values = getOptionValues(select);
    expect(values).toContain("");
    expect(values).toContain("model-a");
    expect(values).toContain("model-b");
  });

  it("separates preferred models into optgroup", () => {
    const select = createSelect([{ value: "", text: "placeholder" }]);
    populateModelSelect(select, ["gpt-4o", "other-model"], ["gpt-4o"], null, false);
    const optgroups = select.querySelectorAll("optgroup");
    expect(optgroups.length).toBe(2);
    expect(optgroups[0].label).toBe("推奨モデル");
    expect(optgroups[1].label).toBe("その他のモデル");
    expect(optgroups[0].querySelector("option")?.value).toBe("gpt-4o");
    expect(optgroups[1].querySelector("option")?.value).toBe("other-model");
  });

  it("preserves __manual__ option when allowManual=true", () => {
    const select = createSelect([
      { value: "", text: "placeholder" },
      { value: "__manual__", text: "手動入力" },
    ]);
    populateModelSelect(select, ["model-a"], [], null, true);
    expect(getOptionValues(select)).toContain("__manual__");
  });

  it("removes __manual__ option when allowManual=false", () => {
    const select = createSelect([
      { value: "", text: "placeholder" },
      { value: "__manual__", text: "手動入力" },
    ]);
    populateModelSelect(select, ["model-a"], [], null, false);
    expect(getOptionValues(select)).not.toContain("__manual__");
  });

  it("restores saved model from fetched list", () => {
    const select = createSelect([{ value: "", text: "placeholder" }]);
    populateModelSelect(select, ["model-a", "model-b"], [], "model-b", false);
    expect(select.value).toBe("model-b");
  });

  it("restores saved model NOT in fetched list by adding it", () => {
    const select = createSelect([{ value: "", text: "placeholder" }]);
    populateModelSelect(select, ["model-a", "model-b"], [], "model-old", false);
    const values = getOptionValues(select);
    expect(values).toContain("model-old");
    expect(select.value).toBe("model-old");
    // The restored option text should indicate it's saved
    const restoredOpt = select.querySelector('option[value="model-old"]');
    expect(restoredOpt?.textContent).toContain("保存済み");
  });

  it("does not duplicate a saved model that IS in fetched list", () => {
    const select = createSelect([{ value: "", text: "placeholder" }]);
    populateModelSelect(select, ["model-a", "model-b"], [], "model-a", false);
    const count = getOptionValues(select).filter(v => v === "model-a").length;
    expect(count).toBe(1);
  });

  it("replaces old options on second call (re-fetch)", () => {
    const select = createSelect([{ value: "", text: "placeholder" }]);
    populateModelSelect(select, ["old-1", "old-2"], [], null, false);
    populateModelSelect(select, ["new-1", "new-2"], [], null, false);
    const values = getOptionValues(select);
    expect(values).not.toContain("old-1");
    expect(values).not.toContain("old-2");
    expect(values).toContain("new-1");
    expect(values).toContain("new-2");
  });

  it("handles empty models array", () => {
    const select = createSelect([{ value: "", text: "placeholder" }]);
    populateModelSelect(select, [], [], null, false);
    const values = getOptionValues(select);
    expect(values).toEqual([""]);
  });

  it("sets value to null when savedModel is null", () => {
    const select = createSelect([{ value: "", text: "placeholder" }]);
    populateModelSelect(select, ["model-a"], [], null, false);
    expect(select.value).toBe("");
  });

  it("shows 'その他のモデル' only once (as optgroup label)", () => {
    const select = createSelect([{ value: "", text: "placeholder" }]);
    populateModelSelect(select, ["model-a", "model-b"], [], null, false);
    const optgroups = select.querySelectorAll("optgroup");
    const otherGroups = Array.from(optgroups).filter(g => g.label === "その他のモデル");
    expect(otherGroups.length).toBe(1);
    // 通常optionとして「その他のモデル」がないこと
    const allOptions = Array.from(select.options);
    const labelAsOption = allOptions.filter(o => o.textContent === "その他のモデル" && o.value === "");
    expect(labelAsOption.length).toBe(0);
  });

  it("does not duplicate optgroups on second call (re-fetch)", () => {
    const select = createSelect([{ value: "", text: "placeholder" }]);
    populateModelSelect(select, ["model-a"], [], null, false);
    populateModelSelect(select, ["model-b", "model-c"], [], null, false);
    const optgroups = select.querySelectorAll("optgroup");
    expect(optgroups.length).toBe(1);
    expect(optgroups[0].label).toBe("その他のモデル");
    // optgroup内のoptionは新しいモデルのみ
    const groupOptions = Array.from(optgroups[0].querySelectorAll("option")).map(o => o.value);
    expect(groupOptions).toEqual(["model-b", "model-c"]);
  });
});

// ---- showAppDialog ----

describe("showAppDialog", () => {
  beforeEach(() => {
    // 既存のダイアログを除去
    document.querySelectorAll(".app-dialog-overlay").forEach(el => el.remove());
    document.body.style.overflow = "";
  });

  afterEach(() => {
    document.querySelectorAll(".app-dialog-overlay").forEach(el => el.remove());
    document.body.style.overflow = "";
  });

  it("renders a single overlay in document.body", async () => {
    const promise = showAppDialog({ title: "Title", message: "Body" });
    const overlays = document.querySelectorAll(".app-dialog-overlay");
    expect(overlays.length).toBe(1);
    document.querySelector<HTMLButtonElement>(".app-dialog-ok")!.click();
    await promise;
  });

  it("displays title and message as textContent", async () => {
    const promise = showAppDialog({ title: "接続テスト", message: "接続成功（Ollama v0.6.2）", type: "success" });
    const title = document.querySelector(".app-dialog-title");
    const message = document.querySelector(".app-dialog-message");
    expect(title?.textContent).toBe("接続テスト");
    expect(message?.textContent).toBe("接続成功（Ollama v0.6.2）");
    document.querySelector<HTMLButtonElement>(".app-dialog-ok")!.click();
    await promise;
  });

  it("closes on OK button click", async () => {
    const promise = showAppDialog({ title: "Test", message: "Msg" });
    expect(document.querySelector(".app-dialog-overlay")).not.toBeNull();
    document.querySelector<HTMLButtonElement>(".app-dialog-ok")!.click();
    await promise;
    expect(document.querySelector(".app-dialog-overlay")).toBeNull();
  });

  it("closes on Escape key", async () => {
    const promise = showAppDialog({ title: "Test", message: "Msg" });
    expect(document.querySelector(".app-dialog-overlay")).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await promise;
    expect(document.querySelector(".app-dialog-overlay")).toBeNull();
  });

  it("closes on overlay background click", async () => {
    const promise = showAppDialog({ title: "Test", message: "Msg" });
    const overlay = document.querySelector<HTMLDivElement>(".app-dialog-overlay")!;
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await promise;
    expect(document.querySelector(".app-dialog-overlay")).toBeNull();
  });

  it("does not close on dialog interior click, then closes on background click", async () => {
    const promise = showAppDialog({ title: "Test", message: "Msg" });
    const dialog = document.querySelector<HTMLDivElement>(".app-dialog")!;
    // 内部クリック → 閉じない
    dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".app-dialog-overlay")).not.toBeNull();
    // 背景クリック → 閉じる
    const overlay = document.querySelector<HTMLDivElement>(".app-dialog-overlay")!;
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await promise;
    expect(document.querySelector(".app-dialog-overlay")).toBeNull();
  });

  it("no side effects from Escape after closing via OK", async () => {
    const promise = showAppDialog({ title: "Test", message: "Msg" });
    document.querySelector<HTMLButtonElement>(".app-dialog-ok")!.click();
    await promise;
    // Escapeを押してもエラーが出ない
    expect(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    }).not.toThrow();
    expect(document.querySelector(".app-dialog-overlay")).toBeNull();
  });

  it("replaces previous dialog on consecutive calls", async () => {
    const promise1 = showAppDialog({ title: "First", message: "Msg1" });
    expect(document.querySelectorAll(".app-dialog-overlay").length).toBe(1);
    // 2回目を呼ぶと1回目のPromiseも解決される
    const promise2 = showAppDialog({ title: "Second", message: "Msg2" });
    await promise1; // 1回目はcloseCurrentDialogで解決
    expect(document.querySelectorAll(".app-dialog-overlay").length).toBe(1);
    const title = document.querySelector(".app-dialog-title");
    expect(title?.textContent).toBe("Second");
    document.querySelector<HTMLButtonElement>(".app-dialog-ok")!.click();
    await promise2;
  });

  it("restores focus to previously focused element", async () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    expect(document.activeElement).toBe(button);

    const promise = showAppDialog({ title: "Test", message: "Msg" });
    expect(document.activeElement).not.toBe(button);
    document.querySelector<HTMLButtonElement>(".app-dialog-ok")!.click();
    await promise;
    expect(document.activeElement).toBe(button);
    button.remove();
  });

  it("does not interpret message as HTML", async () => {
    const promise = showAppDialog({ title: "Test", message: "<script>window.xss=true</script>", type: "error" });
    const message = document.querySelector(".app-dialog-message");
    expect(message?.innerHTML).not.toContain("<script>");
    expect(message?.textContent).toBe("<script>window.xss=true</script>");
    document.querySelector<HTMLButtonElement>(".app-dialog-ok")!.click();
    await promise;
  });

  it("applies icon-success, icon-error, icon-info classes", async () => {
    for (const type of ["success", "error", "info"] as const) {
      const promise = showAppDialog({ title: "Test", message: "Msg", type });
      const icon = document.querySelector(".app-dialog-icon");
      expect(icon?.classList.contains(`icon-${type}`)).toBe(true);
      document.querySelector<HTMLButtonElement>(".app-dialog-ok")!.click();
      await promise;
    }
  });

  it("sets role=dialog and aria-modal=true", async () => {
    const promise = showAppDialog({ title: "Title", message: "Body" });
    const dialog = document.querySelector(".app-dialog");
    expect(dialog?.getAttribute("role")).toBe("dialog");
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    document.querySelector<HTMLButtonElement>(".app-dialog-ok")!.click();
    await promise;
  });

  it("defaults to info type when type is omitted", async () => {
    const promise = showAppDialog({ title: "Test", message: "Msg" });
    const icon = document.querySelector(".app-dialog-icon");
    expect(icon?.classList.contains("icon-info")).toBe(true);
    document.querySelector<HTMLButtonElement>(".app-dialog-ok")!.click();
    await promise;
  });

  it("resolves promise only once even if close is called multiple times", async () => {
    const promise = showAppDialog({ title: "Test", message: "Msg" });
    const okBtn = document.querySelector<HTMLButtonElement>(".app-dialog-ok")!;
    // 2回クリック
    okBtn.click();
    okBtn.click();
    // Promiseは正常に解決される（永遠にpendingにならない）
    await promise;
    expect(document.querySelector(".app-dialog-overlay")).toBeNull();
  });

  it("sets inert on other body children while dialog is open", async () => {
    const sibling = document.createElement("div");
    document.body.appendChild(sibling);

    const promise = showAppDialog({ title: "Test", message: "Msg" });
    expect(sibling.hasAttribute("inert") || sibling.inert === true).toBe(true);

    document.querySelector<HTMLButtonElement>(".app-dialog-ok")!.click();
    await promise;
    expect(sibling.hasAttribute("inert")).toBe(false);
    sibling.remove();
  });

  it("restores original inert states after closing", async () => {
    const normalElement = document.createElement("button");
    const alreadyInertElement = document.createElement("div");
    alreadyInertElement.setAttribute("inert", "");
    document.body.append(normalElement, alreadyInertElement);

    const promise = showAppDialog({ title: "Test", message: "Msg" });
    expect(normalElement.hasAttribute("inert") || normalElement.inert === true).toBe(true);

    document.querySelector<HTMLButtonElement>(".app-dialog-ok")!.click();
    await promise;
    expect(normalElement.hasAttribute("inert")).toBe(false);
    expect(alreadyInertElement.hasAttribute("inert")).toBe(true);
    normalElement.remove();
    alreadyInertElement.remove();
  });
});

// ---- showAppConfirm ----

describe("showAppConfirm", () => {
  afterEach(() => {
    document.querySelector(".app-dialog-overlay")?.remove();
    document.body.style.overflow = "";
  });

  it("renders confirm and cancel buttons", () => {
    const promise = showAppConfirm({ title: "Title", message: "Body" });
    expect(document.querySelector(".app-dialog-confirm")).toBeTruthy();
    expect(document.querySelector(".app-dialog-cancel")).toBeTruthy();
    document.querySelector<HTMLButtonElement>(".app-dialog-cancel")!.click();
    return promise;
  });

  it("confirm button returns true", async () => {
    const promise = showAppConfirm({ title: "T", message: "M" });
    document.querySelector<HTMLButtonElement>(".app-dialog-confirm")!.click();
    expect(await promise).toBe(true);
  });

  it("cancel button returns false", async () => {
    const promise = showAppConfirm({ title: "T", message: "M" });
    document.querySelector<HTMLButtonElement>(".app-dialog-cancel")!.click();
    expect(await promise).toBe(false);
  });

  it("Esc returns false", async () => {
    const promise = showAppConfirm({ title: "T", message: "M" });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(await promise).toBe(false);
  });

  it("overlay click returns false", async () => {
    const promise = showAppConfirm({ title: "T", message: "M" });
    const overlay = document.querySelector(".app-dialog-overlay")!;
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(await promise).toBe(false);
  });

  it("dialog click does not close", async () => {
    const promise = showAppConfirm({ title: "T", message: "M" });
    const dialog = document.querySelector(".app-dialog")!;
    dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".app-dialog-overlay")).toBeTruthy();
    document.querySelector<HTMLButtonElement>(".app-dialog-confirm")!.click();
    expect(await promise).toBe(true);
  });

  it("danger variant adds danger class", () => {
    const promise = showAppConfirm({ title: "T", message: "M", variant: "danger" });
    expect(document.querySelector(".app-dialog-confirm-danger")).toBeTruthy();
    document.querySelector<HTMLButtonElement>(".app-dialog-cancel")!.click();
    return promise;
  });

  it("custom button text", () => {
    const promise = showAppConfirm({ title: "T", message: "M", confirmText: "削除する", cancelText: "やめる" });
    expect(document.querySelector<HTMLButtonElement>(".app-dialog-confirm")!.textContent).toBe("削除する");
    expect(document.querySelector<HTMLButtonElement>(".app-dialog-cancel")!.textContent).toBe("やめる");
    document.querySelector<HTMLButtonElement>(".app-dialog-cancel")!.click();
    return promise;
  });

  it("cancel button has initial focus", () => {
    const promise = showAppConfirm({ title: "T", message: "M" });
    expect(document.activeElement).toBe(document.querySelector(".app-dialog-cancel"));
    document.querySelector<HTMLButtonElement>(".app-dialog-cancel")!.click();
    return promise;
  });

  it("sets aria-modal and role", () => {
    const promise = showAppConfirm({ title: "T", message: "M" });
    const dialog = document.querySelector(".app-dialog")!;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    document.querySelector<HTMLButtonElement>(".app-dialog-cancel")!.click();
    return promise;
  });

  it("removes overlay after close", async () => {
    const promise = showAppConfirm({ title: "T", message: "M" });
    expect(document.querySelector(".app-dialog-overlay")).toBeTruthy();
    document.querySelector<HTMLButtonElement>(".app-dialog-cancel")!.click();
    await promise;
    expect(document.querySelector(".app-dialog-overlay")).toBeNull();
  });

  it("previous dialog is closed when new one opens", async () => {
    const promise1 = showAppConfirm({ title: "First", message: "M1" });
    expect(document.querySelectorAll(".app-dialog-overlay").length).toBe(1);
    const promise2 = showAppConfirm({ title: "Second", message: "M2" });
    expect(document.querySelectorAll(".app-dialog-overlay").length).toBe(1);
    expect(document.querySelector(".app-dialog-title")!.textContent).toBe("Second");
    document.querySelector<HTMLButtonElement>(".app-dialog-confirm")!.click();
    expect(await promise1).toBe(false);
    expect(await promise2).toBe(true);
  });

  it("does not call native confirm or dialog ask", () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const promise = showAppConfirm({ title: "T", message: "M" });
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
    document.querySelector<HTMLButtonElement>(".app-dialog-cancel")!.click();
    return promise;
  });
});
