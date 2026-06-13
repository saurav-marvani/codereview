"use client";

import {
    Accordion,
    AccordionContent,
    AccordionItem,
    AccordionTrigger,
} from "@components/ui/accordion";
import { Card } from "@components/ui/card";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import {
    EnrichedModelUsage,
    ModelPricingInfo,
} from "@services/usage/types";
import { AlertTriangleIcon, InfoIcon } from "lucide-react";

import { M } from "../_lib/constants";

function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toLocaleString();
}

function formatUsd(amount: number): string {
    if (amount >= 1000) {
        const truncated = Math.floor((amount / 1000) * 100) / 100;
        return `$${truncated.toFixed(2)}K`;
    }
    return `$${amount.toFixed(2)}`;
}

/**
 * Strip the provider prefix `google_gemini:` if it leaked through and trim
 * the `:free` / dated suffixes the same way the existing CostCards do.
 */
function displayModelName(model: string): string {
    return model
        .replace(/^[^:/]+[:/]/, "")
        .replace(/-\d{8}$/, "")
        .replace(/:free$/, "");
}

interface PriceCellInput {
    tokens: number;
    cost: number;
}

function PriceCell({ tokens, cost }: PriceCellInput) {
    if (tokens === 0 && cost === 0) {
        return <span className="text-text-tertiary tabular-nums">—</span>;
    }
    return (
        <span className="tabular-nums">
            <span className="text-text-primary">{formatTokens(tokens)}</span>
            <span className="text-text-tertiary"> · {formatUsd(cost)}</span>
        </span>
    );
}

function PricingTooltip({
    info,
    threshold,
}: {
    info: ModelPricingInfo | undefined;
    threshold: number | undefined;
}) {
    if (!info?.pricing) return null;
    const { input, output, cacheRead, cacheWrite } = info.pricing;
    const hasTier =
        input.tier || output.tier || cacheRead.tier || cacheWrite.tier;

    const row = (label: string, rate: { default: number; tier?: { rate: number } }) => (
        <tr>
            <td className="text-text-secondary pr-3">{label}</td>
            <td className="text-text-primary pr-3 text-right tabular-nums">
                ${(rate.default * M).toFixed(4)}
            </td>
            {hasTier && (
                <td className="text-text-primary text-right tabular-nums">
                    {rate.tier ? `$${(rate.tier.rate * M).toFixed(4)}` : "—"}
                </td>
            )}
        </tr>
    );

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    className="text-text-tertiary hover:text-text-primary inline-flex size-4 items-center justify-center">
                    <InfoIcon className="size-3.5" />
                </button>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-sm p-3 text-xs">
                <p className="text-text-primary mb-2 font-medium">
                    Rates per 1M tokens
                </p>
                <table className="w-full text-left">
                    <thead>
                        <tr>
                            <th className="text-text-tertiary pr-3"></th>
                            <th className="text-text-tertiary pr-3 text-right">
                                {hasTier ? `≤ ${formatTokens(threshold ?? 0)}` : "Rate"}
                            </th>
                            {hasTier && (
                                <th className="text-text-tertiary text-right">
                                    {`> ${formatTokens(threshold ?? 0)}`}
                                </th>
                            )}
                        </tr>
                    </thead>
                    <tbody>
                        {row("Input", input)}
                        {row("Output", output)}
                        {row("Cache read", cacheRead)}
                        {cacheWrite.default > 0 && row("Cache write", cacheWrite)}
                    </tbody>
                </table>
                {hasTier && (
                    <p className="text-text-tertiary mt-2 text-pretty">
                        The tier is applied per call — a single request that
                        exceeds {formatTokens(threshold ?? 0)} input tokens is
                        billed at the extended rate.
                    </p>
                )}
            </TooltipContent>
        </Tooltip>
    );
}

function MissingPricingBadge() {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className="bg-warning/15 text-warning inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs">
                    <AlertTriangleIcon className="size-3" />
                    Price unavailable
                </span>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-xs text-xs">
                We couldn't find pricing for this model in the catalog. The
                cost shown is zero and this row is excluded from the totals
                above.
            </TooltipContent>
        </Tooltip>
    );
}

