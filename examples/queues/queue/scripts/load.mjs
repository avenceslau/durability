#!/usr/bin/env node
/**
 * Sends messages to a queue at a steady rate, so the dashboard has something
 * to show and the autoscaler something to react to.
 *
 *   PRODUCER_TOKEN=... node scripts/load.mjs https://<worker> <queue> \
 *     --rate 200 --keys 50 --seconds 60
 *
 * For a Worker behind Cloudflare Access, also set
 * CF_ACCESS_TOKEN="$(cloudflared access token -app=https://<worker>)".
 */
import { parseArgs } from 'node:util';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    rate: { type: 'string', default: '100' },
    keys: { type: 'string', default: '20' },
    seconds: { type: 'string', default: '30' },
  },
});
const [origin, queue] = positionals;
const token = process.env.PRODUCER_TOKEN;
const accessToken = process.env.CF_ACCESS_TOKEN;
if (!origin || !queue || !token) {
  console.error(
    'Usage: PRODUCER_TOKEN=... node scripts/load.mjs <origin> <queue> [--rate n] [--keys n] [--seconds n]'
  );
  process.exit(1);
}

const rate = Number(values.rate);
const keys = Number(values.keys);
const seconds = Number(values.seconds);
const batchesPerSecond = 10;
const batchSize = Math.max(1, Math.round(rate / batchesPerSecond));
const counters = new Map();
let accepted = 0;
let rejected = 0;
let failed = 0;
let firstFailure;

// A send has one key, so each batch is one key's next messages.
const sendBatch = async () => {
  const key = `key-${Math.floor(Math.random() * keys)}`;
  const messages = Array.from({ length: batchSize }, () => {
    const sequence = (counters.get(key) ?? 0) + 1;
    counters.set(key, sequence);
    return { body: { sequence, sentAt: Date.now() } };
  });
  try {
    const response = await fetch(`${origin}/queues/${queue}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(accessToken ? { 'cf-access-token': accessToken } : {}),
      },
      body: JSON.stringify({ key, messages }),
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error(
        `redirected to ${response.headers.get('Location')}; behind Cloudflare Access, set CF_ACCESS_TOKEN`
      );
    }
    const outcome = await response.json();
    if (outcome.accepted === true) {
      accepted += messages.length;
    } else if (outcome.accepted === false) {
      rejected += messages.length;
    } else {
      failed += messages.length;
    }
  } catch (error) {
    failed += messages.length;
    firstFailure ??= error instanceof Error ? error.message : String(error);
  }
};

const startedAt = Date.now();
const timer = setInterval(() => {
  void sendBatch();
}, 1_000 / batchesPerSecond);
const progress = setInterval(() => {
  const elapsed = Math.round((Date.now() - startedAt) / 1_000);
  console.log(
    `${elapsed}s  accepted ${accepted}  rejected ${rejected}  failed ${failed}`
  );
}, 5_000);

setTimeout(() => {
  clearInterval(timer);
  clearInterval(progress);
  console.log(
    `Done: accepted ${accepted}, rejected ${rejected}, failed ${failed}${firstFailure ? ` (first failure: ${firstFailure})` : ''}`
  );
}, seconds * 1_000);
