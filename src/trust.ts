import { spawn } from "node:child_process";
import { copyFileSync, existsSync, unlinkSync } from "node:fs";

export type TrustAction =
  | "installed"
  | "uninstalled"
  | "already-present"
  | "already-absent"
  | "needs-elevation"
  | "unsupported";

export interface TrustResult {
  action: TrustAction;
  platform: NodeJS.Platform;
  // What was (or would have been) executed, end-to-end. Useful for logging
  // and for the Windows branch, where we surface the command verbatim and
  // ask the user to run it elevated.
  commands: string[];
  message: string;
}

// The CN we set on the CA in cert.ts. Uninstall matches on this.
export const CA_COMMON_NAME = "Flapwire Local CA";

export interface TrustRunner {
  platform: NodeJS.Platform;
  isElevated: () => boolean;
  exec: (cmd: string, args: string[]) => Promise<{ code: number; stderr: string }>;
  // Returns a list of files that exist on this system — used to detect the
  // Linux flavour (Debian-style vs RHEL-style trust store) without actually
  // touching disk in tests.
  pathExists: (p: string) => boolean;
  copyFile: (src: string, dest: string) => void;
  unlink: (p: string) => void;
}

export const defaultRunner: TrustRunner = {
  platform: process.platform,
  isElevated: () => {
    // On Unix, effective UID 0 = root. Windows has no getuid, so we default to
    // false there; the Windows branch surfaces a manual command anyway.
    if (process.platform === "win32") return false;
    const getuid = process.getuid?.bind(process);
    return typeof getuid === "function" && getuid() === 0;
  },
  exec: (cmd, args) =>
    new Promise((resolve) => {
      const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
      const err: Buffer[] = [];
      child.stderr.on("data", (c: Buffer) => err.push(c));
      child.on("close", (code) =>
        resolve({ code: code ?? 1, stderr: Buffer.concat(err).toString("utf8") }),
      );
      child.on("error", () => resolve({ code: 1, stderr: "spawn error" }));
    }),
  pathExists: (p) => existsSync(p),
  copyFile: (src, dest) => copyFileSync(src, dest),
  unlink: (p) => unlinkSync(p),
};

// Paths used on Linux for the two trust-store conventions. Kept as constants
// so tests can read them back without re-deriving the logic.
const LINUX_DEBIAN_ANCHOR = "/usr/local/share/ca-certificates/flapwire.crt";
const LINUX_DEBIAN_UPDATE = "/usr/sbin/update-ca-certificates";
const LINUX_RHEL_ANCHOR = "/etc/pki/ca-trust/source/anchors/flapwire.pem";
const LINUX_RHEL_UPDATE = "/usr/bin/update-ca-trust";

export async function installTrust(
  caPath: string,
  runner: TrustRunner = defaultRunner,
): Promise<TrustResult> {
  if (runner.platform === "darwin") {
    const cmd = [
      "security",
      "add-trusted-cert",
      "-d",
      "-r",
      "trustRoot",
      "-k",
      "/Library/Keychains/System.keychain",
      caPath,
    ];
    if (!runner.isElevated()) {
      return {
        action: "needs-elevation",
        platform: "darwin",
        commands: [cmd.join(" ")],
        message: "Writing to the system keychain needs admin — re-running with sudo.",
      };
    }
    const r = await runner.exec(cmd[0] as string, cmd.slice(1));
    return r.code === 0
      ? {
          action: "installed",
          platform: "darwin",
          commands: [cmd.join(" ")],
          message: `Installed ${CA_COMMON_NAME} in the system keychain.`,
        }
      : {
          action: "unsupported",
          platform: "darwin",
          commands: [cmd.join(" ")],
          message: `security failed: ${r.stderr.trim() || `exit ${r.code}`}`,
        };
  }

  if (runner.platform === "linux") {
    if (runner.pathExists(LINUX_DEBIAN_UPDATE)) {
      if (!runner.isElevated()) {
        return {
          action: "needs-elevation",
          platform: "linux",
          commands: [`cp ${caPath} ${LINUX_DEBIAN_ANCHOR}`, LINUX_DEBIAN_UPDATE],
          message: "Writing to the system trust store needs root — re-running with sudo.",
        };
      }
      runner.copyFile(caPath, LINUX_DEBIAN_ANCHOR);
      const r = await runner.exec(LINUX_DEBIAN_UPDATE, []);
      return {
        action: r.code === 0 ? "installed" : "unsupported",
        platform: "linux",
        commands: [`cp ${caPath} ${LINUX_DEBIAN_ANCHOR}`, LINUX_DEBIAN_UPDATE],
        message:
          r.code === 0
            ? `Installed ${CA_COMMON_NAME} via update-ca-certificates.`
            : `update-ca-certificates failed: ${r.stderr.trim() || `exit ${r.code}`}`,
      };
    }
    if (runner.pathExists(LINUX_RHEL_UPDATE)) {
      if (!runner.isElevated()) {
        return {
          action: "needs-elevation",
          platform: "linux",
          commands: [`cp ${caPath} ${LINUX_RHEL_ANCHOR}`, LINUX_RHEL_UPDATE],
          message: "Writing to the system trust store needs root — re-running with sudo.",
        };
      }
      runner.copyFile(caPath, LINUX_RHEL_ANCHOR);
      const r = await runner.exec(LINUX_RHEL_UPDATE, []);
      return {
        action: r.code === 0 ? "installed" : "unsupported",
        platform: "linux",
        commands: [`cp ${caPath} ${LINUX_RHEL_ANCHOR}`, LINUX_RHEL_UPDATE],
        message:
          r.code === 0
            ? `Installed ${CA_COMMON_NAME} via update-ca-trust.`
            : `update-ca-trust failed: ${r.stderr.trim() || `exit ${r.code}`}`,
      };
    }
    return {
      action: "unsupported",
      platform: "linux",
      commands: [],
      message:
        "No supported trust-store tool found (update-ca-certificates, update-ca-trust). Install the CA manually.",
    };
  }

  if (runner.platform === "win32") {
    const cmd = ["certutil", "-addstore", "-f", "ROOT", caPath];
    // We never try to elevate on Windows: UAC prompts don't work well from
    // child processes. Surface the command so the user can run it elevated.
    return {
      action: "needs-elevation",
      platform: "win32",
      commands: [cmd.join(" ")],
      message:
        "Open an elevated PowerShell and run the command above to install the CA in the ROOT store.",
    };
  }

  return {
    action: "unsupported",
    platform: runner.platform,
    commands: [],
    message: `Flapwire doesn't know how to install a CA on ${runner.platform}.`,
  };
}

