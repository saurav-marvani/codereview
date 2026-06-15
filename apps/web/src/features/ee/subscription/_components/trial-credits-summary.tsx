"use client";

import type { ComponentProps, ElementType } from "react";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { Link } from "@components/ui/link";
import { Progress } from "@components/ui/progress";
import { GitPullRequestIcon, KeyRoundIcon, SparklesIcon } from "lucide-react";

import { TRIAL_DAYS } from "../_constants/trial";
import type {
    TrialCreditTier,
    TrialReviewCredits,
    TrialUnlock,
} from "../_services/billing/types";
import {
    getTrialCreditBalance,
    getTrialTierLabel,
    getTrialUnlocks,
    type TrialUnlockViewModel,
} from "../_utils/trial";

const unlockIconByKey: Record<string, ElementType> = {
    team_setup: SparklesIcon,
    multi_author_review: GitPullRequestIcon,
    byok: KeyRoundIcon,
    referral: SparklesIcon,
    manual: SparklesIcon,
};

const statusLabelByStatus: Record<string, string> = {
    locked: "Locked",
    available: "Available",
    completed: "Done",
    claimed: "Done",
};

const statusVariantByStatus: Record<
    string,
    ComponentProps<typeof Badge>["variant"]
> = {
    locked: "helper",
    available: "tertiary",
    completed: "success",
    claimed: "success",
};

const TrialTierItem = ({ unlock }: { unlock: TrialUnlockViewModel }) => {
    const Icon = unlockIconByKey[unlock.key] ?? SparklesIcon;
    const isAvailable = unlock.status === "available";
    const isDone = unlock.status === "completed" || unlock.status === "claimed";
    const statusLabel = statusLabelByStatus[unlock.status] ?? "Available";
    const statusVariant = statusVariantByStatus[unlock.status] ?? "helper";

    return (
        <div className="flex items-start gap-3">
            <Icon className="text-primary-light mt-0.5 size-4 shrink-0" />
            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                    <p className="text-text-primary text-sm font-semibold">
                        {unlock.title}
                    </p>
                    <Badge size="xs" variant={statusVariant}>
                        {statusLabel}
                    </Badge>
                    <span className="text-primary-light text-xs font-semibold">
                        {unlock.rewardLabel}
                    </span>
                </div>
                <p className="text-text-secondary mt-1 text-xs">
                    {unlock.description}
                </p>

                {unlock.href && isAvailable && !isDone && (
                    <Link
                        href={unlock.href}
                        className="mt-2 inline-flex"
                        noHoverUnderline>
                        <Button decorative size="xs" variant="tertiary">
                            {unlock.key === "byok"
                                ? "Configure BYOK"
                                : unlock.key === "referral"
                                  ? "Refer a team"
                                  : "Open setup"}
                        </Button>
                    </Link>
                )}
            </div>
        </div>
    );
};

export const TrialCreditsSummary = ({
    credits,
    trialCreditTier,
    trialUnlocks,
    byok,
    daysLeft,
    workspaceMembersCount,
    codeHostMembersCount,
    compact = false,
}: {
    credits?: TrialReviewCredits;
    trialCreditTier?: TrialCreditTier;
    trialUnlocks?: TrialUnlock[];
    byok?: boolean;
    daysLeft?: number;
    workspaceMembersCount?: number;
    codeHostMembersCount?: number;
    compact?: boolean;
}) => {
    const balance = getTrialCreditBalance(credits);
    const unlocks = getTrialUnlocks({
        billingUnlocks: trialUnlocks,
        byok,
        workspaceMembersCount,
        codeHostMembersCount,
    });
    const remainingLabel = `${balance.remaining} of ${balance.total}`;
    const daysLeftLabel =
        typeof daysLeft === "number"
            ? `${daysLeft} days left in your Team trial`
            : `${TRIAL_DAYS}-day Team trial`;

    return (
        <section className="flex flex-col gap-5">
            <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                    <div>
                        <p className="text-text-primary text-base font-semibold">
                            Kodus pays for your first {balance.total} PR reviews
                        </p>
                        <p className="text-text-secondary mt-1 text-sm">
                            {daysLeftLabel}. After the {balance.total} reviews,
                            connect BYOK or upgrade to keep reviewing PRs.
                        </p>
                    </div>

                    {!byok && (
                        <div className="text-left md:text-right">
                            <p className="text-text-primary text-xl font-semibold">
                                {remainingLabel}
                            </p>
                            <p className="text-text-tertiary text-xs">
                                Kodus-paid reviews left
                            </p>
                        </div>
                    )}
                </div>

                {!byok ? (
                    <div>
                        <div className="mb-2 flex items-center justify-between gap-4 text-sm">
                            <p className="text-text-secondary text-xs">
                                {balance.used} used
                            </p>
                            <p className="text-text-secondary text-xs">
                                {balance.total} total
                            </p>
                        </div>

                        <Progress
                            value={balance.used}
                            max={balance.total}
                            variant={
                                balance.remaining === 0 ? "tertiary" : "primary"
                            }
                        />
                    </div>
                ) : (
                    <div className="bg-success/10 text-success flex items-start gap-2 rounded-lg p-3 text-sm">
                        <SparklesIcon className="mt-0.5 size-4 shrink-0" />
                        <p>
                            BYOK is active. Reviews use your AI key and do not
                            count against the PR reviews paid by Kodus.
                        </p>
                    </div>
                )}
            </div>

            {!compact && (
                <div className="border-card-lv3 flex flex-col gap-3 border-t pt-4">
                    <div className="flex flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-2">
                            <p className="text-text-primary text-sm font-semibold">
                                Ways to extend this evaluation
                            </p>
                            <Badge size="xs" variant="helper">
                                {getTrialTierLabel(trialCreditTier)}
                            </Badge>
                        </div>
                        <p className="text-text-secondary text-xs">
                            These steps can add more Kodus-paid PR reviews for
                            qualified trials. BYOK is always available and uses
                            your own AI key.
                        </p>
                    </div>

                    <div className="grid grid-cols-1 gap-x-6 gap-y-4 lg:grid-cols-2">
                        {unlocks.map((unlock) => (
                            <TrialTierItem key={unlock.key} unlock={unlock} />
                        ))}
                    </div>
                </div>
            )}
        </section>
    );
};
