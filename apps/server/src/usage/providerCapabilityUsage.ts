/**
 * ProviderCapabilityUsage — folds the usage snapshots the server already
 * maintains into the awareness block the orchestrator capabilities result
 * exposes per provider instance.
 *
 * Accounts come from two places: a provider instance's own `usageLimits`
 * snapshot and the pooled accounts `UsageLimitSources` reports for the same
 * driver (a hub such as CLIProxyAPI combines several subscription accounts
 * behind one instance). Matching is by driver, the same convention the
 * /usage-limits report uses; an account the instance's own snapshot already
 * covers is not counted twice.
 *
 * @module usage/providerCapabilityUsage
 */
import type {
  OrchestratorMcpProviderUsage,
  ProviderDriverKind,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import { accountKey } from "@t3tools/shared/usageLimits";

export interface ProviderUsageAccount {
  readonly email: string | undefined;
  readonly limits: ServerProviderUsageLimits;
}

function resetMillis(window: ServerProviderUsageWindow): number | null {
  if (window.resetsAt === undefined) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

/**
 * Distinct accounts reporting on one driver. Accounts without a key (no
 * email, no credential fingerprint) cannot be matched against anything and
 * are kept as their own entry.
 */
export function accountsForDriver(
  driver: ProviderDriverKind,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
): ReadonlyArray<ProviderUsageAccount> {
  const accounts = new Map<string, ProviderUsageAccount>();
  const unkeyed: Array<ProviderUsageAccount> = [];
  const add = (email: string | undefined, limits: ServerProviderUsageLimits) => {
    const account = { email, limits };
    const key = accountKey(driver, email, limits);
    if (key === null) {
      unkeyed.push(account);
      return;
    }
    const previous = accounts.get(key);
    if (previous === undefined) {
      accounts.set(key, account);
      return;
    }
    // The hub may hold a fresher read of the same subscription than the
    // instance's own snapshot (or vice versa); the fresher one wins.
    if (Date.parse(limits.checkedAt) > Date.parse(previous.limits.checkedAt)) {
      accounts.set(key, account);
    }
  };
  for (const provider of providers) {
    if (provider.driver !== driver || provider.usageLimits === undefined) continue;
    add(provider.auth.email, provider.usageLimits);
  }
  for (const source of sources) {
    for (const hubAccount of source.accounts) {
      if (hubAccount.driver !== driver) continue;
      add(hubAccount.email, hubAccount.usageLimits);
    }
  }
  return [...accounts.values(), ...unkeyed];
}

/**
 * The one window across every account that will bite first: the fullest one,
 * and among equally full windows the one that resets soonest (a missing
 * reset sorts last — it can at least be waited out by a window that does).
 */
function mostConstrainedWindow(
  accounts: ReadonlyArray<ProviderUsageAccount>,
): { account: ProviderUsageAccount; window: ServerProviderUsageWindow } | null {
  let winner: { account: ProviderUsageAccount; window: ServerProviderUsageWindow } | null = null;
  for (const account of accounts) {
    for (const window of account.limits.windows) {
      if (winner === null) {
        winner = { account, window };
        continue;
      }
      if (window.usedPercent > winner.window.usedPercent) {
        winner = { account, window };
        continue;
      }
      if (window.usedPercent < winner.window.usedPercent) continue;
      const at = resetMillis(window);
      const winnerAt = resetMillis(winner.window);
      if (at !== null && (winnerAt === null || at < winnerAt)) {
        winner = { account, window };
      }
    }
  }
  return winner;
}

/**
 * The awareness block for a set of accounts, or undefined when there are no
 * accounts at all. The most-constrained account's full window list travels
 * with its winning window, so an agent can see the rest of that account's
 * quota without a second call.
 */
export function aggregateProviderUsage(
  accounts: ReadonlyArray<ProviderUsageAccount>,
): OrchestratorMcpProviderUsage | undefined {
  if (accounts.length === 0) return undefined;
  const combined = accounts.length > 1 ? { accountsCombined: accounts.length } : {};
  const reporting = accounts.filter(
    (account) => account.limits.windows.length > 0 && account.limits.unavailable === undefined,
  );
  const winner = mostConstrainedWindow(reporting);
  if (winner !== null) {
    return {
      checkedAt: winner.account.limits.checkedAt,
      mostConstrained: winner.window,
      windows: winner.account.limits.windows,
      ...combined,
    };
  }
  const unavailable = accounts.find((account) => account.limits.unavailable !== undefined);
  return {
    checkedAt: (unavailable ?? accounts[0]!).limits.checkedAt,
    mostConstrained: null,
    windows: [],
    ...combined,
    ...(unavailable?.limits.unavailable === undefined
      ? {}
      : {
          unavailable: {
            reason: unavailable.limits.unavailable.reason,
            ...(unavailable.limits.unavailable.message === undefined
              ? {}
              : { message: unavailable.limits.unavailable.message }),
          },
        }),
  };
}

/**
 * One entry per provider instance that has any usage data, keyed by instance
 * id. Instances the server holds nothing for are omitted, so the block's
 * absence itself is signal.
 */
export function providerCapabilityUsage(
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
): Record<string, OrchestratorMcpProviderUsage> {
  const usage: Record<string, OrchestratorMcpProviderUsage> = {};
  for (const provider of providers) {
    const aggregated = aggregateProviderUsage(
      accountsForDriver(provider.driver, providers, sources),
    );
    if (aggregated !== undefined) usage[provider.instanceId] = aggregated;
  }
  return usage;
}
