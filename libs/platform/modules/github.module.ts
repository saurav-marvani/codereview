import { Module, forwardRef } from '@nestjs/common';

import { GlobalCacheModule } from '@libs/core/cache/cache.module';
import { AuthIntegrationModule } from '@libs/integrations/modules/authIntegration.module';
import { IntegrationConfigCoreModule } from '@libs/integrations/modules/config-core.module';
import { IntegrationCoreModule } from '@libs/integrations/modules/integrations-core.module';
import { McpCoreModule } from '@libs/mcp-server/mcp-core.module';
import { GithubService as GitHubService } from '../infrastructure/adapters/services/github/github.service';

@Module({
    imports: [
        forwardRef(() => AuthIntegrationModule),
        forwardRef(() => IntegrationCoreModule),
        forwardRef(() => IntegrationConfigCoreModule),
        forwardRef(() => GlobalCacheModule),
        McpCoreModule,
    ],
    providers: [GitHubService],
    exports: [GitHubService],
})
export class GithubModule {}
