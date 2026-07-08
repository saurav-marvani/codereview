"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Heading } from "@components/ui/heading";
import { getFormattedCodeReviewParameterNoCache } from "@services/parameters/fetch";
import { ChevronRightIcon } from "lucide-react";

type RepoRuntimeStatus = {
    id: string;
    name: string;
    state: "ready" | "needs-playbook" | "off";
};

const STATE_LABEL: Record<RepoRuntimeStatus["state"], string> = {
    ready: "Ready",
    "needs-playbook": "Needs playbook",
    off: "Off",
};

const STATE_CLASS: Record<RepoRuntimeStatus["state"], string> = {
    ready: "bg-success/10 text-success",
    "needs-playbook": "bg-warning/10 text-warning",
    off: "bg-card-lv2 text-text-secondary",
};

/**
 * Org-level overview: where every repository stands with Kody Runtime.
 * Computed from the code-review config (enabled + playbook present); each row
 * links to that repo's Kody Runtime tab to finish (or change) its setup.
 */
export const ReposRuntimeStatus = ({ teamId }: { teamId: string }) => {
    const [repos, setRepos] = useState<RepoRuntimeStatus[] | null>(null);

    useEffect(() => {
        if (!teamId) return;
        let alive = true;
        (async () => {
            const res = await getFormattedCodeReviewParameterNoCache(
                teamId,
            ).catch(() => null);
            if (!alive) return;
            const list = (res as any)?.configValue?.repositories ?? [];
            setRepos(
                list
                    .filter((r: any) => r?.isSelected)
                    .map((r: any) => {
                        const env = r?.configs?.environment ?? {};
                        const enabled = !!env?.enabled?.value;
                        const hasPlaybook =
                            (env?.services?.value?.length ?? 0) > 0 ||
                            (env?.setup?.value?.length ?? 0) > 0;
                        const state: RepoRuntimeStatus["state"] = !enabled
                            ? "off"
                            : hasPlaybook
                              ? "ready"
                              : "needs-playbook";
                        return { id: r.id, name: r.name, state };
                    }),
            );
        })();
        return () => {
            alive = false;
        };
    }, [teamId]);

    return (
        <div className="border-card-lv2 flex flex-col gap-4 rounded-xl border p-5">
            <div className="flex flex-col gap-1">
                <Heading variant="h3">Repositories</Heading>
                <p className="text-text-secondary text-sm">
                    Where each repository stands. Open one to turn it on, detect
                    its playbook, or add its secrets.
                </p>
            </div>

            {repos === null ? (
                <span className="text-text-secondary text-sm">Loading...</span>
            ) : repos.length === 0 ? (
                <span className="text-text-secondary text-sm">
                    No repositories reviewed by Kody yet. Connect one under Code
                    Review settings first.
                </span>
            ) : (
                <div className="flex flex-col">
                    {repos.map((repo) => (
                        <Link
                            key={repo.id}
                            href={`/settings/code-review/${repo.id}/kody-runtime`}
                            className="border-card-lv2 hover:bg-card-lv1 group flex flex-row items-center gap-3 border-t px-2 py-3 first:border-t-0">
                            <span
                                className={
                                    "rounded-full px-2.5 py-0.5 text-xs font-medium " +
                                    STATE_CLASS[repo.state]
                                }>
                                {STATE_LABEL[repo.state]}
                            </span>
                            <span className="text-text-primary flex-1 truncate text-sm">
                                {repo.name}
                            </span>
                            <ChevronRightIcon
                                size={16}
                                className="text-text-secondary opacity-0 transition group-hover:opacity-100"
                            />
                        </Link>
                    ))}
                </div>
            )}
        </div>
    );
};
