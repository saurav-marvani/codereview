import 'tsconfig-paths/register';
import { NestFactory } from '@nestjs/core';
import { ApiModule } from '../apps/api/src/api.module';
import { RunPreviewEnvStage } from '@libs/code-review/pipeline/stages/run-preview-env.stage';
import { PreviewEnvAgentService } from '@libs/sandbox/infrastructure/services/preview-env-agent.service';
import { VmSandboxService } from '@libs/sandbox/infrastructure/providers/vm-sandbox.service';

async function main() {
    console.log('Booting the real ApiModule (validates DI wiring with the preview-env changes)...');
    const app = await NestFactory.createApplicationContext(ApiModule, {
        logger: ['error', 'warn'],
        abortOnError: false,
    });
    console.log('APP BOOTED ✅');
    const stage = app.get(RunPreviewEnvStage, { strict: false });
    const agent = app.get(PreviewEnvAgentService, { strict: false });
    const vm = app.get(VmSandboxService, { strict: false });
    console.log('DI RESOLVED ✅ RunPreviewEnvStage:', !!stage, '| PreviewEnvAgentService:', !!agent, '| VmSandboxService:', !!vm);
    console.log('vm.isAvailable():', vm.isAvailable());
    await app.close();
    console.log('DONE — preview-env integration wires into the real Kody app.');
}
main().catch((e) => { console.error('BOOT ERROR:', e?.message ?? e); process.exit(1); });
