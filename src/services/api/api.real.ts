import type {
    AuthResponse,
    ReviewConfig,
    ReviewResult,
    PullRequestSuggestionsResponse,
    BusinessValidationResponse,
    TrialReviewResult,
    TrialStatus,
} from '../../types/index.js';
import { ApiError } from '../../types/index.js';
import type {
    MemoryCaptureApiRequest,
    MemoryCaptureApiResponse,
} from '../../types/index.js';
import type {
    IKodusApi,
    IAuthApi,
    IReviewApi,
    ITrialApi,
    IMemoryApi,
    ISessionsApi,
    GitMetrics,
} from './api.interface.js';
import { RealSessionsApi } from './sessions.api.js';
import { loadConfig, type CliConfig } from '../../utils/config.js';
import { getDeviceIdentity, updateDeviceToken } from '../../utils/device.js';
import { cliDebug, cliError, isCliVerboseMode } from '../../utils/logger.js';

/**
 * Cached config loaded once at first request.
 */
let _configCache: CliConfig | null | undefined;

async function getCachedConfig(): Promise<CliConfig | null> {
    if (_configCache === undefined) {
        _configCache = await loadConfig();
    }
    return _configCache;
}

/** @internal Exported for testing only. */
export function _resetConfigCache(): void {
    _configCache = undefined;
}

/**
 * Validates a custom API URL. Returns it if valid, or null if invalid.
 */
function validateApiUrl(customUrl: string): string | null {
    const defaultUrl = 'https://api.kodus.io';

    try {
        const url = new URL(customUrl);

        const isLocalhost =
            url.hostname === 'localhost' || url.hostname === '127.0.0.1';
        if (url.protocol !== 'https:' && !isLocalhost) {
            cliError('Security Error: API URL must use HTTPS protocol');
            cliError(`Falling back to default: ${defaultUrl}`);
            return null;
        }

        const standardDomains = ['api.kodus.io', 'localhost', '127.0.0.1'];
        const isStandard = standardDomains.some(
            (domain) =>
                url.hostname === domain || url.hostname.endsWith(`.${domain}`),
        );

        if (!isStandard && isCliVerboseMode()) {
            cliDebug(`Warning: Using non-standard API URL: ${url.hostname}`);
        }

        return customUrl;
    } catch {
        cliError('Invalid API URL format:', customUrl);
        cliError(`Falling back to default: ${defaultUrl}`);
        return null;
    }
}

/**
 * Returns the API base URL.
 * Priority: KODUS_API_URL env var > config.json apiUrl > default
 */
export async function resolveApiBaseUrl(): Promise<string> {
    const defaultUrl = 'https://api.kodus.io';

    // Env var takes priority
    if (process.env.KODUS_API_URL) {
        return validateApiUrl(process.env.KODUS_API_URL) ?? defaultUrl;
    }

    // Then config file
    const config = await getCachedConfig();
    if (config?.apiUrl) {
        return validateApiUrl(config.apiUrl) ?? defaultUrl;
    }

    return defaultUrl;
}

const REQUEST_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

/**
 * Returns Cloudflare Access headers when configured.
 * Priority: env vars > config.json
 *
 * Required when the API is behind Cloudflare Access (zero-trust proxy).
 */
export async function getCloudflareAccessHeaders(): Promise<
    Record<string, string>
> {
    const clientId = process.env.CF_ACCESS_CLIENT_ID;
    const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET;

    if (clientId && clientSecret) {
        return {
            'CF-Access-Client-Id': clientId,
            'CF-Access-Client-Secret': clientSecret,
        };
    }

    const config = await getCachedConfig();
    if (config?.cfAccessClientId && config?.cfAccessClientSecret) {
        return {
            'CF-Access-Client-Id': config.cfAccessClientId,
            'CF-Access-Client-Secret': config.cfAccessClientSecret,
        };
    }

    return {};
}

interface ApiErrorPayload {
    message?: string;
    code?: string;
    details?: {
        limit?: number;
        current?: number;
        activeDevices?: number;
    };
}

