import { describe, expect, it } from "vitest";
import { type TrustRunner, installTrust, uninstallTrust } from "./trust.js";

interface ExecCall {
  cmd: string;
  args: string[];
}

function makeRunner(overrides: Partial<TrustRunner>): TrustRunner & {
  execCalls: ExecCall[];
  copyCalls: { src: string; dest: string }[];
  unlinkCalls: string[];
} {
  const execCalls: ExecCall[] = [];
  const copyCalls: { src: string; dest: string }[] = [];
  const unlinkCalls: string[] = [];
  return {
    platform: "linux",
    isElevated: () => false,
    pathExists: () => false,
    exec: async (cmd, args) => {
      execCalls.push({ cmd, args });
      return { code: 0, stderr: "" };
    },
    copyFile: (src, dest) => {
      copyCalls.push({ src, dest });
    },
    unlink: (p) => {
      unlinkCalls.push(p);
    },
    ...overrides,
    execCalls,
    copyCalls,
    unlinkCalls,
  } as TrustRunner & {
    execCalls: ExecCall[];
    copyCalls: { src: string; dest: string }[];
    unlinkCalls: string[];
  };
}

describe("installTrust on macOS", () => {
  it("returns needs-elevation when not running as root", async () => {
    const runner = makeRunner({ platform: "darwin", isElevated: () => false });
    const result = await installTrust("/tmp/ca.pem", runner);
    expect(result.action).toBe("needs-elevation");
    expect(runner.execCalls).toHaveLength(0);
    expect(result.commands[0]).toContain("security add-trusted-cert");
    expect(result.commands[0]).toContain("/tmp/ca.pem");
  });

  it("runs `security add-trusted-cert` when elevated", async () => {
    const runner = makeRunner({ platform: "darwin", isElevated: () => true });
    const result = await installTrust("/tmp/ca.pem", runner);
    expect(result.action).toBe("installed");
    expect(runner.execCalls).toEqual([
      {
        cmd: "security",
        args: [
          "add-trusted-cert",
          "-d",
          "-r",
          "trustRoot",
          "-k",
          "/Library/Keychains/System.keychain",
          "/tmp/ca.pem",
        ],
      },
    ]);
  });

  it("surfaces security failures as unsupported with stderr", async () => {
    const runner = makeRunner({
      platform: "darwin",
      isElevated: () => true,
      exec: async () => ({ code: 1, stderr: "keychain locked" }),
    });
    const result = await installTrust("/tmp/ca.pem", runner);
    expect(result.action).toBe("unsupported");
    expect(result.message).toContain("keychain locked");
  });
});

describe("installTrust on Linux", () => {
  it("uses update-ca-certificates when Debian-style tools are present", async () => {
    const runner = makeRunner({
      platform: "linux",
      isElevated: () => true,
      pathExists: (p) => p === "/usr/sbin/update-ca-certificates",
    });
    const result = await installTrust("/tmp/ca.pem", runner);
    expect(result.action).toBe("installed");
    expect(runner.copyCalls).toEqual([
      { src: "/tmp/ca.pem", dest: "/usr/local/share/ca-certificates/flapwire.crt" },
    ]);
    expect(runner.execCalls).toEqual([{ cmd: "/usr/sbin/update-ca-certificates", args: [] }]);
  });

  it("uses update-ca-trust when RHEL-style tools are present", async () => {
    const runner = makeRunner({
      platform: "linux",
      isElevated: () => true,
      pathExists: (p) => p === "/usr/bin/update-ca-trust",
    });
    const result = await installTrust("/tmp/ca.pem", runner);
    expect(result.action).toBe("installed");
    expect(runner.copyCalls).toEqual([
      { src: "/tmp/ca.pem", dest: "/etc/pki/ca-trust/source/anchors/flapwire.pem" },
    ]);
    expect(runner.execCalls).toEqual([{ cmd: "/usr/bin/update-ca-trust", args: [] }]);
  });

  it("returns needs-elevation on Debian without root", async () => {
    const runner = makeRunner({
      platform: "linux",
      isElevated: () => false,
      pathExists: (p) => p === "/usr/sbin/update-ca-certificates",
    });
    const result = await installTrust("/tmp/ca.pem", runner);
    expect(result.action).toBe("needs-elevation");
    expect(runner.copyCalls).toHaveLength(0);
    expect(runner.execCalls).toHaveLength(0);
  });

  it("returns unsupported when neither tool is available", async () => {
    const runner = makeRunner({
      platform: "linux",
      isElevated: () => true,
      pathExists: () => false,
    });
    const result = await installTrust("/tmp/ca.pem", runner);
    expect(result.action).toBe("unsupported");
  });

  it("returns needs-elevation on RHEL without root", async () => {
    const runner = makeRunner({
      platform: "linux",
      isElevated: () => false,
      pathExists: (p) => p === "/usr/bin/update-ca-trust",
    });
    const result = await installTrust("/tmp/ca.pem", runner);
    expect(result.action).toBe("needs-elevation");
    expect(runner.copyCalls).toHaveLength(0);
    expect(runner.execCalls).toHaveLength(0);
  });

  it("surfaces update-ca-certificates failure as unsupported with stderr", async () => {
    const runner = makeRunner({
      platform: "linux",
      isElevated: () => true,
      pathExists: (p) => p === "/usr/sbin/update-ca-certificates",
      exec: async () => ({ code: 2, stderr: "hash collision" }),
    });
    const result = await installTrust("/tmp/ca.pem", runner);
    expect(result.action).toBe("unsupported");
    expect(result.message).toContain("hash collision");
  });
});

