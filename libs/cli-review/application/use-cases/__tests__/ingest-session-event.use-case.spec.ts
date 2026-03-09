import { IngestSessionEventUseCase } from '../ingest-session-event.use-case';
import { ClassifySessionUseCase } from '../classify-session.use-case';
import { SessionEventRepository } from '@libs/cli-review/infrastructure/repositories/session-event.repository';

describe('IngestSessionEventUseCase', () => {
    let useCase: IngestSessionEventUseCase;
    let repo: jest.Mocked<SessionEventRepository>;
    let classifyUseCase: jest.Mocked<ClassifySessionUseCase>;

    beforeEach(() => {
        repo = {
            create: jest.fn(),
        } as any;

        classifyUseCase = {
            execute: jest.fn().mockResolvedValue(undefined),
        } as any;

        useCase = new IngestSessionEventUseCase(repo, classifyUseCase);
    });

    const baseParams = {
        organizationAndTeamData: {
            organizationId: 'org-1',
            teamId: 'team-1',
        },
    } as any;

    it('should persist event and return accepted', async () => {
        repo.create.mockResolvedValue({ uuid: 'evt-1' } as any);

        const result = await useCase.execute({
            ...baseParams,
            event: {
                sessionId: 'sess-1',
                type: 'turn_start' as const,
                branch: 'main',
                timestamp: '2025-01-01T00:00:00Z',
                prompt: 'hello',
            },
        });

        expect(result).toEqual({ accepted: true });
        expect(repo.create).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationId: 'org-1',
                sessionId: 'sess-1',
                type: 'turn_start',
            }),
        );
    });

    it('should NOT trigger classification for non session_end events', async () => {
        repo.create.mockResolvedValue({ uuid: 'evt-1' } as any);

        await useCase.execute({
            ...baseParams,
            event: {
                sessionId: 'sess-1',
                type: 'turn_start' as const,
                branch: 'main',
                timestamp: '2025-01-01T00:00:00Z',
            },
        });

        // Wait for any setImmediate callbacks
        await new Promise((r) => setImmediate(r));

        expect(classifyUseCase.execute).not.toHaveBeenCalled();
    });

    it('should trigger classification for session_end events', async () => {
        repo.create.mockResolvedValue({ uuid: 'end-1' } as any);

        await useCase.execute({
            ...baseParams,
            event: {
                sessionId: 'sess-1',
                type: 'session_end' as const,
                branch: 'main',
                timestamp: '2025-01-01T00:00:00Z',
            },
        });

        // Wait for setImmediate callback
        await new Promise((r) => setImmediate(r));

        expect(classifyUseCase.execute).toHaveBeenCalledWith('end-1');
    });

    it('should not throw if classification fails asynchronously', async () => {
        repo.create.mockResolvedValue({ uuid: 'end-1' } as any);
        classifyUseCase.execute.mockRejectedValue(new Error('classify boom'));

        const result = await useCase.execute({
            ...baseParams,
            event: {
                sessionId: 'sess-1',
                type: 'session_end' as const,
                branch: 'main',
                timestamp: '2025-01-01T00:00:00Z',
            },
        });

        expect(result).toEqual({ accepted: true });

        // Wait for setImmediate — should not throw
        await new Promise((r) => setImmediate(r));
    });
});
