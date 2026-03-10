import type {
    AuthResponse,
    ReviewConfig,
    ReviewResult,
    PullRequestSuggestionsResponse,
    BusinessValidationResponse,
    TrialReviewResult,
    TrialStatus,
    UserInfo,
    MemoryCaptureApiRequest,
    MemoryCaptureApiResponse,
} from '../../types/index.js';
import type { SessionApiEvent } from '../../types/session-events.js';

export interface IAuthApi {
    login(email: string, password: string): Promise<AuthResponse>;
    refresh(refreshToken: string): Promise<AuthResponse>;
    logout(accessToken: string): Promise<void>;
    generateCIToken(accessToken: string): Promise<string>;
    verify(accessToken: string): Promise<{ valid: boolean; user?: UserInfo }>;
}

export interface GitMetrics {
    userEmail?: string;
    gitRemote?: string;
    branch?: string;
    commitSha?: string;
    inferredPlatform?: 'GITHUB' | 'GITLAB' | 'BITBUCKET' | 'AZURE_REPOS';
    cliVersion?: string;
}

export interface IReviewApi {
    analyze(
        diff: string,
        accessToken: string,
        config?: ReviewConfig,
    ): Promise<ReviewResult>;
    analyzeWithMetrics(
        diff: string,
        accessToken: string,
        config?: ReviewConfig,
        metrics?: GitMetrics,
    ): Promise<ReviewResult>;
    getPullRequestSuggestions(
        accessToken: string,
        params: {
            prUrl?: string;
            prNumber?: number;
            repositoryId?: string;
            format?: 'markdown';
            severity?: string;
            category?: string;
        },
    ): Promise<PullRequestSuggestionsResponse>;
    triggerBusinessValidation(
        accessToken: string,
        params: {
            repository?: string;
            taskUrl?: string;
            taskId?: string;
            diff?: string;
        },
    ): Promise<BusinessValidationResponse>;
    trialAnalyze(diff: string, fingerprint: string): Promise<TrialReviewResult>;
}

export interface ITrialApi {
    getStatus(fingerprint: string): Promise<TrialStatus>;
}

export interface IMemoryApi {
    submitCapture(
        payload: MemoryCaptureApiRequest,
        accessToken: string,
    ): Promise<MemoryCaptureApiResponse>;
}

export interface ISessionsApi {
    sendEvent(event: SessionApiEvent, repoRoot: string): Promise<void>;
}

export interface IKodusApi {
    auth: IAuthApi;
    review: IReviewApi;
    trial: ITrialApi;
    memory: IMemoryApi;
    sessions: ISessionsApi;
}
