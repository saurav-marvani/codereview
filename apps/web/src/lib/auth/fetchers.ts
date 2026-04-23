import { typedFetch } from "@services/fetch";
import type { AxiosResponse } from "axios";
import { API_ROUTES } from "src/core/config/constants";
import type { TODO } from "src/core/types";
import { apiProxyPath } from "src/core/utils/api-proxy";
import { axiosApi, axiosAuthorized } from "src/core/utils/axios";
import { pathToApiUrl } from "src/core/utils/helpers";
import { isServerSide } from "src/core/utils/server-side";

import { AuthProviders } from "./types";

/**
 * fetchers.ts is imported by both `core/config/auth.ts` (server-only
 * NextAuth config) and by several client components (sign-in forms,
 * forgot-password, SSO callback, etc.). Server callers need the full
 * upstream URL so they can reach the API directly; client callers must
 * go through the same-origin /api/proxy/api/<path> route so the internal
 * hostname never ends up in the browser bundle.
 */
const authUrl = (route: string): string =>
    isServerSide ? pathToApiUrl(route) : apiProxyPath(route);

export const checkForEmailExistence = (email: string): Promise<TODO> => {
    return axiosApi.get(authUrl(API_ROUTES.checkForEmailExistence), {
        params: { email },
    });
};

export const loginEmailPassword = (credentials: {
    email: string;
    password: string;
}): Promise<
    AxiosResponse<{ data: { accessToken: string; refreshToken: string } }>
> => {
    return axiosApi.post(authUrl(API_ROUTES.login), credentials);
};

export const registerUser = (payload: {
    name: string;
    email: string;
    password: string;
    organizationId?: string;
}): Promise<{
    data: {
        statusCode: number;
    };
}> => {
    return axiosApi.post(authUrl(API_ROUTES.register), payload);
};

export const forgotPassword = (payload: {
    email: string;
    callbackUrl: string;
}): Promise<TODO> => {
    return axiosApi.post(authUrl(API_ROUTES.forgotPassword), payload);
};

export const createNewPassword = (payload: {
    email: string;
    password: string;
    callbackUrl: string;
}): Promise<TODO> => {
    return axiosApi.post(authUrl(API_ROUTES.createNewPassword), payload);
};

export const completeUserInvitation = (payload: {
    name: string;
    password: string;
    uuid: string;
}): Promise<TODO> => {
    return axiosApi.post(
        authUrl(API_ROUTES.completeUserInvitation),
        payload,
    );
};

export const logout = (payload: TODO): Promise<TODO> => {
    return axiosApi.post(authUrl(API_ROUTES.logout), payload);
};

export const refreshAccessToken = async (payload: { refreshToken: string }) => {
    const response = await typedFetch<{
        data: {
            accessToken: string;
            refreshToken: string;
        };
    }>(authUrl(API_ROUTES.refreshToken), {
        method: "POST",
        body: JSON.stringify({
            refreshToken: payload.refreshToken,
        }),
    });

    return response.data;
};

export const getInviteData = async (userId: string) => {
    try {
        const { data } = await typedFetch<{
            data: {
                uuid: string;
                email: string;
                organization: { name: string };
            };
        }>(authUrl(API_ROUTES.getInviteData), {
            params: { userId },
        });
        return data;
    } catch (error) {
        if (error instanceof Error) {
            throw new Error(`Failed to fetch invite data: ${error.message}`);
        }

        throw error;
    }
};

export const loginOAuth = (
    name: string,
    email: string,
    refreshToken: string,
    authProvider: AuthProviders,
): Promise<TODO> => {
    return axiosApi.post(authUrl(API_ROUTES.loginOAuth), {
        name,
        email,
        refreshToken,
        authProvider,
    });
};

export const ssoLogin = async (organizationId: string) => {
    window.location.href = authUrl(
        `${API_ROUTES.ssoLogin}/${organizationId}`,
    );
};

export const ssoCheck = async (
    domain: string,
): Promise<{
    active: boolean;
    organizationId: string;
}> => {
    const res = await typedFetch<{
        data: {
            active: boolean;
            organizationId: string;
        };
    }>(authUrl(API_ROUTES.ssoCheck), {
        params: { domain },
    });

    return res.data;
};
export const sendForgotPasswordMail = async (email: string) => {
    return axiosApi.post(authUrl(API_ROUTES.forgotPassword), { email });
};

export const confirmEmail = async (token: string) => {
    return axiosAuthorized.post(authUrl(API_ROUTES.confirmEmail), {
        token,
    });
};

export const resendConfirmEmail = async (email: string) => {
    return axiosAuthorized.post(authUrl(API_ROUTES.resendEmail), {
        email,
    });
};

export const resetPassword = async (newPassword: string, token: string) => {
    return axiosApi.post(authUrl(API_ROUTES.resetPassword), {
        newPassword,
        token,
    });
};

export const getOrganizationsByDomain = async (domain: string) => {
    try {
        const data = await axiosAuthorized.fetcher<
            { uuid: string; name: string; owner?: string }[]
        >(authUrl(API_ROUTES.getOrganizationsByDomain), {
            params: { domain },
        });
        return data.data;
    } catch (error) {
        if (error instanceof Error) {
            throw new Error(
                `Failed to fetch organizations by domain: ${error.message}`,
            );
        }
        throw error;
    }
};
