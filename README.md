# BROADSIDE HYPERION

**Realistic Physics LAN Party Starship Combat Game**

**BROADSIDE HYPERION** is a browser-based, real-time multiplayer LAN party tactical starship combat game powered by an authoritative 60Hz Node.js + WebSocket physics server. Two rival starships (**Team Alpha — UNS HYPERION** vs. **Team Omega — KRS VANGUARD**) battle across a procedurally generated sector while operated by a 1-to-3 player bridge crew (**Helm**, **Weapons**, **Engineer**) from **Desktop PCs (Keyboard + Mouse)** and **Tablets/iPads (Multi-Touch)**, with a central TV or projector running the cinematic **Spectator Broadcast View (`/spectate`)**.

---

## How to Start the Game

### 1. Prerequisites
- **Node.js** (v18+ recommended)

### 2. Install & Launch the Server
Open a terminal and run:

```bash
cd broadside-hyperion
npm install
npm start
```

*(For development with auto-restart on file changes, run `npm run dev`.)*

When the server starts, it binds to port `3000` (configurable via `PORT=8080 npm start`) and prints the exact local and LAN URLs in your terminal:

```text
============================================================
  BROADSIDE HYPERION — 60Hz Authoritative LAN Server
============================================================
  Local Crew Console:     http://localhost:3000
  Local Spectator TV:     http://localhost:3000/spectate
  LAN Crew Console:       http://<YOUR_LAN_IP>:3000
  LAN Spectator TV:       http://<YOUR_LAN_IP>:3000/spectate
============================================================
```

### 3. Connect Players & Spectator Screen
Zero client installation is required—every device connects through its web browser on the same local Wi-Fi/LAN network:

1. **Central TV / Projector (Optional):** Open `http://<YOUR_LAN_IP>:3000/spectate` for the pure 3D broadcast camera view, slow-motion kill cam, flashing **VICTOR** screen overlay, and corner feed status / match start-restart button.
2. **Crew Devices (Desktop PCs, Laptops, iPads, Android Tablets):** Open `http://<YOUR_LAN_IP>:3000`.
3. **Drydock & Station Selection:**
   - Enter your **Callsign**.
   - Configure your team's **Hull Class** (`Corvette`, `Frigate`, or `Dreadnought`) and **Station Modules** (`Helm`, `Weapons`, `Engineer`).
   - Click any station (**HELM**, **WEAPONS**, or **ENGINEER**) on **UNS HYPERION (Alpha)** or **KRS VANGUARD (Omega)**.
   - Leave **AI Auto-Crew Bots** enabled to automatically pilot, gun, and route power on any unmanned station (allowing 1v1, 2v2, 3v3, or solo co-op vs. AI).
4. **Launch Match:** Click **LAUNCH MATCH** in the Drydock overlay (or **START / DEMO AI MATCH** on `/spectate`). Players can hot-swap between **Helm**, **Weapons**, and **Engineer** at any time during combat using the top header bar.

---

## Controls & Station Guide

### 1. HELM (Pilot Station)
True Newtonian rigid-body flight ($\sum \vec{F} = m\vec{a}$, zero friction in vacuum) with 6 physical off-center RCS thruster banks (`bowPort`, `bowStarboard`, `sternPort`, `sternStarboard`, `dorsalRoll`, `ventralRoll`) generating real linear impulse and torque ($\tau = \vec{r} \times \vec{F}$).
- **Desktop Controls:**
  - `W` / `S` or `Up` / `Down`: Main Drive Forward / Throttle down
  - `Q` / `E`: Strafe Port / Starboard (fires bow + stern RCS thruster banks)
  - `A` / `D` or `Left` / `Right`: Rotate Counter-Clockwise / Clockwise (manual turn disengages auto-orientation)
  - `R` / `[` (Hold): Fire **Ventral Roll RCS (`ventralRoll`)** to roll Port (CCW)
  - `T` / `]` (Hold): Fire **Dorsal Roll RCS (`dorsalRoll`)** to roll Starboard (CW)
  - `X`: **Stop Roll (Roll Damper)** — fires opposing Roll RCS jet to brake roll angular velocity to `0 rad/s`
  - `Z`: Toggle **Automatic Attitude Control (SAS)** PID stabilizer on/off
  - `1`–`4`: **Automatic Orientation Flight Computer:**
    - `1` (`FACE MOTION` / Prograde): Aligns ship bow with velocity vector $+\vec{v}$
    - `2` (`OPP. MOTION` / Retrograde): Aligns ship bow opposite velocity vector $-\vec{v}$ (for flip-and-burn braking)
    - `3` (`FACE ENEMY` / Target): Aligns ship bow toward the enemy ship (if not concealed in an Ion Nebula)
    - `4` (`OPP. ENEMY` / Anti-Target): Aligns ship bow directly away from the enemy ship (if known)
