"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@components/ui/table";

import { setCockpitRepositoryCookie } from "../../_actions/set-cockpit-repository";
import { CockpitNoDataPlaceholder } from "../../_components/no-data-placeholder";
import type { RepositoryHealthRow } from "../../_services/analytics/review/fetch";
import { ImplRateBar } from "./impl-rate-bar";

export const RepositoriesHealthTable = ({
    data,
}: {
    data: RepositoryHealthRow[];
}) => {
    const router = useRouter();
    const [, startTransition] = useTransition();

    if (!data.length) return <CockpitNoDataPlaceholder />;

    const focusRepository = (repository: string) => {
        startTransition(async () => {
            await setCockpitRepositoryCookie(repository);
            router.refresh();
        });
    };

    return (
        <div>
            <Table>
                <TableHeader>
                    <TableRow className="*:text-text-tertiary *:text-[11px] *:font-semibold *:uppercase">
                        <TableHead>Repository</TableHead>
                        <TableHead>PRs reviewed</TableHead>
                        <TableHead>Suggestions</TableHead>
                        <TableHead>Impl. rate</TableHead>
                        <TableHead>👍 / 👎</TableHead>
                        <TableHead>Weakest category</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {data.map((row) => (
                        <TableRow
                            key={row.repository}
                            className="hover:bg-card-lv2 cursor-pointer"
                            onClick={() => focusRepository(row.repository)}>
                            <TableCell className="text-text-primary font-mono text-xs">
                                {row.repository}
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                                {row.prsReviewed}
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                                {row.suggestionsSent}
                            </TableCell>
                            <TableCell>
                                <ImplRateBar rate={row.implementationRate} />
                            </TableCell>
                            <TableCell className="text-xs whitespace-nowrap">
                                <span className="text-success">
                                    ▲ {row.thumbsUp}
                                </span>{" "}
                                <span className="text-danger">
                                    ▼ {row.thumbsDown}
                                </span>
                            </TableCell>
                            <TableCell className="text-text-secondary text-xs">
                                {row.weakestCategory
                                    ? `${row.weakestCategory.category} (${Math.round(row.weakestCategory.rate * 100)}%)`
                                    : "—"}
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
            <p className="text-text-tertiary mt-3 text-[11px]">
                Click a row to focus the whole cockpit on that repository.{" "}
                <strong>Weakest category</strong> = lowest implementation rate
                in that repo (min. 5 suggestions) — where to tune config or add
                a Kody Rule.
            </p>
        </div>
    );
};
