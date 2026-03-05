import { validateSkillMdForIngest } from './skill-validation.service';

const VALID_SKILL_MD = `---
name: code-review
description: Reviews PRs
metadata:
  version: '1.0.0'
---

# Code Review

This skill reviews pull requests.
`;

describe('skill-validation — validateSkillMdForIngest', () => {

    // -------------------------------------------------------------------------
    // GREEN case: valid minimal SKILL.md
    // -------------------------------------------------------------------------

    describe('valid SKILL.md', () => {
        it('returns valid=true with slug, version, and description for a minimal valid file', () => {
            const result = validateSkillMdForIngest(VALID_SKILL_MD, 'code-review');

            expect(result.valid).toBe(true);
            expect(result.errors).toEqual([]);
            expect(result.slug).toBe('code-review');
            expect(result.version).toBe('1.0.0');
            expect(result.description).toBe('Reviews PRs');
        });

        it('allows extra unknown frontmatter fields without failing validation', () => {
            const content = `---
name: code-review
description: Reviews PRs
metadata:
  version: '1.0.0'
custom_field: some value
another: 42
---
`;
            const result = validateSkillMdForIngest(content, 'code-review');
            expect(result.valid).toBe(true);
            expect(result.errors).toEqual([]);
        });

        it('skips directory name check when submittedDirectoryName is undefined', () => {
            const result = validateSkillMdForIngest(VALID_SKILL_MD);
            expect(result.valid).toBe(true);
        });

        it('allows single-character name (slug rule minimum)', () => {
            const content = `---
name: a
description: Single char name
metadata:
  version: '1.0.0'
---
`;
            const result = validateSkillMdForIngest(content, 'a');
            expect(result.valid).toBe(true);
        });
    });

    // -------------------------------------------------------------------------
    // RED cases: structural / parsing errors
    // -------------------------------------------------------------------------

    describe('missing or malformed YAML frontmatter', () => {
        it('returns valid=false when there are no --- delimiters at all', () => {
            const result = validateSkillMdForIngest('name: code-review\ndescription: Reviews PRs\n');

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('SKILL.md must have YAML frontmatter delimited by ---');
        });

        it('returns valid=false for content with only opening --- delimiter', () => {
            const result = validateSkillMdForIngest('---\nname: code-review\n');

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('SKILL.md must have YAML frontmatter delimited by ---');
        });

        it('returns valid=false and includes error message for invalid YAML syntax', () => {
            const content = `---
name: [unclosed bracket
---
`;
            const result = validateSkillMdForIngest(content);

            expect(result.valid).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.errors[0]).toMatch(/Invalid YAML frontmatter/);
        });
    });

    // -------------------------------------------------------------------------
    // RED cases: missing required fields (Truth 1, 2, 3)
    // -------------------------------------------------------------------------

    describe('missing required fields', () => {
        it('returns valid=false with error naming "name" when name field is absent (Truth 1)', () => {
            const content = `---
description: Reviews PRs
metadata:
  version: '1.0.0'
---
`;
            const result = validateSkillMdForIngest(content);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('name'))).toBe(true);
        });

        it('returns valid=false with error naming "description" when description field is absent (Truth 2)', () => {
            const content = `---
name: code-review
metadata:
  version: '1.0.0'
---
`;
            const result = validateSkillMdForIngest(content);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('description'))).toBe(true);
        });

        it('returns valid=false with error naming "metadata.version" when version is absent (Truth 3)', () => {
            const content = `---
name: code-review
description: Reviews PRs
metadata: {}
---
`;
            const result = validateSkillMdForIngest(content);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('metadata') || e.includes('version'))).toBe(true);
        });

        it('returns valid=false when metadata field itself is absent', () => {
            const content = `---
name: code-review
description: Reviews PRs
---
`;
            const result = validateSkillMdForIngest(content);

            expect(result.valid).toBe(false);
        });
    });

    // -------------------------------------------------------------------------
    // RED case: directory name mismatch (Truth 4)
    // -------------------------------------------------------------------------

    describe('directory name mismatch', () => {
        it('returns valid=false when name does not match submittedDirectoryName (Truth 4)', () => {
            const content = `---
name: code-review
description: Reviews PRs
metadata:
  version: '1.0.0'
---
`;
            const result = validateSkillMdForIngest(content, 'code_review');

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('"code-review"') && e.includes('"code_review"'))).toBe(true);
        });
    });

    // -------------------------------------------------------------------------
    // RED case: slug naming rule violations (Truth 5)
    // -------------------------------------------------------------------------

    describe('slug naming rule — name must be lowercase-hyphenated', () => {
        it('returns valid=false when name contains uppercase letters (Truth 5)', () => {
            const content = `---
name: MySkill
description: Reviews PRs
metadata:
  version: '1.0.0'
---
`;
            const result = validateSkillMdForIngest(content);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('lowercase-hyphenated') || e.includes('name'))).toBe(true);
        });

        it('returns valid=false when name contains spaces (Truth 5)', () => {
            const content = `---
name: My Skill
description: Reviews PRs
metadata:
  version: '1.0.0'
---
`;
            const result = validateSkillMdForIngest(content);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('lowercase-hyphenated') || e.includes('name'))).toBe(true);
        });

        it('returns valid=false when name has leading hyphens (e.g., -bad-)', () => {
            const content = `---
name: '-bad-'
description: Reviews PRs
metadata:
  version: '1.0.0'
---
`;
            const result = validateSkillMdForIngest(content);

            expect(result.valid).toBe(false);
        });

        it('returns valid=false when name has trailing hyphens', () => {
            const content = `---
name: bad-
description: Reviews PRs
metadata:
  version: '1.0.0'
---
`;
            const result = validateSkillMdForIngest(content);

            expect(result.valid).toBe(false);
        });
    });

    // -------------------------------------------------------------------------
    // Combined / multiple errors
    // -------------------------------------------------------------------------

    describe('multiple missing fields', () => {
        it('returns multiple errors when both name and description are missing', () => {
            const content = `---
metadata:
  version: '1.0.0'
---
`;
            const result = validateSkillMdForIngest(content);

            expect(result.valid).toBe(false);
            expect(result.errors.length).toBeGreaterThanOrEqual(2);
        });
    });
});
