"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useDebounce } from "@hooks/use-debounce";

export const useTokenUsageFilters = (models: string[]) => {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const currentFilter = searchParams.get("filter") ?? "daily";

    // Seed from `?models=` (comma-separated) so a deep-link — e.g. the BYOK
    // per-model cost chip — lands scoped to that model. Only ids that actually
    // exist in the current aggregation are honored; anything else falls back to
    // "all models". Mirrors how `prNumber`/`developer` seed from the URL below.
    const [selectedModels, setSelectedModels] = useState<string[]>(() => {
        const fromUrl = searchParams.get("models");
        if (!fromUrl) return models;
        const requested = fromUrl
            .split(",")
            .map((m) => m.trim())
            .filter(Boolean);
        const valid = requested.filter((m) => models.includes(m));
        return valid.length > 0 ? valid : models;
    });

    // Keep selection in sync when the upstream `models` list changes —
    // switching filter (daily/by-pr/by-developer) yields a different
    // aggregation and can swap which models exist. Without this the dropdown
    // claims "N selected" against models that aren't in the list anymore.
    const modelsKey = models.join("|");
    useEffect(() => {
        setSelectedModels((prev) => {
            const stillPresent = prev.filter((m) => models.includes(m));
            return stillPresent.length === 0 ? models : stillPresent;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [modelsKey]);

    const [prNumber, setPrNumber] = useState(
        searchParams.get("prNumber") ?? "",
    );
    const debouncedPrNumber = useDebounce(prNumber, 500);

    const [developer, setDeveloper] = useState(
        searchParams.get("developer") ?? "",
    );
    const debouncedDeveloper = useDebounce(developer, 500);

    const handleFilterChange = (value: string) => {
        const params = new URLSearchParams(searchParams.toString());
        params.set("filter", value);
        if (value !== "by-pr") {
            params.delete("prNumber");
        }
        if (value !== "by-developer") {
            params.delete("developer");
        }
        router.replace(`${pathname}?${params.toString()}`);
    };

    const handleModelChange = (model: string) => {
        const updatedModels = selectedModels.includes(model)
            ? selectedModels.filter((m) => m !== model)
            : [...selectedModels, model];

        setSelectedModels(updatedModels);
    };

    useEffect(() => {
        const params = new URLSearchParams(searchParams.toString());

        if (debouncedPrNumber) {
            params.set("prNumber", debouncedPrNumber);
        } else {
            params.delete("prNumber");
        }

        router.replace(`${pathname}?${params.toString()}`);
    }, [debouncedPrNumber, router, pathname, searchParams]);

    useEffect(() => {
        const params = new URLSearchParams(searchParams.toString());

        if (debouncedDeveloper) {
            params.set("developer", debouncedDeveloper);
        } else {
            params.delete("developer");
        }

        router.replace(`${pathname}?${params.toString()}`);
    }, [debouncedDeveloper, router, pathname, searchParams]);

    // Mirror the model selection back into `?models=` so the scope survives
    // reload/share and matches what a deep-link would produce. Written only for
    // a proper subset; cleared for all/none (both mean "All models", see
    // getModelSelectionText). Keyed on the selection so URL churn doesn't loop.
    const selectedModelsKey = selectedModels.join(",");
    useEffect(() => {
        const params = new URLSearchParams(searchParams.toString());
        const isSubset =
            selectedModels.length > 0 &&
            selectedModels.length < models.length;
        if (isSubset) {
            params.set("models", selectedModelsKey);
        } else {
            params.delete("models");
        }
        router.replace(`${pathname}?${params.toString()}`);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedModelsKey, models.length]);

    const handlePrNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPrNumber(e.target.value);
    };

    const handleDeveloperChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setDeveloper(e.target.value);
    };

    const getModelSelectionText = () => {
        if (
            selectedModels.length === models.length ||
            selectedModels.length === 0
        ) {
            return "All models";
        }
        if (selectedModels.length === 1) {
            return selectedModels[0];
        }
        return `${selectedModels.length} models selected`;
    };

    return {
        currentFilter,
        selectedModels,
        prNumber,
        developer,
        handleFilterChange,
        handleModelChange,
        handlePrNumberChange,
        handleDeveloperChange,
        getModelSelectionText,
        setSelectedModels,
    };
};
