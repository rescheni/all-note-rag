import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/** Public PWA / static assets that must work without a session (install + offline shell). */
function isPublicAsset(pathname: string) {
  if (
    pathname === "/manifest.webmanifest" ||
    pathname === "/sw.js" ||
    pathname === "/favicon.ico" ||
    pathname === "/apple-touch-icon.png" ||
    pathname.startsWith("/icon-")
  ) {
    return true;
  }
  return false;
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (
    pathname === "/login" ||
    pathname.startsWith("/login/") ||
    pathname === "/register" ||
    pathname.startsWith("/register/") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/v1") ||
    isPublicAsset(pathname)
  ) {
    return NextResponse.next();
  }
  const session = req.cookies.get("hub_session")?.value;
  if (!session) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}
