import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { RuntimePlaybookDraftModel } from './schemas/mongoose/runtimePlaybookDraft.model';

/**
 * Persistence for async "Generate config" jobs (runtimePlaybookDrafts). One
 * create when the job starts (status running), one complete when the detect
 * agent finishes; read back by the UI polling `draftId`.
 */
@Injectable()
export class RuntimePlaybookDraftRepository {
    constructor(
        @InjectModel(RuntimePlaybookDraftModel.name)
        private readonly model: Model<RuntimePlaybookDraftModel>,
    ) {}

    async create(params: {
        draftId: string;
        organizationId: string;
        teamId?: string;
        repositoryId?: string;
    }): Promise<void> {
        await this.model.create({ ...params, status: 'running' });
    }

    async complete(
        draftId: string,
        status: 'done' | 'error',
        result: Record<string, any>,
    ): Promise<void> {
        await this.model
            .updateOne({ draftId }, { $set: { status, result } })
            .exec();
    }

    async findByDraftId(
        draftId: string,
    ): Promise<RuntimePlaybookDraftModel | null> {
        return this.model
            .findOne({ draftId })
            .lean<RuntimePlaybookDraftModel>()
            .exec();
    }
}
