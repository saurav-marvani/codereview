import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BundledSkillDocument {
    name: string;
    content: string;
}

function resolveSkillsCandidates(): string[] {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return [
        path.resolve(here, '../../skills'),
        path.resolve(here, '../skills'),
    ];
}

async function resolveBundledSkillsRoot(): Promise<string | null> {
    for (const dir of resolveSkillsCandidates()) {
        try {
            await fs.access(dir);
            return dir;
        } catch {
            // Try next candidate.
        }
    }

    return null;
}

export async function listBundledSkills(): Promise<string[]> {
    const root = await resolveBundledSkillsRoot();
    if (!root) {
        return [];
    }

    try {
        const entries = await fs.readdir(root, { withFileTypes: true });
        const skills = await Promise.all(
            entries
                .filter((entry) => entry.isDirectory())
                .map(async (entry) => {
                    const skillFile = path.join(root, entry.name, 'SKILL.md');
                    try {
                        await fs.access(skillFile);
                        return entry.name;
                    } catch {
                        return null;
                    }
                }),
        );

        return skills
            .filter((name): name is string => !!name)
            .sort((a, b) => a.localeCompare(b));
    } catch {
        return [];
    }
}

export async function readBundledSkills(
    skillNames: string[],
): Promise<BundledSkillDocument[]> {
    const root = await resolveBundledSkillsRoot();
    if (!root) {
        throw new Error('Bundled skills directory not found.');
    }

    const documents = await Promise.all(
        skillNames.map(async (name) => {
            const filePath = path.join(root, name, 'SKILL.md');
            const content = await fs.readFile(filePath, 'utf8');
            return { name, content };
        }),
    );

    return documents;
}

export async function readBundledSkill(name: string): Promise<string> {
    const [skill] = await readBundledSkills([name]);
    return skill.content;
}
