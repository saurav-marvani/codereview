import { LangfuseSpanProcessor } from '@langfuse/otel';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { trace, type AttributeValue } from '@opentelemetry/api';

let spanProcessor: LangfuseSpanProcessor | null = null;
let ownTracerProvider: NodeTracerProvider | null = null;
let beforeExitInstalled = false;

export function shouldTrace(): boolean {
    return (
        process.env.LANGFUSE_TRACING === 'true' &&
        !!process.env.LANGFUSE_PUBLIC_KEY &&
        !!process.env.LANGFUSE_SECRET_KEY
    );
}

/**
 * `beforeExit` fires when Node's event loop drains and the process is about
 * to exit naturally — including the path taken when `uncaughtException` /
 * `unhandledRejection` are swallowed by the global handlers in each
 * app's `main.ts` and the app then quiesces. SIGTERM/SIGINT graceful
 * shutdowns go through `LangfuseShutdownProvider` instead.
 *
 * Idempotent: only installs once per process.
 */
function installBeforeExitFlush(): void {
    if (beforeExitInstalled) return;
    beforeExitInstalled = true;

    process.on('beforeExit', async () => {
        await flushLangfuse();
    });
}

/**
 * Register Langfuse's OTel span processor so Vercel AI SDK
 * `experimental_telemetry` and manual `startActiveObservation` spans flow to
 * Langfuse. Safe to call from every app entrypoint; later calls are no-ops.
 *
 * Coexists with Sentry (`@sentry/opentelemetry`) by attaching the processor
 * to the already-registered provider. If no provider is registered yet,
 * bootstraps a fresh `NodeTracerProvider`.
 */
export function setupLangfuseTracing(): LangfuseSpanProcessor | null {
    if (spanProcessor) return spanProcessor;
    if (!shouldTrace()) return null;

    spanProcessor = new LangfuseSpanProcessor({
        environment:
            process.env.LANGFUSE_ENVIRONMENT ??
            process.env.API_NODE_ENV ??
            'development',
    });

    const provider = trace.getTracerProvider() as any;
    const delegate =
        typeof provider?.getDelegate === 'function'
            ? provider.getDelegate()
            : provider;

    if (typeof delegate?.addSpanProcessor === 'function') {
        delegate.addSpanProcessor(spanProcessor);
    } else {
        ownTracerProvider = new NodeTracerProvider({
            spanProcessors: [spanProcessor],
        });
        ownTracerProvider.register();
    }

    installBeforeExitFlush();

    return spanProcessor;
}

export async function flushLangfuse(): Promise<void> {
    if (!spanProcessor) return;
    try {
        await spanProcessor.forceFlush();
    } catch {
        // best-effort flush on shutdown
    }
}

export async function shutdownLangfuse(): Promise<void> {
    if (ownTracerProvider) {
        try {
            await ownTracerProvider.shutdown();
        } catch {
            // best-effort
        }
        ownTracerProvider = null;
    }
    spanProcessor = null;
}

export interface LangfuseTelemetryMetadata {
    organizationId?: string;
    teamId?: string;
    pullRequestId?: number;
    repositoryId?: string;
    provider?: string;
}

/**
 * Build the `experimental_telemetry` config for a Vercel AI SDK call.
 * `functionId` sets the observation name in Langfuse; `metadata` shows up
 * in the Metadata tab. Safe to call when tracing is disabled — the AI SDK
 * reads `isEnabled` and skips span emission.
 */
export function buildLangfuseTelemetry(
    functionId: string,
    metadata?: LangfuseTelemetryMetadata,
): {
    isEnabled: boolean;
    functionId: string;
    metadata?: Record<string, AttributeValue>;
} {
    const attrs: Record<string, AttributeValue> = {};
    if (metadata?.organizationId) attrs.organizationId = metadata.organizationId;
    if (metadata?.teamId) attrs.teamId = metadata.teamId;
    if (metadata?.pullRequestId !== undefined)
        attrs.pullRequestId = metadata.pullRequestId;
    if (metadata?.repositoryId) attrs.repositoryId = metadata.repositoryId;
    if (metadata?.provider) attrs.provider = metadata.provider;
    return {
        isEnabled: shouldTrace(),
        functionId,
        ...(Object.keys(attrs).length > 0 && { metadata: attrs }),
    };
}
