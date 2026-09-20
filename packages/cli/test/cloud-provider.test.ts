/** Cloud integration seam tests: registry lifecycle + puter provider
 * graceful degradation (no CLI installed in CI → unavailable, no throw). */
import { describe, expect, it } from "vitest";
import {
  type CloudIntegrationProvider,
  getCloudProvider,
  listCloudProviders,
  registerCloudProvider,
  resetCloudProviders,
} from "../src/cloud/provider";
import { puterProvider } from "../src/cloud/puter";

describe("cloud provider registry", () => {
  it("starts empty and registers providers idempotently", async () => {
    resetCloudProviders();
    expect(await listCloudProviders()).toEqual([]);
    const fake: CloudIntegrationProvider = {
      id: "fake",
      label: "Fake",
      available: () => true,
    };
    registerCloudProvider(fake);
    registerCloudProvider(fake);
    const list = await listCloudProviders();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("fake");
    expect(list[0]?.available).toBe(true);
    resetCloudProviders();
  });

  it("reports availability false when provider.available throws", async () => {
    resetCloudProviders();
    registerCloudProvider({
      id: "broken",
      label: "Broken",
      available: () => {
        throw new Error("boom");
      },
    });
    const list = await listCloudProviders();
    expect(list[0]?.available).toBe(false);
    expect(await getCloudProvider("broken")).toBeNull();
    resetCloudProviders();
  });

  it("getCloudProvider returns null for unknown ids", async () => {
    resetCloudProviders();
    expect(await getCloudProvider("nope")).toBeNull();
  });
});

describe("puter provider", () => {
  it("is registered with id 'puter' and degrades gracefully", async () => {
    resetCloudProviders();
    registerCloudProvider(puterProvider);
    // In CI/dev without the puter CLI this resolves to null (no throw).
    const p = await getCloudProvider("puter");
    // available() depends on the host: only assert no-throw + type shape.
    if (p !== null) {
      expect(p.id).toBe("puter");
      const res = await p.publishReport?.("/tmp/nonexistent-run", []);
      expect(res?.url === null || typeof res?.url === "string").toBe(true);
    }
    resetCloudProviders();
  });
});
