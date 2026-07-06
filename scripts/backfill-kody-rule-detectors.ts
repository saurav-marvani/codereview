#!/usr/bin/env npx ts-node
/**
 * Backfill T0 detectors on existing Kody Rules (#1449).
 *
 * Why this exists:
 *   Rules created before the T0 compiler shipped — and every rule that arrives
 *   via a bulk path (IDE/repo-file sync, MCP, import) — have no `detector`, so
 *   they always run the semantic judge. That is CORRECT (the judge is the
 *   100%-recall path) but misses the free regex fast-path. This script activates
 *   the legacy: it compiles a gated detector for each eligible rule. The daily
 *   sweep cron keeps things current afterwards; this is the controllable one-off
 *   for the initial ~10k-rule turn, which is too big to leave to a single cron
 *   run.
 *
 * Safe by construction:
 *   - Idempotent — `onlyMissing` skips rules that already have a detector, so
 *     re-running is cheap and staged runs resume where they left off.
 *   - The gate rejects any regex that doesn't reproduce the rule's own examples,
 *     so a rule only becomes mechanical when it's provably safe; everything else
 *     stays semantic. No rule ever breaks.
 *   - `--max-rules` caps LLM spend per run: do 1k, check cost, run again.
 *
 * Usage:
 *   # See what WOULD be compiled, no LLM calls, no writes
 *   npx ts-node scripts/backfill-kody-rule-detectors.ts --all --dry-run --env=.env.prod
 *
 *   # One org
 *   npx ts-node scripts/backfill-kody-rule-detectors.ts --org-id=<uuid> --env=.env.prod
 *
 *   # Staged mass turn: compile up to 1000 rules this run (repeat to drain)
 *   npx ts-node scripts/backfill-kody-rule-detectors.ts --all --max-rules=1000 --env=.env.prod
 *
 * Required env: same as running the API (PG + Mongo). Model for the compile is
 * the org's BYOK (self-hosted) or the system default (cloud) — the gate makes a
 * cheap model safe.
 */
import 'dotenv/config';
import 'reflect-metadata';

import * as path from 'path';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { config as loadEnv } from 'dotenv';

import { KodyRulesModule } from '@libs/kodyRules/modules/kodyRules.module';
import { BackfillRuleDetectorsUseCase } from '@libs/kodyRules/application/use-cases/backfill-rule-detectors.use-case';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';

interface CliArgs {
    all: boolean;
    orgId?: string;
    dryRun: boolean;
    maxRules: number;
    perOrgConcurrency: number;
    envFile?: string;
}

function parseArgs(): CliArgs {
    const argv = process.argv.slice(2);
    const get = (name: string): string | undefined => {
        const hit = argv.find((a) => a.startsWith(`--${name}=`));
        return hit ? hit.split('=').slice(1).join('=') : undefined;
    };
    const has = (name: string) => argv.includes(`--${name}`);
    return {
        all: has('all'),
        orgId: get('org-id'),
        dryRun: has('dry-run'),
        maxRules: get('max-rules') ? Number(get('max-rules')) : Infinity,
        perOrgConcurrency: get('concurrency') ? Number(get('concurrency')) : 3,
        envFile: get('env'),
    };
}

function loadEnvFile(envFile?: string): void {
    if (!envFile) return;
    const resolved = path.resolve(envFile);
    loadEnv({ path: resolved, override: true });
    console.log(`[env] overlaid env file: ${resolved}`);
}

/** Minimal module — just enough to resolve the backfill use-case + rules service. */
@Module({ imports: [KodyRulesModule] })
class BackfillDetectorsModule {}

const orgIdOf = (doc: any): string | undefined =>
    doc?.organizationId ?? doc?.toObject?.()?.organizationId;
const rulesOf = (doc: any): any[] =>
    doc?.rules ?? doc?.toObject?.()?.rules ?? [];

async function main() {
    const logger = new Logger('backfill-kody-rule-detectors');
    const args = parseArgs();
    loadEnvFile(args.envFile);

    if (!args.all && !args.orgId) {
        logger.error('Pass --all or --org-id=<uuid>. Aborting.');
        process.exitCode = 1;
        return;
    }

    const app = await NestFactory.createApplicationContext(
        BackfillDetectorsModule,
        { logger: ['log', 'warn', 'error'] },
    );

    try {
        const kodyRulesService = app.get<IKodyRulesService>(
            KODY_RULES_SERVICE_TOKEN,
        );
        const backfill = app.get(BackfillRuleDetectorsUseCase);

        // Resolve the org set.
        const docs = args.orgId
            ? [await kodyRulesService.findByOrganizationId(args.orgId)].filter(
                  Boolean,
              )
            : await kodyRulesService.find();

        const orgs = docs
            .map((d) => ({ organizationId: orgIdOf(d), rules: rulesOf(d) }))
            .filter((o) => o.organizationId);

        // Dry run: count eligible (active, non-memory, no detector) per org.
        if (args.dryRun) {
            let eligible = 0;
            for (const o of orgs) {
                const n = o.rules.filter(
                    (r: any) =>
                        r?.uuid &&
                        r.status === 'active' &&
                        (r.type || 'standard').toLowerCase() !== 'memory' &&
                        !r.detector,
                ).length;
                eligible += n;
                if (n > 0)
                    logger.log(`  org=${o.organizationId}: ${n} without detector`);
            }
            logger.log(
                `[DRY RUN] ${orgs.length} org(s), ${eligible} rules would be compiled (no LLM calls made).`,
            );
            return;
        }

        // Real run — staged by a global rule budget.
        let remaining = args.maxRules;
        const totals = { orgs: 0, processed: 0, compiled: 0, declined: 0, errored: 0 };
        for (const o of orgs) {
            if (remaining <= 0) {
                logger.log(
                    `--max-rules budget exhausted; stopping. Re-run to continue (idempotent).`,
                );
                break;
            }
            totals.orgs++;
            const res = await backfill.execute(
                { organizationId: o.organizationId } as any,
                {
                    onlyMissing: true,
                    limit: Number.isFinite(remaining) ? remaining : undefined,
                    concurrency: args.perOrgConcurrency,
                },
            );
            totals.processed += res.processed;
            totals.compiled += res.compiled;
            totals.declined += res.declined;
            totals.errored += res.errored;
            remaining -= res.processed;
            logger.log(
                `✓ org=${o.organizationId}: ${res.compiled} compiled / ${res.processed} processed (${res.declined} semantic, ${res.errored} errored)`,
            );
        }

        logger.log(
            `backfill complete — ${totals.compiled} compiled, ${totals.declined} stayed semantic, ${totals.errored} errored across ${totals.orgs} org(s) (${totals.processed} processed).`,
        );
    } finally {
        await app.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(2);
});
