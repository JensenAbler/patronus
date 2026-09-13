import { createServer } from 'node:http';
import { handler } from './app.js';
const server = createServer(handler);
server.listen(Number(process.env.PORT || 3000), '0.0.0.0');
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => process.exit(1), 25000);
  server.close(error => { clearTimeout(deadline); process.exitCode = error ? 1 : 0; });
});
