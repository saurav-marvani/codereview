# Product

## Register

product

## Users

Software engineers and engineering leads. Two contexts: (1) configuring Kodus — connecting repos, tuning review rules (Kody Rules), managing org/billing settings; (2) consuming output — triaging review findings, cockpit metrics, PR insights. They live between their IDE, GitHub/GitLab, and Kodus. Mid-workday, task-focused, low tolerance for friction or chrome.

## Product Purpose

Kodus is an AI code review platform (cloud + self-hosted). Kody reviews pull requests automatically; the web app is where teams configure, monitor, and trust that process. Success: an engineer can set up a repo, understand what Kody flagged and why, and tune behavior without reading docs.

## Brand Personality

Precise, technical, reliable. A tool built by engineers for engineers — it earns trust through accuracy and restraint, not charm. Confident, never loud. References: Linear (density, speed, refined dark), Vercel/Stripe (typographic clarity, enterprise trust), Raycast (warm dark, dev-native feel).

## Anti-references

- Generic shadcn/Tailwind SaaS look (gray + medium radius + Inter — the default every AI product ships).
- Corporate dashboard chrome (Jira/Azure DevOps: dense bureaucratic gray-blue).
- Neon/cyberpunk dev-tool aesthetic (terminal green, excessive glow).
- Cute startup styling (pastel, playful illustration, lack of seriousness).

## Design Principles

1. **Information earns the pixels** — density over decoration; every surface answers "what did Kody find and what do I do about it".
2. **Quiet confidence** — color signals state (success/danger/pending), not personality; the accent is spent deliberately.
3. **Code is a first-class citizen** — monospace, diffs, and rule snippets are core content, not embeds; typography treats them accordingly.
4. **Defaults that ship** — components look finished with zero configuration; the design system is the product's opinion, not a toolkit of choices.
5. **Same system everywhere** — cloud and self-hosted share one visual topology; no enterprise-vs-community visual tiers.

## Accessibility & Inclusion

WCAG 2.1 AA. Contrast-checked tokens (especially state colors on dark surfaces). Full keyboard navigation on all interactive components (already Radix-based). Respect `prefers-reduced-motion`. Color never the sole carrier of state (icons/labels accompany).
