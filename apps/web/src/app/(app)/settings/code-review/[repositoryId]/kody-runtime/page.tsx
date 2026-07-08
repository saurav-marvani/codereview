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
import { PlaybookYamlEditor } from "./_components/playbook-yaml-editor";
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
                            How to boot the app on the VM, as{" "}
                            <code>.kody/runtime.yml</code> - the same file you can
                            commit to the repo. Phases (setup, build, services,
                            healthcheck, test) run in order; services are
                            backgrounded automatically.
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

                            <PlaybookYamlEditor disabled={!canEdit} />
                        </>
                    )}
                </div>

                {!isGlobal ? (
                    <>
                        <div className="flex flex-col gap-4 rounded-xl border border-card-lv2 p-5">
                            <RequiredEnv />
                        </div>

                        <SecretsVault
                            teamId={teamId}
                            repositoryId={repositoryId}
                            canEdit={canEdit}
                            requiredEnv={
                                (form.watch(
                                    "environment.requiredEnv.value",
                                ) as string[]) ?? []
                            }
                        />
                    </>
                ) : (
                    <div className="rounded-xl border border-card-lv2 p-5">
                        <p className="text-text-secondary text-sm">
                            Shared secrets and where the VMs run are set once for
                            the whole organization in{" "}
                            <a
                                href="/organization/runtime"
                                className="text-primary hover:underline">
                                Organization settings, Kody Runtime
                            </a>
                            . Every repository inherits them; open a repository to
                            add its own playbook and secret overrides.
                        </p>
                    </div>
                )}
            </Page.Content>
        </Page.Root>
    );
}
