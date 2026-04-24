import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { auth } from "src/core/config/auth";
import { createUrl } from "src/core/utils/helpers";

/**
 * Proxy route that forwards client-side fetch calls to the internal MCP
 * Manager service.
 *
 * Mirrors /api/proxy/api/[...path] — kept separate because the MCP
 * Manager uses a different upstream host (WEB_HOSTNAME_MCP_MANAGER /
 * WEB_PORT_MCP_MANAGER / GLOBAL_MCP_MANAGER_CONTAINER_NAME) and has its
 * own auth story (server-resolved NextAuth token injected as Bearer).
 */
async function forward(
    req: NextRequest,
    params: { path: string[] },
): Promise<NextResponse> {
    let hostName = process.env.WEB_HOSTNAME_MCP_MANAGER;
    if (hostName === "localhost") {
        hostName =
            process.env.GLOBAL_MCP_MANAGER_CONTAINER_NAME ||
            "kodus-mcp-manager";
    }
    const port = process.env.WEB_PORT_MCP_MANAGER;
    const upstreamPath = "/" + params.path.join("/");
    const search = req.nextUrl.search;
    const url = createUrl(hostName, port, upstreamPath + search, {
        containerName: hostName,
    });

    const session = await auth();
    const token = session?.user?.accessToken;

    const headers = new Headers(req.headers);
    headers.delete("host");
    if (token) headers.set("Authorization", `Bearer ${token}`);

    const init: RequestInit = {
        method: req.method,
        headers,
    };

    if (req.method !== "GET" && req.method !== "HEAD") {
        init.body = req.body;
        (init as RequestInit & { duplex?: string }).duplex = "half";
    }

    const upstream = await fetch(url, init);

    // See /api/proxy/api for the reason: undici auto-decompresses, so
    // we must drop the upstream Content-Encoding / Content-Length /
    // Transfer-Encoding headers or the browser rejects the response.
    const outHeaders = new Headers(upstream.headers);
    outHeaders.delete("content-encoding");
    outHeaders.delete("content-length");
    outHeaders.delete("transfer-encoding");

    return new NextResponse(upstream.body, {
        status: upstream.status,
        headers: outHeaders,
    });
}

export async function GET(
    req: NextRequest,
    ctx: { params: Promise<{ path: string[] }> },
) {
    return forward(req, await ctx.params);
}
export async function POST(
    req: NextRequest,
    ctx: { params: Promise<{ path: string[] }> },
) {
    return forward(req, await ctx.params);
}
export async function PUT(
    req: NextRequest,
    ctx: { params: Promise<{ path: string[] }> },
) {
    return forward(req, await ctx.params);
}
export async function PATCH(
    req: NextRequest,
    ctx: { params: Promise<{ path: string[] }> },
) {
    return forward(req, await ctx.params);
}
export async function DELETE(
    req: NextRequest,
    ctx: { params: Promise<{ path: string[] }> },
) {
    return forward(req, await ctx.params);
}
