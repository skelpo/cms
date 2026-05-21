// Twin benchmark server — identical source, two execution modes.
//   Node:  npx tsx src/server.ts
//   Perry: perry compile src/server.ts -o dist/bench-twin
//
// Uses Fastify so both runtimes share the same surface. Perry has a
// native Rust impl of Fastify (perry-stdlib); Node uses the npm package.
//
// Endpoints exercise different hotspots:
//   /healthz   — routing + tiny JSON
//   /json      — JSON serialization of a ~1KB nested object
//   /loop      — CPU work (sum of i*i for i in [0, 10_000))
//   /text      — ~14 KB text payload
//   /headers   — read header, set 2 headers, 204 no-content

import Fastify from 'fastify';

const samplePayload = {
  id: 'twin-bench-payload-001',
  name: 'Bench fixture',
  version: '0.0.1',
  created: '2026-05-21T00:00:00Z',
  tags: ['perry', 'node', 'fastify', 'bench', 'twin'],
  meta: {
    runtime: 'twin',
    workload: 'json',
    notes: 'identical source compiled two ways',
    weights: { routing: 1, serialization: 5, allocation: 3 },
  },
  items: [
    { sku: 'A-001', title: 'Widget A', price: 1299, stock: 42, rating: 4.7 },
    { sku: 'A-002', title: 'Widget B', price: 1599, stock: 18, rating: 4.3 },
    { sku: 'A-003', title: 'Widget C', price: 899, stock: 73, rating: 4.5 },
    { sku: 'A-004', title: 'Widget D', price: 2099, stock: 5, rating: 4.9 },
    { sku: 'A-005', title: 'Widget E', price: 499, stock: 200, rating: 4.1 },
    { sku: 'A-006', title: 'Widget F', price: 1799, stock: 12, rating: 4.6 },
    { sku: 'A-007', title: 'Widget G', price: 999, stock: 60, rating: 4.4 },
    { sku: 'A-008', title: 'Widget H', price: 1399, stock: 25, rating: 4.2 },
  ],
  links: {
    self: '/api/v1/bench/twin',
    next: '/api/v1/bench/twin?page=2',
    docs: 'https://example.com/docs/bench',
  },
};

const textLines: string[] = [];
for (let i = 0; i < 256; i++) {
  textLines.push(
    `line ${String(i).padStart(4, '0')}: the quick brown fox jumps over the lazy dog`,
  );
}
const textPayload = textLines.join('\n');

const app = Fastify({ logger: false });

app.get('/healthz', async () => ({ ok: true }));

app.get('/json', async () => samplePayload);

app.get('/loop', async (_req, reply) => {
  const n = 10_000;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc = (acc + i * i) | 0;
  }
  reply.type('text/plain');
  return String(acc);
});

app.get('/text', async (_req, reply) => {
  reply.type('text/plain');
  return textPayload;
});

app.get('/headers', async (req, reply) => {
  const ua = (req.headers['user-agent'] as string | undefined) ?? '';
  reply.header('x-bench', 'twin');
  reply.header('x-ua-len', String(ua.length));
  reply.code(204);
  return null;
});

const port = Number(process.env.PORT ?? 5050);
const host = process.env.HOST ?? '127.0.0.1';

async function main() {
  await app.listen({ port, host });
  console.log(`twin listening at http://${host}:${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
