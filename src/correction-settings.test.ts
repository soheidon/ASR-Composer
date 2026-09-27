import { describe, it, expect, vi } from "vitest";
import {
  resolveCorrectionProvider,
  saveCorrectionSettings,
  type SavedAppSettings,
} from "./correction-settings";

describe("correction-settings.ts", () => {
  describe("resolveCorrectionProvider", () => {
    it("Priority 1: correction_model が設定されている場合はそれを最優先で使用する", async () => {
      const mockSettings: SavedAppSettings = {
        providers: {
          ollama: {
            base_url: "http://localhost:11434",
            default_model: "fallback-model:7b",
          },
        },
        asr_mode: "local",
        asr_engine: "reazonspeech",
        asr_languages: {},
        speaker_diarization: true,
        num_speakers: "auto",
        output_path: "",
        correction_enabled: true,
        correction_provider: "ollama",
        correction_model: "maternion/mimo-v2.6:9b",
      };

      const mockInvoke = vi.fn().mockImplementation(async (cmd: string) => {
        if (cmd === "load_api_settings") return mockSettings;
        throw new Error(`Unexpected command: ${cmd}`);
      });

      const resolved = await resolveCorrectionProvider(mockInvoke as any);
      expect(resolved).toEqual({
        providerId: "ollama",
        baseUrl: "http://localhost:11434",
        model: "maternion/mimo-v2.6:9b",
        mode: "standard",
        useDictionary: true,
        useBackground: true,
      });
    });

    it("Priority 2: correction_model が空文字で Ollama default_model がある場合はフォールバックする", async () => {
      const mockSettings: SavedAppSettings = {
        providers: {
          ollama: {
            base_url: "http://192.168.1.100:11434",
            default_model: "default-ollama:latest",
          },
        },
        asr_mode: "local",
        asr_engine: "reazonspeech",
        asr_languages: {},
        speaker_diarization: true,
        num_speakers: "auto",
        output_path: "",
        correction_enabled: true,
        correction_provider: "ollama",
        correction_model: "",
        correction_mode: "minimal",
        correction_use_dictionary: false,
        correction_use_background: true,
      };

      const mockInvoke = vi.fn().mockImplementation(async (cmd: string) => {
        if (cmd === "load_api_settings") return mockSettings;
        throw new Error(`Unexpected command: ${cmd}`);
      });

      const resolved = await resolveCorrectionProvider(mockInvoke as any);
      expect(resolved).toEqual({
        providerId: "ollama",
        baseUrl: "http://192.168.1.100:11434",
        model: "default-ollama:latest",
        mode: "minimal",
        useDictionary: false,
        useBackground: true,
      });
    });

    it("Correction Mode: minimal / standard / aggressive を正しく解決する", async () => {
      for (const mode of ["minimal", "standard", "aggressive"] as const) {
        const mockSettings: SavedAppSettings = {
          providers: { ollama: { base_url: "http://localhost:11434", default_model: "test-model" } },
          asr_mode: "local",
          asr_engine: "reazonspeech",
          asr_languages: {},
          speaker_diarization: true,
          num_speakers: "auto",
          output_path: "",
          correction_mode: mode,
        };
        const mockInvoke = vi.fn().mockResolvedValue(mockSettings);
        const resolved = await resolveCorrectionProvider(mockInvoke as any);
        expect(resolved?.mode).toBe(mode);
      }
    });

    it("Legacy Settings: correction_mode 未定義時は 'standard' にデフォルト設定される", async () => {
      const mockSettings: SavedAppSettings = {
        providers: { ollama: { base_url: "http://localhost:11434", default_model: "test-model" } },
        asr_mode: "local",
        asr_engine: "reazonspeech",
        asr_languages: {},
        speaker_diarization: true,
        num_speakers: "auto",
        output_path: "",
      };
      const mockInvoke = vi.fn().mockResolvedValue(mockSettings);
      const resolved = await resolveCorrectionProvider(mockInvoke as any);
      expect(resolved?.mode).toBe("standard");
    });

    it("Invalid Mode: 不正な mode 値が渡された場合は 'standard' に安全にフォールバックする", async () => {
      const mockSettings: SavedAppSettings = {
        providers: { ollama: { base_url: "http://localhost:11434", default_model: "test-model" } },
        asr_mode: "local",
        asr_engine: "reazonspeech",
        asr_languages: {},
        speaker_diarization: true,
        num_speakers: "auto",
        output_path: "",
        correction_mode: "invalid-mode" as any,
      };
      const mockInvoke = vi.fn().mockResolvedValue(mockSettings);
      const resolved = await resolveCorrectionProvider(mockInvoke as any);
      expect(resolved?.mode).toBe("standard");
    });

    it("Priority 3: correction_model も default_model も空の場合は null を返す", async () => {
      const mockSettings: SavedAppSettings = {
        providers: {
          ollama: {
            base_url: "http://localhost:11434",
            default_model: "",
          },
        },
        asr_mode: "local",
        asr_engine: "reazonspeech",
        asr_languages: {},
        speaker_diarization: true,
        num_speakers: "auto",
        output_path: "",
        correction_enabled: true,
        correction_provider: "ollama",
        correction_model: "",
      };

      const mockInvoke = vi.fn().mockImplementation(async (cmd: string) => {
        if (cmd === "load_api_settings") return mockSettings;
        throw new Error(`Unexpected command: ${cmd}`);
      });

      const resolved = await resolveCorrectionProvider(mockInvoke as any);
      expect(resolved).toBeNull();
    });

    it("load_api_settings が失敗した場合は null を返す", async () => {
      const mockInvoke = vi.fn().mockRejectedValue(new Error("Disk IO error"));
      const resolved = await resolveCorrectionProvider(mockInvoke as any);
      expect(resolved).toBeNull();
    });
  });

  describe("saveCorrectionSettings", () => {
    it("save_correction_settings コマンドを正しい引数（modeを含む）で呼び出す", async () => {
      const mockInvoke = vi.fn().mockResolvedValue(undefined);

      await saveCorrectionSettings(
        {
          correction_enabled: true,
          correction_provider: "ollama",
          correction_model: "maternion/mimo-v2.6:9b",
          correction_mode: "aggressive",
          correction_use_dictionary: true,
          correction_use_background: false,
        },
        mockInvoke as any,
      );

      expect(mockInvoke).toHaveBeenCalledWith("save_correction_settings", {
        enabled: true,
        provider: "ollama",
        model: "maternion/mimo-v2.6:9b",
        mode: "aggressive",
        useDictionary: true,
        useBackground: false,
      });
    });
  });
});
