import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiOkResponse,
    ApiOperation,
    ApiQuery,
    ApiTags,
} from '@nestjs/swagger';

import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkPermissions } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { GetIntegrationGithubUseCase } from '@libs/platform/application/use-cases/github/get-integration-github';
import { GetOrganizationNameUseCase as GetGithubOrganizationNameUseCase } from '@libs/platform/application/use-cases/github/getOrganizationName.use-case';

import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import { ApiStringResponseDto } from '../dtos/api-response.dto';

@ApiTags('Github')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@Controller('github')
export class GithubController {
    constructor(
        private readonly getIntegrationGithubUseCase: GetIntegrationGithubUseCase,
        private readonly getGithubOrganizationNameUseCase: GetGithubOrganizationNameUseCase,
    ) {}

    @Get('/integration')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.GitSettings,
        }),
    )
    @ApiOperation({
        summary: 'Get GitHub installation status by installId',
        description:
            'Used by the GitHub App callback page to resolve the installation status and organization name after the user finishes installing the app on GitHub.',
    })
    @ApiQuery({ name: 'installId', required: true, type: String })
    public getIntegration(@Query('installId') installId: string) {
        return this.getIntegrationGithubUseCase.execute(installId);
    }

    @Get('/organization-name')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.GitSettings,
        }),
    )
    @ApiOperation({
        summary: 'Get the GitHub organization/account name for the current org',
        description:
            'Returns the GitHub account login (org or user) linked to the authenticated Kodus organization.',
    })
    @ApiOkResponse({ type: ApiStringResponseDto })
    public getOrganizationName() {
        return this.getGithubOrganizationNameUseCase.execute();
    }
}
