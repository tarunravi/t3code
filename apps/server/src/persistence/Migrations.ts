/**
 * Migration runner with an inline loader.
 *
 * Uses Migrator.make with fromRecord to define migrations inline.
 * All migrations are statically imported - no dynamic file system loading.
 *
 * `runMigrations` is called by the SQLite persistence layer at startup, so the
 * schema is always up to date before the application starts.
 */

import * as Migrator from "effect/sql/Migrator";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { reconcileV2PreviewMigration } from "./reconcileV2PreviewMigration.ts";

// Import all migrations statically
import Migration0001 from "./Migrations/001_OrchestrationEvents.ts";
import Migration0002 from "./Migrations/002_OrchestrationCommandReceipts.ts";
import Migration0003 from "./Migrations/003_CheckpointDiffBlobs.ts";
import Migration0004 from "./Migrations/004_ProviderSessionRuntime.ts";
import Migration0005 from "./Migrations/005_Projections.ts";
import Migration0006 from "./Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts";
import Migration0007 from "./Migrations/007_ProjectionThreadMessageAttachments.ts";
import Migration0008 from "./Migrations/008_ProjectionThreadActivitySequence.ts";
import Migration0009 from "./Migrations/009_ProviderSessionRuntimeMode.ts";
import Migration0010 from "./Migrations/010_ProjectionThreadsRuntimeMode.ts";
import Migration0011 from "./Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts";
import Migration0012 from "./Migrations/012_ProjectionThreadsInteractionMode.ts";
import Migration0013 from "./Migrations/013_ProjectionThreadProposedPlans.ts";
import Migration0014 from "./Migrations/014_ProjectionThreadProposedPlanImplementation.ts";
import Migration0015 from "./Migrations/015_ProjectionTurnsSourceProposedPlan.ts";
import Migration0016 from "./Migrations/016_CanonicalizeModelSelections.ts";
import Migration0017 from "./Migrations/017_ProjectionThreadsArchivedAt.ts";
import Migration0018 from "./Migrations/018_ProjectionThreadsArchivedAtIndex.ts";
import Migration0019 from "./Migrations/019_ProjectionSnapshotLookupIndexes.ts";
import Migration0020 from "./Migrations/020_AuthAccessManagement.ts";
import Migration0021 from "./Migrations/021_AuthSessionClientMetadata.ts";
import Migration0022 from "./Migrations/022_AuthSessionLastConnectedAt.ts";
import Migration0023 from "./Migrations/023_ProjectionThreadShellSummary.ts";
import Migration0024 from "./Migrations/024_BackfillProjectionThreadShellSummary.ts";
import Migration0025 from "./Migrations/025_CleanupInvalidProjectionPendingApprovals.ts";
import Migration0026 from "./Migrations/026_CanonicalizeModelSelectionOptions.ts";
import Migration0027 from "./Migrations/027_ProviderSessionRuntimeInstanceId.ts";
import Migration0028 from "./Migrations/028_ProjectionThreadSessionInstanceId.ts";
import Migration0029 from "./Migrations/029_ProjectionThreadDetailOrderingIndexes.ts";
import Migration0030 from "./Migrations/030_ProjectionThreadShellArchiveIndexes.ts";
import Migration0031 from "./Migrations/031_AuthAuthorizationScopes.ts";
import Migration0032 from "./Migrations/032_AuthPairingProofKeyThumbprint.ts";
import Migration0033 from "./Migrations/033_ProjectionThreadsSettled.ts";
import Migration0034 from "./Migrations/034_ProjectionThreadsSnoozed.ts";
import Migration0035 from "./Migrations/035_ProjectionThreadTitleRegeneration.ts";
import Migration0036 from "./Migrations/036_ProjectionThreadsPinned.ts";
import Migration0037 from "./Migrations/037_ProjectionTurnsKeysetIndex.ts";
import Migration0038 from "./Migrations/038_ProjectionThreadsPinOrderKey.ts";
import Migration0039 from "./Migrations/039_ProjectionProjectsDefaultThreadEnvMode.ts";
import Migration0040 from "./Migrations/040_ProjectionProjectFaviconPath.ts";
import Migration0041 from "./Migrations/041_AuthSessionClientConnection.ts";
import Migration0042 from "./Migrations/042_ProjectionThreadLinkedPullRequest.ts";
import Migration0043 from "./Migrations/043_ProjectionThreadsUnsettledAt.ts";
import Migration0044 from "./Migrations/044_ClearAutomaticProjectModelDefaults.ts";
import Migration0045 from "./Migrations/045_ProjectionProjectsAutoPull.ts";
import Migration0046 from "./Migrations/046_RepairAutomaticSettlementTimestamps.ts";
import Migration0047 from "./Migrations/047_ProjectionProjectIcon.ts";
import Migration0048 from "./Migrations/048_ProjectionThreadBranchPullRequest.ts";
import Migration0049 from "./Migrations/049_ProjectionThreadsActiveOrderKey.ts";
import Migration0050 from "./Migrations/050_ProjectionThreadPullRequests.ts";
import Migration0051 from "./Migrations/051_ProjectionThreadMessageContext.ts";
import Migration0052 from "./Migrations/052_ProjectionThreadTitleState.ts";
import Migration0053 from "./Migrations/053_PullRequestFilesViewed.ts";
import Migration0054 from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";
import Migration0055 from "./Migrations/055_OrchestrationV2.ts";
import Migration0056 from "./Migrations/056_RemoveRedundantProjectionIndexes.ts";
import Migration0057 from "./Migrations/057_ScheduledTaskWebhooks.ts";
import Migration0058 from "./Migrations/058_WebhookRelayDeliveries.ts";
import Migration0059 from "./Migrations/059_McpAppModelContext.ts";

