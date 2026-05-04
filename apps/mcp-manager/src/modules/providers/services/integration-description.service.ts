import { Injectable } from '@nestjs/common';
import { readFileSync } from 'fs';
import { resolve } from 'path';

interface IntegrationDescriptions {
    [provider: string]: {
        integrations: {
            [appName: string]: string;
        };
    };
}

@Injectable()
export class IntegrationDescriptionService {
    private descriptions: IntegrationDescriptions;

    constructor() {
        this.loadDescriptions();
    }

    private loadDescriptions(): void {
        try {
            // Resolve relative to this file so the path works regardless of
            // process.cwd() — important in the kodus-ai monorepo where cwd
            // is the repo root, not apps/mcp-manager. Mirrors kodus-mcp.provider.ts.
            const filePath = resolve(
                __dirname,
                '../../../config/integration-descriptions.json',
            );
            const fileContent = readFileSync(filePath, 'utf8');
            this.descriptions = JSON.parse(fileContent);
        } catch (error) {
            console.warn('Error loading integration descriptions:', error);
            this.descriptions = {};
        }
    }

    getDescription(provider: string, appName: string): string {
        const providerDescriptions = this.descriptions[provider];
        if (!providerDescriptions) {
            return this.generateFallbackDescription(appName);
        }

        const description = providerDescriptions.integrations[appName];
        if (!description) {
            return this.generateFallbackDescription(appName);
        }

        return description;
    }

    private generateFallbackDescription(appName: string): string {
        const formattedAppName =
            appName.charAt(0).toUpperCase() + appName.slice(1);
        return `Integration with ${formattedAppName} for automation and task management.`;
    }
}
