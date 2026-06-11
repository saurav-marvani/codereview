import { MCPIntegrationAuthType } from './enums/integration.enum';
import { ManagedTokenCredential } from './managed-credential.types';

/**
 * Render the HTTP auth header(s) for a stored static-token credential, in the
 * exact format each provider's hosted MCP expects:
 *
 * - `bearer_token` → `Authorization: Bearer <secret>`   (Linear, Fireflies)
 * - `basic`        → `Authorization: Basic base64(user:secret)`  (Jira: email:apiToken)
 * - `api_key`      → `<apiKeyHeader>: <secret>`          (custom header)
 *
 * The user/identity for Basic is read from `fields.email` (or `fields.user`).
 * For api_key, the header name comes from `fields.apiKeyHeader` (default
 * `X-Api-Key`).
 *
 * NOTE: provider-specific *non-auth* requirements (e.g. Atlassian's `cloudId`,
 * which tokens are not bound to) are intentionally NOT handled here — they are
 * carried separately on the credential's `fields` and injected by the caller
 * once the exact mechanism is confirmed in sandbox.
 */
export function renderTokenAuthHeaders(
    credential: ManagedTokenCredential,
): Record<string, string> {
    const { authType, secret, fields = {} } = credential;

    switch (authType) {
        case MCPIntegrationAuthType.BEARER_TOKEN:
            return { Authorization: `Bearer ${secret}` };

        case MCPIntegrationAuthType.BASIC: {
            const user = fields.email ?? fields.user ?? '';
            const encoded = Buffer.from(`${user}:${secret}`).toString('base64');
            return { Authorization: `Basic ${encoded}` };
        }

        case MCPIntegrationAuthType.API_KEY: {
            const header = fields.apiKeyHeader ?? 'X-Api-Key';
            return { [header]: secret };
        }

        case MCPIntegrationAuthType.NONE:
        case MCPIntegrationAuthType.OAUTH2:
        default:
            return {};
    }
}
