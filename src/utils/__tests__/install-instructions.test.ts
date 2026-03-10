import { describe, expect, it } from 'vitest';
import { resolveRemoteInstallInstructions } from '../install-instructions.js';

describe('install instructions', () => {
    it('returns shell installer for unix-like platforms', () => {
        const instructions = resolveRemoteInstallInstructions('darwin');

        expect(instructions.primary).toContain('install.sh');
        expect(instructions.primary).toContain('curl -fsSL');
        expect(instructions.fallback).toContain('/tmp/kodus-install.sh');
    });

    it('returns powershell installer for windows', () => {
        const instructions = resolveRemoteInstallInstructions('win32');

        expect(instructions.primary).toContain('install.ps1');
        expect(instructions.primary).toContain('Invoke-RestMethod');
        expect(instructions.fallback).toContain('Invoke-WebRequest');
        expect(instructions.fallback).toContain('.\\install.ps1');
    });
});