function getDefaultApiErrorMessage(
    statusCode: number,
    endpoint: string,
): string {
    const endpointPath = endpoint.split('?')[0] || endpoint;

    if (statusCode === 400) {
        return `Invalid request sent to Kodus API (${endpointPath}).`;
    }

    if (statusCode === 401) {
        if (endpointPath === '/pull-requests/suggestions') {
            return 'Authentication failed while fetching pull request suggestions. Run: kodus auth login or configure a valid team key.';
        }
        return 'Authentication failed. Run: kodus auth login or configure a valid team key.';
    }

    if (statusCode === 403) {
        return `Access denied for Kodus API endpoint (${endpointPath}).`;
    }

    if (statusCode === 404) {
        return `Kodus API endpoint not found (${endpointPath}).`;
    }

    if (statusCode === 422) {
        return `Kodus API could not process the request (${endpointPath}).`;
    }

    if (statusCode === 429) {
        return 'Rate limit exceeded. Please try again later.';
    }

    if (statusCode >= 500) {
        return 'Kodus API is currently unavailable. Please try again.';
    }

    return `Request failed with status ${statusCode}`;
}

function normalizeApiErrorMessage(
    statusCode: number,
    endpoint: string,
    errorData: ApiErrorPayload,
): string {
    if (errorData.code === 'DEVICE_LIMIT_REACHED') {
        const limit = errorData.details?.limit;
        const activeDevices =
            errorData.details?.current ?? errorData.details?.activeDevices;
        if (typeof limit === 'number' && typeof activeDevices === 'number') {
            return `Device limit reached (${activeDevices}/${limit}). Remove an old device or contact your admin.`;
        }
        return 'Device limit reached for this organization. Remove an old device or contact your admin.';
    }

    const fallbackMessage = getDefaultApiErrorMessage(statusCode, endpoint);
    if (!errorData.message || typeof errorData.message !== 'string') {
        return fallbackMessage;
    }

    // Keep auth/permission/server errors deterministic and always in CLI English.
    // 404 is excluded: the backend may return meaningful "not found" details
    // (e.g. "Pull request not found") that are more useful than the generic message.
    if (
        statusCode === 401 ||
        statusCode === 403 ||
        statusCode === 429 ||
        statusCode >= 500
    ) {
        return fallbackMessage;
    }

    const trimmed = errorData.message.trim();
    if (!trimmed) {
        return fallbackMessage;
    }

    const hasNonAscii = /[^\p{ASCII}]/u.test(trimmed);
    if (hasNonAscii) {
        return fallbackMessage;
    }

    return trimmed;
}

