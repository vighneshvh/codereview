import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { inngest } from "@/server/inngest";
import {
  fetchPullRequest,
  getGitHubAccessToken,
} from "@/server/services/github";

const FILE_COMMENT_SCHEMA = z.object({
  file: z.string().min(1),
  severity: z.enum(["critical", "high", "medium", "low"]).optional(),
});

type Severity = "critical" | "high" | "medium" | "low";

const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 8,
  high: 5,
  medium: 3,
  low: 1,
};

function parseReviewComments(input: unknown): Array<{ file: string; severity: Severity }> {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((comment) => {
      const parsed = FILE_COMMENT_SCHEMA.safeParse(comment);
      if (!parsed.success) {
        return null;
      }

      return {
        file: parsed.data.file,
        severity: parsed.data.severity ?? "low",
      };
    })
    .filter((comment): comment is { file: string; severity: Severity } => comment !== null);
}

function getTrendDirection(delta: number): "up" | "down" | "stable" {
  if (delta > 0) return "up";
  if (delta < 0) return "down";
  return "stable";
}

export const reviewRouter = createTRPCRouter({
  trigger: protectedProcedure
    .input(
      z.object({
        repositoryId: z.string(),
        prNumber: z.number(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const repository = await ctx.db.repository.findUnique({
        where: { id: input.repositoryId, userId: ctx.user.id },
      });

      if (!repository) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Repository not found",
        });
      }

      const accessToken = await getGitHubAccessToken(ctx.user.id);
      if (!accessToken) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "GitHub account not connected",
        });
      }

      const [owner, repo] = repository.fullName.split("/");
      if (!owner || !repo) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid repository name",
        });
      }

      const pr = await fetchPullRequest(
        accessToken,
        owner,
        repo,
        input.prNumber,
      );

      const review = await ctx.db.review.create({
        data: {
          repositoryId: repository.id,
          userId: ctx.user.id,
          prNumber: pr.number,
          prTitle: pr.title,
          prUrl: pr.html_url,
          status: "PENDING",
        },
      });

      if (!process.env.INNGEST_EVENT_KEY) {
        await ctx.db.review.update({
          where: { id: review.id },
          data: {
            status: "FAILED",
            error: "INNGEST_EVENT_KEY is not set",
          },
        });
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Inngest is not configured",
        });
      }

      try {
        await inngest.send({
          name: "review/pr.requested",
          data: {
            reviewId: review.id,
            repositoryId: repository.id,
            prNumber: pr.number,
            userId: ctx.user.id,
          },
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to enqueue review";

        await ctx.db.review.update({
          where: { id: review.id },
          data: {
            status: "FAILED",
            error: message,
          },
        });

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to enqueue review",
        });
      }

      return { reviewId: review.id };
    }),
  cancel: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const review = await ctx.db.review.findUnique({
        where: { id: input.id, userId: ctx.user.id },
      });

      if (!review) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Review not found",
        });
      }

      if (review.status === "COMPLETED" || review.status === "FAILED") {
        return { status: review.status };
      }

      const cancelled = await ctx.db.review.update({
        where: { id: review.id },
        data: {
          status: "FAILED",
          error: "Review cancelled by user",
        },
      });

      return { status: cancelled.status };
    }),
  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const review = await ctx.db.review.findUnique({
        where: { id: input.id, userId: ctx.user.id },
        include: { repository: true },
      });

      if (!review) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Review not found",
        });
      }

      return review;
    }),
  list: protectedProcedure
    .input(
      z.object({
        repositoryId: z.string().optional(),
        limit: z.number().min(1).max(50).default(20),
      }),
    )
    .query(async ({ ctx, input }) => {
      const reviews = await ctx.db.review.findMany({
        where: {
          userId: ctx.user.id,
          ...(input.repositoryId && { repositoryId: input.repositoryId }),
        },
        include: { repository: true },
        orderBy: { createdAt: "desc" },
        take: input.limit,
      });

      return reviews;
    }),
  getLatestForPR: protectedProcedure
    .input(
      z.object({
        repositoryId: z.string(),
        prNumber: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const review = await ctx.db.review.findFirst({
        where: {
          repositoryId: input.repositoryId,
          prNumber: input.prNumber,
          userId: ctx.user.id,
        },
        orderBy: { createdAt: "desc" },
      });

      return review;
    }),
  regressionRadar: protectedProcedure
    .input(
      z.object({
        repositoryId: z.string().optional(),
        windowDays: z.number().min(7).max(90).default(30),
        topFiles: z.number().min(3).max(20).default(8),
      }),
    )
    .query(async ({ ctx, input }) => {
      const now = new Date();
      const recentWindowStart = new Date(
        now.getTime() - input.windowDays * 24 * 60 * 60 * 1000,
      );
      const previousWindowStart = new Date(
        recentWindowStart.getTime() - input.windowDays * 24 * 60 * 60 * 1000,
      );

      const whereBase = {
        userId: ctx.user.id,
        status: "COMPLETED" as const,
        ...(input.repositoryId ? { repositoryId: input.repositoryId } : {}),
      };

      const [recentReviews, previousReviews] = await Promise.all([
        ctx.db.review.findMany({
          where: {
            ...whereBase,
            createdAt: {
              gte: recentWindowStart,
              lte: now,
            },
          },
          select: {
            createdAt: true,
            prNumber: true,
            comments: true,
          },
        }),
        ctx.db.review.findMany({
          where: {
            ...whereBase,
            createdAt: {
              gte: previousWindowStart,
              lt: recentWindowStart,
            },
          },
          select: {
            comments: true,
          },
        }),
      ]);

      type HotspotAccumulator = {
        file: string;
        totalFindings: number;
        weightedScore: number;
        critical: number;
        high: number;
        medium: number;
        low: number;
        lastSeenAt: Date | null;
        prsAffected: Set<number>;
      };

      const recentMap = new Map<string, HotspotAccumulator>();
      const previousCounts = new Map<string, number>();

      for (const review of recentReviews) {
        const comments = parseReviewComments(review.comments);

        for (const comment of comments) {
          const existing =
            recentMap.get(comment.file) ??
            ({
              file: comment.file,
              totalFindings: 0,
              weightedScore: 0,
              critical: 0,
              high: 0,
              medium: 0,
              low: 0,
              lastSeenAt: null,
              prsAffected: new Set<number>(),
            } satisfies HotspotAccumulator);

          existing.totalFindings += 1;
          existing.weightedScore += SEVERITY_WEIGHT[comment.severity];
          existing[comment.severity] += 1;
          existing.prsAffected.add(review.prNumber);
          if (!existing.lastSeenAt || review.createdAt > existing.lastSeenAt) {
            existing.lastSeenAt = review.createdAt;
          }

          recentMap.set(comment.file, existing);
        }
      }

      for (const review of previousReviews) {
        const comments = parseReviewComments(review.comments);
        for (const comment of comments) {
          previousCounts.set(comment.file, (previousCounts.get(comment.file) ?? 0) + 1);
        }
      }

      const hotspots = Array.from(recentMap.values())
        .map((item) => {
          const previousFindings = previousCounts.get(item.file) ?? 0;
          const recentFindings = item.totalFindings;
          const trendDelta = recentFindings - previousFindings;

          return {
            file: item.file,
            totalFindings: item.totalFindings,
            weightedScore: item.weightedScore,
            critical: item.critical,
            high: item.high,
            medium: item.medium,
            low: item.low,
            recentFindings,
            previousFindings,
            trendDelta,
            trend: getTrendDirection(trendDelta),
            prsAffected: item.prsAffected.size,
            lastSeenAt: item.lastSeenAt,
          };
        })
        .sort((a, b) => {
          if (b.weightedScore !== a.weightedScore) {
            return b.weightedScore - a.weightedScore;
          }
          return b.totalFindings - a.totalFindings;
        })
        .slice(0, input.topFiles);

      return {
        generatedAt: now,
        windowDays: input.windowDays,
        repositoryId: input.repositoryId ?? null,
        recentReviewCount: recentReviews.length,
        previousReviewCount: previousReviews.length,
        hotspotCount: hotspots.length,
        hotspots,
      };
    }),
});
