// ---- Provider Definitions ----

export type ModelSource = "api" | "static" | "manual";
export type ModelFilter = "asr" | "llm" | "all";

export type ProviderDefinition = {
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

export const asrProviders: ProviderDefinition[] = [
  { id: "google_stt", company: "Google Cloud", name: "Speech-to-Text", icon: "graphic_eq", env: "GOOGLE_CLOUD_API_KEY", defaultBaseUrl: "https://speech.googleapis.com/v2", defaultModel: "chirp_2", modelSource: "manual", allowManualModel: true, modelFilter: "asr", staticModels: ["chirp_2"] },
  { id: "openai_audio", company: "OpenAI", name: "Audio API", icon: "graphic_eq", env: "OPENAI_API_KEY", defaultBaseUrl: "https://api.openai.com/v1", modelSource: "api", allowManualModel: true, modelFilter: "asr", preferredModels: ["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"] },
  { id: "azure_speech", company: "Microsoft Azure", name: "Azure Speech", icon: "graphic_eq", env: "AZURE_SPEECH_KEY", defaultBaseUrl: "https://{region}.stt.speech.microsoft.com", modelSource: "manual", allowManualModel: true, modelFilter: "asr" },
  { id: "xiaomi_mimo_asr", company: "Xiaomi MiMo", name: "Speech Recognition", icon: "graphic_eq", env: "XIAOMI_API_KEY", defaultBaseUrl: "https://api.xiaomimimo.com/v1", defaultModel: "mimo-v2.5-asr", modelSource: "static", allowManualModel: false, modelFilter: "asr", staticModels: ["mimo-v2.5-asr"] },
  { id: "groq_speech", company: "Groq", name: "Speech API", icon: "graphic_eq", env: "GROQ_API_KEY", defaultBaseUrl: "https://api.groq.com/openai/v1", modelSource: "api", allowManualModel: true, modelFilter: "asr", preferredModels: ["whisper-large-v3", "whisper-large-v3-turbo"] },
  { id: "deepgram", company: "Deepgram", name: "Speech API", icon: "graphic_eq", env: "DEEPGRAM_API_KEY", defaultBaseUrl: "https://api.deepgram.com/v1", defaultModel: "nova-3", modelSource: "manual", allowManualModel: true, modelFilter: "asr", staticModels: ["nova-3", "nova-2", "nova"] },
  { id: "assemblyai", company: "AssemblyAI", name: "Speech API", icon: "graphic_eq", env: "ASSEMBLYAI_API_KEY", defaultBaseUrl: "https://api.assemblyai.com/v2", defaultModel: "universal-streaming", modelSource: "manual", allowManualModel: true, modelFilter: "asr" },
];

export const llmProviders: ProviderDefinition[] = [
  { id: "openai", company: "OpenAI", name: "GPT", icon: "auto_awesome", env: "OPENAI_API_KEY", defaultBaseUrl: "https://api.openai.com/v1", modelSource: "api", allowManualModel: true, modelFilter: "llm", preferredModels: ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4.1-mini"] },
  { id: "anthropic", company: "Anthropic", name: "Claude", icon: "auto_awesome", env: "ANTHROPIC_API_KEY", defaultBaseUrl: "https://api.anthropic.com", modelSource: "api", allowManualModel: true, modelFilter: "llm", preferredModels: ["claude-sonnet-4-20250514", "claude-haiku-4-5-20251001", "claude-opus-4-8"] },
  { id: "gemini", company: "Google", name: "Gemini", icon: "auto_awesome", env: "GEMINI_API_KEY", defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta", modelSource: "api", allowManualModel: true, modelFilter: "llm", preferredModels: ["gemini-2.5-pro", "gemini-2.5-flash"] },
  { id: "deepseek", company: "DeepSeek", name: "DeepSeek Models", icon: "auto_awesome", env: "DEEPSEEK_API_KEY", defaultBaseUrl: "https://api.deepseek.com", modelSource: "api", allowManualModel: true, modelFilter: "llm", preferredModels: ["deepseek-chat", "deepseek-reasoner"] },
  { id: "openrouter", company: "OpenRouter", name: "Model Gateway", icon: "auto_awesome", env: "OPENROUTER_API_KEY", defaultBaseUrl: "https://openrouter.ai/api/v1", modelSource: "api", allowManualModel: true, modelFilter: "llm" },
  { id: "mistral", company: "Mistral AI", name: "Mistral", icon: "auto_awesome", env: "MISTRAL_API_KEY", defaultBaseUrl: "https://api.mistral.ai/v1", modelSource: "api", allowManualModel: true, modelFilter: "llm", preferredModels: ["mistral-large-latest", "mistral-small-latest"] },
  { id: "groq", company: "Groq", name: "GroqCloud", icon: "auto_awesome", env: "GROQ_API_KEY", defaultBaseUrl: "https://api.groq.com/openai/v1", modelSource: "api", allowManualModel: true, modelFilter: "llm", preferredModels: ["llama-3.3-70b-versatile", "qwen-qwq-32b"] },
  { id: "ollama", company: "Ollama", name: "ローカルLLMランタイム", icon: "auto_awesome", env: "", defaultBaseUrl: "http://localhost:11434", modelSource: "api", allowManualModel: true, modelFilter: "llm" },
  { id: "xiaomi_mimo", company: "Xiaomi MiMo", name: "MiMo", icon: "auto_awesome", env: "XIAOMI_API_KEY", defaultBaseUrl: "https://api.xiaomimimo.com/v1", modelSource: "api", allowManualModel: true, modelFilter: "llm", defaultModel: "mimo-v2.5", preferredModels: ["mimo-v2.5", "mimo-v2.5-pro"] },
  { id: "moonshot", company: "Moonshot AI", name: "Kimi", icon: "auto_awesome", env: "MOONSHOT_API_KEY", defaultBaseUrl: "https://api.moonshot.ai/v1", modelSource: "api", allowManualModel: true, modelFilter: "llm", preferredModels: ["kimi-k2"] },
  { id: "minimax", company: "MiniMax", name: "MiniMax Models", icon: "auto_awesome", env: "MINIMAX_API_KEY", defaultBaseUrl: "https://api.minimax.io/v1", modelSource: "api", allowManualModel: true, modelFilter: "llm", preferredModels: ["MiniMax-M1.2"] },
  { id: "zai_glm", company: "Z.AI", name: "GLM", icon: "auto_awesome", env: "ZAI_API_KEY", defaultBaseUrl: "https://api.z.ai/api/paas/v4", modelSource: "manual", allowManualModel: true, modelFilter: "llm" },
];

export const cloudLlmProviders = llmProviders.filter(p => p.id !== "ollama");
