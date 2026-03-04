import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    SessionEventModel,
    ClassificationSource,
} from './schemas/session-event.model';
import { CliSessionClassifiedDecision } from '@libs/cli-review/domain/types/cli-session-capture.types';

@Injectable()
export class SessionEventRepository {
    constructor(
        @InjectRepository(SessionEventModel)
        private readonly repo: Repository<SessionEventModel>,
    ) {}

    async create(data: Partial<SessionEventModel>): Promise<SessionEventModel> {
        const model = this.repo.create(data);
        return this.repo.save(model);
    }

    async findByUuid(uuid: string): Promise<SessionEventModel | null> {
        return this.repo.findOne({ where: { uuid } });
    }

    async findBySessionId(
        sessionId: string,
        organizationId: string,
    ): Promise<SessionEventModel[]> {
        return this.repo.find({
            where: { sessionId, organizationId },
            order: { eventTimestamp: 'ASC' },
        });
    }

    async markClassificationProcessing(uuid: string): Promise<void> {
        await this.repo.update(uuid, {
            classificationStatus: 'PROCESSING',
        });
    }

    async markClassificationCompleted(
        uuid: string,
        decisions: CliSessionClassifiedDecision[],
        source: ClassificationSource,
    ): Promise<void> {
        await this.repo.update(uuid, {
            classificationStatus: 'COMPLETED',
            decisions,
            classificationSource: source,
            classifiedAt: new Date(),
        });
    }

    async markClassificationFailed(
        uuid: string,
        errorMessage: string,
    ): Promise<void> {
        await this.repo.update(uuid, {
            classificationStatus: 'FAILED',
            classificationError: errorMessage,
            classifiedAt: new Date(),
        });
    }

    async markClassificationSkipped(
        uuid: string,
        reason: string,
    ): Promise<void> {
        await this.repo.update(uuid, {
            classificationStatus: 'SKIPPED',
            classificationError: reason,
            classifiedAt: new Date(),
        });
    }
}
