import {
    dumpRuntimeYaml,
    parseRuntimeYaml,
    resolveRuntimePlaybook,
    RuntimePlaybookParseError,
    RUNTIME_YAML_PATH,
} from './runtime-playbook.service';

describe('runtime playbook (.kody/runtime.yml)', () => {
    describe('parseRuntimeYaml', () => {
        it('parses a valid playbook into the canonical shape', () => {
            const cfg = parseRuntimeYaml(`
enabled: true
trigger: command
requiredEnv:
  - JWT_SECRET
setup:
  - npm install
build:
  - npm run migrate
services:
  - npm start
healthcheck:
  - curl -sf http://localhost:3000/api/health
`);
            expect(cfg.enabled).toBe(true);
            expect(cfg.trigger).toBe('command');
            expect(cfg.requiredEnv).toEqual(['JWT_SECRET']);
            expect(cfg.setup).toEqual(['npm install']);
            expect(cfg.services).toEqual(['npm start']);
        });

        it('round-trips through dump → parse', () => {
            const cfg = { setup: ['a', 'b'], services: ['run'], requiredEnv: ['X'] };
            expect(parseRuntimeYaml(dumpRuntimeYaml(cfg))).toEqual(cfg);
        });

        it('throws on malformed YAML', () => {
            expect(() => parseRuntimeYaml('setup: [: :')).toThrow(RuntimePlaybookParseError);
        });

        it('throws when the document is not a mapping', () => {
            expect(() => parseRuntimeYaml('- just\n- a\n- list')).toThrow(/must be a YAML mapping/);
            expect(() => parseRuntimeYaml('')).toThrow(/must be a YAML mapping/);
        });

        it('throws when a phase is not a list of strings', () => {
            expect(() => parseRuntimeYaml('setup: npm install')).toThrow(/'setup' must be a list/);
            expect(() => parseRuntimeYaml('build:\n  - 42')).toThrow(/'build' must be a list/);
        });

        it("throws on an invalid trigger", () => {
            expect(() => parseRuntimeYaml('trigger: sometimes')).toThrow(/'trigger' must be/);
        });

        it('rejects a committed secret (defense against leaking values)', () => {
            expect(() => parseRuntimeYaml('JWT_SECRET: abc123')).toThrow(/looks like a secret/);
            expect(() => parseRuntimeYaml('db_password: hunter2')).toThrow(/looks like a secret/);
            expect(() => parseRuntimeYaml('API_KEY: sk-xxx')).toThrow(RuntimePlaybookParseError);
            // requiredEnv naming the secret is fine — it's just the name.
            expect(() => parseRuntimeYaml('requiredEnv:\n  - JWT_SECRET')).not.toThrow();
        });

        it('mentions the file path in the error', () => {
            expect(() => parseRuntimeYaml('- x')).toThrow(new RegExp(RUNTIME_YAML_PATH));
        });
    });

    describe('resolveRuntimePlaybook (precedence)', () => {
        const ui = { enabled: true, trigger: 'command' as const, setup: ['ui-setup'] };
        const repo = { setup: ['repo-setup'], services: ['repo-run'] };

        it('repo YAML wins over the UI config', () => {
            const r = resolveRuntimePlaybook(repo, ui);
            expect(r.source).toBe('repo-yaml');
            expect(r.config?.setup).toEqual(['repo-setup']);
            expect(r.config?.services).toEqual(['repo-run']);
        });

        it('inherits activation (enabled/trigger) from the UI when the repo omits it', () => {
            const r = resolveRuntimePlaybook(repo, ui);
            expect(r.config?.enabled).toBe(true); // from UI
            expect(r.config?.trigger).toBe('command'); // from UI
        });

        it("repo's own enabled/trigger override the UI's", () => {
            const r = resolveRuntimePlaybook({ ...repo, enabled: false, trigger: 'auto' }, ui);
            expect(r.config?.enabled).toBe(false);
            expect(r.config?.trigger).toBe('auto');
        });

        it('falls back to the UI config when there is no repo YAML', () => {
            const r = resolveRuntimePlaybook(null, ui);
            expect(r.source).toBe('ui-config');
            expect(r.config).toBe(ui);
        });

        it('reports none when neither source exists', () => {
            const r = resolveRuntimePlaybook(null, null);
            expect(r.source).toBe('none');
            expect(r.config).toBeUndefined();
        });
    });
});
