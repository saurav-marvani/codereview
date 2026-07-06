import { Type } from 'class-transformer';
import {
    IsIn,
    IsNotEmpty,
    IsOptional,
    IsString,
    ValidateNested,
} from 'class-validator';

class OrganizationAndTeamDataDto {
    @IsString()
    @IsNotEmpty()
    teamId: string;

    @IsString()
    @IsOptional()
    organizationId?: string;
}

/**
 * Body for the preview-env infrastructure write (org-level BYO-cloud for
 * self-hosted). `token` is the cloud API token: encrypted at rest, never
 * returned; `''` removes it, omitted keeps the existing one.
 */
export class SetEnvironmentInfraDto {
    @ValidateNested()
    @Type(() => OrganizationAndTeamDataDto)
    organizationAndTeamData: OrganizationAndTeamDataDto;

    @IsIn(['hetzner'])
    provider: 'hetzner';

    @IsString()
    @IsOptional()
    token?: string;

    @IsString()
    @IsOptional()
    region?: string;

    @IsString()
    @IsOptional()
    serverType?: string;
}
