import {
    redactPhases,
    redactSecrets,
    redactTranscript,
} from './preview-env-run';

/**
 * The run transcript/logs are persisted + shown to the user, and the VM has the
 * customer's secrets injected — so secret VALUES must be scrubbed everywhere
 * before the record leaves the stage.
 */
describe('preview-env run redaction', () => {
    const secrets = { JWT_SECRET: 'sup3r-secret-value', DB_URL: 'postgres://u:p@h/db' };

    it('replaces every secret value with a named marker', () => {
        const out = redactSecrets(
            'connecting with postgres://u:p@h/db and token sup3r-secret-value now',
            secrets,
        );
        expect(out).not.toContain('sup3r-secret-value');
        expect(out).not.toContain('postgres://u:p@h/db');
        expect(out).toContain('‹redacted:JWT_SECRET›');
        expect(out).toContain('‹redacted:DB_URL›');
    });

    it('redacts ALL occurrences, not just the first', () => {
        const out = redactSecrets('a sup3r-secret-value b sup3r-secret-value c', secrets);
        expect(out).toBe('a ‹redacted:JWT_SECRET› b ‹redacted:JWT_SECRET› c');
    });

    it('skips empty/very short values to avoid mangling unrelated text', () => {
        const out = redactSecrets('the cat sat', { X: '', Y: 'at' });
        expect(out).toBe('the cat sat'); // 'at' (<4) not redacted
    });

    it('redacts across a full transcript (command + reasoning + output)', () => {
        const t = redactTranscript(
            [
                {
                    turn: 1,
                    reasoning: 'I will use sup3r-secret-value',
                    commands: [
                        {
                            command: 'echo sup3r-secret-value',
                            exitCode: 0,
                            stdout: 'sup3r-secret-value',
                            stderr: '',
                            durationMs: 5,
                        },
                    ],
                },
            ],
            secrets,
        );
        const blob = JSON.stringify(t);
        expect(blob).not.toContain('sup3r-secret-value');
        expect(blob).toContain('‹redacted:JWT_SECRET›');
        expect(t[0].commands[0].durationMs).toBe(5); // non-text untouched
    });

    it('redacts phase logs', () => {
        const p = redactPhases(
            [{ phase: 'services', command: 'run', exitCode: 0, outputTail: 'booted with sup3r-secret-value' }],
            secrets,
        );
        expect(p[0].outputTail).toContain('‹redacted:JWT_SECRET›');
        expect(p[0].outputTail).not.toContain('sup3r-secret-value');
    });
});
