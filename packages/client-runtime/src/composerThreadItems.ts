import type {
  EnvironmentId,
  EnvironmentMachineKind,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { foldSearchQuery, rankSearchItems, scoreThreadSearch } from "@t3tools/shared/paletteSearch";

import type { EnvironmentThreadShell } from "./state/models.ts";
import { threadSearchSubject, type ThreadSearchShell } from "./state/threadSearch.ts";

const COMPOSER_THREAD_RESULT_LIMIT = 5;

export type ComposerThreadCandidate = ThreadSearchShell &
  Pick<EnvironmentThreadShell, "archivedAt" | "lineage">;

export interface ComposerThreadItem {
  readonly id: string;
  readonly type: "thread";
  readonly thread: ScopedThreadRef;
  readonly label: string;
  readonly description: string;
}

/**
 * Threads the `@` picker offers next to file paths, from every connected environment; the
 * composer's own environment ranks first because the agent can page its full history. A query
 * is required: bare `@` stays a file picker.
 */
export function matchComposerThreadItems(input: {
  shells: ReadonlyArray<ComposerThreadCandidate>;
  environmentId: EnvironmentId;
  /** The machines the composer's environment links to, by name. */
  linkedEnvironments: ReadonlyMap<EnvironmentId, string>;
  excludeThreadId: ThreadId | null;
  query: string;
  /** Recency is measured against this time. */
  now: number;
}): ComposerThreadItem[] {
  const query = foldSearchQuery(input.query);
  if (query.length === 0) return [];
  const candidates = input.shells.filter(
    (shell) =>
      (shell.environmentId !== input.environmentId || shell.id !== input.excludeThreadId) &&
      shell.archivedAt === null &&
      shell.lineage.relationshipToParent !== "subagent",
  );
  return [
    ...rankSearchItems(candidates, (shell, options) =>
      scoreThreadSearch(query, threadSearchSubject(shell, null), input.now, {
        ...options,
        picks: false,
      }),
    ),
  ]
    .sort(
      (left, right) =>
        Number(right.item.environmentId === input.environmentId) -
        Number(left.item.environmentId === input.environmentId),
    )
    .slice(0, COMPOSER_THREAD_RESULT_LIMIT)
    .map(({ item: shell }) => {
      const machine =
        shell.environmentId === input.environmentId
          ? undefined
          : input.linkedEnvironments.get(shell.environmentId);
      return {
        id: `thread:${shell.environmentId}:${shell.id}`,
        type: "thread",
        thread: { environmentId: shell.environmentId, threadId: shell.id },
        label: shell.title,
        description: machine === undefined ? "Thread" : `Thread on ${machine}`,
      };
    });
}

export interface ComposerEnvironmentCandidate {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly machine: EnvironmentMachineKind;
}

export interface ComposerEnvironmentItem {
  readonly id: string;
  readonly type: "environment";
  readonly environmentId: EnvironmentId;
  readonly machine: EnvironmentMachineKind;
  readonly label: string;
  readonly description: string;
}

/**
 * The user's machines the `@` picker offers, so the agent can link or work there. The
 * composer's own environment is left out. Like threads, they need a query: bare `@` stays a
 * file picker.
 */
export function matchComposerEnvironmentItems(input: {
  environments: ReadonlyArray<ComposerEnvironmentCandidate>;
  environmentId: EnvironmentId;
  query: string;
}): ComposerEnvironmentItem[] {
  const query = input.query.trim().toLowerCase();
  if (query.length === 0) return [];
  return input.environments
    .filter(
      (environment) =>
        environment.environmentId !== input.environmentId &&
        environment.label.toLowerCase().includes(query),
    )
    .map((environment) => ({
      id: `environment:${environment.environmentId}`,
      type: "environment",
      environmentId: environment.environmentId,
      machine: environment.machine,
      label: environment.label,
      description: "Machine",
    }));
}
