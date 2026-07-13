import { describe, it, expect } from "vitest";
import { asrProviders, llmProviders, cloudLlmProviders } from "./providers";

describe("asrProviders", () => {
  it("has the expected id, company, name in order", () => {
    expect(asrProviders.map(({ id, company, name }) => ({ id, company, name }))).toEqual([
      { id: "openai_audio", company: "OpenAI", name: "Audio API" },
      { id: "groq_speech", company: "Groq", name: "Speech API" },
      { id: "deepgram", company: "Deepgram", name: "Speech API" },
      { id: "assemblyai", company: "AssemblyAI", name: "Speech API" },
      { id: "google_stt", company: "Google Cloud", name: "Speech-to-Text" },
      { id: "azure_speech", company: "Microsoft Azure", name: "Azure Speech" },
      { id: "xiaomi_mimo_asr", company: "Xiaomi MiMo", name: "Speech Recognition" },
    ]);
  });
});

describe("llmProviders", () => {
  it("has the expected id, company, name in order", () => {
    expect(llmProviders.map(({ id, company, name }) => ({ id, company, name }))).toEqual([
      { id: "openai", company: "OpenAI", name: "GPT" },
      { id: "anthropic", company: "Anthropic", name: "Claude" },
      { id: "gemini", company: "Google", name: "Gemini" },
      { id: "deepseek", company: "DeepSeek", name: "DeepSeek Models" },
      { id: "openrouter", company: "OpenRouter", name: "Model Gateway" },
      { id: "mistral", company: "Mistral AI", name: "Mistral" },
      { id: "groq", company: "Groq", name: "GroqCloud" },
      { id: "ollama", company: "Ollama", name: "ローカルLLMランタイム" },
      { id: "xiaomi_mimo", company: "Xiaomi MiMo", name: "MiMo" },
      { id: "moonshot", company: "Moonshot AI", name: "Kimi" },
      { id: "minimax", company: "MiniMax", name: "MiniMax Models" },
      { id: "zai_glm", company: "Z.AI", name: "GLM" },
    ]);
  });
});

describe("cloudLlmProviders", () => {
  it("excludes ollama", () => {
    expect(cloudLlmProviders.find(p => p.id === "ollama")).toBeUndefined();
  });

  it("maintains order from llmProviders with ollama removed", () => {
    const expected = llmProviders.filter(p => p.id !== "ollama").map(p => p.id);
    expect(cloudLlmProviders.map(p => p.id)).toEqual(expected);
  });
});

describe("provider ID uniqueness", () => {
  it("has no duplicate IDs within asrProviders", () => {
    const ids = asrProviders.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has no duplicate IDs within llmProviders", () => {
    const ids = llmProviders.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has no duplicate IDs across all providers", () => {
    const allIds = [...asrProviders.map(p => p.id), ...llmProviders.map(p => p.id)];
    expect(new Set(allIds).size).toBe(allIds.length);
  });
});
