/**
 * packages/cli/src/cloud/provider.ts — optional cloud integration seam.
 *
 * ARCHITECTURAL PRINCIPLE (v0.17): Elysium is LOCAL-FIRST. The core
 * execution loop never depends on a cloud service; cloud capabilities
 * (dashboard, remote reporting, cross-device profile, report sharing, AI
 * fallback) are opt-in integrations behind this interface.
 *
 * A provider is constructed lazily and must degrade gracefully: when the
 * cloud tooling (CLI/auth) is missing, `available()` returns false and the
 * harness keeps working offline. Nothing in the import graph of the core
 * loop may import this module.
 */

/** Capabilities a cloud provider may expose. All methods are optional so a
 * provider can implement a subset. */
export interface CloudIntegrationProvider {
  /** Stable provider id (e.g. "puter"). */
  readonly id: string;
  /** Human label shown in /cloud output. */
  readonly label: string;
  /** True when the provider's tooling/auth is usable right now. */
  available(): Promise<boolean> | boolean;

  /** Publishes a run artifact directory to cloud storage. Returns a
   * shareable read URL when the provider supports it, else null. */
  publishReport?(artifactDir: string, files: string[]): Promise<{ url: string | null }>;

  /** Reads the operator's cross-device profile (notes/preferences). */
  loadProfile?(): Promise<Record<string, string> | null>;

  /** Saves the operator's cross-device profile. */
  saveProfile?(data: Record<string, string>): Promise<void>;
}

/** Registry of configured providers (empty by default = fully offline). */
const providers = new Map<string, CloudIntegrationProvider>();

/** Registers a cloud provider (idempotent by id). */
export function registerCloudProvider(p: CloudIntegrationProvider): void {
  providers.set(p.id, p);
}

/** Lists registered providers with their current availability. */
export async function listCloudProviders(): Promise<
  Array<{ id: string; label: string; available: boolean }>
> {
  const out: Array<{ id: string; label: string; available: boolean }> = [];
  for (const p of providers.values()) {
    let ok = false;
    try {
      ok = await p.available();
    } catch {
      ok = false;
    }
    out.push({ id: p.id, label: p.label, available: ok });
  }
  return out;
}

/** Returns a provider by id, or null when not registered/unavailable. */
export async function getCloudProvider(id: string): Promise<CloudIntegrationProvider | null> {
  const p = providers.get(id);
  if (!p) return null;
  try {
    if ((await p.available()) === false) return null;
  } catch {
    return null;
  }
  return p;
}

/** Clears all registered providers (used by tests). */
export function resetCloudProviders(): void {
  providers.clear();
}
