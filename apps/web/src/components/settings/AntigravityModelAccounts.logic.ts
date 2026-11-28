import type { ProviderInstanceId, ServerProvider, ServerSettings } from "@t3tools/contracts";

export interface AntigravityAccountOption {
  readonly instanceId: ProviderInstanceId;
  readonly label: string;
}

export interface AntigravityModelRoute {
  readonly slug: string;
  readonly name: string;
  /** Null when the model runs on whichever instance the thread picked. */
  readonly instanceId: ProviderInstanceId | null;
}

/** The enabled Antigravity accounts a model can route to, and each model's current route. */
export function antigravityModelAccounts(
  providers: ReadonlyArray<ServerProvider>,
  routes: ServerSettings["antigravityModelAccounts"],
): {
  readonly accounts: ReadonlyArray<AntigravityAccountOption>;
  readonly models: ReadonlyArray<AntigravityModelRoute>;
} {
  const instances = providers.filter(
    (provider) => provider.driver === "antigravity" && provider.enabled,
  );
  // Instance names, not emails: settings keep account emails hidden until revealed.
  const nameOf = (provider: ServerProvider) => provider.displayName?.trim() || provider.instanceId;
  const nameCounts = new Map<string, number>();
  for (const provider of instances) {
    nameCounts.set(nameOf(provider), (nameCounts.get(nameOf(provider)) ?? 0) + 1);
  }
  const accounts = instances.map((provider) => {
    const name = nameOf(provider);
    return {
      instanceId: provider.instanceId,
      label: nameCounts.get(name) === 1 ? name : `${name} (${provider.instanceId})`,
    };
  });
  const modelNames = new Map<string, string>();
  for (const provider of instances) {
    for (const model of provider.models) {
      if (!modelNames.has(model.slug)) modelNames.set(model.slug, model.name);
    }
  }
  // A route whose model no account lists any more stays visible, so it can be cleared.
  for (const slug of Object.keys(routes)) {
    if (!modelNames.has(slug)) modelNames.set(slug, slug);
  }
  const known = new Set(accounts.map((account) => account.instanceId));
  const models = [...modelNames].map(([slug, name]) => {
    const instanceId = Object.hasOwn(routes, slug) ? routes[slug] : undefined;
    return {
      slug,
      name,
      instanceId: instanceId !== undefined && known.has(instanceId) ? instanceId : null,
    };
  });
  return { accounts, models };
}
