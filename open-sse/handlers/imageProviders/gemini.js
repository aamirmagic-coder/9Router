// Google Gemini adapter (Nano Banana models)
import { nowSec, urlToBase64 } from "./_base.js";
import { PROVIDER_MEDIA } from "../../providers/index.js";

const BASE_URL = PROVIDER_MEDIA["gemini"]?.imageConfig?.baseUrl;

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

  const dataUriMatch = input.match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (dataUriMatch) {
    return { inlineData: { mimeType: dataUriMatch[1], data: dataUriMatch[2] } };
  }

  if (input.startsWith("http://") || input.startsWith("https://")) {
    try {
      const b64 = await urlToBase64(input);
      if (b64) return { inlineData: { mimeType: "image/png", data: b64 } };
    } catch {
      // Fall through
    }
  }

  const clean = input.replace(/\s+/g, "");
  if (/^[A-Za-z0-9+/=]+$/.test(clean) && clean.length > 50) {
    return { inlineData: { mimeType: "image/png", data: clean } };
  }
  return null;
}

export default {
  buildUrl: (model, creds) => {
    const apiKey = creds?.apiKey || creds?.accessToken;
    const modelId = model.replace(/^models\//, "");
    return `${BASE_URL}/${modelId}:generateContent?key=${encodeURIComponent(apiKey)}`;
  },
  buildHeaders: () => ({ "Content-Type": "application/json" }),
  buildBody: async (_model, body) => {
    const parts = [];
    const rawImages = [];
    if (Array.isArray(body.images)) rawImages.push(...body.images);
    else if (body.images) rawImages.push(body.images);
    if (Array.isArray(body.image)) rawImages.push(...body.image);
    else if (body.image) rawImages.push(body.image);
    if (body.input_image && !body.image && !body.images) rawImages.push(body.input_image);
    if (body.image_url && !body.image && !body.images) rawImages.push(body.image_url);

    for (const img of rawImages) {
      const inlineData = await resolveImageInput(img);
      if (inlineData) parts.push(inlineData);
    }
    if (body.prompt) {
      parts.push({ text: body.prompt });
    } else if (parts.length > 0) {
      parts.push({ text: "Generate an image based on the input" });
    }

    return {
      contents: [{ parts }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
    };
  },
  normalize: (responseBody, prompt) => {
    const parts = responseBody.candidates?.[0]?.content?.parts || [];
    const images = parts
      .map((p) => p.inlineData || p.inline_data)
      .filter((id) => id?.data)
      .map((id) => ({ b64_json: id.data }));
    return {
      created: nowSec(),
      data: images.length > 0 ? images : [{ b64_json: "", revised_prompt: prompt }],
    };
  },
};
