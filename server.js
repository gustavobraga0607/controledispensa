// Servidor local para desenvolvimento: entrega os arquivos do app e a API (/api/*).
// Em produção a Vercel faz isso sozinha.
//   DATABASE_URL=postgres://... node server.js
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 5173;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.md': 'text/markdown' };
const api = {
  house: (await import('./api/house.js')).default,
  sync: (await import('./api/sync.js')).default,
  ops: (await import('./api/ops.js')).default,
};

http
  .createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    const route = pathname.match(/^\/api\/(\w+)$/);
    if (route) {
      if (!api[route[1]]) return res.writeHead(404).end();
      return api[route[1]](req, res);
    }
    const file = path.join(root, pathname === '/' ? 'index.html' : decodeURIComponent(pathname));
    if (!file.startsWith(root) || /[\\/](api|node_modules|\.git)[\\/]/.test(file.slice(root.length))) return res.writeHead(404).end();
    try {
      const data = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(data);
    } catch {
      res.writeHead(404).end('Não encontrado');
    }
  })
  .listen(port, () => console.log(`Dispensa em http://localhost:${port}`));
