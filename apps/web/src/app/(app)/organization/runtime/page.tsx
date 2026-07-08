"use client";

import { useState } from "react";
import { Heading } from "@components/ui/heading";
import { Page } from "@components/ui/page";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { ChevronRightIcon } from "lucide-react";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { isSelfHosted } from "src/core/utils/self-hosted";

import { InfrastructureAdvanced } from "../../settings/code-review/[repositoryId]/kody-runtime/_components/infrastructure-advanced";
import { SecretsVault } from "../../settings/code-review/[repositoryId]/kody-runtime/_components/secrets-vault";
import { ReposRuntimeStatus } from "./_components/repos-status";

/**
 * Organization-level Kody Runtime config: the things set once for the whole org
 * — shared secrets every repo inherits, and where the ephemeral VMs run. The
 * per-repo playbook + secret overrides live on each repository's Kody Runtime
 * tab under Code Review.
 */
export default function OrganizationKodyRuntimePage() {
    const { teamId } = useSelectedTeamId();
    const canEdit = usePermission(
        Action.Update,
        ResourceType.CodeReviewSettings,
    );
    // Self-hosted MUST bring their own cloud (there is no platform default), so
    // show infra up front. On cloud it's an optional override, tucked away.
    const [infraOpen, setInfraOpen] = useState(isSelfHosted);

    return (
        <Page.Root>
            <Page.Header>
                <Heading variant="h1">Kody Runtime</Heading>
            </Page.Header>

            <Page.Content>
                <p className="text-text-secondary max-w-2xl text-sm">
                    Kody boots your app on a throwaway VM and runs the pull
                    request against it, catching bugs that only show up when the
                    code actually runs. Shared secrets and infrastructure are
                    set once here; each repository has its own playbook and
                    overrides.
                </p>

                <ReposRuntimeStatus teamId={teamId} />

                <SecretsVault
                    teamId={teamId}
                    repositoryId="global"
                    canEdit={canEdit}
                />

                {isSelfHosted ? (
                    <div className="flex flex-col gap-2">
                        <div className="flex flex-col gap-1">
                            <Heading variant="h3">Where your apps run</Heading>
                            <p className="text-text-secondary text-sm">
                                Your PRs boot on ephemeral VMs in your own cloud,
                                so the code never leaves your account. Required
                                for self-hosted.
                            </p>
                        </div>
                        <InfrastructureAdvanced
                            teamId={teamId}
                            canEdit={canEdit}
                        />
                    </div>
                ) : (
                    <div className="border-card-lv2 flex flex-col gap-4 rounded-xl border p-5">
                        <button
                            type="button"
                            onClick={() => setInfraOpen((v) => !v)}
                            className="flex flex-row items-center gap-3 text-left">
                            <ChevronRightIcon
                                size={16}
                                className={`text-text-secondary transition-transform ${infraOpen ? "rotate-90" : ""}`}
                            />
                            <span className="flex flex-col">
                                <span className="text-sm font-semibold">
                                    Advanced — run in your own cloud
                                </span>
                                <span className="text-text-secondary text-xs">
                                    By default your PRs run on Kodus&apos;s
                                    infrastructure. Bring your own cloud to keep
                                    the code in your account. Optional.
                                </span>
                            </span>
                        </button>
                        {infraOpen && (
                            <InfrastructureAdvanced
                                teamId={teamId}
                                canEdit={canEdit}
                            />
                        )}
                    </div>
                )}
            </Page.Content>
        </Page.Root>
    );
}
