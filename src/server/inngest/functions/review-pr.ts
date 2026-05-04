import { inngest } from "../client";
import { db } from "@/server/db";
import { reviewCode } from "@/server/services/ai";
import {
  fetchPullRequest,
  fetchPullRequestFiles,
  getGitHubAccessToken,
} from "@/server/services/github";

export type ReviewPREvent = {
  name: "review/pr.requested";
  data: {
    reviewId: string;
    repositoryId: string;
    prNumber: number;
    userId: string;
  };
};

export const reviewPR = inngest.createFunction(
  {
    id: "review-pr",
    retries: 2,
  },
  { event: "review/pr.requested" },
  async ({ event, step }) => {
    const { reviewId, repositoryId, prNumber, userId } = event.data;

    const processingUpdate = await step.run("update-status-processing", async () => {
      return db.review.updateMany({
        where: {
          id: reviewId,
          status: "PENDING",
        },
        data: { status: "PROCESSING" },
      });
    });

    if (processingUpdate.count === 0) {
      return { success: false, error: "Review is no longer pending" };
    }

    try {
      const repository = await step.run("get-repository", async () => {
        return db.repository.findUnique({
          where: { id: repositoryId },
        });
      });

      if (!repository) {
        await step.run("mark-failed-no-repo", async () => {
          await db.review.updateMany({
            where: { id: reviewId, status: "PROCESSING" },
            data: { status: "FAILED", error: "No repository found" },
          });
        });
        return { success: false, error: "No repository found" };
      }

      const accessToken = await step.run("get-access-token", async () => {
        return getGitHubAccessToken(userId);
      });

      if (!accessToken) {
        await step.run("mark-failed-no-token", async () => {
          await db.review.updateMany({
            where: { id: reviewId, status: "PROCESSING" },
            data: {
              status: "FAILED",
              error: "GitHub access token not found",
            },
          });
        });
        return { success: false, error: "GitHub access token not found" };
      }

      const [owner, repo] = repository.fullName.split("/");
      if (!owner || !repo) {
        await step.run("mark-failed-invalid-repo", async () => {
          await db.review.updateMany({
            where: { id: reviewId, status: "PROCESSING" },
            data: {
              status: "FAILED",
              error: "Invalid repository name",
            },
          });
        });
        return { success: false, error: "Invalid repository name" };
      }

      const reviewBeforeFetch = await step.run(
        "ensure-review-active-before-fetch",
        async () => {
          return db.review.findUnique({
            where: { id: reviewId },
            select: { status: true, error: true },
          });
        },
      );

      if (!reviewBeforeFetch) {
        return { success: false, error: "Review not found" };
      }

      if (reviewBeforeFetch.status === "FAILED" || reviewBeforeFetch.status === "COMPLETED") {
        return {
          success: false,
          error: reviewBeforeFetch.error ?? `Review ${reviewBeforeFetch.status.toLowerCase()}`,
        };
      }

      const files = await step.run("fetch-pr-files", async () => {
        return fetchPullRequestFiles(accessToken, owner, repo, prNumber);
      });

      const pr = await step.run("fetch-pr", async () => {
        return fetchPullRequest(accessToken, owner, repo, prNumber);
      });

      const reviewBeforeAnalyze = await step.run(
        "ensure-review-active-before-analyze",
        async () => {
          return db.review.findUnique({
            where: { id: reviewId },
            select: { status: true, error: true },
          });
        },
      );

      if (!reviewBeforeAnalyze) {
        return { success: false, error: "Review not found" };
      }

      if (
        reviewBeforeAnalyze.status === "FAILED" ||
        reviewBeforeAnalyze.status === "COMPLETED"
      ) {
        return {
          success: false,
          error: reviewBeforeAnalyze.error ?? `Review ${reviewBeforeAnalyze.status.toLowerCase()}`,
        };
      }

      const reviewResult = await step.run("generate-review", async () => {
        return reviewCode(
          pr.title,
          files.map((f) => ({
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            patch: f.patch,
          })),
        );
      });

      await step.run("save-review-result", async () => {
        await db.review.updateMany({
          where: {
            id: reviewId,
            status: "PROCESSING",
          },
          data: {
            status: "COMPLETED",
            summary: reviewResult.summary,
            riskScore: reviewResult.riskScore,
            comments: reviewResult.comments,
            error: null,
          },
        });
      });

      return { success: true, reviewId };
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unknown error while reviewing pull request";

      await step.run("mark-failed-unhandled-error", async () => {
        await db.review.updateMany({
          where: { id: reviewId, status: "PROCESSING" },
          data: {
            status: "FAILED",
            error: errorMessage,
          },
        });
      });

      return { success: false, error: errorMessage };
    }
  },
);
