import { pathToFileURL } from 'node:url';
import { request } from 'node:http';

export async function serverHealthy() {
  try {
    const host = new URL(process.env.MANAGER_PUBLIC_ORIGIN || 'https://phoney.desmos.help').host;
    return await new Promise(resolve => {
      const req = request({ hostname: '127.0.0.1', port: Number(process.env.PORT || 3210), path: '/health', method: 'GET', headers: { Host: host }, agent: false }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { text += chunk; if (text.length > 4096) req.destroy(new Error('Health response too large')); });
        res.on('error', () => resolve(false));
        res.on('end', () => {
          // A database outage uses app reconnection, not a restart loop.
          try { resolve(res.statusCode === 200 && JSON.parse(text).ok === true); }
          catch { resolve(false); }
        });
      });
      req.setTimeout(5000, () => req.destroy(new Error('Health timeout')));
      req.on('error', () => resolve(false));
      req.end();
    });
  } catch { return false; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await serverHealthy() ? 0 : 1;
}
