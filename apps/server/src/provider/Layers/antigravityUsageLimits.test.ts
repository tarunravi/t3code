import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  antigravityQuotaSummaryToLimits,
  makeAntigravityUsageLimitsReader,
} from "./antigravityUsageLimits.ts";

const checkedAt = "2026-10-03T12:00:00.000Z";

/** The live `retrieveUserQuotaSummary` shape: one 5-hour and one weekly bucket per group. */
const liveSummary = {
  description:
    "Within each group, models share a weekly limit and a 5-hour limit. Quota is consumed proportionally to the cost of the tokens.",
  groups: [
    {
      displayName: "Gemini Models",
      description: "Models within this group: Gemini Flash, Gemini Pro",
      buckets: [
        {
          bucketId: "gemini-weekly",
          displayName: "Weekly Limit Remaining",
          window: "weekly",
          resetTime: "2026-10-07T18:54:30Z",
          description: "You have used some of your weekly limit, it will fully refresh in 3 days.",
          remainingFraction: 0.75,
        },
        {
          bucketId: "gemini-5h",
          displayName: "Five Hour Limit Remaining",
          window: "5h",
          resetTime: "2026-10-04T02:58:19Z",
          remainingFraction: 0.5,
        },
      ],
    },
    {
      displayName: "Claude and GPT models",
      description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
      buckets: [
        { bucketId: "3p-weekly", displayName: "Weekly Limit Remaining", window: "weekly", remainingFraction: 1 },
        { bucketId: "3p-5h", displayName: "Five Hour Limit Remaining", window: "5h", remainingFraction: 1 },
      ],
    },
  ],
};

describe("antigravityQuotaSummaryToLimits", () => {
  it("maps every group's buckets with window kind, math, and reset time", () => {
    expect(antigravityQuotaSummaryToLimits(liveSummary, checkedAt)).toEqual({
      checkedAt,
      windows: [
        {
          id: "3p-5h",
          kind: "session",
          label: "Claude/GPT 5-hour",
          usedPercent: 0,
          windowDurationMins: 300,
        },
        {
          id: "gemini-5h",
          kind: "session",
          label: "Gemini 5-hour",
          usedPercent: 50,
          windowDurationMins: 300,
          resetsAt: "2026-10-04T02:58:19.000Z",
        },
        {
          id: "3p-weekly",
          kind: "weekly",
          label: "Claude/GPT Weekly",
          usedPercent: 0,
          windowDurationMins: 10080,
        },
        {
          id: "gemini-weekly",
          kind: "weekly",
          label: "Gemini Weekly",
          usedPercent: 25,
          windowDurationMins: 10080,
          resetsAt: "2026-10-07T18:54:30.000Z",
        },
      ],
    });
  });

  it("classifies from bucketId and displayName when the window field is absent", () => {
    expect(
      antigravityQuotaSummaryToLimits(
        {
          groups: [
            {
              buckets: [
                // Underscores normalize to hyphens, so the -5h suffix counts.
                { bucketId: "gemini_5h", remainingFraction: 1 },
                // A trailing " limit" is dropped before alias matching.
                { bucketId: "five hour limit", remainingFraction: 1 },
                // No cadence keyword: kept as an untimed row.
                { bucketId: "video-gen", displayName: "Video", remainingFraction: 0.25 },
              ],
            },
          ],
        },
        checkedAt,
      ).windows,
    ).toEqual([
      {
        id: "five hour limit",
        kind: "session",
        label: "Quota 5-hour",
        usedPercent: 0,
        windowDurationMins: 300,
      },
      {
        id: "gemini_5h",
        kind: "session",
        label: "Quota 5-hour",
        usedPercent: 0,
        windowDurationMins: 300,
      },
      { id: "video-gen", kind: "other", label: "Quota Video", usedPercent: 75 },
    ]);
  });

  it("clamps the fraction math on both ends", () => {
    expect(
      antigravityQuotaSummaryToLimits(
        {
          groups: [
            {
              buckets: [
                { bucketId: "a", window: "5h", remainingFraction: 0 },
                { bucketId: "b", window: "5h", remainingFraction: 1.5 },
                { bucketId: "c", window: "5h", remainingFraction: -0.25 },
              ],
            },
          ],
        },
        checkedAt,
      ).windows.map((window) => window.usedPercent),
    ).toEqual([100, 0, 100]);
  });

  it("skips buckets it cannot score and reports unsupported when none remain", () => {
    const summary = {
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            { bucketId: "gemini-5h", window: "5h" },
            { bucketId: "gemini-weekly", window: "weekly" },
            { bucketId: "gemini-disabled", window: "5h", remainingFraction: 0.5, disabled: true },
            { window: "5h", remainingFraction: 0.5 },
          ],
        },
      ],
    };
    expect(antigravityQuotaSummaryToLimits(summary, checkedAt)).toEqual({
      checkedAt,
      windows: [],
      unavailable: { reason: "unsupported" },
    });
  });

  it("reports a probe failure when the payload does not decode", () => {
    expect(antigravityQuotaSummaryToLimits("nope", checkedAt)).toEqual({
      checkedAt,
      windows: [],
      unavailable: { reason: "probeFailed" },
    });
    expect(antigravityQuotaSummaryToLimits(undefined, checkedAt).unavailable?.reason).toBe(
      "probeFailed",
    );
  });
});

