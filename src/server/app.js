/**
 * BROADSIDE HYPERION — Express 5 HTTP & WebSocket Application Factory
 *
 * Serves static client console assets, /spectate broadcast screen, /api/health endpoint,
 * coordinates low-latency WebSocket messaging, and runs the 60Hz simulation loop
 * with 30Hz state snapshot broadcasting to PC, tablet, and TV clients.
 */

import express from 'express';
import http from 'http';
import https from 'https';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { GameRoom } from './game-room.js';
import { ensureTlsCredentials } from './tls.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultPublicDir = path.resolve(__dirname, '../../public');
const threeBuildDir = path.resolve(__dirname, '../../node_modules/three/build');

/**
 * Returns list of local IPv4 network addresses for LAN party client connection.
 */
export function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

/**
 * Creates and configures HTTP + WebSocket application server.
 *
 * @param {object} [options={}]
 * @param {number} [options.port=3000]
 * @param {GameRoom} [options.room]
 * @param {string} [options.publicDir]
 * @param {boolean} [options.listen=true]
 * @param {boolean} [options.autoStartLoop=true]
 * @returns {object} { app, server, wss, room, close }
 */
export function createAppServer(options = {}) {
  const app = express();
  const room = options.room || new GameRoom();
  const publicDir = options.publicDir || defaultPublicDir;
  const port = options.port !== undefined ? options.port : (process.env.PORT || 3000);

  const httpsOption = options.https !== undefined
    ? options.https
    : (process.env.HTTPS === 'true' || process.env.HTTPS === '1' || Boolean(process.env.SSL_KEY_PATH && process.env.SSL_CERT_PATH));

  let tlsCreds = null;
  let server;
  if (httpsOption) {
    tlsCreds = ensureTlsCredentials(httpsOption, { lanAddresses: getLanAddresses(), env: process.env });
    server = https.createServer({ key: tlsCreds.key, cert: tlsCreds.cert }, app);
  } else {
    server = http.createServer(app);
  }

  app.use(express.json());

  // Serve Three.js vendor library locally
  if (fs.existsSync(threeBuildDir)) {
    app.use('/vendor', express.static(threeBuildDir));
  }

  // Static assets from public/
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir, {
      setHeaders(res, filePath) {
        if (path.basename(filePath) === 'sw.js') {
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.setHeader('Service-Worker-Allowed', '/');
        } else if (filePath.endsWith('.webmanifest')) {
          res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }));
  }

  // Cinematic Spectator View route
  app.get('/spectate', (req, res) => {
    const spectateFile = path.join(publicDir, 'spectate.html');
    if (fs.existsSync(spectateFile)) {
      return res.sendFile(spectateFile);
    }
    // Fallback diegetic spectator view HTML until Phase 5 client files exist
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>BROADSIDE HYPERION — Cinematic Spectator View</title>
  <style>
    body { background: #0b0f19; color: #38bdf8; font-family: monospace; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    h1 { letter-spacing: 0.2em; font-size: 2rem; margin-bottom: 0.5rem; text-shadow: 0 0 10px #38bdf8; }
    p { color: #94a3b8; font-size: 1rem; }
  </style>
</head>
<body>
  <h1>BROADSIDE HYPERION</h1>
  <p>Cinematic Spectator Broadcast Screen</p>
  <p>Authoritative 60Hz Physics Server Active</p>
</body>
</html>`);
  });

  // Health and LAN status endpoint
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      protocol: tlsCreds ? 'https' : 'http',
      state: room.state,
      playerCount: room.players.size,
      lanAddresses: getLanAddresses(),
    });
  });

  // Music playlist endpoint
  app.get('/api/music', (req, res) => {
    const musicDir = path.join(publicDir, 'music');
    try {
      if (!fs.existsSync(musicDir)) {
        return res.json({ tracks: [] });
      }
      const files = fs.readdirSync(musicDir);
      const audioExtRegex = /\.(mp3|ogg|wav|m4a|webm)$/i;
      const audioFiles = files
        .filter(f => audioExtRegex.test(f))
        .sort((a, b) => a.localeCompare(b));
      res.json({
        tracks: audioFiles.map(f => '/music/' + encodeURIComponent(f)),
      });
    } catch (err) {
      res.json({ tracks: [] });
    }
  });

  // WebSocket Server
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    const playerId = 'player_' + Math.random().toString(36).slice(2, 9);
    ws.playerId = playerId;

    const isSpectator = Boolean(typeof req?.url === 'string' && req.url.includes('role=spectator'));
    const defaultName = (isSpectator ? 'Spectator_' : 'Crew_') + playerId.slice(-4);

    // Register player
    const player = room.addPlayer(playerId, defaultName, { isSpectator });

    // Send welcome payload with assigned playerId and initial snapshot
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'welcome',
        playerId,
        player,
        musicOwnerId: room.musicOwnerId,
        snapshot: room.getSnapshot(),
      }));
    }

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        room.handleClientMessage(ws.playerId, msg);
        if (msg.type === 'register_spectator' || msg.type === 'claim_music') {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'music_status',
              musicOwnerId: room.musicOwnerId,
              isMusicOwner: room.musicOwnerId === ws.playerId,
            }));
          }
        }
      } catch (err) {
        // Ignore unparseable client messages
      }
    });

    ws.on('close', () => {
      room.removePlayer(ws.playerId);
    });
  });

  // 60Hz Authoritative Simulation Loop (16.67ms)
  let loopInterval = null;
  let tickCounter = 0;

  const startLoop = () => {
    if (loopInterval) return;
    loopInterval = setInterval(() => {
      room.step(1 / 60);
      tickCounter++;

      // Broadcast snapshot at 30Hz (every 2 simulation ticks)
      if (tickCounter % 2 === 0) {
        if (wss.clients.size > 0) {
          const snapshotPayload = JSON.stringify({
            type: 'snapshot',
            snapshot: room.getSnapshot(),
          });
          for (const client of wss.clients) {
            if (client.readyState === WebSocket.OPEN) {
              client.send(snapshotPayload);
            }
          }
        }
      }
    }, 1000 / 60);
  };

  if (options.autoStartLoop !== false) {
    startLoop();
  }

  // Listen if requested
  if (options.listen !== false) {
    server.listen(port);
  }

  /**
   * Gracefully tears down WebSocket server, HTTP server, and simulation loop.
   */
  const close = () => {
    return new Promise((resolve) => {
      if (loopInterval) {
        clearInterval(loopInterval);
        loopInterval = null;
      }
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch (e) {
          // ignore
        }
      }
      wss.close(() => {
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
        server.close(() => {
          resolve();
        });
      });
    });
  };

  return {
    app,
    server,
    wss,
    room,
    startLoop,
    close,
    protocol: tlsCreds ? 'https' : 'http',
    tls: tlsCreds || null,
  };
}
