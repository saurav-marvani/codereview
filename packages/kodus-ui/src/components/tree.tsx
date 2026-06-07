"use client";

import { createContext, useContext } from "react";
import { Check, ChevronDown, Folder as FolderIcon } from "lucide-react";
import { Collapsible as CollapsiblePrimitive } from "radix-ui";

import { cn } from "../lib/cn";

type TreeContextValue = {
    mode: "single" | "multiple";
    values: string[];
    toggle: (value: string) => void;
};

const TreeContext = createContext<TreeContextValue | null>(null);

function useTree() {
    const context = useContext(TreeContext);
    if (!context) throw new Error("Tree.* must be used inside <TreeRoot>");
    return context;
}

export function TreeRoot({
    mode = "multiple",
    values,
    onValuesChange,
    className,
    children,
    ...props
}: React.HTMLAttributes<HTMLDivElement> & {
    mode?: "single" | "multiple";
    values: string[];
    onValuesChange: (values: string[]) => void;
}) {
    const toggle = (value: string) => {
        if (mode === "single") {
            onValuesChange(values.includes(value) ? [] : [value]);
        } else {
            onValuesChange(
                values.includes(value)
                    ? values.filter((current) => current !== value)
                    : [...values, value],
            );
        }
    };

    return (
        <TreeContext.Provider value={{ mode, values, toggle }}>
            <div
                role="tree"
                className={cn("flex flex-col gap-px text-sm", className)}
                {...props}>
                {children}
            </div>
        </TreeContext.Provider>
    );
}

export function TreeFolder({
    label,
    defaultOpen = true,
    className,
    children,
    ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Root> & {
    label: React.ReactNode;
}) {
    return (
        <CollapsiblePrimitive.Root
            defaultOpen={defaultOpen}
            className={className}
            {...props}>
            <CollapsiblePrimitive.Trigger
                className={cn(
                    "group flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left",
                    "text-[13.5px] font-medium text-text-1",
                    "transition-colors duration-120 ease-out-quart hover:bg-surface-2",
                    "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                )}>
                <ChevronDown className="size-3 text-text-3 transition-transform duration-200 ease-out-quart group-data-[state=closed]:-rotate-90" />
                <FolderIcon className="size-3.5 text-text-3" />
                {label}
            </CollapsiblePrimitive.Trigger>
            <CollapsiblePrimitive.Content className="overflow-hidden data-[state=closed]:animate-[kds-collapse-up_200ms_var(--ease-out-quart)] data-[state=open]:animate-[kds-collapse-down_200ms_var(--ease-out-quart)]">
                <div className="mt-px mb-1 ml-[13px] flex flex-col gap-px border-l border-border pl-[9px]">
                    {children}
                </div>
            </CollapsiblePrimitive.Content>
        </CollapsiblePrimitive.Root>
    );
}

export function TreeItem({
    value,
    icon,
    className,
    children,
    ...props
}: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "value"> & {
    value: string;
    icon?: React.ReactNode;
}) {
    const { mode, values, toggle } = useTree();
    const selected = values.includes(value);

    return (
        <button
            type="button"
            role="treeitem"
            aria-selected={selected}
            onClick={() => toggle(value)}
            className={cn(
                "flex h-[30px] w-full items-center gap-2 rounded-sm px-2 text-left",
                "text-[13px] text-text-2",
                "transition-colors duration-120 ease-out-quart",
                "hover:bg-surface-2 hover:text-text-1",
                "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                selected && "text-text-1",
                className,
            )}
            {...props}>
            <span
                aria-hidden
                className={cn(
                    "grid size-4 shrink-0 place-items-center border-[1.5px]",
                    mode === "multiple" ? "rounded-[4.5px]" : "rounded-full",
                    selected
                        ? "border-accent bg-accent text-on-accent"
                        : "border-border-strong bg-surface-1",
                )}>
                {selected &&
                    (mode === "multiple" ? (
                        <Check className="size-3" strokeWidth={3} />
                    ) : (
                        <span className="size-1.5 rounded-full bg-on-accent" />
                    ))}
            </span>
            {icon}
            <span className="min-w-0 flex-1 truncate">{children}</span>
        </button>
    );
}
