import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { createUrl } from "src/core/utils/helpers";

/**
 * Proxy route that forwards client-side fetch calls to the internal
 * billing service. Mirrors /api/proxy/api and /api/proxy/mcp — keeps the
 * internal hostname (WEB_HOSTNAME_BILLING / GLOBAL_BILLING_CONTAINER_NAME)
 * out of the client bundle. Client callers hit /api/proxy/billing/<path>.
 */
async function forward(
    req: NextRequest,
    params: { path: string[] },
): Promise<NextResponse> {
    let hostName = process.env.WEB_HOSTNAME_BILLING;
    if (hostName === "localhost") {
        hostName =
            process.env.GLOBAL_BILLING_CONTAINER_NAME ||
            "kodus-service-billing";
    }
    const port = process.env.WEB_PORT_BILLING;
    const upstreamPath = "/api/billing/" + params.path.join("/");
    const search = req.nextUrl.search;
    const url = createUrl(hostName, port, upstreamPath + search);

    const headers = new Headers(req.headers);
    headers.delete("host");

    const init: RequestInit = {
        method: req.method,
        headers,
    };

    if (req.method !== "GET" && req.method !== "HEAD") {
        init.body = req.body;
        (init as RequestInit & { duplex?: string }).duplex = "half";
    }

    const upstream = await fetch(url, init);

    // undici auto-decompresses gzip/brotli — strip encoding headers
    // before streaming the plaintext body back or the browser will
    // try to decode it a second time and fail with
    // ERR_CONTENT_DECODING_FAILED.
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
