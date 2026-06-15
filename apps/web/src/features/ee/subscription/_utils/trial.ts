import {
    TRIAL_MANAGED_REVIEW_CREDITS_INCLUDED,
    TRIAL_UNLOCK_BYOK_REWARD_LABEL,
    TRIAL_UNLOCK_MULTI_AUTHOR_REWARD,
    TRIAL_UNLOCK_REFERRAL_REWARD,
    TRIAL_UNLOCK_TEAM_REWARD,
} from "../_constants/trial";
import type {
    TrialCreditTier,
    TrialReviewCredits,
    TrialUnlock,
    TrialUnlockKey,
    TrialUnlockStatus,
} from "../_services/billing/types";

export type TrialCreditBalance = {
    total: number;
    used: number;
    remaining: number;
    hasLiveData: boolean;
    percentUsed: number;
};

export type TrialUnlockViewModel = {
    key: TrialUnlockKey;
    title: string;
    description: string;
    rewardLabel: string;
    status: TrialUnlockStatus;
    href?: string;
};

export const getTrialCreditBalance = (
    credits?: TrialReviewCredits,
): TrialCreditBalance => {
    const hasLiveData =
        typeof credits?.total === "number" ||
        typeof credits?.used === "number" ||
        typeof credits?.remaining === "number";

    const fallbackTotal = TRIAL_MANAGED_REVIEW_CREDITS_INCLUDED;
    const total = Math.max(0, credits?.total ?? fallbackTotal);
    const used = Math.max(0, credits?.used ?? 0);
    const remaining = Math.max(
        0,
        credits?.remaining ?? Math.max(0, total - used),
    );
    const percentUsed = total > 0 ? Math.min(100, (used / total) * 100) : 100;

    return {
        total,
        used,
        remaining,
        hasLiveData,
        percentUsed,
    };
};

export const getTrialTierLabel = (tier?: TrialCreditTier): string => {
    switch (tier) {
        case "base":
            return "Base";
        case "team_signal":
            return "Team signal";
        case "qualified":
            return "Qualified";
        case "manual":
            return "Manual";
        case "referral":
            return "Referral";
        default:
            return "Base";
    }
};

const fallbackUnlocks = (params: {
    byok?: boolean;
    workspaceMembersCount?: number;
    codeHostMembersCount?: number;
}): TrialUnlockViewModel[] => [
    {
        key: "team_setup",
        title: "Add your team",
        description:
            params.workspaceMembersCount && params.workspaceMembersCount > 1
                ? "Team member detected. We can confirm this extension."
                : params.codeHostMembersCount &&
                    params.codeHostMembersCount >= 3
                  ? "Invite teammates so the evaluation reflects real team usage."
                  : "Invite another developer to evaluate Kodus as a team.",
        rewardLabel: `+${TRIAL_UNLOCK_TEAM_REWARD} reviews`,
        status:
            params.workspaceMembersCount && params.workspaceMembersCount > 1
                ? "available"
                : "locked",
        href: "/settings/subscription?tab=admins",
    },
    {
        key: "multi_author_review",
        title: "Review PRs from 2 developers",
        description: "Run reviews on real PRs from more than one author.",
        rewardLabel: `+${TRIAL_UNLOCK_MULTI_AUTHOR_REWARD} reviews`,
        status: "locked",
    },
    {
        key: "byok",
        title: "Connect BYOK",
        description:
            "Use your own AI key. Reviews no longer use Kodus-paid PRs.",
        rewardLabel: TRIAL_UNLOCK_BYOK_REWARD_LABEL,
        status: params.byok ? "completed" : "available",
        href: "/organization/byok",
    },
    {
        key: "referral",
        title: "Refer another engineering team",
        description: "Both teams can get extra evaluation reviews after setup.",
        rewardLabel: `+${TRIAL_UNLOCK_REFERRAL_REWARD} reviews`,
        status: "locked",
        href: "mailto:?subject=Try%20Kodus%20for%20AI%20PR%20reviews&body=Hey%2C%20we%27re%20trying%20Kodus%20for%20AI%20pull%20request%20reviews.%20Might%20be%20useful%20for%20your%20engineering%20team%3A%20https%3A%2F%2Fkodus.io",
    },
];

const getBillingUnlockRewardLabel = (
    unlock: TrialUnlock,
    fallbackRewardLabel?: string,
) => {
    if (typeof unlock.rewardCredits === "number") {
        return `+${unlock.rewardCredits} reviews`;
    }

    return fallbackRewardLabel ?? "Extra PR reviews";
};

export const getTrialUnlocks = (params: {
    billingUnlocks?: TrialUnlock[];
    byok?: boolean;
    workspaceMembersCount?: number;
    codeHostMembersCount?: number;
}): TrialUnlockViewModel[] => {
    const fallback = fallbackUnlocks(params);
    const billingUnlocksByKey = new Map(
        params.billingUnlocks?.map((unlock) => [unlock.key, unlock]) ?? [],
    );
    const fallbackKeys = new Set(fallback.map((unlock) => unlock.key));

    const mergedFallbackUnlocks = fallback.map((unlock) => {
        const billingUnlock = billingUnlocksByKey.get(unlock.key);
        if (!billingUnlock) return unlock;

        return {
            ...unlock,
            title: billingUnlock.title || unlock.title,
            description: billingUnlock.description || unlock.description,
            rewardLabel: getBillingUnlockRewardLabel(
                billingUnlock,
                unlock.rewardLabel,
            ),
            status: billingUnlock.status,
        };
    });

    const billingOnlyUnlocks =
        params.billingUnlocks
            ?.filter((unlock) => !fallbackKeys.has(unlock.key))
            .map((unlock) => ({
                key: unlock.key,
                title: unlock.title || "Trial unlock",
                description:
                    unlock.description ||
                    "This unlock can add more PR reviews to this trial.",
                rewardLabel: getBillingUnlockRewardLabel(unlock),
                status: unlock.status,
            })) ?? [];

    return [...mergedFallbackUnlocks, ...billingOnlyUnlocks];
};
