import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('./dist/', import.meta.url));
const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'};
const port = Number(process.env.PORT || 4173);
createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) {res.writeHead(403);res.end();return;}
    if (!(await stat(file)).isFile()) throw new Error('not a file');
    res.writeHead(200, {'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control':'no-store'});
    res.end(await readFile(file));
  } catch {res.writeHead(404);res.end('Not found');}
}).listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${port}`));
