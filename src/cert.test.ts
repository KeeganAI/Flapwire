import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import forge from "node-forge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCertStore, resolveCertDir } from "./cert.js";

describe("resolveCertDir", () => {
  // path.join uses the platform separator, so the expected values follow it
  // — `/tmp/xdg/flapwire` on Unix, `\tmp\xdg\flapwire` on Windows.
  it("honours XDG_CONFIG_HOME when set", () => {
    const dir = resolveCertDir({ XDG_CONFIG_HOME: "/tmp/xdg" }, "/home/alice");
    expect(dir).toBe(join("/tmp/xdg", "flapwire"));
  });

  it("falls back to ~/.config/flapwire when XDG_CONFIG_HOME is unset", () => {
    const dir = resolveCertDir({}, "/home/alice");
    expect(dir).toBe(join("/home/alice", ".config", "flapwire"));
  });

  it("treats an empty XDG_CONFIG_HOME the same as unset", () => {
    const dir = resolveCertDir({ XDG_CONFIG_HOME: "" }, "/home/alice");
    expect(dir).toBe(join("/home/alice", ".config", "flapwire"));
  });
});

describe("createCertStore", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "flapwire-cert-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("generates a CA and persists it on first run", () => {
    const store = createCertStore({ dir: workDir });
    expect(existsSync(store.caPath)).toBe(true);
    expect(existsSync(store.caKeyPath)).toBe(true);
    expect(store.ca.cert).toMatch(/BEGIN CERTIFICATE/);
    expect(store.ca.key).toMatch(/BEGIN RSA PRIVATE KEY/);
  });

  it("reuses the persisted CA on subsequent runs", () => {
    const first = createCertStore({ dir: workDir });
    const second = createCertStore({ dir: workDir });
    expect(second.ca.cert).toBe(first.ca.cert);
    expect(second.ca.key).toBe(first.ca.key);
  });

  it("issues a leaf cert signed by the CA for a given hostname", () => {
    const store = createCertStore({ dir: workDir });
    const leaf = store.leafFor("example.com");

    const caCert = forge.pki.certificateFromPem(store.ca.cert);
    const leafCert = forge.pki.certificateFromPem(leaf.cert);

    const store2 = forge.pki.createCaStore([caCert]);
    const verified = forge.pki.verifyCertificateChain(store2, [leafCert]);
    expect(verified).toBe(true);
  });

  it("puts the hostname in a DNS SAN for a domain name", () => {
    const store = createCertStore({ dir: workDir });
    const leaf = store.leafFor("api.example.com");
    const cert = forge.pki.certificateFromPem(leaf.cert);
    const san = cert.getExtension("subjectAltName") as {
      altNames: { type: number; value?: string; ip?: string }[];
    } | null;
    expect(san).not.toBeNull();
    const names = (san as { altNames: { type: number; value?: string; ip?: string }[] }).altNames;
    expect(names).toContainEqual(expect.objectContaining({ type: 2, value: "api.example.com" }));
  });

  it("puts the address in an IP SAN for an IPv4 literal", () => {
    const store = createCertStore({ dir: workDir });
    const leaf = store.leafFor("127.0.0.1");
    const cert = forge.pki.certificateFromPem(leaf.cert);
    const san = cert.getExtension("subjectAltName") as {
      altNames: { type: number; value?: string; ip?: string }[];
    } | null;
    const names = (san as { altNames: { type: number; value?: string; ip?: string }[] }).altNames;
    expect(names).toContainEqual(expect.objectContaining({ type: 7, ip: "127.0.0.1" }));
  });

  it("caches leaves per hostname so repeated lookups reuse the same cert", () => {
    const store = createCertStore({ dir: workDir });
    const a = store.leafFor("example.com");
    const b = store.leafFor("example.com");
    expect(b).toBe(a);
  });
});
