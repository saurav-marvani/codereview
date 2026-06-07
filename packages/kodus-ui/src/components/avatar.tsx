import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/cn";

const avatarVariants = cva(
    "relative grid shrink-0 place-items-center rounded-full font-semibold",
    {
        variants: {
            size: {
                sm: "size-6 text-[10px]",
                md: "size-8 text-xs",
                lg: "size-10 text-sm",
            },
            variant: {
                neutral: "bg-surface-3 text-text-1",
                accent: "bg-accent-soft text-accent",
                violet: "bg-violet-soft text-violet",
                muted: "bg-surface-2 text-text-3",
            },
        },
        defaultVariants: { size: "md", variant: "neutral" },
    },
);

export type AvatarProps = React.HTMLAttributes<HTMLSpanElement> &
    VariantProps<typeof avatarVariants> & {
        /** Presence dot. Only where presence matters. */
        online?: boolean;
    };

export function Avatar({
    className,
    size,
    variant,
    online,
    children,
    ...props
}: AvatarProps) {
    return (
        <span
            className={cn(avatarVariants({ size, variant }), className)}
            {...props}>
            {children}
            {online && (
                <span className="absolute -right-px -bottom-px size-[9px] rounded-full border-2 border-background bg-success" />
            )}
        </span>
    );
}

export function AvatarStack({
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            className={cn(
                "flex *:-ml-2 *:border-2 *:border-background *:first:ml-0",
                className,
            )}
            {...props}
        />
    );
}
