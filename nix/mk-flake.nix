# `quest.lib.mkFlake`: a repository's per-system flake outputs, with Quest's dev
# shell, formatter, and tree check added, so the repository pins only `nixpkgs`
# and `quest`. treefmt-nix stays an input of Quest's flake, not the repository's.
{
  # Quest's own flake, whose `quest` package the dev shell and check use by default.
  quest,
  treefmt-nix,
}:
{
  # The repository's flake, whose source `checks.quest` validates.
  self,
  # The repository's nixpkgs input.
  nixpkgs,
  # The pinned nixpkgs no longer evaluates on x86_64-darwin; Intel Macs use the release binary.
  systems ? [
    "x86_64-linux"
    "aarch64-linux"
    "aarch64-darwin"
  ],
  overlays ? [ ],
  # A treefmt-nix module, such as `{ programs.rustfmt.enable = true; }`; nixfmt is on unless it turns it off.
  fmt ? { },
  # `{ pkgs, system }` to this system's outputs: `shell`, the arguments of the default dev shell's
  # `pkgs.mkShell`; `quest`, the package to use instead of Quest's; and any outputs, such as `packages`,
  # `checks`, or `apps`, merged with those this adds.
  perSystem ? _: { },
}:
let
  inherit (nixpkgs) lib;
  lock = "${self}/flake.lock";
  flakeHash = builtins.hashString "sha256" (
    builtins.readFile "${self}/flake.nix"
    + lib.optionalString (builtins.pathExists lock) (builtins.readFile lock)
  );
  outputs =
    system:
    let
      pkgs = import nixpkgs { inherit system overlays; };
      own = perSystem { inherit pkgs system; };
      questPackage = own.quest or quest.packages.${system}.quest;
      treefmt =
        (treefmt-nix.lib.evalModule pkgs {
          imports = [ fmt ];
          projectRootFile = "flake.nix";
          programs.nixfmt.enable = lib.mkDefault true;
        }).config.build.wrapper;
      shell = own.shell or { };
      # Everything the repository gave the shell, which nothing else names: its packages, environment
      # attributes, hook, and whatever Nix files they import.
      inner = pkgs.mkShell (
        shell
        // {
          packages = [
            questPackage
            treefmt
          ]
          ++ shell.packages or [ ];
          # Names the repository's root, the nearest directory up that holds flake.nix, so `quest run` and
          # `quest fmt` run here without entering the shell again: only when its flake.nix and flake.lock
          # are the ones this shell was built from, so `nix develop ../other` names no checkout. It checks
          # them once, as the shell is entered; `questShell` below is what `quest run` compares afterwards.
          shellHook = ''
            QUEST_DEV_SHELL=$PWD
            while [ ! -f "$QUEST_DEV_SHELL/flake.nix" ] && [ "$QUEST_DEV_SHELL" != / ]; do
              QUEST_DEV_SHELL=$(dirname "$QUEST_DEV_SHELL")
            done
            if [ -f "$QUEST_DEV_SHELL/flake.nix" ] && [ "$(
              {
                cat "$QUEST_DEV_SHELL/flake.nix"
                [ ! -f "$QUEST_DEV_SHELL/flake.lock" ] || cat "$QUEST_DEV_SHELL/flake.lock"
              } | sha256sum
            )" = "${flakeHash}  -" ]; then
              export QUEST_DEV_SHELL
            else
              unset QUEST_DEV_SHELL
            fi
          ''
          + shell.shellHook or "";
        }
      );
      # The shell's identity is `inner`'s derivation path, which changes with any of its inputs, as a plain string
      # so the shell depends on nothing more than `inner` itself. The shell exports it as `QUEST_DEV_SHELL_ID` and
      # carries it as `passthru.questShell`, which leaves its derivation alone, so `quest run` finds out whether an
      # entered shell is the one `nix develop` enters now.
      identity = builtins.unsafeDiscardStringContext inner.drvPath;
      default = inner.overrideAttrs (old: {
        passthru = old.passthru or { } // {
          questShell = identity;
        };
        # Its own line, since the repository's hook may end without a newline.
        shellHook = old.shellHook + "\nexport QUEST_DEV_SHELL_ID=${identity}\n";
      });
    in
    removeAttrs own [
      "quest"
      "shell"
    ]
    // {
      devShells = own.devShells or { } // {
        inherit default;
      };
      formatter = treefmt;
      checks = {
        quest = pkgs.runCommand "quest-check" { nativeBuildInputs = [ questPackage ]; } ''
          quest --root ${self} check
          touch "$out"
        '';
      }
      // own.checks or { };
    };
  bySystem = lib.genAttrs systems outputs;
  names = lib.unique (lib.concatMap lib.attrNames (lib.attrValues bySystem));
in
# From each system's outputs to each output's systems, as flakes lay them out.
lib.genAttrs names (
  name: lib.mapAttrs (_: each: each.${name}) (lib.filterAttrs (_: each: each ? ${name}) bySystem)
)
