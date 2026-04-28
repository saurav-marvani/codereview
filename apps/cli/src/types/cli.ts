export type OutputFormat = 'terminal' | 'json' | 'markdown' | 'prompt';

export interface FileDiff {
    file: string;
    status: 'added' | 'modified' | 'deleted' | 'renamed';
    additions: number;
    deletions: number;
    diff: string;
}

export interface ProjectContext {
    cursorRules?: string;
    claudeRules?: string;
    kodusRules?: string;
    customContext?: string;
}

export interface GlobalOptions {
    format: OutputFormat;
    output?: string;
    verbose: boolean;
    quiet: boolean;
    agent?: boolean;
    interactive?: boolean;
    promptOnly?: boolean;
    fix?: boolean;
    context?: string;
}

export interface GitInfo {
    userEmail?: string;
    remote?: string | null;
    branch?: string;
    commitSha?: string;
}

export type PlatformType =
    | 'GITHUB'
    | 'GITLAB'
    | 'BITBUCKET'
    | 'AZURE_REPOS'
    | undefined;
