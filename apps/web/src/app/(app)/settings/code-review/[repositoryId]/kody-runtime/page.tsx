"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import { Heading } from "@components/ui/heading";
import { Page } from "@components/ui/page";
import { toast } from "@components/ui/toaster/use-toast";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { CheckIcon, RotateCcwIcon, SaveIcon } from "lucide-react";
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

/** Numbered step header for the setup flow; shows a check once the step is done. */
const StepHeader = ({
    n,
    title,
    done,
}: {
    n: number;
    title: string;
    done: boolean;
}) => (
    <div className="flex flex-row items-center gap-2.5">
        <span
            className={
                "flex size-6 items-center justify-center rounded-full text-xs font-bold " +
                (done
                    ? "bg-success/15 text-success"
                    : "bg-card-lv2 text-text-secondary")
            }>
            {done ? <CheckIcon size={13} /> : n}
        </span>
        <span className="text-text-primary text-sm font-semibold">{title}</span>
    </div>
);
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

    // Setup-flow status, derived from the form + the vault's missing report.
    const enabled = !!form.watch("environment.enabled.value");
    const setupCmds =
        (form.watch("environment.setup.value") as string[]) ?? [];
    const serviceCmds =
        (form.watch("environment.services.value") as string[]) ?? [];
    const hasPlaybook = setupCmds.length > 0 || serviceCmds.length > 0;
    const [missingSecrets, setMissingSecrets] = useState(0);

    const status = !enabled
        ? {
              tone: "off" as const,
              text: "Off. Follow the steps below to let Kody run this app.",
          }
        : !hasPlaybook
          ? {
                tone: "warn" as const,
                text: "Almost there. Kody still needs a playbook (step 2).",
            }
          : missingSecrets > 0
            ? {
                  tone: "warn" as const,
                  text: `Almost there. ${missingSecrets} required secret${missingSecrets === 1 ? "" : "s"} missing (step 3).`,
              }
            : {
                  tone: "ok" as const,
                  text: "Ready. Kody can boot and run this app.",
              };

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

                {!isGlobal && (
                    <div
                        className={
                            "flex flex-row items-center gap-2.5 rounded-xl border px-4 py-3 text-sm " +
                            (status.tone === "ok"
                                ? "border-success/30 bg-success/5 text-success"
                                : status.tone === "warn"
                                  ? "border-warning/30 bg-warning/5 text-warning"
                                  : "border-card-lv2 text-text-secondary")
                        }>
                        <span className="size-2 rounded-full bg-current" />
                        {status.text}
                    </div>
                )}

                {!isGlobal && (
                    <StepHeader n={1} title="Turn it on" done={enabled} />
                )}
                <div data-field-name="environment.enabled">
                    <EnvironmentEnabled />
                </div>

                <div data-field-name="environment.trigger">
                    <RuntimeTrigger />
                </div>

                {!isGlobal && (
                    <StepHeader
                        n={2}
                        title="Teach Kody how to run this app"
                        done={hasPlaybook}
                    />
                )}
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
                                    prominent={!hasPlaybook}
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

                        <StepHeader
                            n={3}
                            title="Give it the secrets it needs"
                            done={enabled && missingSecrets === 0}
                        />
                        <SecretsVault
                            teamId={teamId}
                            repositoryId={repositoryId}
                            canEdit={canEdit}
                            requiredEnv={
                                (form.watch(
                                    "environment.requiredEnv.value",
                                ) as string[]) ?? []
                            }
                            onMissingCount={setMissingSecrets}
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
