"use client";

import type { ComponentProps, ElementType } from "react";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { Link } from "@components/ui/link";
import { Progress } from "@components/ui/progress";
import {
    Building2Icon,
    CheckCircle2Icon,
    CircleIcon,
    GitPullRequestIcon,
    KeyRoundIcon,
    LockIcon,
    MailPlusIcon,
    UsersIcon,
} from "lucide-react";
import { cn } from "src/core/utils/components";

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
    team_setup: UsersIcon,
    multi_author_review: GitPullRequestIcon,
    byok: KeyRoundIcon,
    referral: Building2Icon,
    manual: MailPlusIcon,
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

const TrialUnlockItem = ({ unlock }: { unlock: TrialUnlockViewModel }) => {
    const Icon = unlockIconByKey[unlock.key] ?? CircleIcon;
    const isDone = unlock.status === "completed" || unlock.status === "claimed";
    const isLocked = unlock.status === "locked";
    const statusLabel = statusLabelByStatus[unlock.status] ?? "Available";
    const statusVariant = statusVariantByStatus[unlock.status] ?? "helper";

    return (
        <div className="border-card-lv3/70 flex items-start gap-3 rounded-lg border p-3">
            <div
                className={cn(
                    "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg",
                    isDone
                        ? "bg-success/15 text-success"
                        : "bg-card-lv2 text-text-secondary",
                )}>
                {isDone ? (
                    <CheckCircle2Icon className="size-4" />
                ) : isLocked ? (
                    <LockIcon className="size-4" />
                ) : (
                    <Icon className="size-4" />
                )}
            </div>

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

                {unlock.href && !isDone && (
                    <Link
                        href={unlock.href}
                        className="mt-2 inline-flex"
                        noHoverUnderline>
                        <Button
                            decorative
                            size="xs"
                            variant={isLocked ? "helper" : "tertiary"}>
                            {unlock.key === "referral"
                                ? "Refer a team"
                                : unlock.key === "byok"
                                  ? "Configure BYOK"
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
    const liveBalanceLabel = balance.hasLiveData
        ? `${balance.remaining} of ${balance.total} Kodus review credits left`
        : `${balance.total} PR reviews included with Kodus credits`;

    return (
        <section className="flex flex-col gap-4">
            <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                    <Badge size="xs" variant="primary-dark">
                        {getTrialTierLabel(trialCreditTier)}
                    </Badge>
                    <Badge size="xs" variant="helper">
                        {TRIAL_DAYS}-day Team trial
                    </Badge>
                    {typeof daysLeft === "number" && (
                        <Badge size="xs" variant="helper">
                            {daysLeft} days left
                        </Badge>
                    )}
                    {byok && (
                        <Badge size="xs" variant="success">
                            BYOK active
                        </Badge>
                    )}
                </div>

                <div>
                    <div className="mb-2 flex items-center justify-between gap-4 text-sm">
                        <p className="text-text-primary font-semibold">
                            {byok
                                ? "Reviews use your AI key"
                                : liveBalanceLabel}
                        </p>
                        {!byok && balance.hasLiveData && (
                            <p className="text-text-tertiary text-xs">
                                {balance.used} used
                            </p>
                        )}
                    </div>

                    {!byok && (
                        <Progress
                            value={balance.used}
                            max={balance.total}
                            variant={
                                balance.remaining === 0 ? "tertiary" : "primary"
                            }
                        />
                    )}

                    <p className="text-text-tertiary mt-2 text-xs">
                        {byok
                            ? "BYOK reviews use your AI key and do not spend Kodus trial credits."
                            : balance.hasLiveData
                              ? "Kodus credits cover the AI cost for each review until they run out."
                              : "Live credit balance appears here once trial credit data is available."}
                    </p>
                </div>
            </div>

            {!compact && (
                <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-4">
                        <p className="text-text-primary text-sm font-semibold">
                            Unlock more evaluation capacity
                        </p>
                        <span className="text-text-tertiary text-xs">
                            Credits unlock automatically
                        </span>
                    </div>

                    <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
                        {unlocks.map((unlock) => (
                            <TrialUnlockItem key={unlock.key} unlock={unlock} />
                        ))}
                    </div>
                </div>
            )}
        </section>
    );
};
