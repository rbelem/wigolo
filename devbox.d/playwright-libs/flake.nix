{
  description = "Playwright Chromium runtime libraries for NixOS (no /usr/lib here)";

  inputs = {
    # Same pin as the devbox-global wigolo-git flake, so a library bump there and
    # here cannot drift into two different glib versions.
    nixpkgs.url = "github:NixOS/nixpkgs/241313f4e8e508cb9b13278c2b0fa25b9ca27163";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          # The exact set `ldd chrome-headless-shell | grep 'not found'` reports
          # against a bare NixOS environment. Re-check when the Playwright
          # version in package.json changes.
          #
          # A buildEnv rather than a package list on purpose: devbox's package
          # symlink farm drops glib's and dbus's /lib, which is precisely what
          # the browser needs, so the shell points LD_LIBRARY_PATH at this
          # env's /lib instead of at the profile.
          #
          # DUPLICATED ON PURPOSE — one list, two literal copies. Keep in sync.
          #
          # The other copy is devbox-global's `devbox.d/wigolo-git/flake.nix`
          # (`chromiumDeps`):
          #   /home/rodrigo/Workspace/github.com/rbelem/devbox-global
          # Neither file can own the list for the other: that flake builds a
          # FETCHED wigolo source instead of this checkout (and cannot import a
          # file of ours from `src` either — its pinned rev predates one), while
          # this flake has to evaluate with no network fetch. So: one list, one
          # owner (this file — its package.json Playwright version drives
          # `ldd`), two literal copies.
          #
          # TRIGGER is a Playwright bump: the version in package.json pulls a
          # new chrome-headless-shell, and that is the only thing that changes
          # the set. In ONE change: re-run
          # `ldd chrome-headless-shell | grep 'not found'` against a bare NixOS
          # env, edit BOTH lists, update BOTH attestation hashes below, and keep
          # both flakes' nixpkgs pins equal (see the input comment at the top).
          #
          # BEGIN ATTESTED SET — sha256
          # 2ee112dd9b920ed96127e37d476a1182631408832b3b5527d4c3659ba4f17e63
          # sha256 of the sorted attribute names, one per line, trailing newline
          # included. The string is identical in both copies, so a hash that no
          # longer matches its own list — or two hashes that differ — is drift.
          #   alsa-lib, at-spi2-core, cairo, cups.lib, dbus.lib, expat,
          #   glib.out, libgbm, libx11, libxcb, libxcomposite, libxdamage,
          #   libxext, libxfixes, libxkbcommon, libxrandr, nspr, nss,
          #   pango.out, systemdMinimal
          # END ATTESTED SET
          #
          # Compare the two copies without reading them (empty = in sync):
          #   diff <(sed -n '/BEGIN ATTESTED SE[T]/,/END ATTESTED SE[T]/p' \
          #           devbox.d/playwright-libs/flake.nix) \
          #        <(sed -n '/BEGIN ATTESTED SE[T]/,/END ATTESTED SE[T]/p' \
          #           /home/rodrigo/Workspace/github.com/rbelem/devbox-global/devbox.d/wigolo-git/flake.nix)
          default = pkgs.buildEnv {
            name = "playwright-chromium-deps";
            paths = with pkgs; [
              glib.out
              nspr
              nss
              at-spi2-core
              dbus.lib
              alsa-lib
              cairo
              cups.lib
              expat
              libgbm
              pango.out
              systemdMinimal
              libx11
              libxcb
              libxcomposite
              libxdamage
              libxext
              libxfixes
              libxrandr
              libxkbcommon
            ];
            pathsToLink = [ "/lib" ];
            ignoreCollisions = true;
          };
        }
      );
    };
}
