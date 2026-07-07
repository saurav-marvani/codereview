import {
    IsNotEmpty,
    IsObject,
    IsOptional,
    IsString,
    ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class OrgTeamDto {
    @IsOptional()
    @IsString()
    organizationId?: string;

    @IsNotEmpty()
    @IsString()
    teamId: string;
}

/**
 * Kick off the async "Generate config" job for a repo. The repo identity comes
 * from the settings UI (which already knows it), so the server doesn't re-look
 * it up. Returns a draftId the UI polls.
 */
export class GenerateRuntimePlaybookDto {
    @IsObject()
    @ValidateNested()
    @Type(() => OrgTeamDto)
    organizationAndTeamData: OrgTeamDto;

    @IsNotEmpty()
    @IsString()
    repositoryId: string;

    @IsNotEmpty()
    @IsString()
    repositoryName: string;

    @IsNotEmpty()
    @IsString()
    platformType: string;

    @IsOptional()
    @IsString()
    defaultBranch?: string;

    @IsOptional()
    @IsString()
    branch?: string;
}
