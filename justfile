set shell := ["bash", "-euo", "pipefail", "-c"]

# List the available development commands.
default:
    @just --list

# Install the locked dependencies.
install:
    bun install --frozen-lockfile

# Expensive recipes wait for host room through `quest gate`; nested calls run at once.
gate := "bun run --silent quest gate just"

# Check code, repository tooling, and the quest tree.
check:
    {{gate}} _check

_check:
    bun run check
    bun run --silent quest check
    bun run --silent quest --root examples/export check
    actionlint
    zizmor --offline .github
    shellcheck scripts/*.sh
    shfmt -d scripts/*.sh
    nixfmt --check flake.nix nix/*.nix
    just worker-check

# Run tests, including the install scripts and the lifecycle of both builds.
test:
    {{gate}} _test

_test:
    bun run test
    bash scripts/install-check.test.sh
    bash scripts/installer.test.sh
    bash scripts/release-plan.test.sh
    bun run build
    bash scripts/lifecycle-check.sh "$PWD/dist/quest.js" dev
    bun run compile
    bash scripts/lifecycle-check.sh "$PWD/dist/quest" dev
    just worker-test

# Check that `quest review` runs nothing a reviewed head plants, with the real
# Codex and Claude Code CLIs. Uses each CLI's login and spends its
# usage; run it after upgrading any of them. Arguments go to vitest, such as
# `-t codex`.
review-sandbox *args:
    QUEST_LIVE=1 bun run vitest run test/live/review-sandbox {{args}}

# Apply formatters without changing program behavior.
fix:
    bun run fix
    shfmt -w scripts/*.sh
    nixfmt flake.nix nix/*.nix

# Build the bundled CLI into dist/quest.js.
build:
    bun run build

# Compile a standalone binary for this machine into dist/quest.
compile:
    bun run compile

# Run the local CLI, for example `just run ready`.
run *args:
    bun run --silent quest {{args}}

# `quest gate` runs recipes under the root `bun run`, whose `run.bun` puts a Bun `node`
# shim first on PATH for everything it starts. Wrangler needs Node, so the Worker
# recipes drop that shim, then say so when no Node is left; cloudflare/scripts/require-node.mjs
# fails if a shim gets through.
worker_node := 'export PATH="$(tr : "\n" <<<"$PATH" | grep -v /bun-node- | paste -sd: -)"; command -v node >/dev/null || { echo "cloudflare/ needs Node on PATH for Wrangler: enter the dev shell (nix develop) or install Node" >&2; exit 1; }'

# Check the Worker in cloudflare/: types and formatting.
worker-check:
    cd cloudflare && {{worker_node}} && bun run check

# Test the Worker in cloudflare/.
worker-test:
    cd cloudflare && {{worker_node}} && bun run test
