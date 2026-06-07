import type { QueryClient } from "@tanstack/react-query";
import {
    createRootRouteWithContext,
    createRoute,
    redirect,
} from "@tanstack/react-router";

import { AppShell } from "./shell/app-shell";
import { SettingsLayout } from "./features/settings/settings-layout";
import { CodeReviewGeneralPage } from "./features/settings/code-review-general";

export const rootRoute = createRootRouteWithContext<{
    queryClient: QueryClient;
}>()({
    component: AppShell,
});

const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    beforeLoad: () => {
        throw redirect({
            to: "/settings/code-review/$scope/general",
            params: { scope: "global" },
        });
    },
});

const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: SettingsLayout,
});

const codeReviewGeneralRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: "/code-review/$scope/general",
    component: CodeReviewGeneralPage,
});

export const routeTree = rootRoute.addChildren([
    indexRoute,
    settingsRoute.addChildren([codeReviewGeneralRoute]),
]);
