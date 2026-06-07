"use client";

import { useState } from "react";
import { X } from "lucide-react";

import { cn } from "../lib/cn";

export type TagInputProps = {
    tags: string[];
    onTagsChange: (tags: string[]) => void;
    placeholder?: string;
    disabled?: boolean;
    id?: string;
    /** Characters that commit the current text as a tag (besides Enter). */
    delimiters?: string[];
    className?: string;
};

/** Input that turns Enter/comma into removable tags: approved domains, labels. */
export function TagInput({
    tags,
    onTagsChange,
    placeholder,
    disabled,
    id,
    delimiters = [","],
    className,
}: TagInputProps) {
    const [draft, setDraft] = useState("");

    const commit = () => {
        const value = draft.trim().replace(/,+$/, "");
        if (value && !tags.includes(value)) onTagsChange([...tags, value]);
        setDraft("");
    };

    return (
        <div
            data-disabled={disabled ? "" : undefined}
            className={cn(
                "flex min-h-[38px] flex-wrap items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2 py-1.5",
                "transition-[border-color,box-shadow] duration-150 ease-out-quart",
                "hover:border-border-strong",
                "focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--color-ring)]",
                "data-disabled:pointer-events-none data-disabled:opacity-45",
                className,
            )}>
            {tags.map((tag) => (
                <span
                    key={tag}
                    className="inline-flex h-6 items-center gap-1 rounded-full bg-surface-2 pr-1.5 pl-2.5 text-xs font-medium text-text-1">
                    {tag}
                    <button
                        type="button"
                        aria-label={`Remove ${tag}`}
                        disabled={disabled}
                        onClick={() =>
                            onTagsChange(
                                tags.filter((current) => current !== tag),
                            )
                        }
                        className="grid place-items-center rounded-full text-text-3 hover:text-text-1">
                        <X className="size-3" />
                    </button>
                </span>
            ))}
            <input
                id={id}
                value={draft}
                disabled={disabled}
                placeholder={tags.length === 0 ? placeholder : undefined}
                onChange={(event) => {
                    const next = event.target.value;
                    if (delimiters.some((d) => next.endsWith(d))) {
                        setDraft(next.slice(0, -1));
                        queueMicrotask(commit);
                    } else {
                        setDraft(next);
                    }
                }}
                onKeyDown={(event) => {
                    if (event.key === "Enter") {
                        event.preventDefault();
                        commit();
                    } else if (
                        event.key === "Backspace" &&
                        draft === "" &&
                        tags.length > 0
                    ) {
                        onTagsChange(tags.slice(0, -1));
                    }
                }}
                onBlur={commit}
                className="min-w-[120px] flex-1 bg-transparent px-1 text-sm text-text-1 outline-none placeholder:text-text-3"
            />
        </div>
    );
}
