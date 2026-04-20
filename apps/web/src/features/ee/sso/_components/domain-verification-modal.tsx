"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import { toast } from "@components/ui/toaster/use-toast";
import { requestSSODomainVerification } from "@services/ssoConfig/fetch";

interface DomainVerificationModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    domain: string;
}

export const DomainVerificationModal = ({
    open,
    onOpenChange,
    domain,
}: DomainVerificationModalProps) => {
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [contactEmail, setContactEmail] = useState("");

    const handleSubmit = async () => {
        if (!domain) {
            toast({
                title: "Domain required",
                description: "Select a valid domain to verify.",
                variant: "danger",
            });
            return;
        }

        const trimmedContactEmail = contactEmail.trim().toLowerCase();

        if (!trimmedContactEmail) {
            toast({
                title: "Contact email required",
                description:
                    "Provide an email address at this domain to receive the verification link.",
                variant: "danger",
            });
            return;
        }

        setIsSubmitting(true);

        try {
            await requestSSODomainVerification({
                domain,
                contactEmail: trimmedContactEmail,
            });

            toast({
                title: "Verification email sent",
                description: `We sent a verification link to ${trimmedContactEmail}.`,
                variant: "success",
            });
            setContactEmail("");
            onOpenChange(false);
        } catch (error: any) {
            toast({
                title: "Could not send verification email",
                description:
                    error?.response?.data?.message ||
                    "Please check the contact email and try again.",
                variant: "danger",
            });
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Verify Enterprise Domain</DialogTitle>
                    <DialogDescription>
                        Provide an email from <strong>{domain}</strong>. We will
                        send a verification link.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                    <FormControl.Root>
                        <FormControl.Label>
                            Verification email
                        </FormControl.Label>
                        <Input
                            placeholder={
                                domain ? `admin@${domain}` : "admin@company.com"
                            }
                            value={contactEmail}
                            onChange={(e) => setContactEmail(e.target.value)}
                        />
                    </FormControl.Root>

                    <div className="flex justify-end gap-2">
                        <Button
                            type="button"
                            variant="secondary"
                            size="md"
                            onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            variant="primary"
                            size="md"
                            disabled={!domain || isSubmitting}
                            loading={isSubmitting}
                            onClick={handleSubmit}>
                            Send verification email
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
};
