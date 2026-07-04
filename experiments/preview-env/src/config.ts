import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Env loading mirrors scripts/selfhosted/_common.sh precedence:
 *   1. process.env (caller wins)
 *   2. ~/.kodus-dev/config (global dev config, KEY=VALUE lines)
 * Values that look like `op://...` are resolved via the 1Password CLI.
 */
const GLOBAL_CONFIG = join(homedir(), '.kodus-dev', 'config');

let fileConfig: Record<string, string> | null = null;

function loadFileConfig(): Record<string, string> {
    if (fileConfig) return fileConfig;
    fileConfig = {};
    if (existsSync(GLOBAL_CONFIG)) {
        for (const line of readFileSync(GLOBAL_CONFIG, 'utf8').split('\n')) {
            const m = line.match(/^(?:export\s+)?([A-Z0-9_]+)=(.*)$/);
            if (!m) continue;
            let value = m[2].trim();
            if (
                (value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))
            ) {
                value = value.slice(1, -1);
            }
            fileConfig[m[1]] = value;
        }
    }
    return fileConfig;
}

function resolveOpRef(name: string, value: string): string {
    if (!value.startsWith('op://')) return value;
    try {
        return execFileSync('op', ['read', '--no-newline', value], {
            encoding: 'utf8',
        });
    } catch (e) {
        throw new Error(
            `${name} is a 1Password reference (${value}) but 'op read' failed. ` +
                `Run 'op signin' or replace with a plain value in ~/.kodus-dev/config.`,
        );
    }
}

export function getEnv(name: string): string | undefined {
    const raw = process.env[name] ?? loadFileConfig()[name];
    if (raw === undefined || raw === '') return undefined;
    return resolveOpRef(name, raw);
}

export function requireEnv(name: string): string {
    const value = getEnv(name);
    if (!value) {
        throw new Error(
            `Required env ${name} is not set (checked process.env and ~/.kodus-dev/config)`,
        );
    }
    return value;
}
