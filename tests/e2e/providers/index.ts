import type { Provider, ProviderName } from "../lib/types.js";
import { AzureDevOpsProvider } from "./azure-devops.js";
import { BitbucketProvider } from "./bitbucket.js";
import { GitHubProvider } from "./github.js";
import { GitHubAppProvider } from "./github-app.js";
import { GitLabProvider } from "./gitlab.js";

export function makeProvider(name: ProviderName): Provider {
    switch (name) {
        case "github":
            return new GitHubProvider();
        case "github-app":
            return new GitHubAppProvider();
        case "gitlab":
            return new GitLabProvider();
        case "bitbucket":
            return new BitbucketProvider();
        case "azure-devops":
            return new AzureDevOpsProvider();
        default: {
            const exhaustive: never = name;
            throw new Error(`Unknown provider: ${exhaustive}`);
        }
    }
}

export {
    AzureDevOpsProvider,
    BitbucketProvider,
    GitHubAppProvider,
    GitHubProvider,
    GitLabProvider,
};
