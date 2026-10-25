export default {
  id: "ollama-local",
  priority: 50,
  hasFree: true,
  alias: "ollama-local",
  display: {
    name: "Ollama Local",
    icon: "cloud",
    color: "#ffffffff",
    textIcon: "OL",
    website: "https://ollama.com",
  },
  category: "apikey",
  transport: {
    baseUrl: "http://localhost:11434/api/chat",
    format: "ollama",
  },
  models: [
    { id: "clef", name: "Clef", kind: "systemone" },
    { id: "clef-flash", name: "Clef Flash", kind: "systemone" },
    { id: "phonon", name: "Phonon", kind: "tts", params: ["voice", "response_format"] },
  ],
  serviceKinds: ["llm", "systemone", "tts"],
  systemoneConfig: {
    baseUrl: "http://localhost:11434/v1/systemone",
    // Saved host (providerSpecificData.baseUrl) is joined with this path.
    path: "/v1/systemone",
  },
  ttsConfig: {
    baseUrl: "http://localhost:11434/v1/audio/speech",
    path: "/v1/audio/speech",
    defaultModel: "phonon",
    authType: "apikey",
    format: "openai",
  },
};
