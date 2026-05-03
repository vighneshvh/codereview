export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getHandlers() {
  const [{ serve }, { inngest, functions }] = await Promise.all([
    import("inngest/next"),
    import("@/server/inngest"),
  ]);

  return serve({
    client: inngest,
    functions,
  });
}

export async function GET(request: Request) {
  const handlers = await getHandlers();
  return handlers.GET(request);
}

export async function POST(request: Request) {
  const handlers = await getHandlers();
  return handlers.POST(request);
}

export async function PUT(request: Request) {
  const handlers = await getHandlers();
  return handlers.PUT(request);
}
