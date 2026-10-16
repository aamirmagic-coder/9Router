import { mintMetaCodeKey } from "../../../../open-sse/services/metaCode.js";
import { META_CODE_CONFIG } from "../constants/oauth.js";

const metaCode = {
  config: META_CODE_CONFIG,
  flowType: "device_code",
  requestDeviceCode: async (config) => {
    if (!config.clientId) {
      throw new Error("Meta Code OAuth client not configured: set META_CODE_OAUTH_CLIENT_ID");
    }

    const response = await fetch(config.deviceCodeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ client_id: config.clientId }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Meta Code device code request failed: ${error}`);
    }

    return await response.json();
  },
  pollToken: async (config, deviceCode) => {
    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: config.clientId,
      }),
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: "invalid_response", error_description: text };
    }

    const pending = data?.error === "authorization_pending" || data?.error === "slow_down";
    return { ok: response.ok || pending, data };
  },
  postExchange: (tokens) => mintMetaCodeKey(tokens.access_token),
  mapTokens: (tokens, extra) => ({
    accessToken: extra.api_key,
    refreshToken: tokens.access_token,
    expiresAt: null,
    email: extra.user_email,
    displayName: extra.user_full_name,
    providerSpecificData: {
      authMethod: "device_code",
      subsTier: extra.subs_tier_name || null,
      isSubsActive: !!extra.is_subs_active,
    },
  }),
};

export default metaCode;
