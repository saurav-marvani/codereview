import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { pathToApiUrl } from "src/core/utils/helpers";

/**
 * Proxy route that forwards client-side fetch calls to the internal API.
 *
 * Client components used to call pathToApiUrl("/path") directly, which
 * required WEB_HOSTNAME_API / WEB_PORT_API to be inlined into the client
 * bundle via next.config.js `env:` block. That made it impossible for a
 * single selfhosted image to serve different deployments (each would
 * need its own hostname baked in) and leaked the internal hostname into
 * the browser.
 *
 * Now the browser always fetches `/api/proxy/api/<path>` on the same
 * origin — this handler (running on the Next server, where process.env
 * is live) resolves the real upstream URL and forwards the request.
 */
async function forward(
    req: NextRequest,
    params: { path: string[] },
): Promise<NextResponse> {
    const upstreamPath = "/" + params.path.join("/");
    const search = req.nextUrl.search;
    const url = pathToApiUrl(upstreamPath + search);

    // Strip Host so the upstream sees its own vhost; keep everything
    // else (auth cookies, content-type, X-Forwarded-*).
    const headers = new Headers(req.headers);
    headers.delete("host");

    const init: RequestInit = {
        method: req.method,
        headers,
    };

    if (req.method !== "GET" && req.method !== "HEAD") {
        init.body = req.body;
        // Required by undici (Node fetch) when streaming a request body.
        (init as RequestInit & { duplex?: string }).duplex = "half";
    }

    const upstream = await fetch(url, init);

    // undici transparently decompresses gzip/brotli responses, so
    // upstream.body is already plaintext by the time we stream it back.
    // We must strip the original encoding-related headers or the browser
    // will try to decode the plaintext as gzip and fail with
    // ERR_CONTENT_DECODING_FAILED. Same applies to Transfer-Encoding
    // and Content-Length (which reflects the compressed size).
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
