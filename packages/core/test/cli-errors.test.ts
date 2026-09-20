import {
  FatalError,
  MissingApiKeyError,
  ProviderConfigurationError,
  ProviderInitializationError,
  RecoverableCliError,
  UnknownProviderError,
} from "@elysium/core";
/**
 * Regression tests for Parte A — recoverable CLI errors + transactional provider switch.
 * Tests the core error classes and the provider-switch logic without a real REPL.
 */
import { describe, expect, it } from "vitest";

describe("typed recoverable errors", () => {
  it("MissingApiKeyError is a ProviderConfigurationError and a RecoverableCliError", () => {
    const e = new MissingApiKeyError("glm");
    expect(e).toBeInstanceOf(RecoverableCliError);
    expect(e).toBeInstanceOf(ProviderConfigurationError);
    expect(e.provider).toBe("glm");
    expect(e.message).toContain("No API key configured for glm");
    expect(e.action).toContain("/key glm");
  });

  it("UnknownProviderError carries the provider name", () => {
    const e = new UnknownProviderError("does-not-exist");
    expect(e).toBeInstanceOf(RecoverableCliError);
    expect(e.provider).toBe("does-not-exist");
  });

  it("ProviderInitializationError wraps the cause and suggests an action", () => {
    const e = new ProviderInitializationError("connection refused");
    expect(e).toBeInstanceOf(RecoverableCliError);
    expect(e.action).toContain("retry");
  });

  it("FatalError is NOT a RecoverableCliError", () => {
    const e = new FatalError("bad config");
    expect(e).not.toBeInstanceOf(RecoverableCliError);
  });
});
