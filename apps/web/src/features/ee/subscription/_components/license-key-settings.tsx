"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import { Card } from "@components/ui/card";
import { Input } from "@components/ui/input";
import { useToast } from "@components/ui/toaster/use-toast";
import { Link } from "@components/ui/link";
import { authorizedFetch } from "@services/fetch";
import {
    CheckCircleIcon,
    KeyIcon,
    ServerIcon,
    ShieldCheckIcon,
} from "lucide-react";
import { pathToApiUrl } from "src/core/utils/helpers";
import { useSubscriptionStatus } from "../_hooks/use-subscription-status";

type LicenseActivationResult = {
    valid: boolean;
    subscriptionStatus?: string;
    plan?: string;
    seats?: number;
    features?: string[];
    customer?: string;
    expiresAt?: string;
};

export const LicenseKeySettings = () => {
    const subscription = useSubscriptionStatus();
    const { toast } = useToast();
    const [licenseKey, setLicenseKey] = useState("");
    const [loading, setLoading] = useState(false);
    const [activationResult, setActivationResult] =
        useState<LicenseActivationResult | null>(null);

    const isLicensed = subscription.status === "licensed-self-hosted";

    const handleActivate = async () => {
        if (!licenseKey.trim()) return;

        setLoading(true);
        try {
            const result = await authorizedFetch<LicenseActivationResult>(
                pathToApiUrl("/license/activate"),
                {
                    method: "POST",
                    body: JSON.stringify({ licenseKey: licenseKey.trim() }),
                },
            );

            setActivationResult(result);

            if (result.valid) {
                toast({
                    title: "License activated",
                    description:
                        "Enterprise features are now unlocked. Reload the page to see changes.",
                    variant: "default",
                });
                setLicenseKey("");
            } else {
                toast({
                    title: "Invalid license key",
                    description:
                        "The provided key is invalid or expired. Please check and try again.",
                    variant: "destructive",
                });
            }
        } catch {
            toast({
                title: "Activation failed",
                description:
                    "Could not activate the license key. Please try again.",
                variant: "destructive",
            });
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="mx-auto max-w-2xl space-y-6 py-8">
            <div className="space-y-1">
                <h2 className="text-xl font-semibold">License Management</h2>
                <p className="text-text-secondary text-sm">
                    Manage your self-hosted enterprise license key to unlock
                    additional features.
                </p>
            </div>

            {isLicensed && (
                <Card className="space-y-3 p-5">
                    <div className="flex items-center gap-2">
                        <ShieldCheckIcon className="text-brand-green h-5 w-5" />
                        <h3 className="font-medium">Active License</h3>
                    </div>

                    <div className="text-text-secondary grid grid-cols-2 gap-y-2 text-sm">
                        <span>Plan</span>
                        <span className="font-medium text-white">
                            {subscription.planType}
                        </span>

                        <span>Seats</span>
                        <span className="font-medium text-white">
                            {subscription.numberOfLicenses}
                        </span>
                    </div>
                </Card>
            )}

            {!isLicensed && (
                <Card className="space-y-3 p-5">
                    <div className="flex items-center gap-2">
                        <ServerIcon className="text-text-secondary h-5 w-5" />
                        <h3 className="font-medium">Community Edition</h3>
                    </div>
                    <p className="text-text-secondary text-sm">
                        You're running Kodus in self-hosted mode without a
                        license. Some enterprise features are limited.
                    </p>
                </Card>
            )}

            <Card className="space-y-4 p-5">
                <div className="flex items-center gap-2">
                    <KeyIcon className="text-text-secondary h-5 w-5" />
                    <h3 className="font-medium">
                        {isLicensed
                            ? "Update License Key"
                            : "Activate License Key"}
                    </h3>
                </div>

                <div className="flex gap-2">
                    <Input
                        size="md"
                        type="password"
                        value={licenseKey}
                        placeholder="Paste your license key here"
                        className="flex-1 font-mono"
                        onChange={(e) => setLicenseKey(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") handleActivate();
                        }}
                    />
                    <Button
                        size="md"
                        variant="primary"
                        disabled={!licenseKey.trim() || loading}
                        onClick={handleActivate}>
                        {loading ? "Activating..." : "Activate"}
                    </Button>
                </div>

                {activationResult && activationResult.valid && (
                    <div className="bg-brand-green/10 flex items-start gap-2 rounded-md p-3 text-sm">
                        <CheckCircleIcon className="text-brand-green mt-0.5 h-4 w-4 shrink-0" />
                        <div>
                            <p className="font-medium">
                                License activated successfully
                            </p>
                            <p className="text-text-secondary text-xs">
                                Plan: {activationResult.plan} &middot; Seats:{" "}
                                {activationResult.seats} &middot; Expires:{" "}
                                {activationResult.expiresAt
                                    ? new Date(
                                          activationResult.expiresAt,
                                      ).toLocaleDateString()
                                    : "N/A"}
                            </p>
                        </div>
                    </div>
                )}
            </Card>

            <div className="text-text-secondary text-center text-xs">
                <Link
                    href="https://docs.kodus.io/how_to_use/en/pricing"
                    className="hover:underline">
                    Learn more about Kodus enterprise features
                </Link>
            </div>
        </div>
    );
};
