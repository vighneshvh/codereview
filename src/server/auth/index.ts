import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { db } from "../db";

let authInstance: ReturnType<typeof betterAuth> | null = null;

export function getAuth() {
  if (authInstance) {
    return authInstance;
  }

  const githubClientId = process.env.GITHUB_CLIENT_ID;
  const githubClientSecret = process.env.GITHUB_CLIENT_SECRET;
  const betterAuthUrl = process.env.BETTER_AUTH_URL;

  authInstance = betterAuth({
    database: prismaAdapter(db, {
      provider: "postgresql", // or "mysql", "postgresql", ...etc
    }),
    emailAndPassword: {
      enabled: true,
    },
    socialProviders:
      githubClientId && githubClientSecret
        ? {
            github: {
              clientId: githubClientId,
              clientSecret: githubClientSecret,
              scope: ["read:user", "user:email", "repo"],
            },
          }
        : {},
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ["github"],
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // 24 hours
      cookieCache: {
        enabled: true,
        maxAge: 60 * 5, // 5 minutes
      },
    },
    trustedOrigins: betterAuthUrl ? [betterAuthUrl] : [],
  });

  return authInstance;
}

export type Session = ReturnType<typeof getAuth>["$Infer"]["Session"];
