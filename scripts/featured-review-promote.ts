#!/usr/bin/env npx ts-node
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Featured review curation script.
 *
 * Picks a completed CLI review job (the kind enqueued by
 * POST /cli/public/review-pr) and freezes it into the
 * `featured_public_reviews` collection so the demo can serve it
 * instantly without re-running the review.
 *
 * Usage:
 *   yarn featured-review:promote <jobId> [options]
 *
 * Options:
 *   --slug=<slug>           URL-safe id (default: derived from PR owner/repo/#)
 *   --tags=ts,bug,framework Comma-separated labels
 *   --highlight="..."       Short copy shown next to the card
 *   --sort=<number>         Lower sorts first on the home grid
 *   --unpublish             Mark as draft (won't show in listings)
 *   --env=<path>            Path to .env (default: ./.env)
 */

import * as dotenv from 'dotenv';
import { MongoClient, ObjectId } from 'mongodb';
import * as path from 'path';

const argv = process.argv.slice(2);
const positionals = argv.filter((a) => !a.startsWith('--'));
const flag = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit?.split('=').slice(1).join('=');
};
const has = (name: string) => argv.includes(`--${name}`);

const jobId = positionals[0];
if (!jobId) {
    console.error(
        'usage: yarn featured-review:promote <jobId> [--slug=...] [--tags=a,b] [--highlight="..."] [--sort=N] [--unpublish]',
    );
    process.exit(1);
}

const envArg = flag('env');
const envPath = envArg
    ? path.resolve(envArg)
    : path.resolve(__dirname, '../.env');
dotenv.config({ path: envPath });

function buildMongoUri(): string {
    if (process.env.MONGODB_URI) return process.env.MONGODB_URI;
    const host = process.env.API_MG_DB_HOST ?? 'localhost';
    const port = process.env.API_MG_DB_PORT ?? '27017';
    const user = process.env.API_MG_DB_USERNAME;
    const pass = process.env.API_MG_DB_PASSWORD;
    const auth = user && pass ? `${user}:${encodeURIComponent(pass)}@` : '';
    const db = process.env.API_MG_DB_DATABASE ?? 'kodus';
    return `mongodb://${auth}${host}:${port}/${db}?authSource=admin`;
}

function slugify(input: string): string {
    return input
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

async function main() {
    const slugFlag = flag('slug');
    const tags = (flag('tags') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const highlight = flag('highlight');
    const sortOrder = flag('sort') ? Number(flag('sort')) : undefined;
    const published = !has('unpublish');

    const uri = buildMongoUri();
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db(process.env.API_MG_DB_DATABASE ?? 'kodus');

    try {
        // Workflow jobs live in `workflow_jobs`. Match by id (string or
        // ObjectId, since different setups index it differently).
        const jobsColl = db.collection('workflow_jobs');
        const job = await jobsColl.findOne({
            $or: [
                { _id: jobId } as any,
                ...(ObjectId.isValid(jobId)
                    ? [{ _id: new ObjectId(jobId) } as any]
                    : []),
                { jobId },
                { id: jobId },
                { correlationId: jobId },
            ],
        });

        if (!job) {
            console.error(`No workflow job found with id "${jobId}".`);
            process.exit(2);
        }

        if (job.status !== 'COMPLETED') {
            console.error(
                `Job ${jobId} is in status "${job.status}", expected COMPLETED.`,
            );
            process.exit(3);
        }

        const payload: any = job.payload ?? {};
        const publicPr = payload.publicPr;
        const publicDiff = payload.publicDiff;
        if (!publicPr || !publicDiff) {
            console.error(
                'Job payload is missing publicPr / publicDiff. Only public-demo jobs can be promoted.',
            );
            process.exit(4);
        }

        const result = job.metadata?.result;
        if (!result) {
            console.error(
                'Job metadata.result is missing — was this job processed by the worker?',
            );
            process.exit(5);
        }

        const slug =
            slugFlag ??
            slugify(`${publicPr.owner}-${publicPr.repo}-${publicPr.prNumber}`);
        const prUrl =
            publicPr.htmlUrl ??
            `https://github.com/${publicPr.owner}/${publicPr.repo}/pull/${publicPr.prNumber}`;

        const featuredColl = db.collection('featured_public_reviews');
        const now = new Date();

        const res = await featuredColl.findOneAndUpdate(
            { slug },
            {
                $set: {
                    slug,
                    published,
                    tags,
                    highlight,
                    sortOrder,
                    prUrl,
                    pr: publicPr,
                    diff: publicDiff,
                    result,
                    sourceJobId: String(job._id ?? jobId),
                    updatedAt: now,
                },
                $setOnInsert: { createdAt: now },
            },
            { upsert: true, returnDocument: 'after' },
        );

        const issuesCount = Array.isArray(result.issues)
            ? result.issues.length
            : 0;

        console.log(
            JSON.stringify(
                {
                    ok: true,
                    slug,
                    published,
                    sourceJobId: String(job._id ?? jobId),
                    pr: `${publicPr.owner}/${publicPr.repo}#${publicPr.prNumber}`,
                    title: publicPr.title,
                    issuesCount,
                    tags,
                    upserted: res?.lastErrorObject?.upserted ? true : false,
                },
                null,
                2,
            ),
        );
    } finally {
        await client.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
