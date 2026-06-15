import {
    TRIAL_MANAGED_REVIEW_CREDITS_INCLUDED,
    TRIAL_UNLOCK_BYOK_REWARD_LABEL,
    TRIAL_UNLOCK_CODE_ORG_REWARD,
    TRIAL_UNLOCK_COMPANY_EMAIL_REWARD,
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
        key: "company_email",
        title: "Use a company email",
        description:
            "A confirmed work email helps us qualify the trial automatically.",
        rewardLabel: `+${TRIAL_UNLOCK_COMPANY_EMAIL_REWARD} reviews`,
        status: "locked",
    },
    {
        key: "team_setup",
        title: "Invite 3 teammates",
        description:
            params.workspaceMembersCount && params.workspaceMembersCount >= 3
                ? "Workspace has enough teammates for a real team evaluation."
                : "Add teammates so the trial reflects a real review workflow.",
        rewardLabel: `+${TRIAL_UNLOCK_TEAM_REWARD} reviews`,
        status:
            params.workspaceMembersCount && params.workspaceMembersCount >= 3
                ? "completed"
                : "locked",
        href: "/settings/subscription?tab=admins",
    },
    {
        key: "code_org_10_plus",
        title: "Connect a 10+ developer code org",
        description:
            params.codeHostMembersCount && params.codeHostMembersCount >= 10
                ? "Connected code org has at least 10 members."
                : "Connect the organization, not only a personal account, so we can evaluate team fit.",
        rewardLabel: `+${TRIAL_UNLOCK_CODE_ORG_REWARD} reviews`,
        status:
            params.codeHostMembersCount && params.codeHostMembersCount >= 10
                ? "completed"
                : "locked",
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
        key: "manual_extension",
        title: "Request more trial PR reviews",
        description:
            "Ask Kodus to review your trial signals and extend the evaluation manually.",
        rewardLabel: "Manual review",
        status: "available",
        href: "mailto:sales@kodus.io?subject=Trial%20PR%20review%20extension",
    },
];

const getBillingUnlockRewardLabel = (
    unlock: TrialUnlock,
    fallbackRewardLabel?: string,
) => {
    if (typeof unlock.rewardCredits === "number") {
        return `+${unlock.rewardCredits} reviews`;
    }

    return fallbackRewardLabel ?? "Manual review";
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
