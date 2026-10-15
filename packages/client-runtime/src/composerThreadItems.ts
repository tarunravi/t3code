import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";

const COMPOSER_THREAD_RESULT_LIMIT = 5;

export interface ComposerThreadCandidate {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly title: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

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
  excludeThreadId: ThreadId | null;
  query: string;
}): ComposerThreadItem[] {
  const query = input.query.trim().toLowerCase();
  if (query.length === 0) return [];
  return input.shells
    .filter(
      (shell) =>
        shell.id !== input.excludeThreadId &&
        shell.archivedAt === null &&
        shell.title.toLowerCase().includes(query),
    )
    .sort(
      (left, right) =>
        Number(right.environmentId === input.environmentId) -
          Number(left.environmentId === input.environmentId) ||
        right.updatedAt.localeCompare(left.updatedAt),
    )
    .slice(0, COMPOSER_THREAD_RESULT_LIMIT)
    .map((shell) => ({
      id: `thread:${shell.environmentId}:${shell.id}`,
      type: "thread",
      thread: { environmentId: shell.environmentId, threadId: shell.id },
      label: shell.title,
      description: "Thread",
    }));
}
