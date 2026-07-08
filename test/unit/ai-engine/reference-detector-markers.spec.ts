import { ReferenceDetectorService } from '@libs/ai-engine/infrastructure/adapters/services/reference-detector.service';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('ReferenceDetectorService.extractMarkers', () => {
    const service = Object.create(
        ReferenceDetectorService.prototype,
    ) as ReferenceDetectorService;

    it('does NOT treat Kodus control markers as file references', () => {
        // Every rule file synced via the @kody-sync marker used to get a
        // spurious "file not found: @kody-sync" sync error on the rule.
        const markers = service.extractMarkers(
            'Rule body here.\n\n@kody-sync\n\nAlso @KODY-SYNC and @kody-ignore.',
            [],
        );
        expect(markers).toEqual([]);
    });

    it('still extracts real @file references', () => {
        const markers = service.extractMarkers(
            'See @AGENTS.md and @docs/standards.md for details. @kody-sync',
            [],
        );
        expect(markers).toContain('@AGENTS.md');
        expect(markers).toContain('@docs/standards.md');
        expect(markers).not.toContain('@kody-sync');
    });
});

// LLM path: the detector's model output itself can name control markers as
// files. The regex-path fix alone was NOT enough — reproduced live on the
// manual validation env ('File not found: @kody-sync' on a clean rule).
jest.mock('@libs/llm/llm-call', () => ({
    tracedGenerateText: jest.fn().mockResolvedValue({
        text: JSON.stringify([
            { filePath: '@kody-sync', originalText: '@kody-sync' },
            // The EXACT production shape that escaped the first fix: the
            // model fabricates a repo prefix around the marker.
            {
                filePath: 'kody-sync/@kody-sync',
                fileName: 'kody-sync/@kody-sync',
                repositoryName: 'kody-sync',
                originalText: '@kody-sync',
            },
            {
                filePath: 'docs/real-file.md',
                originalText: '@docs/real-file.md',
            },
        ]),
    }),
}));
jest.mock('@libs/llm/byok-to-vercel', () => ({
    byokToVercelModel: jest.fn().mockReturnValue({}),
    getModelName: jest.fn().mockReturnValue('mock-model'),
}));
jest.mock('@libs/core/log/langfuse', () => ({
    buildLangfuseTelemetry: jest.fn().mockReturnValue({}),
}));

describe('ReferenceDetectorService.detectReferences (LLM path)', () => {
    it('filters Kodus control markers from the model output', async () => {
        const { ReferenceDetectorService: Svc } = jest.requireActual(
            '@libs/ai-engine/infrastructure/adapters/services/reference-detector.service',
        );
        const service = Object.create(Svc.prototype);
        // logger is a field initializer (createLogger), which Object.create
        // skips — inject the mock directly.
        service.logger = {
            log: jest.fn(),
            debug: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };
        const refs = await service.detectReferences({
            requirementId: 'r1',
            promptText: 'rule body with @kody-sync and @docs/real-file.md',
            organizationAndTeamData: { organizationId: 'o', teamId: 't' },
            detectionMode: 'rule',
        });

        expect(refs).toHaveLength(1);
        expect(refs[0].filePath).toBe('docs/real-file.md');
    });
});
