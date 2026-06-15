"use client";

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
import { getTrialCreditBalance } from "../_utils/trial";

export const TrialCreditsSummary = ({
    credits,
    byok,
    daysLeft,
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
                    <p className="text-text-primary text-sm font-semibold">
                        Need more reviews?
                    </p>

                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                        <div className="flex items-start gap-3">
                            <KeyRoundIcon className="text-primary-light mt-0.5 size-4 shrink-0" />
                            <div className="min-w-0">
                                <p className="text-text-primary text-sm font-semibold">
                                    Connect BYOK
                                </p>
                                <p className="text-text-secondary mt-1 text-xs">
                                    Reviews use your own AI key, so they do not
                                    use the {balance.total} PR reviews paid by
                                    Kodus.
                                </p>
                                <Link
                                    href="/organization/byok"
                                    className="mt-2 inline-flex"
                                    noHoverUnderline>
                                    <Button
                                        decorative
                                        size="xs"
                                        variant="tertiary">
                                        Configure BYOK
                                    </Button>
                                </Link>
                            </div>
                        </div>

                        <div className="flex items-start gap-3">
                            <GitPullRequestIcon className="text-primary-light mt-0.5 size-4 shrink-0" />
                            <div className="min-w-0">
                                <p className="text-text-primary text-sm font-semibold">
                                    Upgrade
                                </p>
                                <p className="text-text-secondary mt-1 text-xs">
                                    Keep Kodus-managed PR reviews running after
                                    the trial allowance ends.
                                </p>
                                <Link
                                    href="/choose-plan"
                                    className="mt-2 inline-flex"
                                    noHoverUnderline>
                                    <Button
                                        decorative
                                        size="xs"
                                        variant="helper">
                                        View plans
                                    </Button>
                                </Link>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </section>
    );
};
