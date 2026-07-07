"use client";

import { Button } from "@components/ui/button";
import { Heading } from "@components/ui/heading";
import { Page } from "@components/ui/page";
import { toast } from "@components/ui/toaster/use-toast";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { RotateCcwIcon, SaveIcon } from "lucide-react";
import { useFormContext } from "react-hook-form";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { unformatConfig } from "src/core/utils/helpers";

import { CodeReviewPagesBreadcrumb } from "../../_components/breadcrumb";
import { CentralizedConfigReadOnlyAlert } from "../../_components/centralized-config-readonly-alert";
import { CodeReviewSaveButton } from "../../_components/save-button";
import { useCodeReviewSettingsMutation } from "../../_hooks/use-code-review-settings-mutation";
import { type CodeReviewFormType } from "../../_types";
import { useCodeReviewRouteParams } from "../../../_hooks";
import { EnvironmentEnabled } from "./_components/environment-enabled";
import { GenerateConfigButton } from "./_components/generate-config-button";
import { InfrastructureAdvanced } from "./_components/infrastructure-advanced";
import { PlaybookPhase } from "./_components/playbook-phase";
import { RequiredEnv } from "./_components/required-env";
import { RuntimeTrigger } from "./_components/runtime-trigger";
import { SecretsVault } from "./_components/secrets-vault";

export default function KodyRuntime() {
    const form = useFormContext<CodeReviewFormType>();
    const { teamId } = useSelectedTeamId();
    const { repositoryId, directoryId } = useCodeReviewRouteParams();
    const { saveSettings } = useCodeReviewSettingsMutation({
        teamId,
        repositoryId,
        directoryId,
        form,
    });

    const canEdit = usePermission(
        Action.Update,
        ResourceType.CodeReviewSettings,
        repositoryId,
    );

    const handleSubmit = form.handleSubmit(async (formData) => {
        const { language, ...config } = formData;
        const unformattedConfig = unformatConfig(config);

        try {
            await saveSettings(formData, {
                prepare: async () => ({
                    savedFormData: { ...config, language },
                    codeReviewConfig: unformattedConfig,
                }),
            });
            toast({ description: "Settings saved", variant: "success" });
        } catch (error) {
            console.error("Error saving settings:", error);
            toast({
                title: "Error",
                description:
                    "An error occurred while saving the settings. Please try again.",
                variant: "danger",
            });
        }
    });

    const {
        isDirty: formIsDirty,
        isValid: formIsValid,
        isSubmitting: formIsSubmitting,
    } = form.formState;

    const isGlobal = repositoryId === "global";

    return (
        <Page.Root>
            <Page.Header>
                <CodeReviewPagesBreadcrumb pageName="Kody Runtime" />
            </Page.Header>

            <Page.Header>
                <Page.Title>Kody Runtime</Page.Title>
                <Page.HeaderActions>
                    {formIsDirty && (
                        <Button
                            size="md"
                            variant="cancel"
                            leftIcon={<RotateCcwIcon />}
                            onClick={() => form.reset()}
                            disabled={formIsSubmitting}>
                            Reset
                        </Button>
                    )}
                    <CodeReviewSaveButton
                        size="md"
                        variant="primary"
                        leftIcon={<SaveIcon />}
                        onClick={handleSubmit}
                        disabled={!canEdit || !formIsDirty || !formIsValid}
                        loading={formIsSubmitting}>
                        Save settings
                    </CodeReviewSaveButton>
                </Page.HeaderActions>
            </Page.Header>

            <Page.Content>
                <CentralizedConfigReadOnlyAlert />

                <div data-field-name="environment.enabled">
                    <EnvironmentEnabled />
                </div>

                <div data-field-name="environment.trigger">
                    <RuntimeTrigger />
                </div>

                <div className="flex flex-col gap-4 rounded-xl border border-card-lv2 p-5">
                    <div className="flex flex-col gap-1">
                        <Heading variant="h3">Playbook</Heading>
                        <p className="text-text-secondary text-sm">
                            How to boot the app on the VM. Each phase runs in
                            order; one shell command per line. Long-running
                            services are backgrounded automatically.
                            {!isGlobal &&
                                " Not sure what to put? Let Kody detect it from your repo."}
                        </p>
                    </div>

                    {isGlobal ? (
                        // The playbook (how to boot the app) is specific to each
                        // repo, so it — and "Generate config", which needs a real
                        // repo to inspect — only make sense per repository.
                        <p className="text-text-secondary text-sm">
                            The playbook is specific to each app, so it&apos;s
                            configured per repository. Open a repository&apos;s
                            Kody Runtime settings to set it up (or let Kody
                            generate it).
                        </p>
                    ) : (
                        <>
                            {repositoryId && (
                                <GenerateConfigButton
                                    teamId={teamId}
                                    repositoryId={repositoryId}
                                    disabled={!canEdit}
                                />
                            )}

                            <PlaybookPhase
                                name="environment.setup.value"
                                label="Setup"
                                helper="Install dependencies (e.g. npm ci, pip install -r requirements.txt)."
                                placeholder={"npm ci\ncp .env.example .env"}
                            />
                            <PlaybookPhase
                                name="environment.build.value"
                                label="Build"
                                helper="Compile / prepare the app (e.g. npm run build, migrations)."
                                placeholder={"npm run build\nnpm run db:migrate"}
                            />
                            <PlaybookPhase
                                name="environment.services.value"
                                label="Services"
                                helper="Long-running processes to start (server, worker). These are backgrounded."
                                placeholder={"npm run start\nredis-server"}
                            />
                            <PlaybookPhase
                                name="environment.test.value"
                                label="Test"
                                helper="Optional smoke/tests to run after boot."
                                placeholder={"npm test"}
                            />
                            <PlaybookPhase
                                name="environment.healthcheck.value"
                                label="Health check"
                                helper="Commands that verify the app is up (e.g. curl the health endpoint)."
                                placeholder={"curl -sf http://localhost:3000/health"}
                            />
                        </>
                    )}
                </div>

                {!isGlobal && (
                    <div className="flex flex-col gap-4 rounded-xl border border-card-lv2 p-5">
                        <RequiredEnv />
                    </div>
                )}

                {isGlobal ? (
                    <div className="rounded-xl border border-card-lv2 p-5">
                        <p className="text-text-secondary text-sm">
                            Secrets are configured per repository. Open a specific
                            repository&apos;s Kody Runtime settings to add
                            its <code>.env</code> values.
                        </p>
                    </div>
                ) : (
                    <SecretsVault
                        teamId={teamId}
                        repositoryId={repositoryId}
                        canEdit={canEdit}
                    />
                )}

                {isGlobal && (
                    <InfrastructureAdvanced teamId={teamId} canEdit={canEdit} />
                )}
            </Page.Content>
        </Page.Root>
    );
}
