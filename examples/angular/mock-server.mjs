// Tiny API that always answers 500 with CORS. `node mock-server.mjs` (port 4300).
import http from 'node:http';

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': '*',
  'access-control-expose-headers': 'x-request-id',
};
export function start(port = 4300) {
  const s = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
    res.writeHead(500, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: false, code: 'InternalServerError' }));
  });
  return new Promise((r) => s.listen(port, () => r(s)));
}
if (import.meta.url === `file://${process.argv[1]}`) start().then(() => console.log('mock on 4300'));
