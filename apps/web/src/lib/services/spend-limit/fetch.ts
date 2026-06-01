import { authorizedFetch } from "@services/fetch";
import { axiosAuthorized } from "src/core/utils/axios";

import { SPEND_LIMIT_PATHS } from ".";
import { SpendLimitConfigView, UpdateSpendLimitPayload } from "./types";

export const getSpendLimitConfig = async (teamId?: string) => {
    return await authorizedFetch<SpendLimitConfigView>(SPEND_LIMIT_PATHS.GET, {
        params: teamId ? { teamId } : {},
    });
};

export const updateSpendLimit = async (payload: UpdateSpendLimitPayload) => {
    return await axiosAuthorized.post<SpendLimitConfigView>(
        SPEND_LIMIT_PATHS.UPDATE,
        payload,
    );
};
