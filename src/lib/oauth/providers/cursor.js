import { CURSOR_CONFIG } from "../constants/oauth.js";

const cursor = {
  config: CURSOR_CONFIG,
  // Browser login lives on /api/oauth/cursor/login/* (CLI deep-control poll).
  // The generic OAuth router still treats Cursor as import-only.
  flowType: "import_token",
  mapTokens: (tokens) => ({
    accessToken: tokens.accessToken,
    refreshToken: null, // Cursor doesn't have public refresh endpoint
    expiresIn: tokens.expiresIn || 86400,
    providerSpecificData: {
      machineId: tokens.machineId,
      authMethod: "imported",
    },
  }),
};

export default cursor;
