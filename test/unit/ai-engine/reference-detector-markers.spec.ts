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
