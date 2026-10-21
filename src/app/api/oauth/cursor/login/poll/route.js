import { NextResponse } from "next/server";
import {
  discardCursorLoginSession,
  persistCursorLoginTokens,
  pollCursorLoginSession,
  tokensFromCursorCallback,
} from "@/lib/oauth/cursorLogin";

/**
 * POST /api/oauth/cursor/login/poll
 * One tick of the Cursor login poll. A pasted callback URL that already
 * carries the session is saved directly; otherwise Cursor's 404 means the
 * browser approval is still pending.
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const pasted = tokensFromCursorCallback(body?.callbackUrl);
    if (pasted?.error) {
      return NextResponse.json({ error: pasted.error, fatal: true }, { status: 400 });
    }
    if (pasted?.accessToken && pasted?.refreshToken) {
      discardCursorLoginSession(body?.loginId);
      const connection = await persistCursorLoginTokens(pasted);
      return NextResponse.json({ success: true, connection });
    }

    const result = await pollCursorLoginSession(body?.loginId);

    if (result.pending) {
      return NextResponse.json({ pending: true });
    }
    if (!result.tokens) {
      const status = result.fatal ? 400 : 502;
      return NextResponse.json({ error: result.error || "Cursor login failed", fatal: !!result.fatal }, { status });
    }

    const connection = await persistCursorLoginTokens(result.tokens);
    return NextResponse.json({ success: true, connection });
  } catch (error) {
    console.log("Cursor login poll error:", error.message);
    return NextResponse.json({ error: "Cursor login failed" }, { status: 500 });
  }
}