- **Tablet Multi-Touch Controls:**
  - **Left Virtual Thumbstick:** Main Drive thrust + lateral Port/Starboard RCS strafe
  - **Right Virtual Thumbstick:** Rotational RCS torque
  - **Touch Buttons:** `SAS`, `ROLL PORT`, `STOP ROLL`, `ROLL STBD`, and the 4 `AUTO-ORIENT` buttons (`FACE MOTION`, `OPP. MOTION`, `FACE ENEMY`, `OPP. ENEMY`)
- **Thruster Damage Warning:** If an external RCS bank (e.g., `bowPort`) is destroyed or unpowered, strafing will fire only the remaining thruster (`sternPort`), imparting asymmetric torque that spins the ship!

### 2. WEAPONS (Tactical Gunner Station)
All projectiles inherit the firing ship's instantaneous velocity vector ($\vec{v}_{\text{proj}} = \vec{v}_{\text{ship}} + \vec{v}_{\text{muzzle}}$). Aim using the dynamic **Target Lead Reticle**.
- **Desktop Controls:**
  - **Mouse Move:** Aim articulated turrets
  - **Left-Click / `Space`:** Fire **Twin Pulse Lasers** (2.0x shield damage; builds weapon heat dissipated by Engineer's Coolant flow)
  - **Hold Right-Click / `Shift` / `C` & Release:** Charge (1.2s) and fire **Heavy Railgun** (hypersonic slug curved by gravity wells; pierces unshielded hull to damage targeted subsystem and break 1–3 tiles on the enemy Engineer's 10x10 grid)
  - `T`: Launch **Homing Torpedo** (finite magazine rack: `Heavy`, `EMP 3x3 Grid Blackout`, or `Swarm`; lock breaks inside Ion Storm Nebulae)
  - `F`: Detonate **Point-Defense Flak** (200m burst destroys incoming enemy torpedoes and armed tether mines)
  - `1`–`6` or Dropdown: Select pinpoint enemy subsystem target (`bowPort`, `bowStarboard`, `sternPort`, `sternStarboard`, `mainDrive`)
- **Tablet Multi-Touch Controls:**
  - **Touch-Drag on Viewport:** Aim turrets + lead reticle
  - **Touch Buttons:** `PULSE LASER`, hold-and-release `RAILGUN`, `LAUNCH TORPEDO`, and `FLAK BURST`

### 3. ENGINEER (10x10 Conduit Grid & Repair Drones)
Manage a **10x10 rectangular conduit grid (100 tiles)** with a **strictly finite Reactor Power cap** (`Corvette: 10`, `Frigate: 12`, `Dreadnought: 14`).
- **Zero-Waste Power Division Rule:** Available Reactor power divides evenly across *all* currently connected destination subsystems ($P_{\text{each}} = P_{\text{total}} / N_{\text{connected}}$). Leaving idle systems connected (such as `shields_aft`, `cargo_tractor`, or `drone_bay` when no repairs are active) drains power away from active weapons and forward shields!
- **Desktop & Tablet Controls:**
  - **Tap / Click Rotatable Conduit (`Straight`, `Elbow`, `T-Split`):** Rotate tile 90°
  - **Tap / Click Circuit Breaker (`Breaker`):** Open or close breaker to isolate or connect a subsystem branch
  - **Tap / Click Charged Capacitor (`Capacitor`):** Trigger a **+4 Power Surge** for 12 seconds
  - **Drag-to-Assign (or Tap Drone -> Tap Target):** Dispatch a **Repair Drone** to fix a broken/burning 10x10 grid tile OR a damaged ship subsystem button (`bowPort`, `mainDrive`, etc.)
- **Powered Drone Bay Rule:** Repair Drones **only move and repair while the `drone_bay` node on the 10x10 grid is actively receiving power**. Remember to open the `drone_bay` breaker once repairs finish so power isn't wasted!

---

## Sector Hazards & Torpedo Resupply
- **Debris Fields & Tether Mines:** Drifting rigid-body wreckage bounces off hulls and deflects kinetic railgun slugs. Concealed magnetic **Tether Mines** blink red (1Hz) and detonate on proximity (<150m), imparting violent spin impulse and damaging RCS thrusters.
- **Gravity Wells / Micro-Singularities:** Exert inverse-square gravitational pull ($F = G m_1 m_2 / r^2$) on ships, debris, railgun slugs, and torpedoes.
- **Ion Storm Nebulae:** Break homing torpedo locks for ships inside, and periodically trigger static surges that rotate 1–2 conduit tiles on the Engineer's 10x10 grid.
- **Orbital Munitions Derelict (+3 Torpedoes):** Match low relative velocity ($< 15\text{ m/s}$) within 80m of the supply hulk while the Engineer powers the **Cargo Tractor (`cargo_tractor`)** node for 5 continuous seconds to winch aboard **+3 Torpedoes**.

---

## Running Tests

To run the full Vitest unit and integration test suite (165 tests across 9 suites covering physics, 10x10 grid flow, drone power enforcement, combat ballistics, procedural hazards, server room lifecycle, 3D Three.js scene graph, and frontend assets):

```bash
npm test
```
