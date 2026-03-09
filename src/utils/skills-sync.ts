import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type BundledSkillDocument, readBundledSkills } from './skills.js';

export const DEFAULT_SYNC_SKILL_NAMES = [
    'kodus-review',
    'kodus-pr-suggestions-resolver',
    'kodus-business-rules-validation',
] as const;

const LEGACY_BUSINESS_RULES_NAME = 'business-rules-validation';

export type SkillTargetType = 'skill' | 'command';
export type SkillSyncMode = 'sync' | 'install' | 'uninstall';

export interface SkillSyncTarget {
    label: string;
    type: SkillTargetType;
    activationPath: string;
    baseDir: string;
}

export interface SkillSyncTargetResult {
    target: SkillSyncTarget;
    synced: boolean;
    created: number;
    updated: number;
    unchanged: number;
    removedManaged: number;
    removedLegacy: number;
    reason?: string;
}

export interface SkillSyncResult {
    results: SkillSyncTargetResult[];
    scannedTargets: number;
    syncedTargets: number;
    skippedTargets: number;
    createdFiles: number;
    updatedFiles: number;
    unchangedFiles: number;
    removedManagedEntries: number;
    removedLegacyEntries: number;
}

export interface SyncSkillOptions {
    dryRun?: boolean;
    mode?: SkillSyncMode;
    skills?: BundledSkillDocument[];
}

async function isDirectory(targetPath: string): Promise<boolean> {
    try {
        const stats = await fs.stat(targetPath);
        return stats.isDirectory();
    } catch {
        return false;
    }
}

async function isFile(targetPath: string): Promise<boolean> {
    try {
        const stats = await fs.stat(targetPath);
        return stats.isFile();
    } catch {
        return false;
    }
}

type WriteStatus = 'created' | 'updated' | 'unchanged';

