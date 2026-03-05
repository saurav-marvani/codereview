import { z } from "zod";

const baseFields = {
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1),
    baseURL: z.url().nullable().optional(),
    temperature: z.number().min(0).max(2).nullable().optional(),
    maxInputTokens: z.number().int().min(0).nullable().optional(),
    maxConcurrentRequests: z.number().int().min(0).nullable().optional(),
    maxOutputTokens: z.number().int().min(0).nullable().optional(),
};

export const createKeySchema = z.object({
    ...baseFields,
    apiKey: z.string().trim().min(1),
});

export const editKeySchema = z.object({
    ...baseFields,
    apiKey: z.string().trim().optional().default(""),
});

export type EditKeyForm = z.infer<typeof editKeySchema>;
