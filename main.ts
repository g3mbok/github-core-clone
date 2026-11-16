import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (!envUrl) {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set\n');
  process.exit(1);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function postUntilRegistered(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register answered HTTP ${response.status}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('register answered HTTP ')) throw error;
    }
    await sleep(Math.min(2_000, 250 * 2 ** Math.min(attempt, 8)));
  }
}

async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(30_000) });
      if (response.ok && (await response.json() as { done?: unknown }).done === true) return;
    } catch {
      // The environment may still be starting or may have timed out.
    }
    await sleep(Math.min(2_000, 250 * 2 ** Math.min(attempt, 8)));
  }
}

try {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP port was allocated');
  process.stdout.write(`[entry] listening on port ${address.port}\n`);
  await postUntilRegistered(address.port);
  await waitForDone();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  process.exit(0);
} catch (error) {
  process.stderr.write(`[entry] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