export async function request<T>(
    endpoint: string,
    options: RequestInit = {},
): Promise<T> {
    const baseUrl = await resolveApiBaseUrl();
    const url = `${baseUrl}${endpoint}`;
    let deviceIdentity: { deviceId: string; deviceToken?: string } | undefined;

    if (isCliVerboseMode()) {
        cliDebug(`[API] ${options.method || 'GET'} ${url}`);
    }

    try {
        deviceIdentity = await getDeviceIdentity();
    } catch (error) {
        if (isCliVerboseMode()) {
            cliDebug('[API] Unable to resolve device id:', error);
        }
    }

    const cfHeaders = await getCloudflareAccessHeaders();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
        response = await fetch(url, {
            ...options,
            signal: controller.signal,
            headers: {
                'Content-Type': 'application/json',
                ...cfHeaders,
                ...(deviceIdentity?.deviceId
                    ? { 'X-Kodus-Device-Id': deviceIdentity.deviceId }
                    : {}),
                ...(deviceIdentity?.deviceToken
                    ? { 'X-Kodus-Device-Token': deviceIdentity.deviceToken }
                    : {}),
                ...options.headers,
            },
        });
    } catch (error) {
        clearTimeout(timeout);
        if (error instanceof DOMException && error.name === 'AbortError') {
            throw new ApiError(
                408,
                'Request timed out. The server took too long to respond. Please try again.',
            );
        }
        throw error;
    }

    clearTimeout(timeout);

    const responseDeviceToken = response.headers.get('x-kodus-device-token');
    if (responseDeviceToken) {
        await updateDeviceToken(responseDeviceToken).catch(() => {});
    }

    const contentType = response.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');

    if (!response.ok) {
        const rawError = isJson
            ? await response.json().catch(() => ({ message: 'Request failed' }))
            : { message: `Request failed with status ${response.status}` };
        // Unwrap API envelope: errors may arrive as { data: { code, message, ... } }
        // Only unwrap if the top-level object has no message/code of its own.
        const errorData: ApiErrorPayload =
            rawError &&
            typeof rawError === 'object' &&
            'data' in rawError &&
            rawError.data &&
            typeof rawError.data === 'object' &&
            !('message' in rawError) &&
            !('code' in rawError)
                ? (rawError.data as ApiErrorPayload)
                : (rawError as ApiErrorPayload);
        const errorMessage = normalizeApiErrorMessage(
            response.status,
            endpoint,
            errorData,
        );

        if (isCliVerboseMode()) {
            cliDebug('[API] Error:', {
                status: response.status,
                url,
                contentType,
                errorData,
                normalizedMessage: errorMessage,
            });
        }

        throw new ApiError(response.status, errorMessage);
    }

    if (!isJson) {
        const text = await response.text();
        const preview = text.substring(0, 100);
        cliError(
            `[API] Expected JSON but received ${contentType || 'unknown content-type'}`,
        );
        cliError(`[API] URL: ${url}`);
        cliError(`[API] Response preview: ${preview}...`);
        throw new ApiError(
            500,
            `API returned invalid response (expected JSON, got ${contentType || 'HTML'})`,
        );
    }

    const json = (await response.json()) as any;

    if (isCliVerboseMode()) {
        cliDebug('[API] Raw response structure:', Object.keys(json));
        if (json && typeof json === 'object') {
            // Log key fields without logging full content (could be huge)
            const preview: Record<string, unknown> = {};
            for (const key of Object.keys(json)) {
                const val = json[key];
                if (typeof val === 'string' && val.length > 100) {
                    preview[key] = `[string: ${val.length} chars]`;
                } else if (Array.isArray(val)) {
                    preview[key] = `[array: ${val.length} items]`;
                } else if (typeof val === 'object' && val !== null) {
                    preview[key] = `[object: ${Object.keys(val).join(', ')}]`;
                } else {
                    preview[key] = val;
                }
            }
            cliDebug(
                '[API] Response preview:',
                JSON.stringify(preview, null, 2),
            );
        }
    }

    // API usually returns { data: {...}, statusCode, type }
    // Return only .data when present.
    if (json && typeof json === 'object' && 'data' in json) {
        return json.data as T;
    }

    return json as T;
}

const RETRY_BACKOFF_MS = [1000, 3000];
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

async function requestWithRetry<T>(
    endpoint: string,
    options: RequestInit = {},
): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
        try {
            return await request<T>(endpoint, options);
        } catch (error) {
            lastError = error;

            const isLastAttempt = attempt >= RETRY_BACKOFF_MS.length;
            if (isLastAttempt) {
                break;
            }

            // Only retry on network errors or retryable status codes
            const isRetryable =
                (error instanceof ApiError &&
                    RETRYABLE_STATUS_CODES.has(error.statusCode)) ||
                (!(error instanceof ApiError) && error instanceof Error);

            if (!isRetryable) {
                break;
            }

            if (isCliVerboseMode()) {
                cliDebug(
                    `[API] Retry ${attempt + 1}/${RETRY_BACKOFF_MS.length} after ${RETRY_BACKOFF_MS[attempt]}ms`,
                );
            }

            await new Promise((resolve) =>
                setTimeout(resolve, RETRY_BACKOFF_MS[attempt]),
            );
        }
    }

    throw lastError;
}