/**
 * Migration loader with all migrations defined inline.
 *
 * Key format: "{id}_{name}" where:
 * - id: numeric migration ID (determines execution order)
 * - name: descriptive name for the migration
 *
 * Uses Migrator.fromRecord which parses the key format and
 * returns migrations sorted by ID.
 */
export const migrationEntries = [
  [1, "OrchestrationEvents", Migration0001],
  [2, "OrchestrationCommandReceipts", Migration0002],
  [3, "CheckpointDiffBlobs", Migration0003],
  [4, "ProviderSessionRuntime", Migration0004],
  [5, "Projections", Migration0005],
  [6, "ProjectionThreadSessionRuntimeModeColumns", Migration0006],
  [7, "ProjectionThreadMessageAttachments", Migration0007],
  [8, "ProjectionThreadActivitySequence", Migration0008],
  [9, "ProviderSessionRuntimeMode", Migration0009],
  [10, "ProjectionThreadsRuntimeMode", Migration0010],
  [11, "OrchestrationThreadCreatedRuntimeMode", Migration0011],
  [12, "ProjectionThreadsInteractionMode", Migration0012],
  [13, "ProjectionThreadProposedPlans", Migration0013],
  [14, "ProjectionThreadProposedPlanImplementation", Migration0014],
  [15, "ProjectionTurnsSourceProposedPlan", Migration0015],
  [16, "CanonicalizeModelSelections", Migration0016],
  [17, "ProjectionThreadsArchivedAt", Migration0017],
  [18, "ProjectionThreadsArchivedAtIndex", Migration0018],
  [19, "ProjectionSnapshotLookupIndexes", Migration0019],
  [20, "AuthAccessManagement", Migration0020],
  [21, "AuthSessionClientMetadata", Migration0021],
  [22, "AuthSessionLastConnectedAt", Migration0022],
  [23, "ProjectionThreadShellSummary", Migration0023],
  [24, "BackfillProjectionThreadShellSummary", Migration0024],
  [25, "CleanupInvalidProjectionPendingApprovals", Migration0025],
  [26, "CanonicalizeModelSelectionOptions", Migration0026],
  [27, "ProviderSessionRuntimeInstanceId", Migration0027],
  [28, "ProjectionThreadSessionInstanceId", Migration0028],
  [29, "ProjectionThreadDetailOrderingIndexes", Migration0029],
  [30, "ProjectionThreadShellArchiveIndexes", Migration0030],
  [31, "AuthAuthorizationScopes", Migration0031],
  [32, "AuthPairingProofKeyThumbprint", Migration0032],
  [33, "ProjectionThreadsSettled", Migration0033],
  [34, "ProjectionThreadsSnoozed", Migration0034],
  [35, "ProjectionThreadTitleRegeneration", Migration0035],
  [36, "ProjectionThreadsPinned", Migration0036],
  [37, "ProjectionTurnsKeysetIndex", Migration0037],
  [38, "ProjectionThreadsPinOrderKey", Migration0038],
  [39, "ProjectionProjectsDefaultThreadEnvMode", Migration0039],
  [40, "ProjectionProjectFaviconPath", Migration0040],
  [41, "AuthSessionClientConnection", Migration0041],
  [42, "ProjectionThreadLinkedPullRequest", Migration0042],
  [43, "ProjectionThreadsUnsettledAt", Migration0043],
  [44, "ClearAutomaticProjectModelDefaults", Migration0044],
  [45, "ProjectionProjectsAutoPull", Migration0045],
  [46, "RepairAutomaticSettlementTimestamps", Migration0046],
  [47, "ProjectionProjectIcon", Migration0047],
  [48, "ProjectionThreadBranchPullRequest", Migration0048],
  [49, "ProjectionThreadsActiveOrderKey", Migration0049],
  [50, "ProjectionThreadPullRequests", Migration0050],
  [51, "ProjectionThreadMessageContext", Migration0051],
  [52, "ProjectionThreadTitleState", Migration0052],
  [53, "PullRequestFilesViewed", Migration0053],
  [54, "ProjectionThreadsAutoSettleDisabledAt", Migration0054],
  // Released as 53 and 54 in V2 previews; reconcileV2PreviewMigration preserves their ledger.
  // Preserve this migration's schema. Future V2 schema changes need new migrations.
  [55, "OrchestrationV2", Migration0055],
  [56, "RemoveRedundantProjectionIndexes", Migration0056],
  [57, "ScheduledTaskWebhooks", Migration0057],
  [58, "WebhookRelayDeliveries", Migration0058],
  [59, "McpAppModelContext", Migration0059],
] as const;