const withNodeServices = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) => effect.pipe(Effect.provide(NodeServices.layer));

const tokenFile = JSON.stringify({
  client_id: "client-id",
  client_secret: "client-secret",
  refresh_token: "refresh-token",
  token_uri: "https://accounts.google.com/o/oauth2/token",
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  project_id: "1234567890123456",
});

describe("makeAntigravityUsageLimitsReader", () => {
  it.effect("refreshes the grant once, then probes Cloud Code with the hub identity", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profile = yield* fs.makeTempDirectoryScoped();
      const tokenPath = path.join(profile, "antigravity-acp", "acp_token.json");
      yield* fs.makeDirectory(path.dirname(tokenPath), { recursive: true });
      yield* fs.writeFileString(tokenPath, tokenFile);

      let tokenRequests = 0;
      const client = HttpClient.make((request) => {
        const url = request.url;
        if (url === "https://accounts.google.com/o/oauth2/token") {
          tokenRequests += 1;
          expect(request.method).toBe("POST");
          return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ access_token: "at-1", expires_in: 3600 })));
        }
        expect(request.headers["user-agent"]).toBe("antigravity/hub/2.9.1 darwin/arm64");
        expect(request.headers.authorization).toBe("Bearer at-1");
        if (url === "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist") {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ cloudaicompanionProject: "aicode-consumers" }),
            ),
          );
        }
        if (url === "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary") {
          return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(liveSummary)));
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })),
        );
      });

      const read = makeAntigravityUsageLimitsReader({ tokenPath }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      const first = yield* read;
      expect(first.windows.map((window) => window.id)).toEqual([
        "3p-5h",
        "gemini-5h",
        "3p-weekly",
        "gemini-weekly",
      ]);
      // The second probe rides the cached access token.
      yield* read;
      expect(tokenRequests).toBe(1);
    }).pipe(Effect.scoped, withNodeServices),
  );

  it.effect("reports unsupported without a stored grant and probeFailed on endpoint errors", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profile = yield* fs.makeTempDirectoryScoped();
      const tokenPath = path.join(profile, "antigravity-acp", "acp_token.json");
      expect(
        (yield* makeAntigravityUsageLimitsReader({ tokenPath }).pipe(
          Effect.provideService(HttpClient.HttpClient, HttpClient.make(() => Effect.die("no requests expected"))),
        )).unavailable?.reason,
      ).toBe("unsupported");

      yield* fs.makeDirectory(path.dirname(tokenPath), { recursive: true });
      yield* fs.writeFileString(tokenPath, tokenFile);
      const failing = makeAntigravityUsageLimitsReader({ tokenPath }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                // A request URL the reader never recovers from.
                HttpClientRequest.post(
                  "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
                ),
                Response.json({ error: "backend" }, { status: 500 }),
              ),
            ),
          ),
        ),
      );
      expect((yield* failing).unavailable?.reason).toBe("probeFailed");
    }).pipe(Effect.scoped, withNodeServices),
  );
});
