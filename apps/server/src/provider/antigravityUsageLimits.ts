/**
 * Antigravity (Gemini) subscription usage, read the way the Antigravity hub
 * client reads it: the profile's stored Google OAuth credentials refresh an
 * access token, a `loadCodeAssist` call names the quota project, and
 * `retrieveUserQuotaSummary` reports one bucket per group cadence
 * (5-hour/weekly) that this layer classifies client-side.
 *
 * @module provider/Layers/antigravityUsageLimits
 */
import * as NodeCrypto from "node:crypto";

import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "./providerUsageLimits.ts";

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;

const CLOUD_CODE_BASE = "https://cloudcode-pa.googleapis.com";
// Cloud Code only serves the quota endpoints to the Antigravity hub client family.
const HUB_USER_AGENT = `antigravity/hub/2.9.1 ${process.platform}/${process.arch}`;
// Refresh slightly before the granted expiry so a probe never rides an expired token.
const TOKEN_EXPIRY_SAFETY_MS = 60_000;
const DEFAULT_TOKEN_TTL_SECONDS = 3_600;
const PROBE_TIMEOUT = "10 seconds";

/** The Google OAuth grant the agent stores in the instance profile. */
const AntigravityTokenFile = Schema.Struct({
  client_id: Schema.String,
  client_secret: Schema.String,
  refresh_token: Schema.String,
  token_uri: Schema.String,
});
const decodeTokenFile = Schema.decodeEffect(Schema.fromJsonString(AntigravityTokenFile));

const TokenGrant = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.optional(Schema.Number),
});

/** Raised when `loadCodeAssist` succeeds without naming a quota project. */
class AntigravityQuotaProjectMissingError extends Schema.TaggedError<AntigravityQuotaProjectMissingError>()(
  "AntigravityQuotaProjectMissingError",
  {},
) {}

const QuotaBucket = Schema.Struct({
  bucketId: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
  remainingFraction: Schema.optional(Schema.NullOr(Schema.Number)),
  remaining: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        remainingFraction: Schema.optional(Schema.NullOr(Schema.Number)),
        case: Schema.optional(Schema.NullOr(Schema.String)),
        value: Schema.optional(Schema.NullOr(Schema.Number)),
      }),
    ),
  ),
  resetTime: Schema.optional(Schema.String),
  window: Schema.optional(Schema.String),
});
const QuotaGroup = Schema.Struct({
  displayName: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  buckets: Schema.optional(Schema.Array(QuotaBucket)),
});
const QuotaPayload = Schema.Struct({
  groups: Schema.optional(Schema.NullOr(Schema.Array(QuotaGroup))),
});
// The HTTP endpoint returns `groups` at the top level; the CLI and LSP
// sources wrap the same payload under `summary` or `response`.
const QuotaSummaryResponse = Schema.Struct({
  groups: Schema.optional(Schema.NullOr(Schema.Array(QuotaGroup))),
  summary: Schema.optional(Schema.NullOr(QuotaPayload)),
  response: Schema.optional(Schema.NullOr(QuotaPayload)),
});

const LoadCodeAssistResponse = Schema.Struct({
  cloudaicompanionProject: Schema.optional(
    Schema.Union([
      Schema.String,
      Schema.Struct({
        id: Schema.optional(Schema.String),
        projectId: Schema.optional(Schema.String),
      }),
    ]),
  ),
});

const SESSION_CADENCE_ALIASES = ["session", "5h", "5-hour", "five hour", "five-hour"];
const CADENCE_ALIASES = [...SESSION_CADENCE_ALIASES, "weekly"];

/**
 * Cadence names arrive as free text (`gemini-5h`, `Five Hour Limit`,
 * `WEEKLY`). Mirrors the hub's normalization: lowercase, underscores to
 * hyphens, a trailing " limit" dropped, and a `-<alias>` suffix counted as
 * the alias itself.
 */
