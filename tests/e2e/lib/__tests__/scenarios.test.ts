import { strict as assert } from "node:assert";
import { test } from "node:test";
import { allScenarios, resolveScenarios } from "../../scenarios/index.js";

test("allScenarios: includes the 8 release-gate scenarios", () => {
    const ids = Object.keys(allScenarios).sort();
    assert.deepEqual(ids, [
        "code-review-basic",
        "kody-rules-create-and-apply",
        "license-attribution",
        "onboarding-webhook-registration",
        "per-seat-license-toggle",
        "sso-cookie-domain",
        "sso-multi-user",
        "upgrade-n-1-to-n",
    ]);
});

test("sso-multi-user: single-cell self-hosted × github × license-paid", () => {
    const s = allScenarios["sso-multi-user"];
    assert.deepEqual(s.appliesTo.target, ["self-hosted"]);
    assert.deepEqual(s.appliesTo.provider, ["github"]);
    assert.deepEqual(s.appliesTo.license, ["license-paid"]);
});

test("sso-cookie-domain: single-cell self-hosted × github × license-paid", () => {
    const s = allScenarios["sso-cookie-domain"];
    assert.deepEqual(s.appliesTo.target, ["self-hosted"]);
    assert.deepEqual(s.appliesTo.provider, ["github"]);
    assert.deepEqual(s.appliesTo.license, ["license-paid"]);
});

test("per-seat-license-toggle: self-hosted × all 4 providers × license-paid", () => {
    const s = allScenarios["per-seat-license-toggle"];
    assert.deepEqual(s.appliesTo.target, ["self-hosted"]);
    assert.deepEqual(s.appliesTo.provider, [
        "github",
        "gitlab",
        "bitbucket",
        "azure-devops",
    ]);
    assert.deepEqual(s.appliesTo.license, ["license-paid"]);
});

test("resolveScenarios: returns scenarios in given order", () => {
    const resolved = resolveScenarios([
        "code-review-basic",
        "license-attribution",
    ]);
    assert.equal(resolved.length, 2);
    assert.equal(resolved[0].id, "code-review-basic");
    assert.equal(resolved[1].id, "license-attribution");
});

test("resolveScenarios: throws on unknown id with helpful message", () => {
    assert.throws(
        () => resolveScenarios(["does-not-exist"]),
        /Unknown scenario: does-not-exist/,
    );
});

test("each scenario has required fields", () => {
    for (const s of Object.values(allScenarios)) {
        assert.ok(s.id, `scenario missing id`);
        assert.ok(s.title, `scenario ${s.id} missing title`);
        assert.ok(["P0", "P1", "P2"].includes(s.priority), `scenario ${s.id} invalid priority`);
        assert.ok(s.appliesTo, `scenario ${s.id} missing appliesTo`);
        assert.equal(typeof s.run, "function", `scenario ${s.id} missing run`);
    }
});

test("code-review-basic applies to paid/trial/license-paid but not free/license-free", () => {
    const s = allScenarios["code-review-basic"];
    assert.ok(s.appliesTo.license);
    assert.ok(s.appliesTo.license.includes("paid"));
    assert.ok(s.appliesTo.license.includes("trial"));
    assert.ok(s.appliesTo.license.includes("license-paid"));
    assert.ok(!s.appliesTo.license.includes("free"));
    assert.ok(!s.appliesTo.license.includes("license-free"));
});

test("license-attribution applies to every known license mode", () => {
    const s = allScenarios["license-attribution"];
    assert.ok(s.appliesTo.license);
    for (const m of [
        "free",
        "trial",
        "paid",
        "community-byok",
        "license-paid",
        "license-free",
    ] as const) {
        assert.ok(s.appliesTo.license.includes(m), `missing license: ${m}`);
    }
});

test("upgrade-n-1-to-n only applies to self-hosted", () => {
    const s = allScenarios["upgrade-n-1-to-n"];
    assert.deepEqual(s.appliesTo.target, ["self-hosted"]);
});

test("onboarding-webhook-registration applies to all 4 providers", () => {
    const s = allScenarios["onboarding-webhook-registration"];
    assert.ok(s.appliesTo.provider);
    for (const p of [
        "github",
        "gitlab",
        "bitbucket",
        "azure-devops",
    ] as const) {
        assert.ok(
            s.appliesTo.provider.includes(p),
            `webhook scenario missing provider: ${p}`,
        );
    }
});
