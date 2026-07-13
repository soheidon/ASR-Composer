// ---- Status Badge Helpers ----

export type StatusState = "未設定" | "設定済み" | "一時設定" | "接続確認済み" | "認証エラー" | "接続エラー";

export const STATUS_STYLES: Record<StatusState, { badge: string; dot: string }> = {
  "未設定":       { badge: "status-badge status-unconfigured", dot: "status-dot status-dot-unconfigured" },
  "設定済み":     { badge: "status-badge status-configured",   dot: "status-dot status-dot-configured" },
  "一時設定":     { badge: "status-badge status-temporary",    dot: "status-dot status-dot-temporary" },
  "接続確認済み": { badge: "status-badge status-connected",     dot: "status-dot status-dot-connected" },
  "認証エラー":   { badge: "status-badge status-auth-error",    dot: "status-dot status-dot-auth-error" },
  "接続エラー":   { badge: "status-badge status-conn-error",    dot: "status-dot status-dot-conn-error" },
};

export function setStatusBadge(el: HTMLElement | null, state: StatusState) {
  if (!el) return;
  const s = STATUS_STYLES[state];
  el.className = s.badge;
  el.innerHTML = `<span class="${s.dot}"></span>${state}`;
}

type FetchModelsErrorPayload = {
  kind?: string;
  message?: string;
};

export type ClassifiedError = {
  status: StatusState;
  message: string;
};

export function classifyFetchError(err: unknown): ClassifiedError {
  if (err instanceof Error) {
    if (err.message.includes("が設定されていません") || err.message.includes("環境変数名が設定されていません")) {
      return { status: "未設定", message: err.message };
    }
    return { status: "接続エラー", message: err.message };
  }

  if (typeof err === "object" && err !== null) {
    const payload = err as FetchModelsErrorPayload;
    if ("kind" in err) {
      switch (payload.kind) {
        case "not_configured":
          return { status: "未設定", message: payload.message ?? "必要な設定が行われていません。" };
        case "auth_error":
          return { status: "認証エラー", message: payload.message ?? "認証に失敗しました。" };
        case "connection_error":
          return { status: "接続エラー", message: payload.message ?? "サーバーに接続できませんでした。" };
      }
    }
    if (typeof payload.message === "string") {
      return { status: "接続エラー", message: payload.message };
    }
  }

  if (typeof err === "string") {
    if (err.includes("が設定されていません") || err.includes("環境変数名が設定されていません")) {
      return { status: "未設定", message: err };
    }
    return { status: "接続エラー", message: err };
  }

  return { status: "接続エラー", message: "不明なエラーが発生しました。" };
}

// ---- Model Select Population ----

export function populateModelSelect(
  select: HTMLSelectElement,
  models: string[],
  preferredModels: string[],
  savedModel: string | null,
  allowManual: boolean,
): void {
  // プレースホルダーと手動入力を残して他を全削除（optgroup含む）
  const manualOption = select.querySelector('option[value="__manual__"]');

  // optgroupを先に除去
  select.querySelectorAll("optgroup").forEach(g => g.remove());

  // placeholderと__manual__以外のoptionを除去
  while (select.options.length > 1) {
    const opt = select.options[1];
    if (opt.value === "__manual__") break;
    select.remove(1);
  }

  // allowManualがfalseの場合、__manual__オプションを削除
  if (!allowManual && manualOption) {
    manualOption.remove();
  }

  const preferred = new Set(preferredModels);
  const preferredGroup = document.createElement("optgroup");
  preferredGroup.label = "推奨モデル";
  const otherGroup = document.createElement("optgroup");
  otherGroup.label = "その他のモデル";

  models.forEach(m => {
    const opt = new Option(m, m);
    if (preferred.has(m)) {
      preferredGroup.appendChild(opt);
    } else {
      otherGroup.appendChild(opt);
    }
  });

  // 手動入力オプションの前に挿入
  const insertBefore = allowManual ? manualOption : null;
  if (preferredGroup.children.length > 0) {
    select.insertBefore(preferredGroup, insertBefore);
  }
  if (otherGroup.children.length > 0) {
    select.insertBefore(otherGroup, insertBefore);
  }

  // 保存済みモデルが一覧にない場合、optgroupの直前に追加して復元
  if (savedModel && !models.includes(savedModel)) {
    const restoredOpt = new Option(savedModel + " (保存済み)", savedModel);
    const firstGroup = preferredGroup.children.length > 0 ? preferredGroup : otherGroup.children.length > 0 ? otherGroup : null;
    if (firstGroup) {
      select.insertBefore(restoredOpt, firstGroup);
    } else {
      select.appendChild(restoredOpt);
    }
  }

  // 値を復元
  if (savedModel) {
    select.value = savedModel;
  }
}

