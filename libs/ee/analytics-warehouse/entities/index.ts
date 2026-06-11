import { BackfillProgressEntity } from './backfill-progress.entity';
import { CommitsViewEntity } from './commits-view.entity';
import { IngestionErrorEntity } from './ingestion-error.entity';
import { IngestionRunEntity } from './ingestion-run.entity';
import { IngestionWatermarkEntity } from './ingestion-watermark.entity';
import { PullRequestOptEntity } from './pull-request-opt.entity';
import { PullRequestTypeEntity } from './pull-request-type.entity';
import { SuggestionFeedbackEntity } from './suggestion-feedback.entity';
import { SuggestionMvEntity } from './suggestion-mv.entity';

export {
    BackfillProgressEntity,
    CommitsViewEntity,
    IngestionErrorEntity,
    IngestionRunEntity,
    IngestionWatermarkEntity,
    PullRequestOptEntity,
    PullRequestTypeEntity,
    SuggestionFeedbackEntity,
    SuggestionMvEntity,
};

export const ANALYTICS_ENTITIES = [
    PullRequestOptEntity,
    SuggestionMvEntity,
    SuggestionFeedbackEntity,
    CommitsViewEntity,
    PullRequestTypeEntity,
    IngestionWatermarkEntity,
    IngestionRunEntity,
    BackfillProgressEntity,
    IngestionErrorEntity,
];
