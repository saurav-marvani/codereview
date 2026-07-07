import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { RuntimeRunRecord } from '@libs/code-review/pipeline/services/preview-env-run';
import { RuntimeRunModel } from './schemas/mongoose/runtimeRun.model';

export interface SaveRuntimeRunParams {
    runId: string;
    organizationId: string;
    teamId?: string;
    repositoryId?: string;
    prNumber?: number;
    record: RuntimeRunRecord;
}

export interface RuntimeRunSummary {
    runId: string;
    prNumber?: number;
    ok: boolean;
    findingsCount: number;
    turns: number;
    startedAt?: string;
    finishedAt?: string;
}

/**
 * Persistence for Kody Runtime run records (the `runtimeRuns` collection). One
 * write per run at the end of the stage; read back by the viewer (by runId) and
 * the PR history (by org/repo/PR).
 */
@Injectable()
export class RuntimeRunRepository {
    constructor(
        @InjectModel(RuntimeRunModel.name)
        private readonly model: Model<RuntimeRunModel>,
    ) {}

    async save(params: SaveRuntimeRunParams): Promise<void> {
        await this.model
            .updateOne({ runId: params.runId }, { $set: params }, { upsert: true })
            .exec();
    }

    /** The full record for the viewer. */
    async findByRunId(runId: string): Promise<RuntimeRunModel | null> {
        return this.model.findOne({ runId }).lean<RuntimeRunModel>().exec();
    }

    /** Lightweight list for a PR's runtime-run history (no heavy transcript). */
    async listByPr(
        organizationId: string,
        repositoryId: string,
        prNumber: number,
    ): Promise<RuntimeRunSummary[]> {
        const rows = await this.model
            .find({ organizationId, repositoryId, prNumber })
            .sort({ createdAt: -1 })
            .select({ runId: 1, prNumber: 1, record: 1, _id: 0 })
            .lean<Array<Pick<RuntimeRunModel, 'runId' | 'prNumber' | 'record'>>>()
            .exec();
        return rows.map((r) => ({
            runId: r.runId,
            prNumber: r.prNumber,
            ok: !!r.record?.ok,
            findingsCount: r.record?.findingsCount ?? 0,
            turns: r.record?.turns ?? 0,
            startedAt: r.record?.startedAt,
            finishedAt: r.record?.finishedAt,
        }));
    }
}
