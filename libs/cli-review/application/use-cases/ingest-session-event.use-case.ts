import { Injectable } from '@nestjs/common';
import { createLogger } from '@kodus/flow';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { SessionEventRepository } from '@libs/cli-review/infrastructure/repositories/session-event.repository';
import { SessionEventType } from '@libs/cli-review/infrastructure/repositories/schemas/session-event.model';
import { ClassifySessionUseCase } from './classify-session.use-case';

interface IngestSessionEventInput {
    organizationAndTeamData: OrganizationAndTeamData;
    event: {
        sessionId: string;
        type: SessionEventType;
        branch: string;
        timestamp: string;
        [key: string]: unknown;
    };
}

@Injectable()
export class IngestSessionEventUseCase implements IUseCase {
    private readonly logger = createLogger(IngestSessionEventUseCase.name);

    constructor(
        private readonly sessionEventRepository: SessionEventRepository,
        private readonly classifySessionUseCase: ClassifySessionUseCase,
    ) {}

    async execute(params: IngestSessionEventInput): Promise<{ accepted: boolean }> {
        const { organizationAndTeamData, event } = params;

        let sessionId: string | undefined;
        let type: SessionEventType | undefined;

        try {
            const { sessionId: sid, type: t, branch, timestamp, ...rest } = event;
            sessionId = sid;
            type = t;

            const saved = await this.sessionEventRepository.create({
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
                sessionId,
                type,
                branch,
                eventTimestamp: new Date(timestamp),
                payload: rest,
            });

            if (type === 'session_end') {
                setImmediate(() => {
                    void this.classifySessionUseCase
                        .execute(saved.uuid)
                        .catch((classifyError) => {
                            this.logger.error({
                                message:
                                    'Failed to classify session after session_end',
                                context: IngestSessionEventUseCase.name,
                                error: classifyError,
                                metadata: {
                                    sessionEndEventUuid: saved.uuid,
                                    sessionId,
                                },
                            });
                        });
                });
            }

            return { accepted: true };
        } catch (error) {
            this.logger.error({
                message: 'Failed to ingest session event',
                context: IngestSessionEventUseCase.name,
                error,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    sessionId,
                    type,
                },
            });

            throw error;
        }
    }
}
