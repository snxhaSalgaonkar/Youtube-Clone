import { NextResponse } from "next/server";

const protectedRoutes = ["/upload", "/history", "/channel"];
const authRoutes = ["/login", "/register"];

export function middleware(request) {
  const { pathname } = request.nextUrl;
  const token = request.cookies.get("accessToken")?.value;

  const isProtected = protectedRoutes.some((r) => pathname.startsWith(r));
  const isAuthRoute = authRoutes.some((r) => pathname.startsWith(r));

  // Only redirect to login if it's explicitly a protected route
  if (isProtected && !token) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // If already logged in, don't show login/register page
  if (isAuthRoute && token) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|public).*)"],
};