// ---- App Dialog ----

export type DialogType = "success" | "error" | "info";

export interface ShowDialogOptions {
  title: string;
  message: string;
  type?: DialogType;
}

let closeCurrentDialog: (() => void) | null = null;
let dialogSequence = 0;

export function showAppDialog(options: ShowDialogOptions): Promise<void> {
  closeCurrentDialog?.();

  const previousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const type = options.type ?? "info";
  const dialogId = ++dialogSequence;

  const overlay = document.createElement("div");
  overlay.className = "app-dialog-overlay";

  const dialog = document.createElement("div");
  dialog.className = "app-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");

  const iconSpan = document.createElement("span");
  iconSpan.className = `material-symbols-outlined app-dialog-icon icon-${type}`;
  iconSpan.setAttribute("aria-hidden", "true");
  iconSpan.textContent =
    type === "success" ? "check_circle" : type === "error" ? "error" : "info";

  const titleEl = document.createElement("h3");
  titleEl.className = "app-dialog-title";
  titleEl.id = `app-dialog-title-${dialogId}`;
  titleEl.textContent = options.title;

  const messageEl = document.createElement("p");
  messageEl.className = "app-dialog-message";
  messageEl.id = `app-dialog-message-${dialogId}`;
  messageEl.textContent = options.message;

  dialog.setAttribute("aria-labelledby", titleEl.id);
  dialog.setAttribute("aria-describedby", messageEl.id);

  const okBtn = document.createElement("button");
  okBtn.className = "app-dialog-ok";
  okBtn.type = "button";
  okBtn.textContent = "OK";

  dialog.append(iconSpan, titleEl, messageEl, okBtn);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // 背面操作防止: inert + overflow
  const previousBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";

  const inertStates = Array.from(document.body.children)
    .filter(el => el !== overlay)
    .map(el => ({
      element: el as HTMLElement,
      wasInert: (el as HTMLElement).inert,
    }));
  for (const { element } of inertStates) {
    element.inert = true;
  }

  return new Promise<void>((resolve) => {
    let closed = false;

    const onOkClick = () => close();
    const onOverlayClick = (event: MouseEvent) => {
      if (event.target === overlay) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };

    const close = () => {
      if (closed) return;
      closed = true;

      okBtn.removeEventListener("click", onOkClick);
      overlay.removeEventListener("click", onOverlayClick);
      document.removeEventListener("keydown", onKeyDown);

      overlay.remove();

      for (const { element, wasInert } of inertStates) {
        if (element.isConnected) {
          element.inert = wasInert;
        }
      }
      document.body.style.overflow = previousBodyOverflow;

      if (closeCurrentDialog === close) closeCurrentDialog = null;
      if (previousFocus?.isConnected) previousFocus.focus();
      resolve();
    };

    closeCurrentDialog = close;

    okBtn.addEventListener("click", onOkClick);
    overlay.addEventListener("click", onOverlayClick);
    document.addEventListener("keydown", onKeyDown);

    okBtn.focus();
  });
}
