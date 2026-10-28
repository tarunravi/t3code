# DeepSeek Harness provider

T3 runs `dsh --profile acp` over standard ACP stdio. This opt-in provider reuses the ACP runtime for model discovery, permissions, text/thoughts, tools, cancellation and persistent resume. Install an approved DSH binary separately; T3 does not download it.

## Setup

1. Add a **DeepSeek Harness** provider instance in T3 Settings. Set its binary path if `dsh` is not on PATH.
2. Use an isolated `DSH_HOME` in the instance's environment. Set launch arguments to `--patch /absolute/path/dsh-local.patch.yml` for the supplied local-model example, and set `DSH_LOCAL_API_KEY=local` for a keyless server that requires a dummy key.
3. Adjust the example's endpoint to the Spark serving DeepSeek on port 8888. The server need not be running for configuration, but prompts require it. Refresh models and choose the advertised DeepSeek entry. ACP model IDs are opaque JSON route pairs, not omp slugs; do not copy an omp slug into DSH's picker.
4. Switch a thread through T3's provider/model picker. T3 handles conversation handoff; omp and DSH do not share a native session or KV cache.

The example targets a fresh profile. DSH patches replace the entire entry config: merge any existing routes before applying it to a customized profile. The `acp` profile disables hot reload, so changed patches apply to the next provider process.

For omp, merge `examples/omp-models.yml` into `~/.omp/agent/models.yml`, retaining existing GLM providers. Add `sparksdeepseek/DeepSeek-V4.1-Flash-1017` to the omp instance's `config.customModels` in T3 settings. The model is capped at the serving API's 262,144-token context and 16,384 output tokens, and uses `reasoning_content` plus `chat_template_kwargs.enable_thinking` via omp's `qwen-chat-template` compatibility mode. The existing GLM entry and default launch model remain unchanged.

Keep that context cap in sync with the server: omp starts automatic compaction at 85% of its configured context, so advertising 1,000,000 tokens would defer it until about 850,000—well past this server's 262,144-token limit. At 262,144, the threshold is about 222,823 tokens, leaving room for the next request and output.

## Limits

DSH requires Node >=24.9.0. Its ACP profile supports persistent resume, but not `session/load`, session forking or history replay. DSH and omp retain separate native sessions.

DSH ACP publishes context usage, not per-request billable counters or prices. T3 estimates visible-output speed and leaves billable cost unknown; it does not treat context-window usage as spent tokens.
