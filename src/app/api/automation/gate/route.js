import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  checkPassword,
  issueGateCookie,
  clearGateCookie,
  isGateOpen,
} from "@/lib/automation/gate";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, must-revalidate" };

/**
 * Status gerbang. Dipakai halaman untuk memutuskan menampilkan kunci atau isi —
 * dan supaya membuka menu tidak perlu menunggu percobaan API pertama gagal.
 */
export async function GET(request) {
  return NextResponse.json({ unlocked: isGateOpen(request) }, { headers: NO_STORE });
}

/** Buka gerbang. */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: NO_STORE });
  }

  if (!checkPassword(body?.password)) {
    // Sengaja tidak menyebut "password salah" vs "format salah": tidak ada
    // gunanya memberi tahu penebak seberapa dekat mereka.
    return NextResponse.json({ error: "Wrong password" }, { status: 401, headers: NO_STORE });
  }

  const cookieStore = await cookies();
  const c = issueGateCookie();
  cookieStore.set(c.name, c.value, {
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    path: c.path,
  });

  return NextResponse.json({ unlocked: true }, { headers: NO_STORE });
}

/** Kunci lagi — untuk operator yang memakai mesin bersama. */
export async function DELETE() {
  const cookieStore = await cookies();
  const c = clearGateCookie();
  cookieStore.set(c.name, c.value, { path: c.path, maxAge: 0 });
  return NextResponse.json({ unlocked: false }, { headers: NO_STORE });
}