function cadenceCandidates(values: ReadonlyArray<string | undefined>): Set<string> {
  const candidates = new Set<string>();
  for (const value of values) {
    const normalized = value?.trim().toLowerCase().replaceAll("_", "-");
    if (!normalized) continue;
    const names = normalized.endsWith(" limit")
      ? [normalized, normalized.slice(0, -" limit".length)]
      : [normalized];
    for (const name of names) {
      candidates.add(name);
      for (const alias of CADENCE_ALIASES) {
        if (name.endsWith(`-${alias}`)) candidates.add(alias);
      }
    }
  }
  return candidates;
}

function classifyBucket(input: {
  readonly window: string | undefined;
  readonly bucketId: string;
  readonly displayName: string;
}): ServerProviderUsageWindow["kind"] {
  const explicit = input.window?.trim();
  const candidates = cadenceCandidates(explicit ? [explicit] : [input.bucketId, input.displayName]);
  if (SESSION_CADENCE_ALIASES.some((alias) => candidates.has(alias))) return "session";
  return candidates.has("weekly") ? "weekly" : "other";
}

/** "Gemini Models" → "Gemini", "Claude and GPT models" → "Claude/GPT". */
function groupTitle(displayName: string | undefined): string {
  const title = displayName?.trim() ?? "";
  const lowered = title.toLowerCase();
  if (lowered.includes("gemini")) return "Gemini";
  if (lowered.includes("claude") || lowered.includes("gpt")) return "Claude/GPT";
  return title || "Quota";
}

/**
 * The full quota summary into usage windows keyed by bucket id, so per-group
 * buckets (a 5-hour and a weekly limit per model family) each get a row.
 * Buckets without a usable remaining fraction are skipped; a summary that
 * decodes but yields nothing means no measured quota is available.
 */
export function antigravityQuotaSummaryToLimits(
  summary: unknown,
  checkedAt: string,
): ServerProviderUsageLimits {
  let payload: typeof QuotaSummaryResponse.Type;
  try {
    payload = Schema.decodeUnknownSync(QuotaSummaryResponse)(summary);
  } catch {
    return makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" });
  }
  const groups = (payload.response ?? payload.summary ?? payload).groups ?? [];
  const windows = new Map<string, ServerProviderUsageWindow>();
  for (const group of groups) {
    const title = groupTitle(group.displayName ?? group.name);
    for (const bucket of group.buckets ?? []) {
      const bucketId = (bucket.bucketId ?? bucket.id ?? "").trim();
      const displayName = (bucket.displayName ?? bucket.name ?? "").trim() || bucketId;
      const remainingFraction =
        bucket.remainingFraction ??
        bucket.remaining?.remainingFraction ??
        (bucket.remaining?.case === "remainingFraction" ? bucket.remaining.value : undefined);
      if (
        !bucketId ||
        bucket.disabled === true ||
        typeof remainingFraction !== "number" ||
        !Number.isFinite(remainingFraction)
      ) {
        continue;
      }
      const kind = classifyBucket({
        window: bucket.window,
        bucketId,
        displayName,
      });
      const bucketTitle =
        kind === "session" ? "5-hour" : kind === "weekly" ? "Weekly" : displayName;
      const reset = bucket.resetTime ? DateTime.make(bucket.resetTime) : Option.none();
      windows.set(bucketId, {
        id: bucketId,
        kind,
        label: `${title} ${bucketTitle}`,
        usedPercent: clampPercent(100 - remainingFraction * 100),
        ...(kind === "session"
          ? { windowDurationMins: SESSION_MINS }
          : kind === "weekly"
            ? { windowDurationMins: WEEK_MINS }
            : {}),
        ...(Option.isSome(reset) ? { resetsAt: DateTime.formatIso(reset.value) } : {}),
      });
    }
  }
  if (windows.size === 0) {
    return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  }
  return makeUsageLimits({ checkedAt, windows: windows.values() });
}

interface CachedAccessToken {
  readonly credentialIdentity: string;
  readonly token: string;
  readonly expiresAtMs: number;
}

function refreshAccessToken(input: {
  readonly client: HttpClient.HttpClient;
  readonly credentials: typeof AntigravityTokenFile.Type;
}) {
  return input.client
    .execute(
      HttpClientRequest.post(input.credentials.token_uri).pipe(
        HttpClientRequest.bodyText(
          new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: input.credentials.refresh_token,
            client_id: input.credentials.client_id,
            client_secret: input.credentials.client_secret,
          }).toString(),
          "application/x-www-form-urlencoded",
        ),
      ),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(TokenGrant)),
    );
}

