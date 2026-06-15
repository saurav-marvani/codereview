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
            return "Base evaluation";
        case "team_signal":
            return "Team evaluation";
        case "qualified":
            return "Qualified evaluation";
        case "manual":
            return "Manual extension";
        case "referral":
            return "Referral bonus";
        default:
            return "Base evaluation";
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
                ? "Team member detected. Extra review credits unlock after this step is confirmed."
                : params.codeHostMembersCount &&
                    params.codeHostMembersCount >= 3
                  ? "Code organization size detected. Invite teammates to evaluate on real PRs."
                  : "Invite another developer so the trial reflects a real team workflow.",
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
        description:
            "Run Kodus on real PRs from more than one author to unlock a stronger evaluation.",
        rewardLabel: `+${TRIAL_UNLOCK_MULTI_AUTHOR_REWARD} reviews`,
        status: "locked",
    },
    {
        key: "byok",
        title: "Connect BYOK",
        description:
            "Use your AI key for trial reviews without spending Kodus credits.",
        rewardLabel: TRIAL_UNLOCK_BYOK_REWARD_LABEL,
        status: params.byok ? "completed" : "available",
        href: "/organization/byok",
    },
    {
        key: "referral",
        title: "Refer another engineering team",
        description:
            "Both teams get extra evaluation reviews after the referred company connects an org and runs its first review.",
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

    return fallbackRewardLabel ?? "Extra credits";
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
                    "This unlock can add more review credits to this trial.",
                rewardLabel: getBillingUnlockRewardLabel(unlock),
                status: unlock.status,
            })) ?? [];

    return [...mergedFallbackUnlocks, ...billingOnlyUnlocks];
};
