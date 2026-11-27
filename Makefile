.PHONY: help release-beta release-patch release-minor release-major _release release-tag release-dry-run

# Disable gpg signing just for these targets (project rule: never sign)
NOSIGN := GIT_CONFIG_COUNT=2 \
  GIT_CONFIG_KEY_0=tag.gpgsign GIT_CONFIG_VALUE_0=false \
  GIT_CONFIG_KEY_1=commit.gpgsign GIT_CONFIG_VALUE_1=false

# ── Public-beta releases — via PR, because `main` is protected ───────────────
# main requires pull requests, so a release is TWO steps:
#
#   1. Open a version-bump PR:   make release-beta   (or -patch / -minor / -major)
#   2. After it merges, publish:  make release-tag
#
# Step 2 pushes a git tag (tags aren't branch-protected); the release workflow
# fires on the tag and publishes to npm + creates the GitHub Release.
#
# Releases are PRE-RELEASES during the beta: versions carry a -beta.N suffix and
# the GitHub Release is flagged --prerelease (see .github/workflows/release.yml).
# npm still publishes to the `latest` dist-tag, so `npm install wigolo` works.
#
# GOING STABLE later: switch the pre*/prerelease bumps below to plain
# patch/minor/major, and drop --prerelease from the release workflow.
PREID := beta

help:  ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

release-beta:  ## Step 1: open a PR bumping to the next -beta.N
	@$(MAKE) --no-print-directory _release BUMP=prerelease

release-patch:  ## Step 1: open a PR bumping to the next patch (x.y.z-beta.0)
	@$(MAKE) --no-print-directory _release BUMP=prepatch

release-minor:  ## Step 1: open a PR bumping to the next minor (x.y+1.0-beta.0)
	@$(MAKE) --no-print-directory _release BUMP=preminor

release-major:  ## Step 1: open a PR bumping to the next major (x+1.0.0-beta.0)
	@$(MAKE) --no-print-directory _release BUMP=premajor

_release:
	@set -e; \
	if [ -n "$$(git status --porcelain)" ]; then echo "working tree not clean — commit or stash first"; exit 1; fi; \
	git checkout main; git pull --ff-only; \
	npm version --no-git-tag-version $(BUMP) --preid=$(PREID); \
	bun install; \
	VERSION=$$(bun -p "require('./package.json').version"); \
	git checkout -b "release/v$$VERSION"; \
	$(NOSIGN) git commit -am "chore(release): v$$VERSION"; \
	git push -u origin "release/v$$VERSION"; \
	gh pr create --base main --head "release/v$$VERSION" \
	  --title "chore(release): v$$VERSION" \
	  --body "Version bump to \`v$$VERSION\`. Merge, then run \`make release-tag\` to publish."; \
	echo "PR opened. After it merges: make release-tag"

release-tag:  ## Step 2: after the release PR merges, tag main to publish
	@set -e; \
	git checkout main; git pull --ff-only; \
	VERSION=$$(bun -p "require('./package.json').version"); \
	echo "Tagging v$$VERSION on main and pushing (fires the release workflow)…"; \
	$(NOSIGN) git tag "v$$VERSION"; \
	git push origin "v$$VERSION"

release-dry-run:  ## Build and preview npm tarball (no publish, no tag)
	rm -rf dist
	npm run build
	npm publish --dry-run