// Safe to replay over the recognized legacy schema: every change is guarded by a
// schema check, IF NOT EXISTS, or IF EXISTS, and none backfills rows.
const replayableMigrationIds: ReadonlySet<number> = new Set([33, 51, 53, 54, 56, 57, 58, 59]);

export const migrationManifest = migrationEntries.map(([id, name]) => [id, name] as const);

// September 8 split V2 migrations are equivalent to today's bundled 055.
// Keep their original ids/names: rewriting them would erase peer history.
const legacyV2Names = new Map<number, string>([
  [33, "ProjectionThreadsRunningBackgroundTaskCount"],
  [50, "OrchestrationV2"],
  [51, "OrchestrationV2Subagents"],
  [52, "OrchestrationV2Foundation"],
  [53, "OrchestrationV2ProviderSessionBindings"],
  [54, "OrchestrationV2ThreadLaunchWorkflows"],
  [55, "ApplicationEventSource"],
  [56, "OrchestrationV2EffectCancellation"],
  [57, "ScheduledTasks"],
  [58, "LegacyV1ImportState"],
  [59, "ApplicationEventSequenceIndexes"],
  [60, "OrchestrationV2RecoveryIndexes"],
  [61, "OrchestrationV2ShellIndexes"],
]);

// Frozen schema contract for skipped 050/052/055. Generated from their static DDL
// plus 055 composed steps; tested against fresh migration output. Never replay
// these migrations to fill gaps: their backfills/table rebuilds are not idempotent.
const legacySkippedColumns: Readonly<Record<string, string>> = {
  orchestration_command_receipts: "command_type",
  orchestration_events: "application_event_version",
  orchestration_v2_command_receipts:
    "command_id thread_id command_type accepted_at result_sequence status error",
  orchestration_v2_effect_outbox:
    "effect_id command_id thread_id effect_type payload_json status attempt_count available_at lease_owner lease_expires_at created_at updated_at completed_at last_error",
  orchestration_v2_events:
    "sequence event_id command_id thread_id run_id node_id provider raw_event_id event_type occurred_at payload_json driver provider_instance_id",
  orchestration_v2_legacy_imports:
    "thread_id source_updated_at shell_imported_at transcript_imported_at imported_message_count last_error",
  orchestration_v2_projection_checkpoint_scopes:
    "scope_id thread_id run_id node_id parent_scope_id provider_thread_id kind ordinal_within_parent advances_app_run_count created_at payload_json",
  orchestration_v2_projection_checkpoints:
    "checkpoint_id thread_id scope_id run_id node_id parent_checkpoint_id ordinal_within_scope app_run_ordinal status captured_at payload_json",
  orchestration_v2_projection_context_handoffs:
    "context_handoff_id thread_id target_run_id to_provider_thread_id strategy status updated_at payload_json",
  orchestration_v2_projection_context_transfers:
    "context_transfer_id source_thread_id target_thread_id target_run_id type status source_provider target_provider updated_at payload_json source_provider_instance_id target_provider_instance_id",
  orchestration_v2_projection_messages:
    "message_id thread_id run_id node_id role streaming created_at updated_at payload_json",
  orchestration_v2_projection_metadata: "projection_name schema_version last_sequence updated_at",
  orchestration_v2_projection_nodes:
    "node_id thread_id run_id parent_node_id root_node_id kind status provider_thread_id provider_turn_id runtime_request_id checkpoint_scope_id started_at completed_at payload_json",
  orchestration_v2_projection_plans: "plan_id thread_id run_id node_id kind status payload_json",
  orchestration_v2_projection_provider_session_bindings: "provider_session_id thread_id",
  orchestration_v2_projection_provider_sessions:
    "provider_session_id thread_id provider status model updated_at payload_json driver provider_instance_id",
  orchestration_v2_projection_provider_threads:
    "provider_thread_id thread_id owner_node_id provider provider_session_id status first_run_ordinal last_run_ordinal updated_at payload_json driver provider_instance_id",
  orchestration_v2_projection_provider_turns:
    "provider_turn_id thread_id provider_thread_id node_id run_attempt_id ordinal status started_at completed_at payload_json",
  orchestration_v2_projection_run_attempts:
    "attempt_id thread_id run_id attempt_ordinal root_node_id provider provider_thread_id provider_turn_id status payload_json provider_instance_id",
  orchestration_v2_projection_runs:
    "run_id thread_id ordinal provider provider_thread_id status requested_at completed_at payload_json provider_instance_id",
  orchestration_v2_projection_runtime_requests:
    "runtime_request_id thread_id node_id provider_turn_id kind status created_at resolved_at payload_json",
  orchestration_v2_projection_subagents:
    "subagent_id thread_id run_id parent_node_id provider provider_thread_id child_thread_id origin status started_at completed_at updated_at payload_json driver provider_instance_id",
  orchestration_v2_projection_threads:
    "thread_id project_id title default_provider runtime_mode interaction_mode active_provider_thread_id created_at updated_at archived_at deleted_at payload_json provider_instance_id",
  orchestration_v2_projection_turn_items:
    "turn_item_id thread_id run_id node_id provider_thread_id provider_turn_id parent_item_id ordinal type status updated_at payload_json",
  orchestration_v2_thread_launch_workflows:
    "command_id thread_id project_id status title worktree_path branch setup_committed thread_committed message_committed last_error created_at updated_at",
  orchestration_v2_turn_item_positions: "thread_id turn_item_id ordinal",
  projection_thread_pull_requests:
    "thread_id host repository number url source linked_at snapshot_json stack_json",
  scheduled_tasks:
    "task_id title prompt enabled schedule_json project_id thread_id workspace_strategy_json model_selection_json runtime_mode interaction_mode created_by creation_source created_at updated_at next_run_at last_run_at last_run_status last_run_error run_count",
  projection_threads: "title_state_json",
};
const legacySkippedIndexes = [
  "idx_orchestration_events_agent_stream_sequence",
  "idx_orchestration_events_application_high_water",
  "idx_orchestration_events_application_sequence",
  "idx_projection_thread_pull_requests_pr",
  "idx_scheduled_tasks_due",
  "idx_scheduled_tasks_project",
  "orchestration_events_v2_created_threads_idx",
  "orchestration_v2_command_receipts_thread_sequence_idx",
  "orchestration_v2_effect_outbox_claim_idx",
  "orchestration_v2_effect_outbox_command_idx",
  "orchestration_v2_effect_outbox_thread_status_idx",
  "orchestration_v2_events_command_idx",
  "orchestration_v2_events_instance_sequence_idx",
  "orchestration_v2_events_node_sequence_idx",
  "orchestration_v2_events_raw_event_idx",
  "orchestration_v2_events_run_sequence_idx",
  "orchestration_v2_events_thread_sequence_idx",
  "orchestration_v2_events_thread_type_sequence_idx",
  "orchestration_v2_legacy_imports_pending_transcript_idx",
  "orchestration_v2_projection_checkpoint_scopes_parent_idx",
  "orchestration_v2_projection_checkpoint_scopes_thread_idx",
  "orchestration_v2_projection_checkpoints_parent_idx",
  "orchestration_v2_projection_checkpoints_scope_ordinal_idx",
  "orchestration_v2_projection_checkpoints_thread_idx",
  "orchestration_v2_projection_context_handoffs_target_run_idx",
  "orchestration_v2_projection_context_handoffs_thread_idx",
  "orchestration_v2_projection_context_transfers_source_thread_idx",
  "orchestration_v2_projection_context_transfers_target_run_idx",
  "orchestration_v2_projection_context_transfers_target_thread_idx",
  "orchestration_v2_projection_messages_latest_user_idx",
  "orchestration_v2_projection_messages_node_idx",
  "orchestration_v2_projection_messages_run_idx",
  "orchestration_v2_projection_messages_thread_created_idx",
  "orchestration_v2_projection_nodes_parent_idx",
  "orchestration_v2_projection_nodes_provider_turn_idx",
  "orchestration_v2_projection_nodes_thread_run_idx",
  "orchestration_v2_projection_plans_run_idx",
  "orchestration_v2_projection_plans_thread_idx",
  "orchestration_v2_projection_provider_session_bindings_thread_idx",
  "orchestration_v2_projection_provider_sessions_instance_status_idx",
  "orchestration_v2_projection_provider_sessions_provider_status_idx",
  "orchestration_v2_projection_provider_sessions_thread_idx",
  "orchestration_v2_projection_provider_threads_instance_status_idx",
  "orchestration_v2_projection_provider_threads_owner_idx",
  "orchestration_v2_projection_provider_threads_session_idx",
  "orchestration_v2_projection_provider_threads_thread_idx",
  "orchestration_v2_projection_provider_turns_thread_idx",
  "orchestration_v2_projection_provider_turns_thread_ordinal_idx",
  "orchestration_v2_projection_requests_recovery_idx",
  "orchestration_v2_projection_run_attempts_run_ordinal_idx",
  "orchestration_v2_projection_run_attempts_thread_idx",
  "orchestration_v2_projection_runs_provider_thread_idx",
  "orchestration_v2_projection_runs_recovery_idx",
  "orchestration_v2_projection_runs_thread_ordinal_idx",
  "orchestration_v2_projection_runs_thread_status_idx",
  "orchestration_v2_projection_runtime_requests_provider_turn_idx",
  "orchestration_v2_projection_runtime_requests_thread_status_idx",
  "orchestration_v2_projection_subagents_child_thread_idx",
  "orchestration_v2_projection_subagents_parent_node_idx",
  "orchestration_v2_projection_subagents_provider_thread_idx",
  "orchestration_v2_projection_subagents_thread_idx",
  "orchestration_v2_projection_threads_project_updated_idx",
  "orchestration_v2_projection_turn_items_node_ordinal_idx",
  "orchestration_v2_projection_turn_items_provider_turn_idx",
  "orchestration_v2_projection_turn_items_recovery_idx",
  "orchestration_v2_projection_turn_items_run_ordinal_idx",
  "orchestration_v2_projection_turn_items_shell_pending_idx",
  "orchestration_v2_projection_turn_items_thread_ordinal_idx",
  "orchestration_v2_projection_turn_items_thread_run_idx",
];

