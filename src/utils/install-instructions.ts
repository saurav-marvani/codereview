export interface RemoteInstallInstructionSet {
    primary: string;
    fallback?: string;
}

const UNIX_INSTALLER_URL =
    'https://raw.githubusercontent.com/kodustech/cli/main/install.sh';
const WINDOWS_INSTALLER_URL =
    'https://raw.githubusercontent.com/kodustech/cli/main/install.ps1';

export function resolveRemoteInstallInstructions(
    platform = process.platform,
): RemoteInstallInstructionSet {
    if (platform === 'win32') {
        return {
            primary: `powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-RestMethod ${WINDOWS_INSTALLER_URL} | Invoke-Expression"`,
            fallback: [
                `powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest ${WINDOWS_INSTALLER_URL} -OutFile install.ps1"`,
                'powershell -NoProfile -ExecutionPolicy Bypass -File .\\install.ps1',
            ].join(' && '),
        };
    }

    return {
        primary: `curl -fsSL ${UNIX_INSTALLER_URL} | bash`,
        fallback: [
            `curl -fsSL ${UNIX_INSTALLER_URL} -o /tmp/kodus-install.sh`,
            'bash /tmp/kodus-install.sh',
        ].join(' && '),
    };
}
