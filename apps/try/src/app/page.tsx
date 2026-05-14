"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PrUrlInput } from "@/components/PrUrlInput";
import { FeaturedPrs } from "@/components/FeaturedPrs";
import { MainHeader } from "@/components/MainHeader";
import { SignupBanner } from "@/components/SignupBanner";
import { enqueuePublicReview, type ApiError } from "@/lib/api";
import { getOrCreateFingerprint } from "@/lib/fingerprint";
import { saveSnapshot } from "@/lib/snapshot";
import { useSignupGate } from "@/components/SignupGate";

export default function HomePage() {
    return (
        <Suspense fallback={null}>
            <HomePageContent />
        </Suspense>
    );
}

function HomePageContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const incomingPr = searchParams.get("pr");
    const { open: openSignupGate } = useSignupGate();

    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<ApiError | null>(null);

    const submit = async (prUrl: string) => {
        setError(null);
        setSubmitting(true);
        try {
            const fingerprint = getOrCreateFingerprint();
            const result = await enqueuePublicReview(prUrl, fingerprint);
            saveSnapshot(result.jobId, {
                pr: result.pr,
                diff: result.diff,
            });
            router.push(`/r/${encodeURIComponent(result.jobId)}`);
        } catch (e) {
            const err = e as ApiError;
            // Past the demo cap (too large / private repo) — pop the
            // signup modal immediately so the user lands on a single
            // clear CTA instead of staring at an inline error message.
            if (err.code === "too_large") {
                openSignupGate({
                    title: "This PR is bigger than the free demo",
                    body: err.message,
                });
            } else if (err.code === "requires_auth") {
                openSignupGate({
                    title: "Sign up to review this PR",
                    body: err.message,
                });
            }
            setError(err);
            setSubmitting(false);
        }
    };

    useEffect(() => {
        if (incomingPr && !submitting && !error) {
            submit(incomingPr);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [incomingPr]);

    return (
        <main className="min-h-screen flex flex-col relative">
            <MainHeader />

            <section className="relative flex-1 overflow-hidden">
                <div
                    aria-hidden
                    className="absolute inset-0 hero-grid opacity-90"
                />

                <div className="relative max-w-3xl mx-auto px-6 pt-20 pb-24 sm:pt-28">
                    <Eyebrow />

                    <h1
                        className="fade-up text-[44px] sm:text-[56px] leading-[1.05] tracking-[-0.02em] font-medium mb-5"
                        style={{ animationDelay: "0.05s" }}
                    >
                        Code review on{" "}
                        <span className="relative">
                            <span className="bg-gradient-to-r from-[var(--accent)] to-[var(--accent-hover)] bg-clip-text text-transparent">
                                any GitHub PR.
                            </span>
                            <span
                                aria-hidden
                                className="absolute -inset-x-2 -bottom-1 h-[8px] bg-[var(--accent)]/10 blur-md -z-10"
                            />
                        </span>
                    </h1>

                    <p
                        className="fade-up text-[17px] text-[var(--text-muted)] mb-9 max-w-xl leading-relaxed"
                        style={{ animationDelay: "0.12s" }}
                    >
                        Paste any public PR and Kodus reads the diff, flags
                        real bugs, and writes inline fixes you can copy
                        straight into Cursor or Claude — in seconds. No
                        signup.
                    </p>

                    <div
                        className="fade-up"
                        style={{ animationDelay: "0.2s" }}
                    >
                        <PrUrlInput
                            onSubmit={submit}
                            initialValue={incomingPr ?? ""}
                            disabled={submitting}
                            autoFocus
                        />
                    </div>

                    {!submitting && !error && (
                        <>
                            <p
                                className="fade-up text-[10px] uppercase tracking-[0.18em] text-[var(--text-dim)] mt-10 mb-3"
                                style={{ animationDelay: "0.3s" }}
                            >
                                Try a featured PR
                            </p>
                            <FeaturedPrs onPick={submit} />
                        </>
                    )}

                    {submitting && (
                        <div className="mt-8 inline-flex items-center gap-2.5 text-sm text-[var(--text-muted)]">
                            <span className="relative flex h-2 w-2">
                                <span
                                    className="absolute inline-flex h-full w-full rounded-full bg-[var(--accent)]"
                                    style={{
                                        animation:
                                            "kodus-pulse-ring 1.6s cubic-bezier(0.21,0.6,0.35,1) infinite",
                                    }}
                                />
                                <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--accent)]" />
                            </span>
                            Fetching PR from GitHub…
                        </div>
                    )}

                    {error && <ErrorBlock error={error} />}

                    <ValueProps />
                </div>
            </section>

            <Footer />
        </main>
    );
}

