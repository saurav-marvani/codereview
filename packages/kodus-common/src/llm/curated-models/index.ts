import catalog from "./curated-models.json";
import type { CuratedModel, CuratedModelsCatalog } from "./curated-models.types";

export * from "./curated-models.types";

const typedCatalog = catalog as CuratedModelsCatalog;

/**
 * The full BYOK curated model catalog. Imported as JSON so it stays a plain
 * value at build time and can be tree-shaken freely.
 */
export { catalog };

/**
 * Returns the model's catalog-defined temperature when the provider only
 * accepts a fixed value (e.g. Moonshot's Kimi K2.* family only allows
 * temperature=1). Returns undefined for models with no such restriction.
 *
 * This is the single source of truth for mandatory model temperatures.
 * Consumers should prefer BYOK/config-provided temperature when available,
 * and fall back to this value only when no explicit temperature was set.
 */
export function getModelRequiredTemperature(
    modelId: string | undefined,
): number | undefined {
    if (!modelId) {
        return undefined;
    }

    const model = typedCatalog.models.find((m: CuratedModel) => m.id === modelId);
    if (!model) {
        return undefined;
    }

    const temperature = model.defaults?.temperature;
    if (temperature === undefined || temperature === null) {
        return undefined;
    }

    // Only treat it as "required" when the catalog explicitly pins a non-zero
    // temperature. Models that accept any temperature are catalogued with 0.
    // This matches the legacy REASONING_TEMP_ONE semantic for reasoning models
    // that reject temperature != 1.
    return temperature === 0 ? undefined : temperature;
}

/**
 * Convenience helper: resolves the effective temperature for a model given an
 * optional explicit temperature (e.g. from BYOK config) and a prompt default.
 */
export function resolveModelTemperature(
    modelId: string | undefined,
    explicitTemperature: number | undefined,
    promptDefault = 0,
): number {
    return (
        explicitTemperature ??
        getModelRequiredTemperature(modelId) ??
        promptDefault
    );
}
