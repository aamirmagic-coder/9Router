import { resolveOllamaLocalHost } from "../../config/providers.js";
import { responseToBase64, throwUpstreamError } from "./_base.js";

const DEFAULT_MODEL = "phonon";
const DEFAULT_VOICE = "default";

export default {
  async synthesize(text, model, credentials, responseFormat = "mp3") {
    const rawHost = resolveOllamaLocalHost(credentials);
    const host = String(rawHost)
      .replace(/\/+$/, "")
      .replace(/\/v1\/audio\/speech$/, "")
      .replace(/\/v1$/, "");

    let ttsModel = DEFAULT_MODEL;
    let voice = DEFAULT_VOICE;

    if (model) {
      const parts = String(model).split("/").filter(Boolean);
      if (parts.length >= 2) {
        ttsModel = parts[0];
        voice = parts.slice(1).join("/");
      } else if (parts.length === 1) {
        ttsModel = parts[0];
      }
    }

    // Ollama /v1/audio/speech natively supports "wav" or "pcm".
    // If client requested "mp3" or "json" (or unspecified), request "wav" from Ollama.
    const upstreamFormat = (responseFormat === "pcm") ? "pcm" : "wav";

    const payload = {
      model: ttsModel,
      input: text,
      voice,
      response_format: upstreamFormat,
    };

    const headers = {
      "Content-Type": "application/json",
    };
    if (credentials?.apiKey) {
      headers["Authorization"] = `Bearer ${credentials.apiKey}`;
    }

    let res;
    try {
      res = await fetch(`${host}/v1/audio/speech`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
    } catch (err) {
      if (err.cause?.code === "ECONNREFUSED" || err.code === "ECONNREFUSED" || err.message?.includes("fetch failed")) {
        throw new Error(`Cannot connect to Ollama at ${host}. Please ensure Ollama is running (e.g. 'ollama serve').`);
      }
      throw err;
    }

    if (!res.ok) {
      await throwUpstreamError(res);
    }

    return responseToBase64(res, responseFormat || "wav");
  },
};
