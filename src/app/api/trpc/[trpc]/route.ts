export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getHandler(req: Request) {
  const [{ fetchRequestHandler }, { appRouter }, { createTRPCContext }] =
    await Promise.all([
      import("@trpc/server/adapters/fetch"),
      import("@/server/api/root"),
      import("@/server/api/trpc"),
    ]);

  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () => createTRPCContext({ headers: req.headers }),
    onError:
      process.env.NODE_ENV === "development" ? console.error : console.error,
  });
}

export async function GET(req: Request) {
  return getHandler(req);
}

export async function POST(req: Request) {
  return getHandler(req);
}