function Eyebrow() {
    return (
        <div
            className="fade-up inline-flex items-center gap-2 px-3 py-1 rounded-full border border-[var(--border-strong)] bg-[var(--bg-2)]/80 backdrop-blur-sm text-[11px] text-[var(--text-muted)] mb-6"
            style={{ boxShadow: "0 0 0 1px rgba(248,183,109,0.05)" }}
        >
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
            <span className="font-mono">
                Open-source · Powered by Gemini 2.5 Flash
            </span>
        </div>
    );
}

function ValueProps() {
    const items = [
        {
            title: "Real bugs, not nitpicks",
            body: "Trained on years of code review feedback. No comments about missing semicolons.",
        },
        {
            title: "Copy-paste to your LLM",
            body: "Every suggestion ships with a one-click prompt for Cursor, Claude Code, or ChatGPT.",
        },
        {
            title: "Open source",
            body: "MIT-licensed. Self-host on your own cluster or stay on the hosted cloud.",
        },
    ];
    return (
        <div
            className="fade-up mt-20 grid grid-cols-1 sm:grid-cols-3 gap-4"
            style={{ animationDelay: "0.45s" }}
        >
            {items.map((item) => (
                <div
                    key={item.title}
                    className="rounded-lg border border-[var(--border)] bg-[var(--bg-2)]/40 px-4 py-4"
                >
                    <p className="text-[13px] font-medium text-[var(--text)] mb-1">
                        {item.title}
                    </p>
                    <p className="text-[13px] text-[var(--text-muted)] leading-relaxed">
                        {item.body}
                    </p>
                </div>
            ))}
        </div>
    );
}

function Footer() {
    return (
        <footer className="border-t border-[var(--border)]/60 px-6 py-5 hairline-top relative z-10">
            <div className="max-w-6xl mx-auto flex items-center justify-between text-xs text-[var(--text-dim)]">
                <p>
                    Built by{" "}
                    <a
                        href="https://kodus.io"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[var(--text-muted)] hover:text-[var(--text)]"
                    >
                        Kodus
                    </a>
                </p>
                <div className="flex items-center gap-4">
                    <a
                        href="https://github.com/kodustech/kodus-ai"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-[var(--text-muted)]"
                    >
                        GitHub
                    </a>
                    <a
                        href="https://kodus.io"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-[var(--text-muted)]"
                    >
                        kodus.io
                    </a>
                </div>
            </div>
        </footer>
    );
}

function ErrorBlock({ error }: { error: ApiError }) {
    const Inner = ({ children }: { children: React.ReactNode }) => (
        <div className="mt-8 space-y-3 fade-up">{children}</div>
    );

    // `too_large` and `requires_auth` already pop the signup modal in
    // submit(). Render a quiet inline trace so the user can re-read the
    // reason after dismissing the modal without re-submitting.
    if (error.code === "too_large" || error.code === "requires_auth") {
        return (
            <Inner>
                <Notice tone="warning">{error.message}</Notice>
            </Inner>
        );
    }

    if (error.code === "rate_limited" || error.statusCode === 429) {
        return (
            <Inner>
                <Notice tone="warning">
                    {error.message ||
                        "You've used your free trial reviews. Sign up to keep going."}
                </Notice>
                <SignupBanner reason="Sign up for unlimited reviews." />
            </Inner>
        );
    }

    return (
        <Inner>
            <Notice tone="error">
                {error.message || "Something went wrong. Please try again."}
            </Notice>
        </Inner>
    );
}

function Notice({
    tone,
    children,
}: {
    tone: "warning" | "error";
    children: React.ReactNode;
}) {
    // The Kodus palette saves --red for hard failures; surface most
    // user-recoverable states with the warmer alert/warning tones so
    // the page doesn't feel alarmist.
    const cls =
        tone === "error"
            ? "border-[var(--orange)]/30 bg-[var(--orange)]/5"
            : "border-[var(--yellow)]/30 bg-[var(--yellow)]/5";
    return (
        <div
            className={`rounded-lg border ${cls} px-4 py-3 text-sm text-[var(--text)]`}
        >
            {children}
        </div>
    );
}
