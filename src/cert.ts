import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import forge from "node-forge";

export interface CertPair {
  cert: string;
  key: string;
}

export interface CertStore {
  dir: string;
  caPath: string;
  caKeyPath: string;
  ca: CertPair;
  leafFor(hostname: string): CertPair;
}

export interface CreateCertStoreOptions {
  dir?: string;
}

// Where we park the local CA. XDG first (most modern tools honour it, macOS
// users often set it), otherwise a plain ~/.config/flapwire. Kept a single
// code path so the test suite can pin it via { dir } without touching env.
export function resolveCertDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0) {
    return join(env.XDG_CONFIG_HOME, "flapwire");
  }
  return join(home, ".config", "flapwire");
}

export function createCertStore(options: CreateCertStoreOptions = {}): CertStore {
  const dir = options.dir ?? resolveCertDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const caPath = join(dir, "ca.pem");
  const caKeyPath = join(dir, "ca-key.pem");

  let ca: CertPair;
  if (existsSync(caPath) && existsSync(caKeyPath)) {
    ca = {
      cert: readFileSync(caPath, "utf8"),
      key: readFileSync(caKeyPath, "utf8"),
    };
  } else {
    ca = generateCa();
    writeFileSync(caPath, ca.cert);
    writeFileSync(caKeyPath, ca.key);
    // Private key is only useful to the current user — mirror the 0600 convention
    // sshd etc. enforce. Best-effort: no-op on Windows where POSIX modes don't apply.
    try {
      chmodSync(caKeyPath, 0o600);
    } catch {}
  }

  // Leaf certs are cheap to regenerate but costly to sign (RSA 2048). The proxy
  // will ask for the same hostnames repeatedly in a session, so we cache per
  // hostname in process memory. Cache is not persisted — CA persists, leaves don't.
  const leafCache = new Map<string, CertPair>();
  const leafFor = (hostname: string): CertPair => {
    const cached = leafCache.get(hostname);
    if (cached) return cached;
    const leaf = signLeaf(ca, hostname);
    leafCache.set(hostname, leaf);
    return leaf;
  };

  return { dir, caPath, caKeyPath, ca, leafFor };
}

// Self-signed root CA, 10-year validity. The private key never leaves disk
// once written. The public cert is what `flapwire trust` later installs in
// the OS trust store — a browser that trusts this cert will trust any leaf
// we sign with it (which is the whole point of terminating TLS in-proxy).
function generateCa(): CertPair {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerialHex();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

  const attrs = [
    { name: "commonName", value: "Flapwire Local CA" },
    { name: "organizationName", value: "Flapwire" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

// Signs a leaf cert for a single hostname. SAN is the only thing modern
// browsers look at — CN is legacy, set only for human-readable output of
// `openssl x509 -text`.
function signLeaf(ca: CertPair, hostname: string): CertPair {
  const caCert = forge.pki.certificateFromPem(ca.cert);
  const caKey = forge.pki.privateKeyFromPem(ca.key);

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerialHex();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

  cert.setSubject([{ name: "commonName", value: hostname }]);
  cert.setIssuer(caCert.subject.attributes);

  // SAN type 2 = DNS, type 7 = IP. The client's SNI (from the TLS handshake)
  // or a literal IP from `Host:` both land here, so dispatch on shape.
  const altName = isIpLiteral(hostname) ? { type: 7, ip: hostname } : { type: 2, value: hostname };
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: [altName] },
  ]);
  cert.sign(caKey, forge.md.sha256.create());

  return {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

// Positive 64-bit serial. The high bit of the leading byte is cleared because
// X.509 serials are DER INTEGERs and a leading 1 bit would encode as negative.
function randomSerialHex(): string {
  const bytes = forge.random.getBytesSync(8);
  const hex = forge.util.bytesToHex(bytes);
  const firstByte = Number.parseInt(hex.slice(0, 2), 16) & 0x7f;
  return firstByte.toString(16).padStart(2, "0") + hex.slice(2);
}

function isIpLiteral(host: string): boolean {
  // v4 is strict enough, v6 is "has at least one colon and no slashes" — good
  // enough for hostname-vs-IP distinction; we're not validating the address.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (host.includes(":") && !host.includes("/")) return true;
  return false;
}
