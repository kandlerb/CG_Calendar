import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, organizersFromEnv } from './src/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 3000);
const appName = process.env.CG_APP_NAME ?? 'Community Group Calendar';
const dataFile = process.env.CG_DATA_FILE ?? path.join(here, 'data', 'calendar.json');
const organizers = organizersFromEnv();

const { server, auth } = createServer({ dataFile, organizers, appName });

server.listen(port, () => {
  console.log(`${appName} is running at http://localhost:${port}`);
  console.log(`Data file: ${dataFile}`);
  console.log(`Organizers: ${auth.organizerNames().join(', ')}`);
  if (auth.generatedPassword) {
    console.log(
      '\nNo CG_ORGANIZERS were configured, so a temporary organizer was created:\n' +
        `  name:     organizer\n  password: ${auth.generatedPassword}\n` +
        'Set CG_ORGANIZERS in your environment to choose your own organizers.\n',
    );
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
