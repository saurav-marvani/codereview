import { ClassifySessionUseCase } from '../classify-session.use-case';
import { SessionEventRepository } from '@libs/cli-review/infrastructure/repositories/session-event.repository';
import { SessionEventModel } from '@libs/cli-review/infrastructure/repositories/schemas/session-event.model';
import { PromptRunnerService } from '@kodus/kodus-common/llm';

function makeEvent(
    overrides: Partial<SessionEventModel>,
): SessionEventModel {
    return {
        uuid: 'evt-1',
        organizationId: 'org-1',
        teamId: 'team-1',
        sessionId: 'sess-1',
        type: 'session_start',
        branch: 'main',
        eventTimestamp: new Date(),
        payload: {},
        classificationStatus: null,
        decisions: null,
        classificationSource: null,
        classificationError: null,
        classifiedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    } as SessionEventModel;
}

describe('ClassifySessionUseCase', () => {
    let useCase: ClassifySessionUseCase;
    let repo: jest.Mocked<SessionEventRepository>;
    let promptRunner: jest.Mocked<PromptRunnerService>;

    beforeEach(() => {
        repo = {
            findByUuid: jest.fn(),
            findBySessionId: jest.fn(),
            markClassificationProcessing: jest.fn(),
            markClassificationCompleted: jest.fn(),
            markClassificationFailed: jest.fn(),
            markClassificationSkipped: jest.fn(),
            create: jest.fn(),
        } as any;

        promptRunner = {
            builder: jest.fn(),
        } as any;

        useCase = new ClassifySessionUseCase(repo, promptRunner);
    });

    it('should skip if event not found', async () => {
        repo.findByUuid.mockResolvedValue(null);

        await useCase.execute('missing-uuid');

        expect(repo.markClassificationSkipped).not.toHaveBeenCalled();
        expect(repo.markClassificationProcessing).not.toHaveBeenCalled();
    });

    it('should skip if event type is not session_end', async () => {
        repo.findByUuid.mockResolvedValue(
            makeEvent({ uuid: 'evt-1', type: 'turn_start' }),
        );

        await useCase.execute('evt-1');

        expect(repo.markClassificationSkipped).toHaveBeenCalledWith(
            'evt-1',
            expect.stringContaining('Unsupported event type'),
        );
    });

    it('should skip if no useful content in session', async () => {
        repo.findByUuid.mockResolvedValue(
            makeEvent({ uuid: 'end-1', type: 'session_end' }),
        );
        repo.findBySessionId.mockResolvedValue([
            makeEvent({ type: 'session_start', payload: {} }),
            makeEvent({ type: 'session_end', uuid: 'end-1', payload: {} }),
        ]);

        await useCase.execute('end-1');

        expect(repo.markClassificationSkipped).toHaveBeenCalledWith(
            'end-1',
            'No textual context for classification',
        );
    });

    it('should call LLM and mark completed on success', async () => {
        repo.findByUuid.mockResolvedValue(
            makeEvent({ uuid: 'end-1', type: 'session_end' }),
        );
        repo.findBySessionId.mockResolvedValue([
            makeEvent({
                type: 'session_start',
                payload: { agentType: 'claude-code' },
            }),
            makeEvent({
                type: 'turn_start',
                payload: { prompt: 'Add authentication to the API' },
            }),
            makeEvent({
                type: 'turn_end',
                payload: {
                    toolCalls: [{ tool: 'Edit', summary: 'edited auth.ts' }],
                    filesModified: ['src/auth.ts'],
                },
            }),
            makeEvent({ type: 'session_end', uuid: 'end-1', payload: {} }),
        ]);

        const mockExecute = jest.fn().mockResolvedValue({
            decisions: [
                {
                    type: 'implementation_detail',
                    decision: 'Use JWT for API authentication',
                    confidence: 0.85,
                },
            ],
        });

        promptRunner.builder.mockReturnValue({
            setProviders: jest.fn().mockReturnThis(),
            setParser: jest.fn().mockReturnThis(),
            setLLMJsonMode: jest.fn().mockReturnThis(),
            setTemperature: jest.fn().mockReturnThis(),
            setPayload: jest.fn().mockReturnThis(),
            addPrompt: jest.fn().mockReturnThis(),
            setRunName: jest.fn().mockReturnThis(),
            setBYOKConfig: jest.fn().mockReturnThis(),
            setBYOKFallbackConfig: jest.fn().mockReturnThis(),
            execute: mockExecute,
        } as any);

        await useCase.execute('end-1');

        expect(repo.markClassificationProcessing).toHaveBeenCalledWith('end-1');
        expect(repo.markClassificationCompleted).toHaveBeenCalledWith(
            'end-1',
            expect.arrayContaining([
                expect.objectContaining({
                    type: 'implementation_detail',
                    decision: 'Use JWT for API authentication',
                }),
            ]),
            'llm',
        );
    });

    it('should fallback to heuristics when LLM returns empty', async () => {
        repo.findByUuid.mockResolvedValue(
            makeEvent({ uuid: 'end-1', type: 'session_end' }),
        );
        repo.findBySessionId.mockResolvedValue([
            makeEvent({
                type: 'turn_start',
                payload: { prompt: 'We decided to use Redis for caching instead of Memcached' },
            }),
            makeEvent({
                type: 'turn_end',
                payload: { filesModified: ['src/cache.ts'] },
            }),
            makeEvent({ type: 'session_end', uuid: 'end-1', payload: {} }),
        ]);

        const mockExecute = jest.fn().mockResolvedValue({
            decisions: [],
        });

        promptRunner.builder.mockReturnValue({
            setProviders: jest.fn().mockReturnThis(),
            setParser: jest.fn().mockReturnThis(),
            setLLMJsonMode: jest.fn().mockReturnThis(),
            setTemperature: jest.fn().mockReturnThis(),
            setPayload: jest.fn().mockReturnThis(),
            addPrompt: jest.fn().mockReturnThis(),
            setRunName: jest.fn().mockReturnThis(),
            setBYOKConfig: jest.fn().mockReturnThis(),
            setBYOKFallbackConfig: jest.fn().mockReturnThis(),
            execute: mockExecute,
        } as any);

        await useCase.execute('end-1');

        expect(repo.markClassificationCompleted).toHaveBeenCalledWith(
            'end-1',
            expect.arrayContaining([
                expect.objectContaining({ type: expect.any(String) }),
            ]),
            'heuristic',
        );
    });

    it('should fallback to heuristics when LLM throws', async () => {
        repo.findByUuid.mockResolvedValue(
            makeEvent({ uuid: 'end-1', type: 'session_end' }),
        );
        repo.findBySessionId.mockResolvedValue([
            makeEvent({
                type: 'turn_start',
                payload: { prompt: 'Adopt convention: always use snake_case for DB columns' },
            }),
            makeEvent({
                type: 'turn_end',
                payload: { filesModified: ['src/db.ts'] },
            }),
            makeEvent({ type: 'session_end', uuid: 'end-1', payload: {} }),
        ]);

        const mockExecute = jest.fn().mockRejectedValue(new Error('LLM timeout'));

        promptRunner.builder.mockReturnValue({
            setProviders: jest.fn().mockReturnThis(),
            setParser: jest.fn().mockReturnThis(),
            setLLMJsonMode: jest.fn().mockReturnThis(),
            setTemperature: jest.fn().mockReturnThis(),
            setPayload: jest.fn().mockReturnThis(),
            addPrompt: jest.fn().mockReturnThis(),
            setRunName: jest.fn().mockReturnThis(),
            setBYOKConfig: jest.fn().mockReturnThis(),
            setBYOKFallbackConfig: jest.fn().mockReturnThis(),
            execute: mockExecute,
        } as any);

        await useCase.execute('end-1');

        expect(repo.markClassificationCompleted).toHaveBeenCalledWith(
            'end-1',
            expect.any(Array),
            'heuristic-fallback',
        );
    });

    it('should mark failed when both LLM and heuristics throw', async () => {
        repo.findByUuid.mockResolvedValue(
            makeEvent({ uuid: 'end-1', type: 'session_end' }),
        );
        // Return session with content so it doesn't skip
        repo.findBySessionId.mockResolvedValue([
            makeEvent({
                type: 'turn_start',
                payload: { prompt: 'do something' },
            }),
            makeEvent({ type: 'session_end', uuid: 'end-1', payload: {} }),
        ]);

        const mockExecute = jest.fn().mockRejectedValue(new Error('LLM down'));
        promptRunner.builder.mockReturnValue({
            setProviders: jest.fn().mockReturnThis(),
            setParser: jest.fn().mockReturnThis(),
            setLLMJsonMode: jest.fn().mockReturnThis(),
            setTemperature: jest.fn().mockReturnThis(),
            setPayload: jest.fn().mockReturnThis(),
            addPrompt: jest.fn().mockReturnThis(),
            setRunName: jest.fn().mockReturnThis(),
            setBYOKConfig: jest.fn().mockReturnThis(),
            setBYOKFallbackConfig: jest.fn().mockReturnThis(),
            execute: mockExecute,
        } as any);

        // Make markCompleted throw to simulate heuristic persistence failure
        repo.markClassificationCompleted.mockRejectedValue(
            new Error('DB write failed'),
        );

        await useCase.execute('end-1');

        expect(repo.markClassificationFailed).toHaveBeenCalledWith(
            'end-1',
            'DB write failed',
        );
    });
});
