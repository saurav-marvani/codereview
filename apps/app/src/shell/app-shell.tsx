import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
    Avatar,
    Badge,
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    IndicatorDot,
    Navbar,
    NavbarActions,
    NavbarBrand,
    NavbarItem,
    NavbarNav,
    Toaster,
    TooltipProvider,
} from "@kodus/ui";
import { Bell, GitPullRequest, SlidersHorizontal } from "lucide-react";

import { useSession } from "@/lib/session";

/**
 * Strangler shell: only migrated verticals render here. Everything else
 * links back to the Next app (full page load) until its vertical moves.
 */
const LEGACY_ROUTES = [
    { label: "Cockpit", href: "/cockpit" },
    { label: "Pull Requests", href: "/pull-requests" },
    { label: "Issues", href: "/issues" },
];

export function AppShell() {
    const { data: session } = useSession();
    const pathname = useRouterState({
        select: (state) => state.location.pathname,
    });

    const initials =
        session?.user?.name
            ?.split(" ")
            .map((part) => part[0])
            .slice(0, 2)
            .join("")
            .toUpperCase() ?? "K";

    return (
        <TooltipProvider delayDuration={200}>
            <div className="flex h-dvh flex-col">
                <Navbar>
                    <NavbarBrand>
                        kodus<span className="text-accent">·</span>
                    </NavbarBrand>
                    <NavbarNav>
                        {LEGACY_ROUTES.map((route) => (
                            <NavbarItem key={route.href} asChild>
                                {/* legacy vertical: hard navigation to the Next app */}
                                <a href={route.href}>
                                    {route.label === "Pull Requests" && (
                                        <GitPullRequest className="size-3.5" />
                                    )}
                                    {route.label}
                                </a>
                            </NavbarItem>
                        ))}
                        <NavbarItem
                            asChild
                            active={pathname.startsWith("/settings")}
                            icon={<SlidersHorizontal className="size-3.5" />}>
                            <Link
                                to="/settings/code-review/$scope/general"
                                params={{ scope: "global" }}>
                                Settings
                            </Link>
                        </NavbarItem>
                    </NavbarNav>
                    <NavbarActions>
                        <Badge variant="violet" dot={false}>
                            UI v2 alpha
                        </Badge>
                        <IndicatorDot show={false}>
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Notifications">
                                <Bell className="size-4" />
                            </Button>
                        </IndicatorDot>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <button
                                    aria-label="User menu"
                                    className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                                    <Avatar variant="accent">{initials}</Avatar>
                                </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuLabel>
                                    {session?.user?.email ?? "Not signed in"}
                                </DropdownMenuLabel>
                                <DropdownMenuItem asChild>
                                    <a href="/settings/git">
                                        Workspace settings
                                    </a>
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem destructive asChild>
                                    <a href="/api/auth/signout">Sign out</a>
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </NavbarActions>
                </Navbar>
                <div className="flex min-h-0 flex-1">
                    <Outlet />
                </div>
                <Toaster />
            </div>
        </TooltipProvider>
    );
}