/** Only published histories may bypass name equality; unknown histories stop before writes. */
export const verifyMigrationHistory = Effect.fn("verifyMigrationHistory")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables =
    yield* sql`SELECT name FROM sqlite_master WHERE name = 'effect_sql_migrations' AND type = 'table'`;
  if (tables.length === 0) return;
  const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  const expected = new Map<number, string>(migrationManifest);
  const legacySlot33 = history.some(
    (row) => row.migration_id === 33 && row.name === legacyV2Names.get(33),
  );
  if (legacySlot33) expected.set(33, "ProjectionThreadsRunningBackgroundTaskCount");
  const legacy = history.some(
    (row) => row.migration_id >= 50 && legacyV2Names.get(row.migration_id) === row.name,
  );
  if (legacy) {
    for (const [id, name] of legacyV2Names) expected.set(id, name);
  } else {
    // The September 15–16 previews are reconciled transactionally below.
    const preview = history.find(
      (row) =>
        (row.migration_id === 53 || row.migration_id === 54) && row.name === "OrchestrationV2",
    );
    if (preview) {
      expected.set(preview.migration_id, "OrchestrationV2");
      expected.set(55, "RemoveRedundantProjectionIndexes");
      for (const row of history) {
        if (
          row.migration_id > preview.migration_id &&
          !(preview.migration_id === 54 && row.migration_id === 55)
        ) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: "Unexpected migration after V2 preview",
          });
        }
      }
    }
  }
  const invalid = history.find(
    (row, index) => row.migration_id !== index + 1 || expected.get(row.migration_id) !== row.name,
  );
  if (invalid || (legacy && history.length !== 61)) {
    return yield* new Migrator.MigrationError({
      kind: "BadState",
      message: invalid
        ? `Unrecognized migration history at ${invalid.migration_id}:${invalid.name}`
        : "Incomplete September 8 V2 migration history; expected all 61 entries",
    });
  }
  if (legacy) {
    for (const [table, required] of Object.entries(legacySkippedColumns)) {
      const columns = yield* sql.unsafe<{ readonly name: string }>(`PRAGMA table_info("${table}")`);
      const missing = required
        .split(" ")
        .find((name) => !columns.some((column) => column.name === name));
      if (missing) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: `Incomplete legacy schema: missing ${table}.${missing}; unsafe migration replay refused`,
        });
      }
    }
    const indexes = yield* sql<{
      readonly name: string;
    }>`SELECT name FROM sqlite_master WHERE type = 'index'`;
    const missingIndex = legacySkippedIndexes.find(
      (name) => !indexes.some((index) => index.name === name),
    );
    if (missingIndex) {
      return yield* new Migrator.MigrationError({
        kind: "BadState",
        message: `Incomplete legacy schema: missing index ${missingIndex}; unsafe migration replay refused`,
      });
    }
  }
});

const makeMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      migrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

/**
 * Migrator run function - no schema dumping needed
 * Uses the base Migrator.make without platform dependencies
 */
const run = Migrator.make({});

export interface RunMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

/**
 * Run all pending migrations.
 *
 * Creates the migrations tracking table (effect_sql_migrations) if it doesn't exist,
 * then runs any migrations with ID greater than the latest recorded migration.
 *
 * Returns array of [id, name] tuples for migrations that were run.
 *
 * @returns Effect containing array of executed migrations
 */
export const runMigrations = Effect.fn("runMigrations")(function* ({
  toMigrationInclusive,
}: RunMigrationsOptions = {}) {
  yield* verifyMigrationHistory();
  const previewMigrations =
    toMigrationInclusive === undefined || toMigrationInclusive >= 55
      ? yield* reconcileV2PreviewMigration()
      : [];
  const executedMigrations = [
    ...previewMigrations,
    ...(yield* run({ loader: makeMigrationLoader(toMigrationInclusive) })),
  ];
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Database schema is current")
    : Effect.log("Migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));

  // The migrator keys on migration_id: a database that recorded a different
  // migration under a shared id (local or fork builds) keeps that id and
  // silently skips this build's migration at it. Surface the divergence so the
  // skipped schema change is diagnosable.
  const sql = yield* SqlClient.SqlClient;
  const recorded = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations`;
  const manifestEntries = new Map<
    number,
    readonly [number, string, Effect.Effect<void, unknown, SqlClient.SqlClient>]
  >(migrationEntries.map((entry) => [entry[0], entry]));
  const divergent = recorded.flatMap((row) => {
    const expected = manifestEntries.get(row.migration_id)?.[1];
    if (expected === undefined) {
      return [`${row.migration_id}:${row.name} (unknown to this build)`];
    }
    return expected === row.name
      ? []
      : [`${row.migration_id}:${row.name} (this build: ${expected})`];
  });
  if (divergent.length > 0) {
    yield* Effect.logWarning(
      "Recognized legacy migration history; preserving recorded ids and replaying only guarded schema changes.",
    ).pipe(Effect.annotateLogs({ divergent }));
  }

  // Replay skipped migrations that check the schema before changing it. The
  // ledger stays untouched, so they replay on every start until it matches.
  const replayable = recorded.flatMap((row) => {
    const entry = manifestEntries.get(row.migration_id);
    return entry !== undefined &&
      entry[1] !== row.name &&
      replayableMigrationIds.has(entry[0]) &&
      (toMigrationInclusive === undefined || entry[0] <= toMigrationInclusive)
      ? [entry]
      : [];
  });
  if (replayable.length > 0) {
    yield* sql.withTransaction(
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      Effect.forEach(replayable, ([id, name, migration]) =>
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off
        migration.pipe(
          Effect.mapError(
            (cause) =>
              new Migrator.MigrationError({
                kind: "Failed",
                message: `Replaying migration ${id}_${name} failed`,
                cause,
              }),
          ),
        ),
      ),
    );
    yield* Effect.log("Replayed idempotent migrations skipped by divergent history").pipe(
      Effect.annotateLogs({ migrations: replayable.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  return executedMigrations;
});
