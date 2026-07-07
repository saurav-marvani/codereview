import * as yaml from 'js-yaml';

/**
 * Kody Runtime playbook config — the SAME canonical shape whether it comes from
 * the Kodus UI (org-parameters) or a committed `.kody/runtime.yml`. This module
 * parses/validates the YAML and resolves which source wins.
 *
 * Precedence (kept deliberately simple — no merge): if the repo has a valid
 * `.kody/runtime.yml`, it is the single source of truth; otherwise the UI
 * config. One active source, one obvious winner.
 *
 * Secrets are NEVER part of the playbook (UI or YAML) — only `requiredEnv`
 * (the NAMES). Values live in the encrypted org-level vault and are injected
 * into the VM at /opt/kody/customer.env.
 */

/** The committed playbook path, relative to the repo root. */
export const RUNTIME_YAML_PATH = '.kody/runtime.yml';

/** Phases that must be lists of shell commands. */
const COMMAND_PHASES = [
    'setup',
    'build',
    'services',
    'test',
    'healthcheck',
] as const;

export interface RuntimeEnvironmentConfig {
    enabled?: boolean;
    /** 'command' (default) = on-demand only; 'auto' = every automatic review. */
    trigger?: 'auto' | 'command';
    /** Names of the env vars/secrets the app needs (values come from the vault). */
    requiredEnv?: string[];
    setup?: string[];
    build?: string[];
    services?: string[];
    test?: string[];
    healthcheck?: string[];
    /** Cross-repo deps (alpha). */
    dependsOn?: any[];
    /** Monorepo scoping (alpha). */
    scope?: Record<string, any>;
}

export class RuntimePlaybookParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RuntimePlaybookParseError';
    }
}

/**
 * Parse + validate a `.kody/runtime.yml` document into a RuntimeEnvironmentConfig.
 * Throws RuntimePlaybookParseError on malformed YAML or a wrong-typed field so
 * the caller can surface a clear message instead of booting a broken playbook.
 */
export function parseRuntimeYaml(raw: string): RuntimeEnvironmentConfig {
    let doc: unknown;
    try {
        doc = yaml.load(raw);
    } catch (e: any) {
        throw new RuntimePlaybookParseError(
            `Invalid YAML in ${RUNTIME_YAML_PATH}: ${e?.reason ?? e?.message ?? e}`,
        );
    }
    if (doc === null || doc === undefined || typeof doc !== 'object' || Array.isArray(doc)) {
        throw new RuntimePlaybookParseError(
            `${RUNTIME_YAML_PATH} must be a YAML mapping (key: value), not empty or a list`,
        );
    }
    const obj = doc as Record<string, unknown>;

    for (const phase of COMMAND_PHASES) {
        const v = obj[phase];
        if (v !== undefined && v !== null) {
            if (!Array.isArray(v) || v.some((c) => typeof c !== 'string')) {
                throw new RuntimePlaybookParseError(
                    `${RUNTIME_YAML_PATH}: '${phase}' must be a list of shell command strings`,
                );
            }
        }
    }
    if (obj.requiredEnv !== undefined && obj.requiredEnv !== null) {
        if (
            !Array.isArray(obj.requiredEnv) ||
            obj.requiredEnv.some((s) => typeof s !== 'string')
        ) {
            throw new RuntimePlaybookParseError(
                `${RUNTIME_YAML_PATH}: 'requiredEnv' must be a list of env var names`,
            );
        }
    }
    if (obj.trigger !== undefined && obj.trigger !== 'auto' && obj.trigger !== 'command') {
        throw new RuntimePlaybookParseError(
            `${RUNTIME_YAML_PATH}: 'trigger' must be 'auto' or 'command'`,
        );
    }
    if (obj.enabled !== undefined && typeof obj.enabled !== 'boolean') {
        throw new RuntimePlaybookParseError(
            `${RUNTIME_YAML_PATH}: 'enabled' must be true or false`,
        );
    }

    // Reject stray secret-looking values so nobody commits a secret by mistake.
    for (const key of Object.keys(obj)) {
        if (/secret|password|token|api[_-]?key/i.test(key)) {
            throw new RuntimePlaybookParseError(
                `${RUNTIME_YAML_PATH}: '${key}' looks like a secret — secrets never go in the playbook; declare the name in 'requiredEnv' and set the value in the Kodus vault`,
            );
        }
    }

    return obj as RuntimeEnvironmentConfig;
}

/**
 * Serialize a config back to YAML (for the "generate" flow → download/commit).
 */
export function dumpRuntimeYaml(config: RuntimeEnvironmentConfig): string {
    return yaml.dump(config, { lineWidth: 120, noRefs: true });
}

export type PlaybookSource = 'repo-yaml' | 'ui-config' | 'none';

export interface ResolvedPlaybook {
    config: RuntimeEnvironmentConfig | undefined;
    source: PlaybookSource;
}

/**
 * Resolve which playbook wins. Repo `.kody/runtime.yml` (already parsed) beats
 * the UI config; if there is no repo YAML, fall back to the UI config. No merge.
 * `enabled`/`trigger` are activation concerns — when the repo YAML omits them,
 * inherit them from the UI config so a committed playbook doesn't have to
 * re-declare activation.
 */
export function resolveRuntimePlaybook(
    repoYaml: RuntimeEnvironmentConfig | null | undefined,
    uiConfig: RuntimeEnvironmentConfig | null | undefined,
): ResolvedPlaybook {
    if (repoYaml) {
        return {
            source: 'repo-yaml',
            config: {
                ...repoYaml,
                // Activation (enabled/trigger) inherits from the UI when the
                // committed playbook doesn't declare it.
                enabled: repoYaml.enabled ?? uiConfig?.enabled,
                trigger: repoYaml.trigger ?? uiConfig?.trigger,
            },
        };
    }
    if (uiConfig) {
        return { source: 'ui-config', config: uiConfig };
    }
    return { source: 'none', config: undefined };
}
