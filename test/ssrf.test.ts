import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { fetch } from 'undici';
import { assertAcceptableUrl, createSafeAgent, isPrivateAddress, UnsafeUrlError } from '../src/ssrf.js';

describe('SSRF guards', () => {
  it('knows which addresses are private', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.5.4', '192.168.1.1', '169.254.169.254', '::1', 'fd12::1', '::ffff:127.0.0.1']) {
      assert.equal(isPrivateAddress(address), true, address);
    }
    for (const address of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) {
      assert.equal(isPrivateAddress(address), false, address);
    }
  });

  it('rejects obviously bad URLs at registration', () => {
    assert.throws(() => assertAcceptableUrl('http://example.com/hook'), UnsafeUrlError);
    assert.throws(() => assertAcceptableUrl('https://169.254.169.254/latest/meta-data/'), UnsafeUrlError);
    assert.throws(() => assertAcceptableUrl('https://user:pass@example.com/hook'), UnsafeUrlError);
    assert.equal(assertAcceptableUrl('https://example.com/hook').hostname, 'example.com');
  });

  it('refuses to connect to a hostname that resolves to a private address', async () => {
    const server = createServer((_req, res) => res.end('internal secrets'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      // "localhost" passes the registration check (it's a name), but resolves to 127.0.0.1.
      await assert.rejects(
        fetch(`http://localhost:${port}/`, { dispatcher: createSafeAgent() }),
        (err: Error) => err.cause instanceof UnsafeUrlError,
      );
      const permissive = createSafeAgent({ allowPrivate: true });
      const allowed = await fetch(`http://localhost:${port}/`, { dispatcher: permissive });
      assert.equal(await allowed.text(), 'internal secrets');
      await permissive.close();
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
