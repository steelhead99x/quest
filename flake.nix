{
  description = "Quest - versioned plans for repository work";

  # Kixel Quest's binary cache, which quest.toml opts this repository into.
  nixConfig = {
    extra-substituters = [ "https://nix.kixel.quest" ];
    extra-trusted-public-keys = [ "nix.kixel.quest-2:VxG5pPqlpBKsAoH+pudaBvTehL5DRBbkMtblKZnK8qY=" ];
  };

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    # Bun 1.4.4, ahead of `nixpkgs`: 1.4.2 passes its non-blocking stderr to the
    # commands it spawns, which uv aborts on (oven-sh/bun#43868). Drop this input
    # once `nixpkgs` reaches 1.4.4.
    nixpkgs-bun.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    # Builds `lib.mkFlake`'s formatter, so a repository using it needs no input of its own for it.
    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # A reviewed quest for the dev shell's merge driver, so local merges resolve
    # link lists without running the checkout's own, possibly unreviewed, code.
    # Only its source is pinned, so the lock never chains older pins. Dependabot's
    # weekly nix update bumps it in its own PR, without the cooldown; bump it by
    # hand with `nix flake update quest-pinned`.
    quest-pinned = {
      url = "github:kixel-ai/quest";
      flake = false;
    };
    # token-max, which reads and prices `quest usage`'s sessions; the lock pins it so its JSON stays what the
    # parser reads. Its own quest input follows this flake, so the lock never chains older quest pins.
    token-max = {
      url = "github:kixel-ai/token-max";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-utils.follows = "flake-utils";
      inputs.quest.follows = "";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      nixpkgs-bun,
      flake-utils,
      treefmt-nix,
      quest-pinned,
      token-max,
      ...
    }:
    let
      lib.mkFlake = import ./nix/mk-flake.nix {
        quest = self;
        inherit treefmt-nix;
      };
    in
    {
      inherit lib;
    }
    // lib.mkFlake {
      inherit self nixpkgs;
      overlays = [
        (_: prev: { inherit (nixpkgs-bun.legacyPackages.${prev.stdenv.hostPlatform.system}) bun; })
      ];
      fmt =
        { pkgs, ... }:
        let
          # The Prettier bun.lock pins, which `bun run check` runs from node_modules, so a fresh clone formats too.
          prettier = pkgs.runCommand "prettier" { } ''
            mkdir "$out"
            tar -xzf ${
              (pkgs.callPackage ./nix/package.nix { }).tarball "prettier"
            } --strip-components=1 -C "$out"
          '';
        in
        {
          programs.shfmt = {
            enable = true;
            # .editorconfig's.
            indent_size = null;
          };
          settings.formatter.prettier = {
            command = pkgs.lib.getExe pkgs.bun;
            options = [
              "${prettier}/bin/prettier.cjs"
              "--write"
            ];
            includes = [
              "*.ts"
              "*.mjs"
              "*.json"
            ];
          };
        };
      perSystem =
        { pkgs, system }:
        let
          # A flake build cannot see tags, so it reports its commit.
          quest = pkgs.callPackage ./nix/package.nix { rev = self.shortRev or self.dirtyShortRev or null; };
          # A pin from before builds took `rev` reads its version from package.json instead.
          pinnedPackage = "${quest-pinned}/nix/package.nix";
          questPinned = pkgs.callPackage pinnedPackage (
            pkgs.lib.optionalAttrs (pkgs.lib.functionArgs (import pinnedPackage) ? rev) {
              rev = quest-pinned.shortRev;
            }
          );
          manifest = pkgs.lib.importJSON ./package.json;
          # package.json's packageManager pins Bun for CI runners without Nix.
          bunVersion = pkgs.lib.removePrefix "bun@" manifest.packageManager;
        in
        {
          # The dev shell's: `quest resolve` for the merge driver; `just` and `bun run quest` run the checkout.
          quest = questPinned;
          packages = {
            inherit quest;
            default = quest;
          };
          apps.default = flake-utils.lib.mkApp { drv = quest; };
<<<<<<< HEAD
          devShells.default = pkgs.mkShell {
            packages =
              with pkgs;
              [
                # Installs dependencies, runs the CLI and its scripts and tests, and compiles the release binaries.
                bun
                # Wrangler and the Worker's workerd tests in `cloudflare/`, which support Node, not Bun.
                nodejs
                # `quest resolve` for the merge driver; `just` and `bun run quest` run the checkout.
                questPinned
                just
                jq
                git
                gh
                # Exports and prices `quest usage`'s sessions.
                token-max.packages.${system}.default
                direnv
                actionlint
                shellcheck
                shfmt
                nixfmt
                # GNU time, which the gate's cancellation tests put between Bash and their leaf.
                time
              ]
              # `flock` (the land daemon's repository lock) and `script` (the tests' terminal), which
              # self-hosted NixOS runners don't otherwise provide.
              ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.util-linux ];
          };
          formatter = pkgs.nixfmt;
=======
          shell.packages =
            with pkgs;
            [
              # Installs dependencies, runs every script and tool, and compiles the release binaries.
              bun
              just
              jq
              git
              gh
              # Exports and prices `quest usage`'s sessions.
              token-max.packages.${system}.default
              direnv
              actionlint
              zizmor
              shellcheck
              shfmt
              nixfmt
              # GNU time, which the gate's cancellation tests put between Bash and their leaf.
              time
            ]
            # `flock` (the land daemon's repository lock) and `script` (the tests' terminal), which
            # self-hosted NixOS runners don't otherwise provide.
            ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.util-linux ];
