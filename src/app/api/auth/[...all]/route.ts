import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getHandler() {
  const [{ toNextJsHandler }, { getAuth }] = await Promise.all([
    import("better-auth/next-js"),
    import("@/server/auth"),
  ]);

  return toNextJsHandler(getAuth());
}

export async function GET(request: NextRequest) {
  const handler = await getHandler();
  return handler.GET(request);
}

export async function POST(request: NextRequest) {
  const handler = await getHandler();
  return handler.POST(request);
}
