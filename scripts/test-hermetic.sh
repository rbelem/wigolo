#!/usr/bin/env bash
# Run the test suite with ambient credentials removed.
#
# Why: several suites assert the "no provider configured" path — key-store's
# fallback precedence, llm-runner's throw with no provider, synthesis-local's
# local-LLM gate, extraction's LLM fallback. On a developer box that exports a
# real GEMINI_API_KEY (or any other provider key) those assertions compare
# against the ambient key and fail. CI is green only because its environment is
# empty, so the suite is accidentally hermetic there and nowhere else.
#
# Stripping here, rather than in each test, keeps upstream's tests untouched and
# puts the requirement in one readable place: tests that need a key set it
# themselves.
set -euo pipefail

for var in \
  ANTHROPIC_API_KEY \
  OPENAI_API_KEY \
  GEMINI_API_KEY \
  GOOGLE_API_KEY \
  GROQ_API_KEY \
  MISTRAL_API_KEY \
  DEEPSEEK_API_KEY \
  XAI_API_KEY \
  ZAI_API_KEY \
  ZHIPU_API_KEY \
  MOONSHOT_API_KEY \
  KIMI_API_KEY \
  ALIBABA_TOKEN_PLAN_API_KEY \
  ALIBABA_CODING_PLAN_API_KEY \
  OPENCODE_API_KEY \
  OPENCODE_GO_API_KEY \
  LLM_API_KEY \
  TEXT_MODEL_API_KEY \
  OPENAI_BASE_URL \
  OPENAI_MODEL \
  WIGOLO_LLM_API_KEY \
  WIGOLO_LLM_PROVIDER \
  WIGOLO_LLM_MODEL \
  WIGOLO_EMBEDDING_API_KEY \
  WIGOLO_RERANK_API_KEY \
  WIGOLO_RERANKER_API_KEY \
  WIGOLO_HOSTED_READER_URL \
  BRAVE_API_KEY \
  WIGOLO_GITHUB_TOKEN \
  WIGOLO_SEARXNG_URL \
  SEARXNG_URL
do
  unset "$var"
done

exec npx vitest "$@"
