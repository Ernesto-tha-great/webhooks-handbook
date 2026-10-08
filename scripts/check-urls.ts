/**
 * Runs some webhook URLs past both SSRF checks: the one when a customer
 * registers a URL, and the one when the dispatcher actually connects.
 *
 *   npm run check-urls
 */
import { fetch } from 'undici';
import { assertAcceptableUrl, createSafeAgent } from '../src/ssrf';

console.log('When a customer registers the URL:');
for (const url of [
  'https://hooks.example.com/webhooks',
  'http://hooks.example.com/webhooks',
  'https://admin:hunter2@hooks.example.com/webhooks',
  'https://169.254.169.254/latest/meta-data/',
  'https://[::ffff:127.0.0.1]/',
  'https://localhost/webhooks',
]) {
  try {
    assertAcceptableUrl(url);
    console.log(`  ✓ ${url}`);
  } catch (err) {
    console.log(`  ✗ ${url}: ${(err as Error).message}`);
  }
}

// localhost got through, because it's a name and not an IP. So let's try to connect to it.
console.log('\nWhen the dispatcher connects:');
const url = 'https://localhost/webhooks';
try {
  await fetch(url, { dispatcher: createSafeAgent() });
  console.log(`  ✓ ${url}`);
} catch (err) {
  const cause = (err as Error).cause;
  console.log(`  ✗ ${url}: ${cause instanceof Error ? cause.message : (err as Error).message}`);
}
