"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { DataTable } from "@components/ui/data-table";

import { setCockpitRepositoryCookie } from "../../_actions/set-cockpit-repository";
import { CockpitNoDataPlaceholder } from "../../_components/no-data-placeholder";
import type { RepositoryHealthRow } from "../../_services/analytics/review/fetch";
import { repositoriesColumns } from "./repositories-columns";

export const RepositoriesHealthTable = ({
    data,
}: {
    data: RepositoryHealthRow[];
}) => {
    const router = useRouter();
    const [, startTransition] = useTransition();

    if (!data.length) return <CockpitNoDataPlaceholder />;

    const focusRepository = (row: RepositoryHealthRow) => {
        startTransition(async () => {
            await setCockpitRepositoryCookie(row.repository);
            router.refresh();
        });
    };

    return (
        <div>
            <DataTable
                columns={repositoriesColumns}
                data={data}
                searchable
                searchPlaceholder="Search repositories…"
                pageSize={10}
                getRowId={(row) => row.repository}
                onRowClick={focusRepository}
            />
            <p className="text-text-tertiary mt-3 text-[11px]">
                Click a row to focus the whole cockpit on that repository.{" "}
                <strong>Weakest category</strong> = lowest implementation rate
                in that repo (min. 5 suggestions) — where to tune config or add
                a Kody Rule.
            </p>
        </div>
    );
};
