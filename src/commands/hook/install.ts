import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';
import inquirer from 'inquirer';
import { gitService } from '../../services/git.service.js';

const KODUS_MARKER = '# kodus-hook';

function generateHookScript(failOn: string, fast: boolean): string {
  const flags: string[] = [];
  if (fast) flags.push('--fast');
  flags.push('--fail-on', failOn);
  flags.push('--format', 'terminal');
  flags.push('--quiet');

  const reviewFlags = flags.join(' ');

  return `#!/bin/sh
${KODUS_MARKER} — installed by kodus CLI
# To uninstall: kodus hook uninstall

# Skip hook if KODUS_SKIP_HOOK is set
if [ -n "$KODUS_SKIP_HOOK" ]; then
  exit 0
fi

# Check if kodus is available
if ! command -v kodus >/dev/null 2>&1; then
  echo "Warning: kodus CLI not found. Skipping pre-push review."
  echo "Install: npm install -g @kodus/cli"
  exit 0
fi

remote="$1"
current_branch="$(git symbolic-ref --short HEAD 2>/dev/null)"

while read local_ref local_sha remote_ref remote_sha; do
  # Skip branch deletions
  if [ "$local_sha" = "0000000000000000000000000000000000000000" ]; then
    continue
  fi

  # New branch — no remote state to compare, skip review
  if [ "$remote_sha" = "0000000000000000000000000000000000000000" ]; then
    continue
  fi

  # Extract branch name from ref (refs/heads/my-branch → my-branch)
  branch_name="\${local_ref#refs/heads/}"

  # Only review if pushing the currently checked-out branch
  # (--branch compares against HEAD, so reviewing other refs would produce wrong diffs)
  if [ "\$branch_name" != "\$current_branch" ]; then
    continue
  fi

  # Review changes not yet on the remote
  if ! kodus review --branch "\${remote}/\${branch_name}" ${reviewFlags}; then
    exit 1
  fi
done
`;
}

export async function installAction(options: {
  failOn?: string;
  fast?: boolean;
  force?: boolean;
}): Promise<void> {
  const failOn = options.failOn ?? 'critical';
  const fast = options.fast !== false; // default true

  const isRepo = await gitService.isGitRepository();
  if (!isRepo) {
    console.error(chalk.red('Error: Not a git repository.'));
    process.exit(1);
  }

  const gitRoot = await gitService.getGitRoot();
  const hooksDir = path.join(gitRoot.trim(), '.git', 'hooks');
  const hookPath = path.join(hooksDir, 'pre-push');

  // Check if hook already exists
  let existingContent: string | null = null;
  try {
    existingContent = await fs.readFile(hookPath, 'utf-8');
  } catch {
    // File doesn't exist
  }

  if (existingContent) {
    const isKodusHook = existingContent.includes(KODUS_MARKER);

    if (!isKodusHook && !options.force) {
      const { overwrite } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'overwrite',
          message: 'A pre-push hook already exists. Overwrite it?',
          default: false,
        },
      ]);

      if (!overwrite) {
        console.log(chalk.yellow('Installation cancelled.'));
        return;
      }
    }
  }

  // Ensure hooks directory exists
  await fs.mkdir(hooksDir, { recursive: true });

  // Write hook script
  const script = generateHookScript(failOn, fast);
  await fs.writeFile(hookPath, script, { mode: 0o755 });

  console.log(chalk.green('✓ Pre-push hook installed successfully!'));
  console.log(chalk.dim(`  Path: ${hookPath}`));
  console.log(chalk.dim(`  Fail on: ${failOn}`));
  console.log(chalk.dim(`  Fast mode: ${fast ? 'yes' : 'no'}`));
  console.log('');
  console.log(chalk.dim('Skip with: KODUS_SKIP_HOOK=1 git push'));
  console.log(chalk.dim('Remove with: kodus hook uninstall'));
}

export { KODUS_MARKER, generateHookScript };
