import { describe, expect, test } from "bun:test";
import {
  LAUNCHD_LABEL,
  renderLaunchd,
  renderSystemd,
  unitPath,
} from "../../src/commands/service";

/**
 * The user-service units, rendered: the absolute command, the service
 * marker the daemon reads after an upgrade, the captured `PATH`, and the
 * restart policy that does not restart a daemon that cannot start.
 */

const input = {
  args: [
    "/opt/hyp/bin/hypotenuse",
    "-c",
    "/home/m/My Configs/hyp.toml",
    "daemon",
    "start",
    "--foreground",
  ],
  path: "/opt/homebrew/bin:/usr/bin",
  output: "/home/m/.local/state/hypotenuse/service.log",
};

describe("units", () => {
  test("systemd: quoted ExecStart, restart on failure but not on 78, PATH captured", () => {
    const unit = renderSystemd(input);
    expect(unit).toContain(
      'ExecStart=/opt/hyp/bin/hypotenuse -c "/home/m/My Configs/hyp.toml" daemon start --foreground',
    );
    expect(unit).toContain("Restart=on-failure\n");
    expect(unit).toContain("RestartPreventExitStatus=78\n");
    expect(unit).toContain("Environment=HYPOTENUSE_SERVICE=1\n");
    expect(unit).toContain('Environment="PATH=/opt/homebrew/bin:/usr/bin"\n');
    expect(unit).toContain("WantedBy=default.target");
  });

  test("launchd: each argument a string, KeepAlive on failure, PATH captured", () => {
    const plist = renderLaunchd({ ...input, args: [...input.args, "<&>"] });
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain("    <string>/home/m/My Configs/hyp.toml</string>");
    expect(plist).toContain("<string>&lt;&amp;&gt;</string>");
    expect(plist).toContain("<key>SuccessfulExit</key>\n    <false/>");
    expect(plist).toContain(
      "<key>HYPOTENUSE_SERVICE</key>\n    <string>1</string>",
    );
    expect(plist).toContain("<string>/opt/homebrew/bin:/usr/bin</string>");
    expect(plist).not.toContain("{{");
  });

  test("unit paths per platform; none on Windows", () => {
    expect(unitPath("darwin", { HOME: "/Users/m" })).toBe(
      `/Users/m/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`,
    );
    expect(unitPath("linux", { HOME: "/home/m" })).toBe(
      "/home/m/.config/systemd/user/hypotenuse.service",
    );
    expect(unitPath("linux", { HOME: "/home/m", XDG_CONFIG_HOME: "/x" })).toBe(
      "/x/systemd/user/hypotenuse.service",
    );
    expect(unitPath("win32", { HOME: "C:/Users/m" })).toBeNull();
  });
});
