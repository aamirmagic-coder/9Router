import { BaseExecutor } from "./base.js";
import { stripUnsupportedParams } from "../translator/concerns/paramSupport.js";

export class NvidiaExecutor extends BaseExecutor {
  constructor() {
    super("nvidia", { format: "openai" });
  }

  transformRequest(model, body, stream, credentials) {
    // Strip provider prefix from model (nvidia/nemotron-3-ultra-550b-a55b -> nemotron-3-ultra-550b-a55b)
    const cleanModel = model?.replace(/^nvidia\//, "") || model;
    
    // Apply base transformations
    let transformed = super.transformRequest(cleanModel, body, stream, credentials);
    
    // Also strip unsupported params like 'text' (handled by stripUnsupportedParams via base)
    // But ensure model is clean
    if (transformed && typeof transformed === "object") {
      transformed.model = cleanModel;
    }
    
    return transformed;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    // NVIDIA uses a single endpoint for chat completions
    return "https://integrate.api.nvidia.com/v1/chat/completions";
  }
}
