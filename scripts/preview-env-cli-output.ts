import 'tsconfig-paths/register';
import { NestFactory } from '@nestjs/core';
import { ApiModule } from '../apps/api/src/api.module';
import { FormatCliOutputStage } from '@libs/cli-review/pipeline/stages/format-cli-output.stage';
import { findingToSuggestion } from '@libs/code-review/pipeline/services/preview-env-findings';

async function main() {
    const app = await NestFactory.createApplicationContext(ApiModule, { logger: ['error'], abortOnError: false });
    console.log('APP BOOTED ✅');
    const format = app.get(FormatCliOutputStage, { strict: false });

    // A preview-env finding as it comes out of the agent (the real count bug we
    // reproduced live), mapped through the REAL mapping into a CodeSuggestion.
    const previewFinding = {
        description: 'Removing the `as count` alias breaks the count on SQLite: `const [{ count }]` is undefined → total returns NaN.',
        evidence: '$ node -e "knex(\'links\').count(\'*\')" -> [{"count(*)":3}] (no `count` key). GET /api/links -> {"total":null}',
        file: 'server/queries/link.queries.js',
        severity: 'medium' as const,
    };
    const context: any = {
        validSuggestions: [findingToSuggestion(previewFinding)],
        changedFiles: [{ filename: 'server/queries/link.queries.js' }],
        organizationAndTeamData: { organizationId: 'cli', teamId: 'cli' },
    };

    const out = await format.execute(context);
    console.log('\n=== CLI RESPONSE (what `kody review` returns) ===');
    console.log('issues:', out.cliResponse?.issues?.length);
    for (const iss of out.cliResponse?.issues ?? []) {
        console.log(JSON.stringify(iss, null, 2).slice(0, 900));
    }
    await app.close();
    console.log('DONE — a preview-env finding is returned in the CLI response.');
}
main().catch((e) => { console.error('ERROR:', e?.message ?? e); process.exit(1); });
