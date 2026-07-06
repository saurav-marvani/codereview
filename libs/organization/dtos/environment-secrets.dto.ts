import { Type } from 'class-transformer';
import {
    IsNotEmpty,
    IsObject,
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
 * Body for the preview-env secrets vault write. `secrets` is a flat map of
 * NAME -> value; a value of `''` REMOVES that key (partial edits don't require
 * re-sending every secret). Values are encrypted at rest and NEVER returned by
 * the API — only `getStatus` returns the set of names.
 */
export class SetEnvironmentSecretsDto {
    @ValidateNested()
    @Type(() => OrganizationAndTeamDataDto)
    organizationAndTeamData: OrganizationAndTeamDataDto;

    @IsString()
    @IsNotEmpty()
    repositoryId: string;

    @IsObject()
    secrets: Record<string, string>;
}
