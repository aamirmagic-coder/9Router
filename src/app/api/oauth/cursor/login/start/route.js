import { NextResponse } from "next/server";
import { createCursorLoginSession } from "@/lib/oauth/cursorLogin";

/**
 * POST /api/oauth/cursor/login/start
 * Begin a Cursor CLI browser login. The PKCE verifier stays on the server.
 */
export async function POST() {
  try {
    const session = createCursorLoginSession();
    return NextResponse.json({
      loginId: session.loginId,
      loginUrl: session.loginUrl,
    });
  } catch (error) {
    console.log("Cursor login start error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 429 });
  }
}