function ModelBlock({
    row,
    pricingInfo,
}: {
    row: EnrichedModelUsage;
    pricingInfo: ModelPricingInfo | undefined;
}) {
    const uncachedInput = Math.max(0, row.input - (row.cacheRead ?? 0));
    const totalUncached =
        (row.byTier?.le.input ?? 0) -
        (row.byTier?.le.cacheRead ?? 0) +
        ((row.byTier?.gt.input ?? 0) - (row.byTier?.gt.cacheRead ?? 0));
    const inputThreshold = pricingInfo?.pricing?.input?.tier?.threshold;
    const isTiered = !!row.byTier && !!row.costByTier;
    const showCacheWrite = (row.cacheWrite ?? 0) > 0;

    const leUncached = isTiered
        ? Math.max(0, row.byTier!.le.input - row.byTier!.le.cacheRead)
        : 0;
    const gtUncached = isTiered
        ? Math.max(0, row.byTier!.gt.input - row.byTier!.gt.cacheRead)
        : 0;

    return (
        <Card className="p-0">
            <AccordionItem value={row.model} className="border-none">
                <AccordionTrigger className="hover:no-underline px-4 py-3">
                    <div className="flex flex-1 items-center justify-between gap-3">
                        <div
                            className="flex items-center gap-2"
                            onClick={(e) => e.stopPropagation()}>
                            <h3 className="text-text-primary font-medium">
                                {displayModelName(row.model)}
                            </h3>
                            <PricingTooltip
                                info={pricingInfo}
                                threshold={inputThreshold}
                            />
                            {row.pricingSource === "missing" && (
                                <MissingPricingBadge />
                            )}
                        </div>
                        <p className="text-text-primary text-lg font-semibold tabular-nums">
                            {formatUsd(row.cost.total)}
                        </p>
                    </div>
                </AccordionTrigger>
                <AccordionContent className="px-4 pt-0 pb-4">
                    <table className="w-full text-sm">
                <thead>
                    <tr className="text-text-tertiary border-card-lv1 border-b">
                        <th className="py-2 text-left font-normal"></th>
                        {isTiered ? (
                            <>
                                <th className="py-2 text-right font-normal">
                                    ≤ {formatTokens(inputThreshold ?? 0)}
                                </th>
                                <th className="py-2 text-right font-normal">
                                    {"> "}
                                    {formatTokens(inputThreshold ?? 0)}
                                </th>
                            </>
                        ) : (
                            <th className="py-2 text-right font-normal">
                                Rate
                            </th>
                        )}
                        <th className="py-2 text-right font-normal">Total</th>
                    </tr>
                </thead>
                <tbody className="divide-card-lv1 divide-y">
                    <tr>
                        <td className="text-text-secondary py-2">
                            Uncached input
                        </td>
                        {isTiered ? (
                            <>
                                <td className="py-2 text-right">
                                    <PriceCell
                                        tokens={leUncached}
                                        cost={row.costByTier!.le.input}
                                    />
                                </td>
                                <td className="py-2 text-right">
                                    <PriceCell
                                        tokens={gtUncached}
                                        cost={row.costByTier!.gt.input}
                                    />
                                </td>
                            </>
                        ) : (
                            <td className="py-2 text-right">
                                <PriceCell
                                    tokens={uncachedInput}
                                    cost={row.cost.input}
                                />
                            </td>
                        )}
                        <td className="py-2 text-right">
                            <PriceCell
                                tokens={isTiered ? totalUncached : uncachedInput}
                                cost={row.cost.input}
                            />
                        </td>
                    </tr>
                    <tr>
                        <td className="text-text-secondary py-2">
                            Cache read
                        </td>
                        {isTiered ? (
                            <>
                                <td className="py-2 text-right">
                                    <PriceCell
                                        tokens={row.byTier!.le.cacheRead}
                                        cost={row.costByTier!.le.cacheRead}
                                    />
                                </td>
                                <td className="py-2 text-right">
                                    <PriceCell
                                        tokens={row.byTier!.gt.cacheRead}
                                        cost={row.costByTier!.gt.cacheRead}
                                    />
                                </td>
                            </>
                        ) : (
                            <td className="py-2 text-right">
                                <PriceCell
                                    tokens={row.cacheRead ?? 0}
                                    cost={row.cost.cacheRead}
                                />
                            </td>
                        )}
                        <td className="py-2 text-right">
                            <PriceCell
                                tokens={row.cacheRead ?? 0}
                                cost={row.cost.cacheRead}
                            />
                        </td>
                    </tr>
                    <tr>
                        <td className="text-text-secondary py-2">Output</td>
                        {isTiered ? (
                            <>
                                <td className="py-2 text-right">
                                    <PriceCell
                                        tokens={row.byTier!.le.output}
                                        cost={row.costByTier!.le.output}
                                    />
                                </td>
                                <td className="py-2 text-right">
                                    <PriceCell
                                        tokens={row.byTier!.gt.output}
                                        cost={row.costByTier!.gt.output}
                                    />
                                </td>
                            </>
                        ) : (
                            <td className="py-2 text-right">
                                <PriceCell
                                    tokens={row.output}
                                    cost={row.cost.output}
                                />
                            </td>
                        )}
                        <td className="py-2 text-right">
                            <PriceCell tokens={row.output} cost={row.cost.output} />
                        </td>
                    </tr>
                    {showCacheWrite && (
                        <tr>
                            <td className="text-text-secondary py-2">
                                Cache write
                            </td>
                            {isTiered ? (
                                <>
                                    <td className="py-2 text-right">
                                        <PriceCell
                                            tokens={row.byTier!.le.cacheWrite}
                                            cost={row.costByTier!.le.cacheWrite}
                                        />
                                    </td>
                                    <td className="py-2 text-right">
                                        <PriceCell
                                            tokens={row.byTier!.gt.cacheWrite}
                                            cost={row.costByTier!.gt.cacheWrite}
                                        />
                                    </td>
                                </>
                            ) : (
                                <td className="py-2 text-right">
                                    <PriceCell
                                        tokens={row.cacheWrite ?? 0}
                                        cost={row.cost.cacheWrite}
                                    />
                                </td>
                            )}
                            <td className="py-2 text-right">
                                <PriceCell
                                    tokens={row.cacheWrite ?? 0}
                                    cost={row.cost.cacheWrite}
                                />
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
                </AccordionContent>
            </AccordionItem>
        </Card>
    );
}

export const ModelBreakdownTable = ({
    rows,
    pricing,
}: {
    rows: EnrichedModelUsage[];
    pricing: Record<string, ModelPricingInfo>;
}) => {
    if (rows.length === 0) return null;
    return (
        <div className="flex flex-col gap-3">
            <h2 className="text-text-secondary text-sm font-medium uppercase tracking-wide">
                Per-model breakdown
            </h2>
            <Accordion type="multiple" className="flex flex-col gap-3">
                {rows.map((row) => (
                    <ModelBlock
                        key={row.model}
                        row={row}
                        pricingInfo={pricing[row.model]}
                    />
                ))}
            </Accordion>
        </div>
    );
};
