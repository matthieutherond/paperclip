import { describe, it, expect } from "vitest";
import { buildProxyEnv, type CredentialProxyConfig } from "../infra.js";

describe("buildProxyEnv", () => {
  it("emits GITHUB_TOKEN for static token config", () => {
    const config: CredentialProxyConfig = {
      authMode: "api-key",
      apiKey: "sk-test",
      githubToken: "ghp_static123",
    };
    const env = buildProxyEnv(config);
    expect(env.GITHUB_TOKEN).toBe("ghp_static123");
    expect(env.GITHUB_APP_ID).toBeUndefined();
    expect(env.GITHUB_APP_INSTALLATION_ID).toBeUndefined();
    expect(env.GITHUB_APP_KEY_PATH).toBeUndefined();
  });

  it("emits App credentials for GitHub App config", () => {
    const config: CredentialProxyConfig = {
      authMode: "api-key",
      apiKey: "sk-test",
      githubApp: {
        appId: "12345",
        installationId: "67890",
        privateKeyPath: "/path/to/key.pem",
      },
    };
    const env = buildProxyEnv(config);
    expect(env.GITHUB_APP_ID).toBe("12345");
    expect(env.GITHUB_APP_INSTALLATION_ID).toBe("67890");
    expect(env.GITHUB_APP_KEY_PATH).toBe("/path/to/key.pem");
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("prefers GitHub App over static token when both present", () => {
    const config: CredentialProxyConfig = {
      authMode: "oauth",
      oauthToken: "oauth-tok",
      githubToken: "ghp_static",
      githubApp: {
        appId: "111",
        installationId: "222",
        privateKeyPath: "/key.pem",
      },
    };
    const env = buildProxyEnv(config);
    expect(env.GITHUB_APP_ID).toBe("111");
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("emits no GitHub vars when neither token nor app configured", () => {
    const config: CredentialProxyConfig = {
      authMode: "api-key",
      apiKey: "sk-test",
    };
    const env = buildProxyEnv(config);
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GITHUB_APP_ID).toBeUndefined();
  });

  it("includes protected branches when configured", () => {
    const config: CredentialProxyConfig = {
      authMode: "api-key",
      apiKey: "sk-test",
      protectedBranches: ["main", "release"],
    };
    const env = buildProxyEnv(config);
    expect(env.PROTECTED_BRANCHES).toBe("main,release");
  });
});
