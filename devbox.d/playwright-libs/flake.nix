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
