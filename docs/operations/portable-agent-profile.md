# Portable agent profile

`config/agent-profile.json` keeps a shareable set of provider identities, enabled preferences, subagent model availability settings, and the Work and cook subagent presets. The hidden-model lists control subagent delegation availability; they are independent of the composer model picker. The profile contains model IDs, selection options, role labels, and short generalized descriptions. Provider credentials, environment variables, launch commands, executable paths, endpoints, and thread rosters stay local.

The recipient needs a T3 fork build whose settings schema supports `providerInstances`, `subagentModelPreferences`, and `subagentPresets`. Copy the repository files to the recipient machine, install the T3 build and provider CLIs used by the profile, complete each provider's local authentication and launch setup, then quit T3 before applying settings. The `omp` identity, for example, carries no local launch configuration. A missing nondefault identity is added disabled, and an existing identity keeps its current enabled state. Implicit Codex and Claude defaults on an existing home remain managed by T3 as enabled defaults, including when the profile adds custom models. `preferredEnabled` records the source preference for reference; it does not control recipient enablement. Symlinked `settings.json` files are unsupported and rejected.

Preview against the default `~/.t3` home:

```sh
node scripts/apply-agent-profile.mjs
```

Preview or apply to another T3 home:

```sh
node scripts/apply-agent-profile.mjs --home /path/to/.t3
node scripts/apply-agent-profile.mjs --home /path/to/.t3 --apply
```

Apply to the default `~/.t3` home:

```sh
node scripts/apply-agent-profile.mjs --apply
```

The script uses Node built-ins only. It validates the whole profile before any write, applies only the fields in its explicit allowlist, preserves recipient config and unrelated settings, and makes a local backup before changing an existing settings file. Existing legacy `providers[instanceId]` configuration is left for T3's own migration/hydration; the script does not shadow it with a disabled instance. A fresh home gets a new settings file with restrictive permissions. The source custom model lists are empty; if later populated, they merge into recipient lists by model slug. Reapplying an unchanged version is byte-stable and does not create another backup. Presets with the same stable ID are replaced; if only the name matches, the recipient's preset ID is retained so local default references continue to work. Other presets and per-thread rosters remain untouched.

Run its focused tests with:

```sh
node --test tests/apply-agent-profile.test.mjs
```
