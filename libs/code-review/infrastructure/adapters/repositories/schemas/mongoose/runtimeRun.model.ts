import { RuntimeRunRecord } from '@libs/code-review/pipeline/services/preview-env-run';
import { CoreDocument } from '@libs/core/infrastructure/repositories/model/mongodb';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

/**
 * A persisted Kody Runtime run — the full, redacted record (transcript + phase
 * and service logs + summary + findings) so the PR reviewer can open it and see
 * 100% of what the model did in the VM. Keyed by org/repo/PR; `runId` uniquely
 * identifies one run for the viewer link.
 */
@Schema({
    collection: 'runtimeRuns',
    timestamps: true,
    autoIndex: true,
})
export class RuntimeRunModel extends CoreDocument {
    @Prop({ type: String, required: true })
    runId: string;

    @Prop({ type: String, required: true })
    organizationId: string;

    @Prop({ type: String, required: false })
    teamId: string;

    @Prop({ type: String, required: false })
    repositoryId: string;

    @Prop({ type: Number, required: false })
    prNumber: number;

    // The whole redacted record (transcript, phases, service log, summary…).
    // Stored as an opaque object — it's read back and rendered wholesale.
    @Prop({ type: Object, required: true })
    record: RuntimeRunRecord;
}

export const RuntimeRunSchema = SchemaFactory.createForClass(RuntimeRunModel);

RuntimeRunSchema.index({ runId: 1 }, { unique: true, name: 'idx_runtime_run_id', background: true });
RuntimeRunSchema.index(
    { organizationId: 1, repositoryId: 1, prNumber: 1, createdAt: -1 },
    { name: 'idx_runtime_run_pr', background: true },
);
