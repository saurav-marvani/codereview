import { Link, Outlet, useParams } from "@tanstack/react-router";
import {
    Page,
    Sidebar,
    SidebarGroup,
    SidebarItem,
    SidebarScope,
} from "@kodus/ui";
import { CreditCard, GitBranch, Puzzle } from "lucide-react";

import { useCodeReviewRepositories } from "./api";

/**
 * The settings scope tree (global → repo → directory), DS-native.
 * Org-level routes still live in the Next app → plain <a>.
 */
const CODE_REVIEW_PAGES = [{ label: "General", slug: "general" }] as const;

const LEGACY_PAGES = [
    "Review Categories",
    "Review Filters",
    "Custom Prompts",
    "PR Summary",
    "Kody Rules",
    "Custom Messages",
];

export function SettingsLayout() {
    const { scope } = useParams({ strict: false });
    const { data: repositories = [] } = useCodeReviewRepositories();

    return (
        <>
            <Sidebar>
                <SidebarGroup label="Organization">
                    <SidebarItem
                        asChild
                        icon={<GitBranch className="size-3.5" />}>
                        <a href="/settings/git">Git Settings</a>
                    </SidebarItem>
                    <SidebarItem
                        asChild
                        icon={<CreditCard className="size-3.5" />}>
                        <a href="/settings/subscription">Subscription</a>
                    </SidebarItem>
                    <SidebarItem
                        asChild
                        icon={<Puzzle className="size-3.5" />}>
                        <a href="/settings/plugins">Plugins</a>
                    </SidebarItem>
                </SidebarGroup>
                <SidebarGroup label="Code review">
                    <SidebarScope label="Global">
                        {CODE_REVIEW_PAGES.map((page) => (
                            <SidebarItem
                                key={page.slug}
                                asChild
                                active={scope === "global"}>
                                <Link
                                    to="/settings/code-review/$scope/general"
                                    params={{ scope: "global" }}>
                                    {page.label}
                                </Link>
                            </SidebarItem>
                        ))}
                        {LEGACY_PAGES.map((label) => (
                            <SidebarItem key={label} asChild>
                                {/* not migrated yet → Next app */}
                                <a
                                    href={`/settings/code-review/global/${label
                                        .toLowerCase()
                                        .replace(/ /g, "-")}`}>
                                    {label}
                                </a>
                            </SidebarItem>
                        ))}
                    </SidebarScope>
                    {repositories.map((repository) => (
                        <SidebarScope
                            key={repository.id}
                            label={repository.name}
                            defaultOpen={scope === repository.id}>
                            <SidebarItem
                                asChild
                                active={scope === repository.id}>
                                <Link
                                    to="/settings/code-review/$scope/general"
                                    params={{ scope: repository.id }}>
                                    General
                                </Link>
                            </SidebarItem>
                        </SidebarScope>
                    ))}
                </SidebarGroup>
            </Sidebar>
            <Page.WithSidebar>
                <Outlet />
            </Page.WithSidebar>
        </>
    );
}
