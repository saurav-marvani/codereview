import 'dotenv/config';

import { setupSentry } from '@libs/core/infrastructure/config/log/sentry';
import { setupLangfuseTracing } from '@libs/core/log/langfuse';

setupSentry('webhook');
setupLangfuseTracing();