describe("installTrust on Windows", () => {
  it("surfaces the certutil command and asks for elevation", async () => {
    const runner = makeRunner({ platform: "win32", isElevated: () => false });
    const result = await installTrust("C:\\ca.pem", runner);
    expect(result.action).toBe("needs-elevation");
    expect(result.commands[0]).toBe("certutil -addstore -f ROOT C:\\ca.pem");
    expect(runner.execCalls).toHaveLength(0);
  });
});

describe("uninstallTrust", () => {
  it("on macOS, runs security delete-certificate by common name", async () => {
    const runner = makeRunner({ platform: "darwin", isElevated: () => true });
    const result = await uninstallTrust(runner);
    expect(result.action).toBe("uninstalled");
    expect(runner.execCalls[0]?.cmd).toBe("security");
    expect(runner.execCalls[0]?.args).toContain("Flapwire Local CA");
  });

  it("on macOS, treats a non-zero exit as already-absent (cert wasn't there)", async () => {
    const runner = makeRunner({
      platform: "darwin",
      isElevated: () => true,
      exec: async () => ({ code: 44, stderr: "not found" }),
    });
    const result = await uninstallTrust(runner);
    expect(result.action).toBe("already-absent");
  });

  it("on Debian Linux with the anchor missing, skips the update step", async () => {
    const runner = makeRunner({
      platform: "linux",
      isElevated: () => true,
      pathExists: (p) => p === "/usr/sbin/update-ca-certificates",
    });
    const result = await uninstallTrust(runner);
    expect(result.action).toBe("already-absent");
    expect(runner.execCalls).toHaveLength(0);
    expect(runner.unlinkCalls).toHaveLength(0);
  });

  it("on Debian Linux with the anchor present, unlinks and refreshes", async () => {
    const runner = makeRunner({
      platform: "linux",
      isElevated: () => true,
      pathExists: (p) =>
        p === "/usr/sbin/update-ca-certificates" ||
        p === "/usr/local/share/ca-certificates/flapwire.crt",
    });
    const result = await uninstallTrust(runner);
    expect(result.action).toBe("uninstalled");
    expect(runner.unlinkCalls).toEqual(["/usr/local/share/ca-certificates/flapwire.crt"]);
    expect(runner.execCalls).toEqual([{ cmd: "/usr/sbin/update-ca-certificates", args: [] }]);
  });

  it("on Debian Linux without root, asks for elevation before touching the FS", async () => {
    const runner = makeRunner({
      platform: "linux",
      isElevated: () => false,
      pathExists: (p) =>
        p === "/usr/sbin/update-ca-certificates" ||
        p === "/usr/local/share/ca-certificates/flapwire.crt",
    });
    const result = await uninstallTrust(runner);
    expect(result.action).toBe("needs-elevation");
    expect(runner.unlinkCalls).toHaveLength(0);
    expect(runner.execCalls).toHaveLength(0);
  });

  it("on RHEL Linux with the anchor present, unlinks and refreshes", async () => {
    const runner = makeRunner({
      platform: "linux",
      isElevated: () => true,
      pathExists: (p) =>
        p === "/usr/bin/update-ca-trust" || p === "/etc/pki/ca-trust/source/anchors/flapwire.pem",
    });
    const result = await uninstallTrust(runner);
    expect(result.action).toBe("uninstalled");
    expect(runner.unlinkCalls).toEqual(["/etc/pki/ca-trust/source/anchors/flapwire.pem"]);
    expect(runner.execCalls).toEqual([{ cmd: "/usr/bin/update-ca-trust", args: [] }]);
  });

  it("on Linux without any supported trust tool, returns unsupported", async () => {
    const runner = makeRunner({
      platform: "linux",
      isElevated: () => true,
      pathExists: () => false,
    });
    const result = await uninstallTrust(runner);
    expect(result.action).toBe("unsupported");
  });

  it("on Windows, surfaces the certutil delstore command for elevated shell", async () => {
    const runner = makeRunner({ platform: "win32" });
    const result = await uninstallTrust(runner);
    expect(result.action).toBe("needs-elevation");
    expect(result.commands[0]).toBe("certutil -delstore ROOT Flapwire Local CA");
    expect(runner.execCalls).toHaveLength(0);
  });

  it("on an unknown platform, returns unsupported with a message naming it", async () => {
    const runner = makeRunner({ platform: "freebsd" as NodeJS.Platform });
    const result = await uninstallTrust(runner);
    expect(result.action).toBe("unsupported");
    expect(result.message).toContain("freebsd");
  });
});

describe("installTrust on unknown platforms", () => {
  it("returns unsupported with a message naming the platform", async () => {
    const runner = makeRunner({ platform: "openbsd" as NodeJS.Platform });
    const result = await installTrust("/tmp/ca.pem", runner);
    expect(result.action).toBe("unsupported");
    expect(result.message).toContain("openbsd");
  });
});
