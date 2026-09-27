import type { InvokeFn } from "./ollama-provider";

export interface SavedProviderSettings {
  env_name?: string;
  base_url?: string;
  default_model?: string;
  options?: Record<string, string>;
}

export interface SavedAppSettings {
  providers: Record<string, SavedProviderSettings>;
  asr_mode: string;
  asr_engine: string;
  asr_languages: Record<string, string>;
  speaker_diarization: boolean;
  num_speakers: string;
  output_path: string;
  correction_enabled?: boolean;
  correction_provider?: string;
  correction_model?: string;
  correction_use_dictionary?: boolean;
  correction_use_background?: boolean;
}

export interface SavedCorrectionSettings {
  correction_enabled: boolean;
  correction_provider: string;
  correction_model: string;
  correction_use_dictionary?: boolean;
  correction_use_background?: boolean;
}

export interface ResolvedCorrectionProvider {
  providerId: "ollama";
  baseUrl: string;
  model: string;
  useDictionary: boolean;
  useBackground: boolean;
}

async function defaultInvokeTauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

/**
 * 補完LLMの設定とモデルを解決する共通ヘルパー。
 * 優先順位:
 * 1. correction_model (明示設定)
 * 2. Ollama設定の default_model (フォールバック)
 * 3. どちらも未設定なら null
 */
export async function resolveCorrectionProvider(
  invokeFn: InvokeFn = defaultInvokeTauri,
): Promise<ResolvedCorrectionProvider | null> {
  let settings: SavedAppSettings;
  try {
    settings = await invokeFn<SavedAppSettings>("load_api_settings");
  } catch (e) {
    console.warn("load_api_settings failed in resolveCorrectionProvider:", e);
    return null;
  }

  const providerId = settings?.correction_provider?.trim() || "ollama";
  if (providerId !== "ollama") {
    console.warn(`Unsupported correction_provider: "${providerId}". Only "ollama" is currently supported.`);
    return null;
  }

  const ollama = settings?.providers?.["ollama"];
  let baseUrl = "http://localhost:11434";
  if (ollama?.base_url && ollama.base_url.trim().length > 0) {
    baseUrl = ollama.base_url.trim();
  }

  // 1. correction_model 優先
  let selectedModel = settings?.correction_model?.trim() || "";
  // 2. 空なら Ollama default_model フォールバック
  if (!selectedModel && ollama?.default_model && ollama.default_model.trim().length > 0) {
    selectedModel = ollama.default_model.trim();
  }

  if (!selectedModel) {
    return null;
  }

  return {
    providerId: "ollama",
    baseUrl,
    model: selectedModel,
    useDictionary: settings?.correction_use_dictionary !== false,
    useBackground: settings?.correction_use_background !== false,
  };
}

export async function saveCorrectionSettings(
  settings: SavedCorrectionSettings,
  invokeFn: InvokeFn = defaultInvokeTauri,
): Promise<void> {
  await invokeFn("save_correction_settings", {
    enabled: settings.correction_enabled,
    provider: settings.correction_provider,
    model: settings.correction_model,
    useDictionary: settings.correction_use_dictionary,
    useBackground: settings.correction_use_background,
  });
}
