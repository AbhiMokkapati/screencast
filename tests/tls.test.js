const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const WebSocket = require('ws');
const { ensureTls, createCaServer } = require('../src/tls');
const { createApp } = require('../src/app');

const HOSTS = { ips: ['127.0.0.1', '::1', '10.1.2.3'], dns: ['localhost', 'my-pc'] };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sc-tls-test-'));

test('leaf is signed by the CA, covers every IP/host, and is within iOS limits', () => {
  const t = ensureTls(tmp(), HOSTS);
  const leaf = new crypto.X509Certificate(t.cert);
  const ca = new crypto.X509Certificate(t.caDer);
  assert.equal(ca.ca, true);
  assert.equal(leaf.ca, false);
  assert.ok(leaf.verify(ca.publicKey), 'leaf must chain to the CA');
  for (const ip of HOSTS.ips) assert.ok(leaf.checkIP(ip), `SAN covers ${ip}`);
  assert.ok(leaf.checkHost('my-pc'));
  assert.equal(leaf.checkIP('10.9.9.9'), undefined, 'does not cover unrelated IPs');
  const days = (new Date(leaf.validTo) - new Date(leaf.validFrom)) / 86400000;
  assert.ok(days <= 398, `leaf valid ${days} days; iOS requires <= 825`);
  assert.ok(leaf.keyUsage.includes('1.3.6.1.5.5.7.3.1'), 'extended key usage serverAuth');
});

test('CA and leaf are reused across runs; a changed IP set re-issues only the leaf', () => {
  const dir = tmp();
  const a = ensureTls(dir, HOSTS);
  const b = ensureTls(dir, HOSTS);
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(b.cert, a.cert);
  const c = ensureTls(dir, { ips: ['127.0.0.1', '192.168.9.9'], dns: ['localhost'] });
  assert.notEqual(c.cert, a.cert);
  assert.ok(c.caDer.equals(a.caDer), 'CA stays the same so iPads need not re-trust');
  assert.ok(new crypto.X509Certificate(c.cert).checkIP('192.168.9.9'));
});

test('no private key material is in what the server hands out for download', () => {
  const t = ensureTls(tmp(), HOSTS);
  assert.ok(!t.caDer.toString('latin1').includes('PRIVATE KEY'));
  assert.ok(!t.cert.includes('PRIVATE KEY'));
});

test('a client that trusts only the CA can open https and wss to the server', async () => {
  const t = ensureTls(tmp(), HOSTS);
  const { server } = createApp({ token: 'tok', display: {}, handleInput() {}, tls: { key: t.key, cert: t.cert } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const ca = new crypto.X509Certificate(t.caDer).toString();
  try {
    const status = await new Promise((res, rej) => {
      https.get({ host: '127.0.0.1', port, path: '/', ca, servername: 'localhost' }, (r) => { r.resume(); res(r.statusCode); }).on('error', rej);
    });
    assert.ok(status === 200 || status === 404, `https reachable (got ${status})`);

    const ws = new WebSocket(`wss://127.0.0.1:${port}/?t=tok`, { ca, servername: 'localhost' });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    ws.terminate();

    await assert.rejects(new Promise((res, rej) => {
      const req = https.get({ host: '127.0.0.1', port, path: '/', servername: 'localhost' }, res);
      req.on('error', rej);
    }), /self.signed|unable to verify|certificate/i, 'untrusted without the CA');
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

test('CA download server serves the public cert as a download and a help page, nothing else', async () => {
  const t = ensureTls(tmp(), HOSTS);
  const srv = createCaServer(t.caDer);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const get = (p) => new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path: p }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => res({ r, body: Buffer.concat(chunks) }));
    }).on('error', rej);
  });
  try {
    const cer = await get('/ca.cer');
    assert.equal(cer.r.headers['content-type'], 'application/x-x509-ca-cert');
    assert.ok(cer.body.equals(t.caDer));
    assert.match((await get('/')).body.toString(), /Download certificate/);
    assert.equal((await get('/server.key.pem')).r.statusCode, 404);
    assert.equal((await get('/ca.key.pem')).r.statusCode, 404);
  } finally {
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
  }
});
