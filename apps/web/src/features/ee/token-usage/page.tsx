import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Page } from "@components/ui/page";
import {
    getDailyTokenUsage,
    getSummaryTokenUsage,
    getTokenPricing,
    getTokenUsageByDeveloper,
    getTokenUsageByPR,
} from "@services/usage/fetch";
import {
    BaseUsageContract,
    ModelPricingInfo,
    UsageByPrResultContract,
    UsageSummaryContract,
} from "@services/usage/types";
import { CookieName } from "src/core/utils/cookie";
import { getGlobalSelectedTeamId } from "src/core/utils/get-global-selected-team-id";
import { isBYOKSubscriptionPlan } from "src/features/ee/byok/_utils";
import { getSelectedDateRange } from "src/features/ee/cockpit/_helpers/get-selected-date-range";
import { validateOrganizationLicense } from "src/features/ee/subscription/_services/billing/fetch";
import { fetchModelPricingFromModelsDev } from "src/features/ee/subscription/choose-plan/_services/models";

import { TokenUsagePageClient } from "./_components/page.client";

function buildFallbackPricing(
    model: string,
    prompt: number,
    completion: number,
): ModelPricingInfo {
    return {
        id: model,
        pricing: {
            input: { default: prompt },
            output: { default: completion },
            cacheRead: { default: 0 },
            cacheWrite: { default: 0 },
            prompt,
            completion,
            // Reasoning is already counted inside outputTokens for every
            // provider we ship; the scalar stays for backward compat only.
            internal_reasoning: completion,
        },
    };
}

async function getModelPricing(model: string): Promise<ModelPricingInfo> {
    // First try internal API (LiteLLM catalog, wrapped by TokenPricingUseCase)
    try {
        const internalPricing = await getTokenPricing(model);
        if (
            internalPricing?.pricing?.prompt > 0 ||
            internalPricing?.pricing?.completion > 0
        ) {
            return internalPricing;
        }
    } catch {
        // Fall through to models.dev
    }

    // Try models.dev as fallback (no cache rates — those fields default to 0)
    const modelsDevPricing = await fetchModelPricingFromModelsDev(model);
    if (modelsDevPricing) {
        return buildFallbackPricing(
            model,
            modelsDevPricing.prompt,
            modelsDevPricing.completion,
        );
    }

    // Return zero pricing as last resort
    return buildFallbackPricing(model, 0, 0);
}

export default async function TokenUsagePage({
    searchParams,
}: {
    searchParams: { [key: string]: string | string[] | undefined };
}) {
    const params = await searchParams;
    const teamId = await getGlobalSelectedTeamId();
    const subscription = await validateOrganizationLicense({ teamId }).catch(
        () => null,
    );

    const isBYOK = subscription ? isBYOKSubscriptionPlan(subscription) : false;
    const isTrial = subscription?.subscriptionStatus === "trial";

    const cookieStore = await cookies();

    const selectedDateRange = await getSelectedDateRange();

    const filters = {
        startDate: selectedDateRange.startDate,
        endDate: selectedDateRange.endDate,
        prNumber: params.prNumber ? Number(params.prNumber) : undefined,
        developer: params.developer,
        byok: isBYOK,
    };

    let data: BaseUsageContract[] = [];
    let summary: UsageSummaryContract | null = null;
    let activeDayCount = 0;
    let uniquePrCount = 0;
    const filterType = params.filter ?? "daily";

    try {
        const chartFetch =
            filterType === "by-pr"
                ? getTokenUsageByPR(filters)
                : filterType === "by-developer"
                  ? getTokenUsageByDeveloper(filters)
                  : getDailyTokenUsage(filters);

        // Daily + by-pr requests run unconditionally because the cost cards
        // need both "active days" and "unique PRs" counts regardless of which
        // dimension the chart is rendering.
        const [chartData, summaryData, dailyData, prData] = await Promise.all([
            chartFetch,
            getSummaryTokenUsage(filters),
            filterType === "daily"
                ? Promise.resolve(null)
                : getDailyTokenUsage(filters),
            filterType === "by-pr"
                ? Promise.resolve(null)
                : getTokenUsageByPR(filters),
        ]);

        data = chartData;
        summary = summaryData;

        const dailyRows = (filterType === "daily" ? chartData : dailyData) ?? [];
        const prRows = (filterType === "by-pr" ? chartData : prData) ?? [];
        activeDayCount = new Set(
            (dailyRows as Array<{ date?: string }>)
                .map((r) => r.date)
                .filter(Boolean),
        ).size;
        uniquePrCount = new Set(
            (prRows as Array<{ prNumber?: number }>)
                .map((r) => r.prNumber)
                .filter((n): n is number => typeof n === "number"),
        ).size;
    } catch (error) {
        console.error("Failed to fetch token usage data:", error);
    }

    const ENABLE_MOCK_DATA = false;

    if (ENABLE_MOCK_DATA && filterType === "by-pr") {
        const mockData: UsageByPrResultContract[] = [];

        for (let i = 1; i <= 30; i++) {
            const isOutlier = i === 15;
            const isHighUsage = i === 5 || i === 22;

            const baseInput = isOutlier
                ? 15000000
                : isHighUsage
                  ? 50000
                  : Math.random() * 5000 + 1000;
            const baseOutput = isOutlier
                ? 8000000
                : isHighUsage
                  ? 30000
                  : Math.random() * 3000 + 500;
            const baseReasoning = isOutlier
                ? 2000000
                : isHighUsage
                  ? 10000
                  : Math.random() * 1000 + 200;

            const input = Math.floor(baseInput);
            const output = Math.floor(baseOutput);
            const outputReasoning = Math.floor(baseReasoning);

            mockData.push({
                model: "claude-3-5-sonnet-20241022",
                input,
                output,
                outputReasoning,
                total: input + output + outputReasoning,
                prNumber: i,
            });
        }

        data = mockData;
    }

    const uniqueModels: string[] = Array.from(
        new Set(data.map((d) => d.model)),
    );

    let pricing = {};

    if (ENABLE_MOCK_DATA && filterType === "by-pr") {
        pricing = {
            "claude-3-5-sonnet-20241022": buildFallbackPricing(
                "claude-3-5-sonnet-20241022",
                3.0,
                15.0,
            ),
        };
    } else {
        try {
            const pricingPromises = uniqueModels.map(async (model) => {
                const pricingInfo = await getModelPricing(model);
                return { [model]: pricingInfo };
            });

            const pricingArray = await Promise.all(pricingPromises);
            pricing = Object.assign({}, ...pricingArray);
        } catch (error) {
            console.error("Failed to fetch pricing data:", error);
        }
    }

    const dateRangeCookieValue = cookieStore.get(
        "cockpit-selected-date-range" satisfies CookieName,
    )?.value;

    return (
        <Page.Root>
            <Page.Header>
                <Page.Title>Token Usage</Page.Title>
            </Page.Header>
            <Page.Content>
                <TokenUsagePageClient
                    data={data}
                    summary={summary}
                    activeDayCount={activeDayCount}
                    uniquePrCount={uniquePrCount}
                    cookieValue={dateRangeCookieValue}
                    models={uniqueModels}
                    pricing={pricing}
                />
            </Page.Content>
        </Page.Root>
    );
}
