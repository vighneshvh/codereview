import {
  GoogleGenerativeAI,
  type GenerativeModel,
} from "@google/generative-ai";
import { z } from "zod";

let geminiModel: GenerativeModel | null = null;

function getGeminiModel(): GenerativeModel {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  if (!geminiModel) {
    const genAI = new GoogleGenerativeAI(apiKey);
    geminiModel = genAI.getGenerativeModel({
      model: "gemini-2.5-flash-lite",
      systemInstruction: SYSTEM_PROMPT,
    });
  }

  return geminiModel;
}

export const ReviewCommentSchema = z.object({
  file: z.string(),
  line: z.number(),
  severity: z.enum(["critical", "high", "medium", "low"]),
  category: z.enum(["bug", "security", "performance", "style", "suggestion"]),
  message: z.string(),
  suggestion: z.string().optional(),
});

export const ReviewResultSchema = z.object({
  summary: z.string(),
  riskScore: z.number().min(0).max(100),
  comments: z.array(ReviewCommentSchema),
});

export type ReviewComment = z.infer<typeof ReviewCommentSchema>;
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

interface FileChange {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

const SYSTEM_PROMPT = `You are an expert code reviewer. Analyze the provided pull request diff and provide a structured review.

Your review should:
1. Identify bugs, security issues, performance problems, and code style issues
2. Provide a brief summary of the changes
3. Assign a risk score (0-100) based on the complexity and potential issues
4. Give specific, actionable feedback with line numbers

Respond with valid JSON matching this schema:
{
  "summary": "Brief summary of changes and overall assessment",
  "riskScore": 0-100,
  "comments": [
    {
      "file": "path/to/file.ts",
      "line": 42,
      "severity": "critical" | "high" | "medium" | "low",
      "category": "bug" | "security" | "performance" | "style" | "suggestion",
      "message": "What the issue is",
      "suggestion": "How to fix it (optional)"
    }
  ]
}

Severity guide:
- critical: Security vulnerabilities, data loss, crashes
- high: Bugs that will cause issues in production
- medium: Should be fixed but won't break things
- low: Style issues, minor improvements

Be concise but specific. Reference exact line numbers from the diff.

Return strictly valid JSON only (no markdown/code fences). If there are many issues, return only the highest-impact findings.`;

function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith("```") || !trimmed.endsWith("```")) {
    return trimmed;
  }

  const lines = trimmed.split("\n");
  if (lines.length <= 2) {
    return trimmed;
  }

  return lines.slice(1, -1).join("\n").trim();
}

function extractFirstJsonObject(content: string): string | null {
  const start = content.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < content.length; i++) {
    const ch = content[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      depth++;
      continue;
    }

    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return content.slice(start, i + 1);
      }
    }
  }

  return null;
}

function toReviewResultFallback(reason: string): ReviewResult {
  return {
    summary: `Automated review could not be fully parsed (${reason}).`,
    riskScore: 0,
    comments: [],
  };
}

function sanitizeReviewResult(input: unknown): ReviewResult | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const candidate = input as Record<string, unknown>;
  const summary =
    typeof candidate.summary === "string" && candidate.summary.trim()
      ? candidate.summary.trim()
      : "Automated review completed.";

  const rawRisk = candidate.riskScore;
  const riskNumber =
    typeof rawRisk === "number"
      ? rawRisk
      : typeof rawRisk === "string"
        ? Number(rawRisk)
        : 0;
  const riskScore = Number.isFinite(riskNumber)
    ? Math.min(100, Math.max(0, Math.round(riskNumber)))
    : 0;

  const rawComments = Array.isArray(candidate.comments) ? candidate.comments : [];
  const comments = rawComments
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const obj = item as Record<string, unknown>;

      const file = typeof obj.file === "string" ? obj.file : "unknown";
      const lineRaw =
        typeof obj.line === "number"
          ? obj.line
          : typeof obj.line === "string"
            ? Number(obj.line)
            : 1;
      const line = Number.isFinite(lineRaw) ? Math.max(1, Math.round(lineRaw)) : 1;

      const severityRaw =
        typeof obj.severity === "string" ? obj.severity.toLowerCase() : "low";
      const severity =
        severityRaw === "critical" ||
        severityRaw === "high" ||
        severityRaw === "medium" ||
        severityRaw === "low"
          ? severityRaw
          : "low";

      const categoryRaw =
        typeof obj.category === "string" ? obj.category.toLowerCase() : "suggestion";
      const category =
        categoryRaw === "bug" ||
        categoryRaw === "security" ||
        categoryRaw === "performance" ||
        categoryRaw === "style" ||
        categoryRaw === "suggestion"
          ? categoryRaw
          : "suggestion";

      const message =
        typeof obj.message === "string" && obj.message.trim()
          ? obj.message.trim()
          : "Potential issue detected.";
      const suggestion =
        typeof obj.suggestion === "string" && obj.suggestion.trim()
          ? obj.suggestion.trim()
          : undefined;

      return { file, line, severity, category, message, suggestion };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .slice(0, 50);

  const validated = ReviewResultSchema.safeParse({
    summary,
    riskScore,
    comments,
  });

  return validated.success ? validated.data : null;
}

function parseReviewResult(content: string): ReviewResult | null {
  const candidates = [
    content.trim(),
    stripCodeFence(content),
    extractFirstJsonObject(content) ?? "",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const strict = ReviewResultSchema.safeParse(parsed);
      if (strict.success) {
        return strict.data;
      }

      const sanitized = sanitizeReviewResult(parsed);
      if (sanitized) {
        return sanitized;
      }
    } catch {
      // try next candidate
    }
  }

  return null;
}

export async function reviewCode(
  prTitle: string,
  files: FileChange[],
): Promise<ReviewResult> {
  const diffContent = files
    .filter((f) => f.patch)
    .map(
      (f) => `### ${f.filename} (${f.status})\n\`\`\`diff\n${f.patch}\n\`\`\``,
    )
    .join("\n\n");

  if (!diffContent.trim()) {
    return {
      summary: "No code changes to review (binary files or empty diff).",
      riskScore: 0,
      comments: [],
    };
  }

  const userPrompt = `Review this pull request:

**Title:** ${prTitle}

**Changes:**
${diffContent}

Important:
- Return valid JSON only
- Keep output concise
- If there are many findings, include only the top 20 most important`;

  const model = getGeminiModel();
  let response;
  try {
    response = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.3,
        maxOutputTokens: 2000,
      },
    });
  } catch {
    return toReviewResultFallback("model request failed");
  }

  const content = response.response.text();
  if (!content) {
    return toReviewResultFallback("empty model response");
  }

  const parsed = parseReviewResult(content);
  if (parsed) {
    return parsed;
  }

  try {
    const repairResponse = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Fix this into valid JSON that matches the schema exactly. Return only JSON.\n\n${content}`,
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0,
        maxOutputTokens: 2000,
      },
    });

    const repaired = repairResponse.response.text();
    if (!repaired) {
      return toReviewResultFallback("invalid JSON and empty repair response");
    }

    const repairedParsed = parseReviewResult(repaired);
    if (repairedParsed) {
      return repairedParsed;
    }
  } catch {
    return toReviewResultFallback("invalid JSON and repair request failed");
  }

  return toReviewResultFallback("invalid JSON after repair attempt");
}
