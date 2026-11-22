import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { devinQuotaUsageToLimits, readDevinUsageLimits } from "./devinUsageLimits.ts";

const checkedAt = "2026-11-22T10:00:00.000Z";
const environment = { XDG_DATA_HOME: "/data" } as NodeJS.ProcessEnv;
const credentialsFile = [
  'windsurf_api_key = "secret-token"',
  'devin_webapp_host = "app.devin.ai"',
  'devin_api_url = "https://api.devin.ai"',
  'api_server_url = "https://api.devin.ai"',
  "",
].join("\n");

const notFound = (path: string, method = "readFileString") =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    cause: new Error("ENOENT"),
  });

const credentialsFileSystem = (contents: string) =>
  FileSystem.makeNoop({
    readFileString: (path) =>
      path === "/data/devin/credentials.toml"
        ? Effect.succeed(contents)
        : Effect.fail(notFound(path)),
  });

const noHttpClient = HttpClient.make(() => Effect.die("must not probe without credentials"));

describe("devinQuotaUsageToLimits", () => {
  it("maps the daily and weekly quota windows with their resets", () => {
    const limits = devinQuotaUsageToLimits(
      {
        is_quota_plan: true,
        daily_percentage: 12.5,
        weekly_percentage: 40,
        daily_reset_at: "2026-11-23T00:00:00-08:00",
        weekly_reset_at: "2026-11-29T00:00:00-08:00",
        hide_daily_quota: false,
      },
      checkedAt,
    );
    expect(limits.windows).toEqual([
      {
        id: "daily",
        kind: "session",
        label: "Daily",
        usedPercent: 12.5,
        resetsAt: "2026-11-23T08:00:00.000Z",
        windowDurationMins: 1440,
      },
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 40,
        resetsAt: "2026-11-29T08:00:00.000Z",
        windowDurationMins: 10080,
      },
    ]);
  });

  it("omits the daily window when the plan hides it", () => {
    const limits = devinQuotaUsageToLimits(
      {
        is_quota_plan: true,
        daily_percentage: 0,
        weekly_percentage: 14,
        weekly_reset_at: "2026-11-29T00:00:00-08:00",
        hide_daily_quota: true,
      },
      checkedAt,
    );
    expect(limits.windows).toEqual([
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 14,
        resetsAt: "2026-11-29T08:00:00.000Z",
        windowDurationMins: 10080,
      },
    ]);
  });

  it("scales sub-1 fractions to percentages", () => {
    expect(
      devinQuotaUsageToLimits(
        { daily_percentage: 0.14, weekly_percentage: 1 },
        checkedAt,
      ).windows.map((window) => window.usedPercent),
    ).toEqual([14, 100]);
  });

  it("reports non-quota plans as unsupported", () => {
    expect(devinQuotaUsageToLimits({ is_quota_plan: false }, checkedAt).unavailable?.reason).toBe(
      "unsupported",
    );
  });
});

it.layer(NodeServices.layer)("readDevinUsageLimits", (it) => {
  it.effect("is unsupported when the credentials file does not exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dataHome = yield* fs.makeTempDirectoryScoped({ prefix: "devin-usage-" });
      const limits = yield* readDevinUsageLimits({ XDG_DATA_HOME: dataHome }).pipe(
        Effect.provideService(HttpClient.HttpClient, noHttpClient),
      );
      expect(limits.unavailable?.reason).toBe("unsupported");
    }),
  );

  it.effect("is unsupported when credentials are unreadable or hold no key", () =>
    Effect.gen(function* () {
      for (const fs of [
        FileSystem.makeNoop({ readFileString: (path) => Effect.fail(notFound(path)) }),
        credentialsFileSystem('devin_webapp_host = "app.devin.ai"\n'),
        credentialsFileSystem(""),
      ]) {
        const limits = yield* readDevinUsageLimits(environment).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(HttpClient.HttpClient, noHttpClient),
        );
        expect(limits.unavailable?.reason).toBe("unsupported");
      }
    }),
  );

  it.effect("reads quota through the organizations endpoint with the org header", () =>
    Effect.gen(function* () {
      const requests: Array<{
        url: string;
        authorization: string | undefined;
        org: string | undefined;
      }> = [];
      const limits = yield* readDevinUsageLimits(environment).pipe(
        Effect.provideService(FileSystem.FileSystem, credentialsFileSystem(credentialsFile)),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            requests.push({
              url: request.url,
              authorization: request.headers.authorization,
              org: request.headers["x-cog-org-id"],
            });
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                request.url.endsWith("/api/organizations")
                  ? Response.json([{ org_id: "org-79f99644", display_name: "My Team" }])
                  : Response.json({
                      is_quota_plan: true,
                      has_quota_allocation: true,
                      daily_percentage: 0,
                      weekly_percentage: 14,
                      daily_reset_at: "2026-11-23T00:00:00-08:00",
                      weekly_reset_at: "2026-11-29T00:00:00-08:00",
                      overage_balance: -0.112253,
                      hide_daily_quota: true,
                    }),
              ),
            );
          }),
        ),
      );
      expect(requests).toEqual([
        {
          url: "https://app.devin.ai/api/organizations",
          authorization: "Bearer secret-token",
          org: undefined,
        },
        {
          url: "https://app.devin.ai/api/org-79f99644/billing/quota/usage",
          authorization: "Bearer secret-token",
          org: "org-79f99644",
        },
      ]);
      expect(limits.windows).toEqual([
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 14,
          resetsAt: "2026-11-29T08:00:00.000Z",
          windowDurationMins: 10080,
        },
      ]);
      expect(limits.externalUsage).toEqual({
        label: "Manage usage",
        url: "https://app.devin.ai/settings/usage",
      });
    }),
  );

  it.effect("is probeFailed when the quota request is not ok", () =>
    Effect.gen(function* () {
      const limits = yield* readDevinUsageLimits(environment).pipe(
        Effect.provideService(FileSystem.FileSystem, credentialsFileSystem(credentialsFile)),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                request.url.endsWith("/api/organizations")
                  ? Response.json([{ org_id: "org-79f99644" }])
                  : new Response("private response", { status: 401 }),
              ),
            ),
          ),
        ),
      );
      expect(limits.unavailable).toEqual({
        reason: "probeFailed",
        message: "Devin could not read usage limits.",
      });
      expect(limits.windows).toEqual([]);
    }),
  );
});
