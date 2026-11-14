import { config } from './config.js';
import { createApp } from './app.js';

const app = createApp();
app.listen(config.port, () => {
  console.log(`Campus Rooms listening on http://localhost:${config.port}`);
  console.log(`  student app: /    admin console: /admin.html`);
});
