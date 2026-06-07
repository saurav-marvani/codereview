import { useParams } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import {
    Breadcrumb,
    BreadcrumbCurrent,
    BreadcrumbLink,
    BreadcrumbSeparator,
    Button,
    Form,
    FormControl,
    FormField,
    FormItem,
    LoadingState,
    Page,
    PageHeader,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Setting,
    SettingsGroup,
    Switch,
    toast,
} from "@kodus/ui";

import {
    toGeneralSettings,
    useCodeReviewConfig,
    useSaveGeneralSettings,
    type GeneralSettings,
} from "./api";

export function CodeReviewGeneralPage() {
    const { scope } = useParams({ strict: false });
    const scopeId = scope ?? "global";
    const { config, isLoading } = useCodeReviewConfig(scopeId);
    const save = useSaveGeneralSettings(scopeId);
    const settings = toGeneralSettings(config);

    const form = useForm<GeneralSettings>({
        defaultValues: {
            automatedReviewActive: false,
            reviewCadenceType: "automatic",
            runOnDraft: false,
            pullRequestApprovalActive: false,
            isRequestChangesActive: false,
        },
        values: settings,
    });

    if (isLoading || !settings) return <LoadingState />;

    const scopeLabel = scopeId === "global" ? "Global" : scopeId;

    return (
        <Page.Root>
            <Page.Header>
                <Breadcrumb>
                    <BreadcrumbLink href="/settings">Settings</BreadcrumbLink>
                    <BreadcrumbSeparator />
                    <BreadcrumbCurrent>{scopeLabel}</BreadcrumbCurrent>
                </Breadcrumb>
                <PageHeader
                    title="General settings"
                    description={
                        scopeId === "global"
                            ? "Defaults for every repository. Repos can override."
                            : `Overrides for ${scopeLabel}.`
                    }
                    actions={
                        <Button
                            loading={save.isPending}
                            onClick={form.handleSubmit((data) =>
                                save.mutate(data, {
                                    onSuccess: () =>
                                        toast({
                                            title: "Settings saved",
                                            variant: "success",
                                        }),
                                }),
                            )}>
                            Save settings
                        </Button>
                    }
                />
            </Page.Header>
            <Page.Content>
                <Form {...form}>
                    <SettingsGroup
                        title="Automated review"
                        description="How and when Kody reviews pull requests">
                        <FormField
                            control={form.control}
                            name="automatedReviewActive"
                            render={({ field }) => (
                                <Setting
                                    title="Automated code review"
                                    description="Kody reviews every new pull request automatically, posting inline suggestions."
                                    control={
                                        <FormControl>
                                            <Switch
                                                checked={field.value}
                                                onCheckedChange={
                                                    field.onChange
                                                }
                                            />
                                        </FormControl>
                                    }
                                />
                            )}
                        />
                        <FormField
                            control={form.control}
                            name="reviewCadenceType"
                            render={({ field }) => (
                                <Setting
                                    title="Review cadence"
                                    description="How Kody runs follow-up reviews after the first one."
                                    control={
                                        <Select
                                            value={field.value}
                                            onValueChange={field.onChange}>
                                            <FormControl>
                                                <SelectTrigger className="w-[200px]">
                                                    <SelectValue />
                                                </SelectTrigger>
                                            </FormControl>
                                            <SelectContent>
                                                <SelectItem value="automatic">
                                                    Automatic
                                                </SelectItem>
                                                <SelectItem value="auto_pause">
                                                    Auto pause
                                                </SelectItem>
                                                <SelectItem value="manual">
                                                    Manual
                                                </SelectItem>
                                            </SelectContent>
                                        </Select>
                                    }
                                />
                            )}
                        />
                        <FormField
                            control={form.control}
                            name="runOnDraft"
                            render={({ field }) => (
                                <Setting
                                    title="Run on draft pull requests"
                                    description="Review drafts before the PR is marked ready."
                                    control={
                                        <FormControl>
                                            <Switch
                                                checked={field.value}
                                                onCheckedChange={
                                                    field.onChange
                                                }
                                            />
                                        </FormControl>
                                    }
                                />
                            )}
                        />
                    </SettingsGroup>
                    <SettingsGroup
                        title="Review outcome"
                        description="What Kody does after finishing a review">
                        <FormField
                            control={form.control}
                            name="pullRequestApprovalActive"
                            render={({ field }) => (
                                <Setting
                                    title="Approve when no issues found"
                                    description="Kody approves the pull request automatically after a clean review."
                                    control={
                                        <FormControl>
                                            <Switch
                                                checked={field.value}
                                                onCheckedChange={
                                                    field.onChange
                                                }
                                            />
                                        </FormControl>
                                    }
                                />
                            )}
                        />
                        <FormField
                            control={form.control}
                            name="isRequestChangesActive"
                            render={({ field }) => (
                                <Setting
                                    title="Request changes on critical issues"
                                    description={`Sets the review status to "Request Changes" when critical findings exist.`}
                                    note="Not applicable to GitLab."
                                    control={
                                        <FormControl>
                                            <Switch
                                                checked={field.value}
                                                onCheckedChange={
                                                    field.onChange
                                                }
                                            />
                                        </FormControl>
                                    }
                                />
                            )}
                        />
                    </SettingsGroup>
                </Form>
            </Page.Content>
        </Page.Root>
    );
}
