/**
 * Copy text to the clipboard.
 *
 * `navigator.clipboard` only exists in a *secure context* (HTTPS, or
 * `localhost`). Self-hosted instances are routinely served over plain
 * HTTP on an internal address, where the Clipboard API is absent — so we
 * fall back to the legacy `document.execCommand("copy")` path.
 *
 * @returns `true` when the copy succeeded, `false` otherwise. Callers
 * should surface failure to the user instead of assuming success.
 */
export const ClipboardHelpers = {
    copyTextToClipboard: async (text: string): Promise<boolean> => {
        const clipboard = (globalThis as { navigator?: Navigator }).navigator
            ?.clipboard;

        if (clipboard?.writeText) {
            try {
                await clipboard.writeText(text);
                return true;
            } catch {
                // Permission denied or insecure context — fall through.
            }
        }

        return legacyCopy(text);
    },
};

/**
 * Pre-Clipboard-API copy: drop the text into an off-screen <textarea>,
 * select it, and run `execCommand("copy")`. Works in insecure contexts.
 */
function legacyCopy(text: string): boolean {
    const doc = (globalThis as { document?: Document }).document;
    if (!doc?.body) {
        return false;
    }

    try {
        const textarea = doc.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        // Keep it out of view and avoid scroll/zoom jumps on mobile.
        textarea.style.position = "fixed";
        textarea.style.top = "0";
        textarea.style.left = "0";
        textarea.style.opacity = "0";

        doc.body.appendChild(textarea);
        textarea.select();
        const ok = doc.execCommand("copy");
        doc.body.removeChild(textarea);
        return ok;
    } catch {
        return false;
    }
}
