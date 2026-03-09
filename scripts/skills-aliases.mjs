import { parseFrontmatter } from './skills-utils.mjs';

export const SKILL_ALIASES = [
    {
        canonical: 'kodus-business-rules-validation',
        alias: 'business-rules-validation',
    },
];

export function renderAliasSkillContent(canonicalContent, aliasName) {
    const parsed = parseFrontmatter(canonicalContent);
    if (parsed.error) {
        throw new Error(parsed.error);
    }

    if (!/^\s*name:\s*.+$/m.test(parsed.yamlBlock)) {
        throw new Error('Canonical frontmatter must include a "name" field.');
    }

    const aliasYamlBlock = parsed.yamlBlock.replace(
        /^\s*name:\s*.+$/m,
        `name: ${aliasName}`,
    );
    const normalizedBody = (parsed.body ?? '').replace(/^\n+/, '');
    return `---\n${aliasYamlBlock}\n---\n\n${normalizedBody}`;
}
