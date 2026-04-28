import type {
    KodyRuleMutationResult,
    CreateKodyRuleRequest,
    KodyRule,
    KodyRuleScope,
    KodyRuleSeverity,
    UpdateKodyRuleRequest,
    ViewKodyRulesRequest,
} from '../types/rules.js';
import { CommandError } from '../utils/command-errors.js';
import { api } from './api/index.js';
import { authService } from './auth.service.js';

export type UpdateKodyRuleInput = {
    ruleId: string;
} & UpdateKodyRuleRequest;

const VALID_SEVERITIES: KodyRuleSeverity[] = [
    'low',
    'medium',
    'high',
    'critical',
];

const VALID_SCOPES: KodyRuleScope[] = ['pull request', 'file'];

class RulesService {
    async createRule(
        input: CreateKodyRuleRequest,
    ): Promise<KodyRuleMutationResult> {
        const accessToken = await authService.getValidToken();
        const payload: CreateKodyRuleRequest = {
            title: this.requireText(input.title, 'title'),
            rule: this.requireText(input.rule, 'rule'),
            repositoryId:
                this.normalizeOptionalText(input.repositoryId) || 'global',
            severity: this.normalizeSeverity(input.severity ?? 'medium'),
            scope: this.normalizeScope(input.scope ?? 'file'),
            path: this.normalizeOptionalText(input.path) || '**/*',
        };

        return api.rules.createRule(accessToken, payload);
    }

    async updateRule(
        input: UpdateKodyRuleInput,
    ): Promise<KodyRuleMutationResult> {
        const accessToken = await authService.getValidToken();
        const ruleId = this.requireText(input.ruleId, 'rule-id');
        let hasRuleChanges = false;

        const payload: UpdateKodyRuleRequest = {};

        const title = this.normalizeOptionalText(input.title);
        if (title) {
            payload.title = title;
            hasRuleChanges = true;
        }

        const rule = this.normalizeOptionalText(input.rule);
        if (rule) {
            payload.rule = rule;
            hasRuleChanges = true;
        }

        if (input.severity !== undefined) {
            payload.severity = this.normalizeSeverity(input.severity);
            hasRuleChanges = true;
        }

        if (input.scope !== undefined) {
            payload.scope = this.normalizeScope(input.scope);
            hasRuleChanges = true;
        }

        const path = this.normalizeOptionalText(input.path);
        if (path) {
            payload.path = path;
            hasRuleChanges = true;
        }

        const repositoryId = this.normalizeOptionalText(input.repositoryId);
        if (repositoryId) {
            payload.repositoryId = repositoryId;
            hasRuleChanges = true;
        }

        if (!hasRuleChanges) {
            throw new CommandError(
                'INVALID_INPUT',
                'Provide at least one field to update: --repo-id, --title, --rule, --severity, --scope, or --path.',
            );
        }

        return api.rules.updateRule(accessToken, ruleId, payload);
    }

    async viewRules(input: ViewKodyRulesRequest = {}): Promise<KodyRule[]> {
        const accessToken = await authService.getValidToken();
        const query: ViewKodyRulesRequest = {
            repositoryId: this.normalizeOptionalText(input.repositoryId),
            ruleId: this.normalizeOptionalText(input.ruleId),
        };

        return api.rules.viewRules(accessToken, query);
    }

    private normalizeSeverity(value: string): KodyRuleSeverity {
        const normalized = value.trim().toLowerCase() as KodyRuleSeverity;
        if (!VALID_SEVERITIES.includes(normalized)) {
            throw new CommandError(
                'INVALID_INPUT',
                `Invalid severity '${value}'. Use one of: ${VALID_SEVERITIES.join(', ')}.`,
            );
        }

        return normalized;
    }

    private normalizeScope(value: string): KodyRuleScope {
        const normalized = value.trim().toLowerCase() as KodyRuleScope;
        if (!VALID_SCOPES.includes(normalized)) {
            throw new CommandError(
                'INVALID_INPUT',
                `Invalid scope '${value}'. Use one of: ${VALID_SCOPES.join(', ')}.`,
            );
        }

        return normalized;
    }

    private requireText(value: string, field: string): string {
        const normalized = value.trim();
        if (!normalized) {
            throw new CommandError(
                'INVALID_INPUT',
                `--${field} cannot be empty.`,
            );
        }

        return normalized;
    }

    private normalizeOptionalText(value?: string): string | undefined {
        const normalized = value?.trim();
        return normalized ? normalized : undefined;
    }
}

export { RulesService };
export const rulesService = new RulesService();
