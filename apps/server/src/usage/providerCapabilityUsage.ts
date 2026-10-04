/** Per-instance quota awareness. Hub snapshots have no instance binding, so
 * driver equality alone must never attribute their accounts to an instance. */
import type {
  OrchestratorMcpProviderUsage,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";

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
  _sources: UsageLimitSourceSnapshots,
): Record<string, OrchestratorMcpProviderUsage> {
  const usage: Record<string, OrchestratorMcpProviderUsage> = {};
  for (const provider of providers) {
    const aggregated = aggregateProviderUsage(
      provider.usageLimits === undefined
        ? []
        : [{ email: provider.auth.email, limits: provider.usageLimits }],
    );
    if (aggregated !== undefined) usage[provider.instanceId] = aggregated;
  }
  return usage;
}
