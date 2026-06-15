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
        <div className="grid grid-cols-[auto_1fr] gap-3 md:grid-cols-[auto_1fr_auto]">
            <Icon className="text-primary-light mt-0.5 size-4 shrink-0" />
            <div className="min-w-0 flex-1">
                <p className="text-text-primary text-sm font-semibold">
                    {unlock.title}
                </p>
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
            <div className="col-start-2 flex flex-wrap items-center gap-2 md:col-start-auto md:justify-end">
                <Badge size="xs" variant={statusVariant}>
                    {statusLabel}
                </Badge>
                <span className="text-primary-light text-xs font-semibold">
                    {unlock.rewardLabel}
                </span>
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
    const daysLeftValue = typeof daysLeft === "number" ? daysLeft : TRIAL_DAYS;
    const trialReviewCopy = byok
        ? "BYOK active. Reviews use your AI key."
        : `${balance.remaining} of ${balance.total} Kodus-paid PR reviews left.`;

    return (
        <section className="flex flex-col gap-5">
            <div className="flex flex-col gap-3">
                <div>
                    <p className="text-text-primary text-base font-semibold">
                        Team trial status
                    </p>
                    <p className="text-text-secondary mt-1 text-sm">
                        Your Team plan trial and Kodus-paid PR reviews are
                        separate limits.
                    </p>
                </div>

                <div className="border-card-lv3 grid grid-cols-1 gap-4 border-y py-3 md:grid-cols-2">
                    <div>
                        <p className="text-text-tertiary text-xs font-semibold uppercase">
                            Team plan access
                        </p>
                        <p className="text-text-primary mt-1 text-xl font-semibold">
                            {daysLeftValue} days
                        </p>
                        <p className="text-text-secondary mt-1 text-xs">
                            Full Team features during the {TRIAL_DAYS}-day
                            trial.
                        </p>
                    </div>

                    <div>
                        <p className="text-text-tertiary text-xs font-semibold uppercase">
                            PR reviews paid by Kodus
                        </p>
                        <p className="text-text-primary mt-1 text-xl font-semibold">
                            {byok
                                ? "BYOK"
                                : `${balance.remaining} of ${balance.total}`}
                        </p>
                        <p className="text-text-secondary mt-1 text-xs">
                            {trialReviewCopy}
                        </p>
                    </div>
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
                            BYOK is active, so the 14-day Team trial controls
                            feature access. PR review volume depends on your AI
                            provider key.
                        </p>
                    </div>
                )}
            </div>

            {!compact && (
                <div className="border-card-lv3 flex flex-col gap-3 border-t pt-4">
                    <div className="flex flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-2">
                            <p className="text-text-primary text-sm font-semibold">
                                Trial extension tiers
                            </p>
                            <Badge size="xs" variant="helper">
                                Current: {getTrialTierLabel(trialCreditTier)}
                            </Badge>
                        </div>
                        <p className="text-text-secondary text-xs">
                            These steps can unlock more Kodus-paid PR reviews
                            for qualified trials. BYOK stays available even when
                            the Kodus-paid reviews run out.
                        </p>
                    </div>

                    <div className="grid grid-cols-1 gap-x-6 gap-y-4">
                        {unlocks.map((unlock) => (
                            <TrialTierItem key={unlock.key} unlock={unlock} />
                        ))}
                    </div>
                </div>
            )}
        </section>
    );
};