class RealAuthApi implements IAuthApi {
    async login(email: string, password: string): Promise<AuthResponse> {
        const response = await requestWithRetry<{
            accessToken: string;
            refreshToken: string;
        }>('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email, password }),
        });

        // Map API response into the CLI auth shape.
        return {
            accessToken: response.accessToken,
            refreshToken: response.refreshToken,
            expiresIn: 3600, // Default: 1 hour
            user: {
                id: 'unknown', // Login response does not include user profile fields.
                email,
                orgs: [],
            },
        };
    }

    async refresh(refreshToken: string): Promise<AuthResponse> {
        return requestWithRetry<AuthResponse>('/auth/refresh', {
            method: 'POST',
            body: JSON.stringify({ refreshToken }),
        });
    }

    async logout(accessToken: string): Promise<void> {
        await requestWithRetry<void>('/auth/logout', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        });
    }

    async generateCIToken(accessToken: string): Promise<string> {
        const response = await requestWithRetry<{ token: string }>(
            '/auth/ci-token',
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
            },
        );
        return response.token;
    }

    async verify(accessToken: string): Promise<{ valid: boolean; user?: any }> {
        // SECURITY NOTE: This performs basic client-side JWT validation without signature verification.
        // This is acceptable for a CLI client where:
        // 1. The token is securely stored locally and only accessed by the user
        // 2. The API validates the token signature on every request
        // 3. We only check format and expiration to avoid unnecessary API calls
        //
        // For production security, all authorization decisions MUST be made by the API
        // after validating the token signature.

        if (!accessToken || !accessToken.startsWith('eyJ')) {
            return { valid: false };
        }

        try {
            // Decode JWT payload (without signature validation)
            const parts = accessToken.split('.');
            if (parts.length !== 3) {
                return { valid: false };
            }

            const payload = JSON.parse(
                Buffer.from(parts[1], 'base64').toString(),
            );

            // Check expiration
            if (payload.exp && payload.exp * 1000 < Date.now()) {
                return { valid: false };
            }

            return {
                valid: true,
                user: {
                    id: payload.sub || 'unknown',
                    email: payload.email || 'unknown',
                    orgs: [],
                },
            };
        } catch (error) {
            if (isCliVerboseMode()) {
                cliDebug('Token verification failed:', error);
            }
            return { valid: false };
        }
    }
}

