/**
 * BROADSIDE HYPERION — Server Entrypoint
 * Starts the authoritative 60Hz physics and multiplayer LAN server.
 */

import { createAppServer, getLanAddresses } from './server/app.js';

const PORT = Number(process.env.PORT) || 3000;
const useHttps =
  process.argv.includes('--https') ||
  process.env.HTTPS === 'true' ||
  process.env.HTTPS === '1' ||
  Boolean(process.env.SSL_KEY_PATH && process.env.SSL_CERT_PATH);

const { server, protocol, tls } = createAppServer({
  port: PORT,
  listen: true,
  ...(useHttps ? { https: true } : {}),
});

server.on('listening', () => {
  const lanIps = getLanAddresses();
  const address = server.address();
  const boundPort = address && typeof address === 'object' ? address.port : PORT;

  console.log('====================================================');
  console.log('   BROADSIDE HYPERION — Authoritative 60Hz Server   ');
  console.log('====================================================');
  console.log(`Local Access:     ${protocol}://localhost:${boundPort}`);
  console.log(`Spectator View:   ${protocol}://localhost:${boundPort}/spectate`);
  if (protocol === 'https') {
    console.log(`TLS Mode:         HTTPS + WSS (${tls?.source})`);
    console.log(
      `Trust Notice:     Self-signed LAN cert at ${tls?.certPath || 'memory'} — trust/accept once per LAN device for PWA installation`
    );
  }
  console.log('----------------------------------------------------');
  console.log('LAN Party Crew Stations:');
  if (lanIps.length === 0) {
    console.log(`  ${protocol}://localhost:${boundPort}`);
  } else {
    for (const ip of lanIps) {
      console.log(`  Bridge Consoles: ${protocol}://${ip}:${boundPort}`);
      console.log(`  TV / Spectator:  ${protocol}://${ip}:${boundPort}/spectate`);
    }
  }
  console.log('====================================================');
});
