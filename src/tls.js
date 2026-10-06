/**
 * Local HTTPS for the iPad.
 *
 * Safari only enables WebCodecs (hardware H.264 decode) on secure pages, so the server has to speak
 * HTTPS. A self-signed leaf would need re-trusting every time the PC's IP changes, so instead:
 *   - a local CA is created once (certs/ca.*.pem). The iPad trusts this once.
 *   - a leaf certificate for this machine's current IPs/hostname is (re)issued from it on demand.
 * The CA private key never leaves certs/ (gitignored) and is never served.
 */

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const http   = require('http');
const crypto = require('crypto');
const forge  = require('node-forge');

const DAY_MS = 24 * 60 * 60 * 1000;
const CA_VALID_YEARS = 10;
const LEAF_VALID_DAYS = 397;       // iOS rejects leaf certs valid for more than 825 days
const RENEW_BEFORE_DAYS = 30;

function newKeyPair() {
  // Node's native keygen is far faster than forge's JS implementation.
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicPem:  publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

function serial() { return '01' + crypto.randomBytes(15).toString('hex'); } // positive, 16 bytes

/** Hostnames and IPs the leaf certificate must cover. */
function localHosts() {
  const ips = new Set(['127.0.0.1', '::1']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.internal) continue;
      if (i.family === 'IPv6' && (i.address.toLowerCase().startsWith('fe80') || i.address.includes('%'))) continue;
      ips.add(i.address);
    }
  }
  const dns = new Set(['localhost']);
  const host = os.hostname();
  if (host) dns.add(host.toLowerCase());
  return { ips: [...ips].sort(), dns: [...dns].sort() };
}

function createCa() {
  const keys = newKeyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(keys.publicPem);
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - DAY_MS);
  cert.validity.notAfter  = new Date(Date.now() + CA_VALID_YEARS * 365 * DAY_MS);
  const subject = [{ name: 'commonName', value: 'ScreenCast Local CA' }, { name: 'organizationName', value: 'ScreenCast' }];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(forge.pki.privateKeyFromPem(keys.privatePem), forge.md.sha256.create());
  return { keyPem: keys.privatePem, certPem: forge.pki.certificateToPem(cert) };
}

function issueLeaf(ca, { ips, dns }) {
  const keys = newKeyPair();
  const caCert = forge.pki.certificateFromPem(ca.certPem);
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(keys.publicPem);
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - DAY_MS);
  cert.validity.notAfter  = new Date(Date.now() + LEAF_VALID_DAYS * DAY_MS);
  cert.setSubject([{ name: 'commonName', value: 'ScreenCast' }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [
      ...dns.map((value) => ({ type: 2, value })),
      ...ips.map((ip) => ({ type: 7, ip })),
    ] },
  ]);
  cert.sign(forge.pki.privateKeyFromPem(ca.keyPem), forge.md.sha256.create());
  return { keyPem: keys.privatePem, certPem: forge.pki.certificateToPem(cert) };
}

function readIf(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }
function writePrivate(file, data) { fs.writeFileSync(file, data, { mode: 0o600 }); }

function leafStillGood(leaf, hostsKey, hostsFile) {
  if (!leaf.certPem || !leaf.keyPem || readIf(hostsFile) !== hostsKey) return false;
  try {
    const x = new crypto.X509Certificate(leaf.certPem);
    return new Date(x.validTo).getTime() - Date.now() > RENEW_BEFORE_DAYS * DAY_MS;
  } catch { return false; }
}

/**
 * Returns { key, cert, caDer, created } — TLS options for https.createServer, plus the CA certificate
 * (DER) for the iPad to download. `created` is true when a brand-new CA was made (iPad must trust it).
 */
function ensureTls(dir, hosts = localHosts()) {
  fs.mkdirSync(dir, { recursive: true });
  const caKeyFile = path.join(dir, 'ca.key.pem');
  const caCrtFile = path.join(dir, 'ca.crt.pem');
  const leafKey   = path.join(dir, 'server.key.pem');
  const leafCrt   = path.join(dir, 'server.crt.pem');
  const hostsFile = path.join(dir, 'server.hosts.txt');

  let ca = { keyPem: readIf(caKeyFile), certPem: readIf(caCrtFile) };
  let created = false;
  if (!ca.keyPem || !ca.certPem) {
    ca = createCa();
    writePrivate(caKeyFile, ca.keyPem);
    fs.writeFileSync(caCrtFile, ca.certPem);
    for (const f of [leafKey, leafCrt, hostsFile]) { try { fs.unlinkSync(f); } catch { /* none */ } }
    created = true;
  }

  const hostsKey = JSON.stringify(hosts);
  let leaf = { keyPem: readIf(leafKey), certPem: readIf(leafCrt) };
  if (!leafStillGood(leaf, hostsKey, hostsFile)) {
    leaf = issueLeaf(ca, hosts);
    writePrivate(leafKey, leaf.keyPem);
    fs.writeFileSync(leafCrt, leaf.certPem);
    fs.writeFileSync(hostsFile, hostsKey);
  }

  const caDer = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(forge.pki.certificateFromPem(ca.certPem))).getBytes(), 'binary');
  return { key: leaf.keyPem, cert: leaf.certPem, caDer, created, hosts };
}

const HELP_HTML = (certPath) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>ScreenCast setup</title>
<style>body{font:17px/1.5 -apple-system,system-ui,sans-serif;max-width:34em;margin:2em auto;padding:0 1em}
a.b{display:inline-block;background:#0a84ff;color:#fff;padding:.7em 1.2em;border-radius:10px;text-decoration:none;font-weight:600}</style>
</head><body><h1>ScreenCast: trust this PC</h1>
<p>One-time setup so Safari can use the fast video decoder over HTTPS.</p>
<p><a class="b" href="${certPath}">Download certificate</a></p>
<ol><li>Tap <b>Allow</b> when asked to download a profile.</li>
<li>Open <b>Settings → General → VPN &amp; Device Management</b> (or "Profile Downloaded"), tap <b>ScreenCast Local CA</b>, then <b>Install</b>.</li>
<li>Open <b>Settings → General → About → Certificate Trust Settings</b> and turn on <b>ScreenCast Local CA</b>.</li>
<li>Go back to the <code>https://</code> address printed by the server.</li></ol></body></html>`;

/** Plain-HTTP server that only serves the public CA certificate and setup instructions. */
function createCaServer(caDer) {
  return http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    const common = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
    if (url === '/ca.cer') {
      res.writeHead(200, { ...common, 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="ScreenCast-CA.cer"' });
      res.end(caDer);
    } else if (url === '/') {
      res.writeHead(200, { ...common, 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HELP_HTML('/ca.cer'));
    } else {
      res.writeHead(404, common);
      res.end();
    }
  });
}

module.exports = { ensureTls, createCaServer, localHosts };