class RealReviewApi implements IReviewApi {
    async analyze(
        diff: string,
        accessToken: string,
        config?: ReviewConfig,
    ): Promise<ReviewResult> {
        const isTeamKey = accessToken.startsWith('kodus_');

        if (isCliVerboseMode()) {
            cliDebug('[API] analyze() called');
            cliDebug(`[API]   - diff length: ${diff.length} chars`);
            cliDebug(`[API]   - isTeamKey: ${isTeamKey}`);
            cliDebug(`[API]   - config files: ${config?.files?.length ?? 0}`);
        }

        if (isTeamKey) {
            return requestWithRetry<ReviewResult>('/cli/review', {
                method: 'POST',
                headers: {
                    'X-Team-Key': accessToken,
                },
                body: JSON.stringify({ diff, config }),
            });
        }

        let teamId: string | undefined;
        try {
            const payload = JSON.parse(
                Buffer.from(accessToken.split('.')[1], 'base64').toString(),
            );
            teamId = payload.organizationId;
        } catch {
            // Ignore if cannot decode
        }

        const endpoint = teamId
            ? `/cli/review?teamId=${encodeURIComponent(teamId)}`
            : '/cli/review';

        return requestWithRetry<ReviewResult>(endpoint, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({ diff, config }),
        });
    }

    async analyzeWithMetrics(
        diff: string,
        accessToken: string,
        config?: ReviewConfig,
        metrics?: GitMetrics,
    ): Promise<ReviewResult> {
        const isTeamKey = accessToken.startsWith('kodus_');

        if (isTeamKey) {
            return requestWithRetry<ReviewResult>('/cli/review', {
                method: 'POST',
                headers: {
                    'X-Team-Key': accessToken,
                },
                body: JSON.stringify({
                    diff,
                    config,
                    ...metrics,
                }),
            });
        }

        return this.analyze(diff, accessToken, config);
    }

    async getPullRequestSuggestions(
        accessToken: string,
        params: {
            prUrl?: string;
            prNumber?: number;
            repositoryId?: string;
            format?: 'markdown';
            severity?: string;
            category?: string;
        },
    ): Promise<PullRequestSuggestionsResponse> {
        const query = new URLSearchParams();

        if (params.prUrl) {
            query.set('prUrl', params.prUrl);
        }

        if (params.prNumber !== undefined) {
            query.set('prNumber', params.prNumber.toString());
        }

        if (params.repositoryId) {
            query.set('repositoryId', params.repositoryId);
        }

        if (params.format) {
            query.set('format', params.format);
        }

        if (params.severity) {
            query.set('severity', params.severity);
        }

        if (params.category) {
            query.set('category', params.category);
        }

        const queryString = query.toString();
        const endpoint = `/pull-requests/suggestions${queryString ? `?${queryString}` : ''}`;
        const isTeamKey = accessToken.startsWith('kodus_');

        return requestWithRetry<PullRequestSuggestionsResponse>(endpoint, {
            headers: {
                ...(isTeamKey
                    ? { 'X-Team-Key': accessToken }
                    : { Authorization: `Bearer ${accessToken}` }),
            },
        });
    }

    async triggerBusinessValidation(
        accessToken: string,
        params: {
            repository?: string;
            taskUrl?: string;
            taskId?: string;
            diff?: string;
        },
    ): Promise<BusinessValidationResponse> {
        const isTeamKey = accessToken.startsWith('kodus_');
        const body: Record<string, unknown> = {};

        if (params.repository) {
            body.repository = params.repository;
        }
        if (params.taskUrl) {
            body.taskUrl = params.taskUrl;
        }
        if (params.taskId) {
            body.taskId = params.taskId;
        }
        if (params.diff) {
            body.diff = params.diff;
        }

        return requestWithRetry<BusinessValidationResponse>(
            '/cli/business-validation',
            {
                method: 'POST',
                headers: {
                    ...(isTeamKey
                        ? { 'X-Team-Key': accessToken }
                        : { Authorization: `Bearer ${accessToken}` }),
                },
                body: JSON.stringify(body),
            },
        );
    }

    async trialAnalyze(
        diff: string,
        fingerprint: string,
    ): Promise<TrialReviewResult> {
        if (isCliVerboseMode()) {
            cliDebug('[API] trialAnalyze() called');
            cliDebug(`[API]   - diff length: ${diff.length} chars`);
            cliDebug(
                `[API]   - fingerprint: ${fingerprint.substring(0, 8)}...`,
            );
        }

        return requestWithRetry<TrialReviewResult>('/cli/trial/review', {
            method: 'POST',
            body: JSON.stringify({ diff, fingerprint }),
        });
    }
}

class RealTrialApi implements ITrialApi {
    async getStatus(fingerprint: string): Promise<TrialStatus> {
        return requestWithRetry<TrialStatus>(
            `/cli/trial/status?fingerprint=${fingerprint}`,
        );
    }
}

class RealMemoryApi implements IMemoryApi {
    async submitCapture(
        payload: MemoryCaptureApiRequest,
        accessToken: string,
    ): Promise<MemoryCaptureApiResponse> {
        const isTeamKey = accessToken.startsWith('kodus_');
        const headers: Record<string, string> = isTeamKey
            ? { 'X-Team-Key': accessToken }
            : { Authorization: `Bearer ${accessToken}` };

        return request<MemoryCaptureApiResponse>('/cli/memory/captures', {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
        });
    }
}

export class RealApi implements IKodusApi {
    auth: IAuthApi = new RealAuthApi();
    review: IReviewApi = new RealReviewApi();
    trial: ITrialApi = new RealTrialApi();
    memory: IMemoryApi = new RealMemoryApi();
    sessions: ISessionsApi = new RealSessionsApi();
}