>>>>>>> upstream/main
          checks = {
            package = quest;
            # The checkout's build checks the tree, since its rules may be newer than the pinned quest's.
            quest = pkgs.runCommand "quest-check" { nativeBuildInputs = [ quest ]; } ''
              quest --root ${self} check
              touch "$out"
            '';
            bun-version = pkgs.runCommand "bun-version" { } ''
              if [ "${pkgs.bun.version}" != "${bunVersion}" ]; then
                echo "package.json pins bun@${bunVersion}, but the flake provides Bun ${pkgs.bun.version}" >&2
                exit 1
              fi
              touch "$out"
            '';
            # `lib.mkFlake` as another repository calls it, with a stand-in quest: its dev shell carries quest and
            # treefmt and names the root holding this flake, and it adds the formatter and the tree check.
            mk-flake =
              let
                fixture = lib.mkFlake {
                  inherit self nixpkgs;
                  systems = [ system ];
                  # A hook that ends without a newline, which the identity's export must not join.
                  perSystem = _: {
                    quest = pkgs.hello;
                    shell.shellHook = "HOOKED=1";
                  };
                };
                shell = fixture.devShells.${system}.default;
                # The same shell with only an environment attribute added: its identity must move with it.
                changed =
                  (lib.mkFlake {
                    inherit self nixpkgs;
                    systems = [ system ];
                    perSystem = _: {
                      quest = pkgs.hello;
                      shell.shellHook = "HOOKED=1";
                      shell.CHANGED = "1";
                    };
                  }).devShells.${system}.default;
              in
              assert fixture.checks.${system} ? quest;
              assert shell.questShell != changed.questShell;
              pkgs.runCommand "mk-flake" { nativeBuildInputs = shell.nativeBuildInputs; } ''
                hello --version >/dev/null
                treefmt --version
                [ "$(${pkgs.lib.getExe fixture.formatter.${system}} --version)" = "$(treefmt --version)" ]
                mkdir -p repo/sub other
                cp ${self}/flake.nix ${self}/flake.lock repo/
                cd repo/sub
                ${shell.shellHook}
                [ "$QUEST_DEV_SHELL" = "$(dirname "$PWD")" ]
                [ "$HOOKED" = 1 ]
                [ "$QUEST_DEV_SHELL_ID" = ${shell.questShell} ]
                # Another flake's checkout, and none at all.
                { cat ${self}/flake.nix; echo "# other"; } > ../../other/flake.nix
                for dir in ../../other /; do
                  cd "$dir"
                  ${shell.shellHook}
                  [ -z "''${QUEST_DEV_SHELL+set}" ]
                done
                touch "$out"
              '';
          };
        };
    };
}
