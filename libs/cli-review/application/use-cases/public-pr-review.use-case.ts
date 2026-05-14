import { Injectable } from '@nestjs/common';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import {
    GitHubPublicPrService,
    PublicPrFetchError,
} from '@libs/cli-review/infrastructure/services/github-public-pr.service';
import { PublicPrAiSummaryService } from '@libs/cli-review/infrastructure/services/public-pr-ai-summary.service';
import { PublicPrGroupingService } from '@libs/cli-review/infrastructure/services/public-pr-grouping.service';
import { TrialRateLimiterService } from '@libs/cli-review/infrastructure/services/trial-rate-limiter.service';
import { EnqueueCliReviewUseCase } from './enqueue-cli-review.use-case';

export interface PublicPrReviewInput {
    prUrl: string;
    fingerprint: string;
}

export type PublicPrReviewResult =
    | {
          ok: true;
          response: {
              jobId: string;
              status: JobStatus;
              statusUrl: string;
              pr: Record<string, unknown>;
              diff: string;
              rateLimit: {
                  remaining: number;
                  limit: number;
                  resetAt?: string;
              };
          };
      }
    | {
          ok: false;
          code: 'rate_limited' | PublicPrFetchError['code'];
          message: string;
          statusCode: number;
          rateLimit?: {
              remaining: number;
              limit: number;
              resetAt?: string;
          };
      };

/**
 * Orchestrates the public PR review flow. Pulled out of the controller
 * so the HTTP handler stays a thin "request → use-case → response"
 * adapter and the same flow can be exercised from tests / scripts
 * without spinning up Nest.
 *
 * Returns a result discriminator instead of throwing — the controller
 * decides how to map each case to an HTTP status.
 */
@Injectable()
export class PublicPrReviewUseCase {
    constructor(
        private readonly trialRateLimiter: TrialRateLimiterService,
        private readonly githubPublicPrService: GitHubPublicPrService,
        private readonly enqueueCliReviewUseCase: EnqueueCliReviewUseCase,
        private readonly publicPrAiSummaryService: PublicPrAiSummaryService,
        private readonly publicPrGroupingService: PublicPrGroupingService,
    ) {}

    async execute(input: PublicPrReviewInput): Promise<PublicPrReviewResult> {
        const { prUrl, fingerprint } = input;

        const rateLimitResult =
            await this.trialRateLimiter.checkRateLimit(fingerprint);
        if (!rateLimitResult.allowed) {
            return {
                ok: false,
                code: 'rate_limited',
                message: 'Rate limit exceeded. Please try again later.',
                statusCode: 429,
                rateLimit: {
                    remaining: rateLimitResult.remaining,
                    limit: 2,
                    resetAt: rateLimitResult.resetAt?.toISOString(),
                },
            };
        }

        let pr: Awaited<ReturnType<GitHubPublicPrService['fetch']>>;
        try {
            pr = await this.githubPublicPrService.fetch(prUrl);
        } catch (err) {
            if (err instanceof PublicPrFetchError) {
                return {
                    ok: false,
                    code: err.code,
                    message: err.message,
                    statusCode: err.statusCode,
                };
            }
            throw err;
        }

        // Summary and groupings both need the diff; both are cheap on
        // Flash. Run them in parallel so the perceived submit delay
        // stays bounded by the slower of the two (~3–5s total) instead
        // of being additive. Failures are non-blocking — undefined
        // makes the UI fall back gracefully.
        const changedFilePaths = extractChangedFiles(pr.diff);
        const [aiAnalysis, groupings] = await Promise.all([
            this.publicPrAiSummaryService.generate(pr, pr.diff),
            this.publicPrGroupingService.generate(
                pr,
                pr.diff,
                changedFilePaths,
            ),
        ]);

        const publicPrMetadata = {
            owner: pr.owner,
            repo: pr.repo,
            prNumber: pr.prNumber,
            title: pr.title,
            state: pr.state,
            merged: pr.merged,
            isDraft: pr.isDraft,
            headSha: pr.headSha,
            headRef: pr.headRef,
            baseSha: pr.baseSha,
            baseRef: pr.baseRef,
            additions: pr.additions,
            deletions: pr.deletions,
            changedFiles: pr.changedFiles,
            commitsCount: pr.commitsCount,
            discussionCount: pr.discussionCount,
            htmlUrl: pr.htmlUrl,
            author: pr.author,
            reviewers: pr.reviewers,
            checks: pr.checks,
            commits: pr.commits,
            comments: pr.comments,
            labels: pr.labels,
            assignees: pr.assignees,
            body: pr.body,
            aiAnalysis,
            groupings,
        };

        const { jobId } = await this.enqueueCliReviewUseCase.execute({
            organizationAndTeamData: {
                organizationId: 'trial',
                teamId: 'trial',
            },
            input: {
                diff: pr.diff,
                // `fast: true` keeps the public demo on Gemini Flash —
                // the controller used the same flag inline before this
                // use case existed.
                config: { fast: true } as unknown as never,
            },
            isTrialMode: true,
            gitContext: {
                remote: pr.cloneUrl,
                branch: pr.headRef,
                commitSha: pr.headSha,
                mergeBaseSha: pr.baseSha,
                inferredPlatform: 'github' as never,
            },
            publicPr: publicPrMetadata,
            publicDiff: pr.diff,
        });

        return {
            ok: true,
            response: {
                jobId,
                status: JobStatus.PENDING,
                statusUrl: `/cli/public/review/jobs/${jobId}`,
                pr: publicPrMetadata,
                diff: pr.diff,
                rateLimit: {
                    remaining: rateLimitResult.remaining,
                    limit: 2,
                    resetAt: rateLimitResult.resetAt?.toISOString(),
                },
            },
        };
    }
}

/**
 * Lift the "after" file paths out of a unified diff. Used to give the
 * grouping LLM the exact strings it must echo back so we can drop any
 * hallucinated paths. Mirrors the parser in apps/try/src/lib/diff.ts
 * but kept local — backend has no Next.js path aliases.
 */
function extractChangedFiles(diff: string): string[] {
    const paths: string[] = [];
    const re = /^diff --git a\/.+? b\/(.+)$/gm;
    let match: RegExpExecArray | null;
    while ((match = re.exec(diff)) !== null) {
        paths.push(match[1]);
    }
    return paths;
}
