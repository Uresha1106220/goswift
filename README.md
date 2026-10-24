# ◉ GoSwift — Defense-Grade Traffic Intelligence System

> Signal-aware routing, arrival-uncertainty bands (P50/P90), time-dependent departure optimization, and in-car tactical navigation HUD.

![GoSwift HUD](https://img.shields.io/badge/Status-Operational-brightgreen)
![Python](https://img.shields.io/badge/Backend-FastAPI-blue)
![Frontend](https://img.shields.io/badge/Frontend-Vanilla%20JS%20%2B%20Leaflet-orange)
![License](https://img.shields.io/badge/License-MIT-green)

---

## 🚀 Key Advantages Over Consumer Maps

| Feature | Consumer Maps (e.g. Google Maps) | GoSwift Defense Edge |
|---|---|---|
| **Signal Timing** | Hidden / nonexistent | 3-tier signal engine (Official, Learned, Webster Modeled) with live countdowns & lane guidance |
| **ETA Output** | Single deterministic number | Full probability distribution: **P50 Typical** & **P90 Worst-Case** uncertainty range |
| **Telemetry & Privacy** | Telemetry sent to 3rd-party cloud | Air-gap capable (`OFFLINE=1`), zero telemetry leakage, self-hostable |
| **Mission Profiles** | Single-vehicle consumer routes | Convoy Mode (staggered departures, vehicle separation), Avoid-Zones, Audit Trail |
| **Departure Optimization** | Fixed arrival estimate | Dynamic 120-minute time-dependent departure sweep with departure charts |

---

## 📱 Responsive In-Car Navigation HUD

Designed for high-stress, tactical environments with responsive support for smartphones, tablets, and command center monitors:
- **Top-Left Turn Card:** Dynamic turn maneuver (`↰`, `↱`, `⬆`), distance, and street name.
- **Top-Right Speedometer:** Circular digital gauge (`24` km/h), speed limit sign (`50` / `60`), and speed camera radar warning badges.
- **Roadside Traffic Light & Lane Guidance:** Floating signal pills on the road showing live phase countdowns (`(24)` green or `(32)` red) + lane indicators (`↑ ↑ ↑ ↱`).
- **3D Vehicle Follow Marker:** Sleek red tactical vehicle marker with dynamic heading bearing.
- **Bottom-Left Mini-Map Radar:** Picture-in-picture circular overview widget showing overall route progression.
- **Floating Bottom Navigation Dock:** 🔍 Quick search, Duration (`4 min`), Arrival time (`16:16`), Remaining distance (`1.6 km`), and ☰ Tactical Drawer.
- **Dual Visual Modes:** 
  - ☀️ **Day Mode:** High-contrast crisp light map theme.
  - 🌙 **Night Mode:** Tactical dark glass theme with electric cyan & glowing indicators.
- **Drive Simulation Mode (`▶`):** Live navigation simulation demonstrating real-time vehicle movement, speed changes, and countdown progression.

---

## 🔐 Default Credentials

| Username | Password | Role | Permissions |
|---|---|---|---|
| `admin` | `goswift` | Administrator | Full access: Audit logs, avoid-zones, corridors, system controls |
| `operator` | `operator123` | Operator | Routing, convoy planning, departure sweep, signals |

---

## 🛠️ Architecture

```
goswift/
├── app.py           # Backend: API gateway, predictor, optimizer, signal engine, security
├── index.html       # UI structure & Responsive In-Car HUD layout
├── style.css        # Command-center & HUD styling (Day & Night themes)
├── app.js           # MapLibre/Leaflet logic, HUD animations, geocoding autocomplete, charts
├── api/index.py     # Vercel Serverless Function entrypoint
├── vercel.json      # Vercel deployment configuration
└── requirements.txt # Python dependencies
```

---

## ☁️ Deploying to Vercel

1. Push this repository to GitHub.
2. Go to [Vercel Dashboard](https://vercel.com/dashboard) and click **"Add New Project"**.
3. Import your `goswift` repository.
4. Click **Deploy**. Vercel will automatically build the Python Serverless Function and host the static UI.

---

## 💻 Running Locally

```bash
# Clone the repository
git clone https://github.com/Uresha1106220/goswift.git
cd goswift

# Install dependencies
pip install -r requirements.txt

# Run the server on port 7000
python app.py
```
Open **`http://localhost:7000`** in your browser.
