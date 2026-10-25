// Antigravity image adapter - delegates to the executor for correct request
// envelope (project, model, requestType, sessionId) and auth headers.
import { nowSec, sizeToAspectRatio, urlToBase64 } from "./_base.js";
import { getExecutor } from "../../executors/index.js";

// Convert image input (data URI, raw base64, URL, or object) to Gemini inlineData part
async function resolveImageInput(input) {
  if (!input) return null;
  if (typeof input === "object") {
    if (input.inlineData) return input;
    if (input.inline_data) {
      return { inlineData: { mimeType: input.inline_data.mime_type || "image/png", data: input.inline_data.data } };
    }
    if (input.url && typeof input.url === "string") return await resolveImageInput(input.url);
    if (input.image_url?.url && typeof input.image_url.url === "string") return await resolveImageInput(input.image_url.url);
    if (input.b64_json && typeof input.b64_json === "string") return await resolveImageInput(input.b64_json);
    if (input.data && typeof input.data === "string") {
      const mime = input.mimeType || input.mime_type || "image/png";
      return { inlineData: { mimeType: mime, data: input.data } };
    }
  }
  if (typeof input !== "string") return null;

  // data:image/png;base64,... format
  const dataUriMatch = input.match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (dataUriMatch) {
    return { inlineData: { mimeType: dataUriMatch[1], data: dataUriMatch[2] } };
  }

  // HTTP(S) URL
  if (input.startsWith("http://") || input.startsWith("https://")) {
    try {
      const b64 = await urlToBase64(input);
      if (b64) {
        return { inlineData: { mimeType: "image/png", data: b64 } };
      }
    } catch {
      // Fall through
    }
  }

  // Raw base64 string (assume PNG)
  const clean = input.replace(/\s+/g, "");
  if (/^[A-Za-z0-9+/=]+$/.test(clean) && clean.length > 50) {
    return { inlineData: { mimeType: "image/png", data: clean } };
  }
  return null;
}

export default {
  // Delegate to executor instead of building URL/headers/body manually
  useExecutor: true,

  // Stubs - required by imageGenerationCore interface but unused with useExecutor
  buildUrl: () => "",
  buildHeaders: () => ({}),
  buildBody: () => ({}),

  async executeViaExecutor(model, body, credentials, log) {
    const executor = getExecutor("antigravity");
    if (!executor) throw new Error("Antigravity executor not found");

    // Ensure we use an image model for image generation
    const isImageModel = (m) => /image|imagen|image-generation/i.test(m || "");
    let targetModel = isImageModel(model) ? model : "gemini-3.1-flash-image";

    // If body.size is provided, resolve aspect ratio and append to model
    if (body.size && typeof body.size === "string") {
      const ratio = sizeToAspectRatio(body.size);
      const suffix = ratio.replace(":", "x");
      if (!targetModel.includes(suffix)) {
        targetModel = `${targetModel}-${suffix}`;
      }
    }

    // Build parts: input images for editing + text prompt
    const parts = [];
    const rawImages = [];
    if (Array.isArray(body.images)) {
      rawImages.push(...body.images);
    } else if (body.images) {
      rawImages.push(body.images);
    }
    if (Array.isArray(body.image)) {
      rawImages.push(...body.image);
    } else if (body.image) {
      rawImages.push(body.image);
    }
    if (body.input_image && !body.image && !body.images) {
      rawImages.push(body.input_image);
    }
    if (body.image_url && !body.image && !body.images) {
      rawImages.push(body.image_url);
    }

    for (const img of rawImages) {
      const inlineData = await resolveImageInput(img);
      if (inlineData) parts.push(inlineData);
    }

    if (body.prompt) {
      parts.push({ text: body.prompt });
    } else if (parts.length > 0) {
      parts.push({ text: "Generate an image based on the input" });
    }

    const chatBody = {
      contents: [{ role: "user", parts }],
    };

    const result = await executor.execute({
      model: targetModel,
      body: chatBody,
      stream: false,
      credentials,
      log,
    });

    if (!result.response.ok) {
      const text = await result.response.text();
      throw new Error(text || `HTTP ${result.response.status}`);
    }

    return result.response.json();
  },

  normalize: (responseBody, prompt) => {
    const candidates = responseBody.candidates || responseBody.response?.candidates || [];
    const parts = candidates[0]?.content?.parts || [];
    const images = parts
      .map((p) => p.inlineData || p.inline_data)
      .filter((id) => id?.data)
      .map((id) => ({
        b64_json: id.data,
      }));
    return {
      created: nowSec(),
      data: images.length > 0 ? images : [{ b64_json: "", revised_prompt: prompt }],
    };
  },
};
