import { CoreDocument } from '@libs/core/infrastructure/repositories/model/mongodb';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

/**
 * An async "Generate config" job: the detect agent takes minutes (VM boot + an
 * agent run), too long for a blocking HTTP request, so the endpoint kicks it off
 * and stores the draft here; the UI polls by `draftId`. `result` is the
 * GeneratePlaybookResult once `status` is 'done' or 'error'.
 */
@Schema({
    collection: 'runtimePlaybookDrafts',
    timestamps: true,
    autoIndex: true,
})
export class RuntimePlaybookDraftModel extends CoreDocument {
    @Prop({ type: String, required: true })
    draftId: string;

    @Prop({ type: String, required: true })
    organizationId: string;

    @Prop({ type: String, required: false })
    teamId: string;

    @Prop({ type: String, required: false })
    repositoryId: string;

    @Prop({ type: String, required: true, enum: ['running', 'done', 'error'] })
    status: 'running' | 'done' | 'error';

    // The GeneratePlaybookResult once finished (playbookYaml, config, …).
    @Prop({ type: Object, required: false })
    result?: Record<string, any>;
}

export const RuntimePlaybookDraftSchema = SchemaFactory.createForClass(
    RuntimePlaybookDraftModel,
);

RuntimePlaybookDraftSchema.index(
    { draftId: 1 },
    { unique: true, name: 'idx_runtime_draft_id', background: true },
);
RuntimePlaybookDraftSchema.index(
    { organizationId: 1, repositoryId: 1, createdAt: -1 },
    { name: 'idx_runtime_draft_repo', background: true },
);
