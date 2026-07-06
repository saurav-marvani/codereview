import 'tsconfig-paths/register';
import * as fs from 'fs';
import { NestFactory } from '@nestjs/core';
import { ApiModule } from '../apps/api/src/api.module';
import { CliReviewPipelineStrategy } from '@libs/cli-review/pipeline/strategy/cli-review-pipeline.strategy';
import { getDefaultKodusConfigFile } from '@libs/common/utils/validateCodeReviewConfigFile';

async function main() {
    const app = await NestFactory.createApplicationContext(ApiModule, { logger: ['error'], abortOnError: false });
    console.log('APP BOOTED ✅');
    const strategy = app.get(CliReviewPipelineStrategy, { strict: false });

    const envCfg = JSON.parse(fs.readFileSync('kutt-env.json', 'utf8'));
    const base: any = getDefaultKodusConfigFile();
    const codeReviewConfig: any = { ...base, environment: envCfg };

    const context: any = {
        origin: 'cli',
        isFastMode: false,
        isTrialMode: true,
        startTime: Date.now(),
        correlationId: 'preview-full-cli',
        organizationAndTeamData: { organizationId: '540866fe-8707-4780-86d1-cd34b2adc03a', teamId: '4437a9c0-6f4b-4578-b4bf-e70c5b410bde' },
        codeReviewConfig,
        changedFiles: [{ filename: 'server/queries/link.queries.js', patch: '@@ total() @@\n-  query.count("* as count");\n+  query.count("*");', status: 'modified', additions: 1, deletions: 1, changes: 2 }],
        reviewDirective: undefined,
        validSuggestions: [],
        discardedSuggestions: [],
        preparedFileContexts: [],
        repository: { id: 'r1', name: 'kutt', fullName: 'thedevs-network/kutt', private: false, owner: 'thedevs-network', default_branch: 'main', html_url: 'https://github.com/thedevs-network/kutt' },
        branch: 'main',
        pullRequest: { number: 0, title: 'CLI Review', base: { repo: { fullName: 'thedevs-network/kutt' }, ref: 'main' }, repository: {}, isDraft: false, stats: { total_additions: 1, total_deletions: 1, total_files: 1 } },
        gitContext: { remote: 'https://github.com/thedevs-network/kutt', branch: 'main', baseBranch: 'main' },
    };

    let ctx = context;
    for (const stage of strategy.configureStages()) {
        const name = (stage as any).stageName ?? stage.constructor.name;
        console.log(`\n>>> STAGE: ${name}`);
        try { ctx = await (stage as any).execute(ctx); }
        catch (e: any) { console.log(`  stage ${name} threw: ${e?.message ?? e}`); }
        console.log(`  validSuggestions so far: ${ctx.validSuggestions?.length ?? 0}`);
    }
    console.log('\n=== FINAL CLI RESPONSE ===');
    console.log('issues:', ctx.cliResponse?.issues?.length ?? 'n/a', '| summary:', ctx.cliResponse?.summary);
    for (const iss of ctx.cliResponse?.issues ?? []) console.log(`[${iss.severity}] ${iss.category} ${iss.file}: ${(iss.message||'').slice(0,180)}`);
    await app.close();
    console.log('DONE — full CLI pipeline run.');
}
main().catch((e) => { console.error('ERROR:', e?.stack ?? e); process.exit(1); });