async function writeIfChanged(
    filePath: string,
    content: string,
    dryRun: boolean,
): Promise<WriteStatus> {
    let existingContent: string | null = null;
    try {
        existingContent = await fs.readFile(filePath, 'utf8');
    } catch {
        // File does not exist yet.
    }

    if (existingContent === content) {
        return 'unchanged';
    }

    if (dryRun) {
        return existingContent === null ? 'created' : 'updated';
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
    return existingContent === null ? 'created' : 'updated';
}

async function removePathIfExists(
    targetPath: string,
    dryRun: boolean,
): Promise<boolean> {
    const exists =
        (await isDirectory(targetPath)) || (await isFile(targetPath));
    if (!exists) {
        return false;
    }

    if (!dryRun) {
        await fs.rm(targetPath, { recursive: true, force: true });
    }

    return true;
}

function applyWriteStatus(
    result: SkillSyncTargetResult,
    writeStatus: WriteStatus,
): void {
    if (writeStatus === 'created') {
        result.created += 1;
        return;
    }
    if (writeStatus === 'updated') {
        result.updated += 1;
        return;
    }
    result.unchanged += 1;
}

function createSkippedTargetResult(
    target: SkillSyncTarget,
    reason: string,
): SkillSyncTargetResult {
    return {
        target,
        synced: false,
        created: 0,
        updated: 0,
        unchanged: 0,
        removedManaged: 0,
        removedLegacy: 0,
        reason,
    };
}

function createSyncedTargetResult(
    target: SkillSyncTarget,
): SkillSyncTargetResult {
    return {
        target,
        synced: true,
        created: 0,
        updated: 0,
        unchanged: 0,
        removedManaged: 0,
        removedLegacy: 0,
    };
}

export function buildDefaultSkillSyncTargets(
    cwd = process.cwd(),
    homeDir = os.homedir(),
): SkillSyncTarget[] {
    return [
        {
            label: 'Codex project skills',
            type: 'skill',
            activationPath: path.join(cwd, '.codex'),
            baseDir: path.join(cwd, '.codex', 'skills'),
        },
        {
            label: 'Codex user skills',
            type: 'skill',
            activationPath: path.join(homeDir, '.codex'),
            baseDir: path.join(homeDir, '.codex', 'skills'),
        },
        {
            label: 'Claude project commands',
            type: 'command',
            activationPath: path.join(cwd, '.claude'),
            baseDir: path.join(cwd, '.claude', 'commands'),
        },
        {
            label: 'Claude user commands',
            type: 'command',
            activationPath: path.join(homeDir, '.claude'),
            baseDir: path.join(homeDir, '.claude', 'commands'),
        },
        {
            label: 'Claude config commands',
            type: 'command',
            activationPath: path.join(homeDir, '.config', 'claude'),
            baseDir: path.join(homeDir, '.config', 'claude', 'commands'),
        },
        {
            label: 'Cursor project commands',
            type: 'command',
            activationPath: path.join(cwd, '.cursor'),
            baseDir: path.join(cwd, '.cursor', 'commands'),
        },
        {
            label: 'Cursor user commands',
            type: 'command',
            activationPath: path.join(homeDir, '.cursor'),
            baseDir: path.join(homeDir, '.cursor', 'commands'),
        },
        {
            label: 'Agents project skills',
            type: 'skill',
            activationPath: path.join(cwd, '.agents'),
            baseDir: path.join(cwd, '.agents', 'skills'),
        },
        {
            label: 'Agents user skills',
            type: 'skill',
            activationPath: path.join(homeDir, '.config', 'agents'),
            baseDir: path.join(homeDir, '.config', 'agents', 'skills'),
        },
    ];
}

async function loadSkillsForSync(
    skills?: BundledSkillDocument[],
): Promise<BundledSkillDocument[]> {
    if (skills) {
        return skills;
    }

    return readBundledSkills([...DEFAULT_SYNC_SKILL_NAMES]);
}

export async function syncSkillsToTargets(
    targets: SkillSyncTarget[],
    options: SyncSkillOptions = {},
): Promise<SkillSyncResult> {
    const dryRun = options.dryRun ?? false;
    const mode = options.mode ?? 'sync';
    const skills = await loadSkillsForSync(options.skills);
    const results: SkillSyncTargetResult[] = [];

    for (const target of targets) {
        let hasTargetDirectory = await isDirectory(target.baseDir);
        if (mode === 'install' && !hasTargetDirectory) {
            const hasActivationPath = await isDirectory(target.activationPath);
            if (!hasActivationPath) {
                results.push(
                    createSkippedTargetResult(
                        target,
                        'Agent root directory not found.',
                    ),
                );
                continue;
            }

            if (!dryRun) {
                await fs.mkdir(target.baseDir, { recursive: true });
            }
            hasTargetDirectory = true;
        }

        if (!hasTargetDirectory) {
            results.push(
                createSkippedTargetResult(
                    target,
                    'Target directory not found.',
                ),
            );
            continue;
        }

        const targetResult = createSyncedTargetResult(target);

        if (mode === 'uninstall') {
            for (const skill of skills) {
                const filePath =
                    target.type === 'skill'
                        ? path.join(target.baseDir, skill.name)
                        : path.join(target.baseDir, `${skill.name}.md`);
                if (await removePathIfExists(filePath, dryRun)) {
                    targetResult.removedManaged += 1;
                } else {
                    targetResult.unchanged += 1;
                }
            }
        } else {
            for (const skill of skills) {
                const filePath =
                    target.type === 'skill'
                        ? path.join(target.baseDir, skill.name, 'SKILL.md')
                        : path.join(target.baseDir, `${skill.name}.md`);
                const writeStatus = await writeIfChanged(
                    filePath,
                    skill.content,
                    dryRun,
                );
                applyWriteStatus(targetResult, writeStatus);
            }
        }

        const legacyPath =
            target.type === 'skill'
                ? path.join(target.baseDir, LEGACY_BUSINESS_RULES_NAME)
                : path.join(target.baseDir, `${LEGACY_BUSINESS_RULES_NAME}.md`);
        if (await removePathIfExists(legacyPath, dryRun)) {
            targetResult.removedLegacy += 1;
        }

        results.push(targetResult);
    }

    const syncedTargets = results.filter((result) => result.synced).length;
    return {
        results,
        scannedTargets: results.length,
        syncedTargets,
        skippedTargets: results.length - syncedTargets,
        createdFiles: results.reduce((sum, result) => sum + result.created, 0),
        updatedFiles: results.reduce((sum, result) => sum + result.updated, 0),
        unchangedFiles: results.reduce(
            (sum, result) => sum + result.unchanged,
            0,
        ),
        removedManagedEntries: results.reduce(
            (sum, result) => sum + result.removedManaged,
            0,
        ),
        removedLegacyEntries: results.reduce(
            (sum, result) => sum + result.removedLegacy,
            0,
        ),
    };
}
