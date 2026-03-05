const CHARS_PER_TOKEN = 3.5;

/** Estimate token count from text length */
export function estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Convert token count back to approximate char count */
export function tokensToChars(tokens: number): number {
    return Math.floor(tokens * CHARS_PER_TOKEN);
}
