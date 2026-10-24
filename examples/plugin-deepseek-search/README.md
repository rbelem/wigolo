# DeepSeek search engine plugin

A `searchEngine` plugin that queries DeepSeek's search API (`POST
https://api.deepseek.com/v1/tools/search`) and maps its results onto wigolo's
`RawSearchResult` shape. `maxResults` becomes the API's `count`; `rerank_score`
(0-3) divides by 3 into wigolo's 0-1 scale.

**This is a worked example, not the recommended way to search DeepSeek.** wigolo
now ships its own key-gated `deepseek` engine
([`src/search/engines/deepseek.ts`](../../src/search/engines/deepseek.ts)), so if
you only want DeepSeek results, set `DEEPSEEK_API_KEY` and use the core engine —
no plugin needed. The example stays because it is the shortest non-trivial
plugin in the tree (HTTP call, timeout, error mapping, result translation).

It registers under the name **`deepseek-tools`**, not `deepseek`: two engines
under one name make results indistinguishable, and the plugin loader drops a
plugin whose engine name is already registered.

`wigolo plugin add` accepts a git URL only, so from the repository root link
this directory into your plugins dir and validate it:

```bash
ln -s "$PWD/examples/plugin-deepseek-search" ~/.wigolo/plugins/deepseek-search
wigolo plugin validate
```

`DEEPSEEK_API_KEY` must be set in the server environment
(`WIGOLO_DEEPSEEK_ENDPOINT` overrides the endpoint, and the request deadline
defaults to 10 seconds). Plugin engines join the fan-out on the `searxng` and
`hybrid` tiers, where every registered engine gets at least one query per
fan-out search. `mode: "cache"` dispatches a single engine instead, and the
default `core` backend builds its pool from built-in verticals, so neither
reaches a plugin engine.