function loadQuotaProject(input: {
  readonly client: HttpClient.HttpClient;
  readonly accessToken: string;
}) {
  return input.client
    .execute(
      HttpClientRequest.post(`${CLOUD_CODE_BASE}/v1internal:loadCodeAssist`).pipe(
        HttpClientRequest.bearerToken(input.accessToken),
        HttpClientRequest.setHeader("user-agent", HUB_USER_AGENT),
        HttpClientRequest.bodyJsonUnsafe({
          metadata: {
            ideType: "ANTIGRAVITY",
            platform: "PLATFORM_UNSPECIFIED",
            pluginType: "GEMINI",
          },
        }),
      ),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(LoadCodeAssistResponse)),
      Effect.flatMap((body) => {
        const project = body.cloudaicompanionProject;
        const id =
          typeof project === "string" ? project : (project?.id ?? project?.projectId ?? "").trim();
        return id ? Effect.succeed(id) : Effect.fail(new AntigravityQuotaProjectMissingError());
      }),
    );
}

function retrieveQuotaSummary(input: {
  readonly client: HttpClient.HttpClient;
  readonly accessToken: string;
  readonly project: string;
}) {
  return input.client
    .execute(
      HttpClientRequest.post(`${CLOUD_CODE_BASE}/v1internal:retrieveUserQuotaSummary`).pipe(
        HttpClientRequest.bearerToken(input.accessToken),
        HttpClientRequest.setHeader("user-agent", HUB_USER_AGENT),
        HttpClientRequest.bodyJsonUnsafe({ project: input.project }),
      ),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(QuotaSummaryResponse)),
    );
}

/**
 * Builds the probe-side reader for one Antigravity instance profile. The
 * credential file is re-read on every probe so a native re-sign-in is picked
 * up without a restart; only the derived access token is cached, and it is
 * refreshed in memory once it nears expiry.
 */
export const makeAntigravityUsageLimitsReader = (input: {
  readonly tokenPath: string;
}): Effect.Effect<
  ServerProviderUsageLimits,
  never,
  FileSystem.FileSystem | HttpClient.HttpClient
> => {
  let cachedToken: CachedAccessToken | undefined;
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const probeFailed = makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "Antigravity could not read Gemini usage limits.",
    });
    return yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const client = yield* HttpClient.HttpClient;
      // No stored grant means this instance never signed in with a Google
      // account, so it has no subscription quota to report at all.
      if (!(yield* fs.exists(input.tokenPath))) {
        cachedToken = undefined;
        return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
      }
      const credentials = yield* fs
        .readFileString(input.tokenPath)
        .pipe(Effect.flatMap(decodeTokenFile));
      const credentialIdentity = NodeCrypto.createHash("sha256")
        .update(
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify([
            credentials.client_id,
            credentials.client_secret,
            credentials.refresh_token,
            credentials.token_uri,
          ]),
        )
        .digest("hex");
      if (cachedToken?.credentialIdentity !== credentialIdentity) cachedToken = undefined;
      const nowMs = (yield* DateTime.now).epochMilliseconds;
      const cached = cachedToken;
      let accessToken: string;
      if (cached && nowMs < cached.expiresAtMs - TOKEN_EXPIRY_SAFETY_MS) {
        accessToken = cached.token;
      } else {
        const grant = yield* refreshAccessToken({ client, credentials });
        accessToken = grant.access_token;
        cachedToken = {
          credentialIdentity,
          token: accessToken,
          expiresAtMs: nowMs + (grant.expires_in ?? DEFAULT_TOKEN_TTL_SECONDS) * 1000,
        };
      }
      const project = yield* loadQuotaProject({ client, accessToken });
      const summary = yield* retrieveQuotaSummary({ client, accessToken, project });
      return antigravityQuotaSummaryToLimits(summary, checkedAt);
    }).pipe(
      Effect.timeout(PROBE_TIMEOUT),
      Effect.orElseSucceed(() => probeFailed),
    );
  });
};
