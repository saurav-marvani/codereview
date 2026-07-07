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
 * Kick off the async "Generate config" job for a repo. The server resolves the
 * repo (name/platform/clone URL) from the org integration, so the UI only sends
 * the id. Returns a draftId the UI polls.
 */
export class GenerateRuntimePlaybookDto {
    @IsObject()
    @ValidateNested()
    @Type(() => OrgTeamDto)
    organizationAndTeamData: OrgTeamDto;

    @IsNotEmpty()
    @IsString()
    repositoryId: string;

    @IsOptional()
    @IsString()
    branch?: string;
}