export async function uninstallTrust(runner: TrustRunner = defaultRunner): Promise<TrustResult> {
  if (runner.platform === "darwin") {
    const cmd = [
      "security",
      "delete-certificate",
      "-c",
      CA_COMMON_NAME,
      "/Library/Keychains/System.keychain",
    ];
    if (!runner.isElevated()) {
      return {
        action: "needs-elevation",
        platform: "darwin",
        commands: [cmd.join(" ")],
        message: "Removing from the system keychain needs admin — re-running with sudo.",
      };
    }
    const r = await runner.exec(cmd[0] as string, cmd.slice(1));
    // `security delete-certificate` exits non-zero when the cert isn't present.
    // Treat that as already-absent instead of an error.
    if (r.code === 0) {
      return {
        action: "uninstalled",
        platform: "darwin",
        commands: [cmd.join(" ")],
        message: `Removed ${CA_COMMON_NAME} from the system keychain.`,
      };
    }
    return {
      action: "already-absent",
      platform: "darwin",
      commands: [cmd.join(" ")],
      message: `No ${CA_COMMON_NAME} found in the system keychain.`,
    };
  }

  if (runner.platform === "linux") {
    const anchor = runner.pathExists(LINUX_DEBIAN_UPDATE)
      ? { file: LINUX_DEBIAN_ANCHOR, update: LINUX_DEBIAN_UPDATE }
      : runner.pathExists(LINUX_RHEL_UPDATE)
        ? { file: LINUX_RHEL_ANCHOR, update: LINUX_RHEL_UPDATE }
        : null;
    if (!anchor) {
      return {
        action: "unsupported",
        platform: "linux",
        commands: [],
        message: "No supported trust-store tool found.",
      };
    }
    if (!runner.pathExists(anchor.file)) {
      return {
        action: "already-absent",
        platform: "linux",
        commands: [],
        message: `${anchor.file} is not present.`,
      };
    }
    if (!runner.isElevated()) {
      return {
        action: "needs-elevation",
        platform: "linux",
        commands: [`rm ${anchor.file}`, anchor.update],
        message: "Removing from the system trust store needs root — re-running with sudo.",
      };
    }
    runner.unlink(anchor.file);
    const r = await runner.exec(anchor.update, []);
    return {
      action: r.code === 0 ? "uninstalled" : "unsupported",
      platform: "linux",
      commands: [`rm ${anchor.file}`, anchor.update],
      message:
        r.code === 0
          ? `Removed ${CA_COMMON_NAME} and refreshed the trust store.`
          : `${anchor.update} failed: ${r.stderr.trim() || `exit ${r.code}`}`,
    };
  }

  if (runner.platform === "win32") {
    const cmd = ["certutil", "-delstore", "ROOT", CA_COMMON_NAME];
    return {
      action: "needs-elevation",
      platform: "win32",
      commands: [cmd.join(" ")],
      message: "Open an elevated PowerShell and run the command above to remove the CA.",
    };
  }

  return {
    action: "unsupported",
    platform: runner.platform,
    commands: [],
    message: `Flapwire doesn't know how to uninstall a CA on ${runner.platform}.`,
  };
}
