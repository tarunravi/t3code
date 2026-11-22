import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";

const DEFAULT_DEVIN_WEBAPP_HOST = "app.devin.ai";

const DevinOrganizationsResponse = Schema.Array(Schema.Struct({ org_id: Schema.String }));

export const DevinQuotaUsageResponse = Schema.Struct({
  is_quota_plan: Schema.optional(Schema.Boolean),
  daily_percentage: Schema.optional(Schema.Number),
  weekly_percentage: Schema.optional(Schema.Number),
  daily_reset_at: Schema.optional(Schema.String),
  weekly_reset_at: Schema.optional(Schema.String),
  hide_daily_quota: Schema.optional(Schema.Boolean),
});

// `devin auth login` stores a flat `key = "value"` file, not nested TOML.
function parseDevinCredentials(contents: string): {
  readonly apiKey: string | undefined;
  readonly webappHost: string | undefined;
} {
  const fields: Record<string, string> = {};
  for (const line of contents.split("\n")) {
    const [, key, value] = /^\s*([A-Za-z0-9_]+)\s*=\s*"([^"]*)"\s*$/.exec(line) ?? [];
    if (key !== undefined) fields[key] = value ?? "";
  }
  return {
    apiKey: fields["windsurf_api_key"]?.trim() || undefined,
    webappHost: fields["devin_webapp_host"]?.trim() || undefined,
  };
}

// Devin reports values <= 1 as a fraction of the window, like CodexBar treats them.
const devinPercent = (value: number) =>
  clampPercent(value <= 1 ? Math.round(value * 10_000) / 100 : value);

function resetIso(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const reset = DateTime.make(value);
  return Option.isSome(reset) ? DateTime.formatIso(reset.value) : undefined;
}

export function devinQuotaUsageToLimits(
  usage: typeof DevinQuotaUsageResponse.Type,
  checkedAt: string,
): ServerProviderUsageLimits {
  const windows: ServerProviderUsageWindow[] = [];
  // Max plans set hide_daily_quota and have no daily window at all.
  if (usage.daily_percentage !== undefined && usage.hide_daily_quota !== true) {
    const resetsAt = resetIso(usage.daily_reset_at);
    windows.push({
      id: "daily",
      kind: "session",
      label: "Daily",
      usedPercent: devinPercent(usage.daily_percentage),
      ...(resetsAt === undefined ? {} : { resetsAt }),
      windowDurationMins: 24 * 60,
    });
  }
  if (usage.weekly_percentage !== undefined) {
    const resetsAt = resetIso(usage.weekly_reset_at);
    windows.push({
      id: "weekly",
      kind: "weekly",
      label: "Weekly",
      usedPercent: devinPercent(usage.weekly_percentage),
      ...(resetsAt === undefined ? {} : { resetsAt }),
      windowDurationMins: 7 * 24 * 60,
    });
  }
  return windows.length > 0
    ? makeUsageLimits({ checkedAt, windows })
    : makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
}

export const readDevinUsageLimits = Effect.fn("readDevinUsageLimits")(function* (
  environment: NodeJS.ProcessEnv = process.env,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  const probeFailed = makeUnavailableUsageLimits({
    checkedAt,
    reason: "probeFailed",
    message: "Devin could not read usage limits.",
  });
  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dataHome =
      environment.XDG_DATA_HOME ||
      path.join(
        environment.HOME || environment.USERPROFILE || (yield* HostProcess.HomeDirectory),
        ".local",
        "share",
      );
    // No credentials file means `devin auth login` never ran on this environment.
    const contents = yield* fs
      .readFileString(path.join(dataHome, "devin", "credentials.toml"))
      .pipe(
        Effect.catchTags({
          PlatformError: () => Effect.succeed(""),
        }),
      );
    const { apiKey, webappHost } = parseDevinCredentials(contents);
    if (apiKey === undefined) return unsupported;
    const host = webappHost ?? DEFAULT_DEVIN_WEBAPP_HOST;
    const bearer = HttpClientRequest.bearerToken(apiKey);
    const client = yield* HttpClient.HttpClient;
    const organizations = yield* client
      .execute(
        HttpClientRequest.get(`https://${host}/api/organizations`).pipe(
          bearer,
          HttpClientRequest.setHeader("Accept", "application/json"),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(DevinOrganizationsResponse)),
      );
    const orgId = organizations[0]?.org_id;
    if (orgId === undefined) return unsupported;
    const usage = yield* client
      .execute(
        HttpClientRequest.get(
          `https://${host}/api/${encodeURIComponent(orgId)}/billing/quota/usage`,
        ).pipe(
          bearer,
          HttpClientRequest.setHeaders({
            Accept: "application/json",
            "x-cog-org-id": orgId,
          }),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(DevinQuotaUsageResponse)),
      );
    return {
      ...devinQuotaUsageToLimits(usage, checkedAt),
      externalUsage: { label: "Manage usage", url: `https://${host}/settings/usage` },
    };
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() => probeFailed),
  );
});
