"""
GoSwift v1.0 — Backend Server
=============================
Defense-grade traffic intelligence system.

Requirements:
    pip install fastapi uvicorn pyjwt

Run:
    python app.py
    # or: uvicorn app:app --host 0.0.0.0 --port 8000 --reload
"""

# ============================================================
# SECTION 1: IMPORTS AND CONFIGURATION
# ============================================================

import os, sys, json, math, time, uuid, hashlib, hmac, secrets, random, statistics
import sqlite3, threading, asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional, List, Dict, Any, Tuple
from functools import wraps, lru_cache
from contextlib import contextmanager

from fastapi import FastAPI, Request, Response, HTTPException, Depends, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
import jwt as pyjwt
import uvicorn
import httpx

# --------------- Environment Config ---------------
SECRET_KEY = os.getenv("GOSWIFT_SECRET_KEY", "goswift-dev-secret-change-in-production")
OFFLINE_MODE = os.getenv("GOSWIFT_OFFLINE", "0") == "1"
TOMTOM_API_KEY = os.getenv("TOMTOM_API_KEY", "z6OWt7WBJOEzT3KDHjlZ3Qln86K0DAx3")
GOOGLE_MAPS_API_KEY = os.getenv("GOOGLE_MAPS_API_KEY", "")   # Set in Vercel env vars
OPENMETEO_ENABLED = os.getenv("OPENMETEO_ENABLED", "1") == "1"
OVERPASS_URL = os.getenv("OVERPASS_URL", "https://maps.mail.ru/osm/tools/overpass/api/interpreter")
OVERPASS_FALLBACK_URL = "https://overpass-api.de/api/interpreter"
if os.getenv("VERCEL"):
    DB_PATH = os.getenv("GOSWIFT_DB_PATH", "/tmp/goswift.db")
    bundled_db = Path(__file__).parent / "goswift.db"
    if bundled_db.exists() and not Path(DB_PATH).exists():
        try:
            import shutil
            shutil.copyfile(bundled_db, DB_PATH)
        except Exception:
            pass
else:
    DB_PATH = os.getenv("GOSWIFT_DB_PATH", str(Path(__file__).parent / "goswift.db"))
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_HOURS = 24
COLLECTOR_INTERVAL_SEC = int(os.getenv("GOSWIFT_COLLECTOR_INTERVAL", "600"))  # 10 min
# Auto-detect: use real APIs if TomTom key is available, otherwise mock
USE_MOCK = OFFLINE_MODE or not TOMTOM_API_KEY
HTTP_TIMEOUT = 15  # seconds for external API calls

BASE_DIR = Path(__file__).parent
START_TIME = time.time()
VERSION = "1.0.0"

# ============================================================
# SECTION 2: FASTAPI APP AND MIDDLEWARE
# ============================================================

app = FastAPI(title="GoSwift", version=VERSION, docs_url="/docs")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --------------- Rate Limiter (in-memory) ---------------
_rate_buckets: Dict[str, List[float]] = {}
RATE_LIMIT = 100  # requests per minute

def check_rate_limit(ip: str):
    now = time.time()
    window = _rate_buckets.setdefault(ip, [])
    _rate_buckets[ip] = [t for t in window if now - t < 60]
    if len(_rate_buckets[ip]) >= RATE_LIMIT:
        raise HTTPException(429, "Rate limit exceeded")
    _rate_buckets[ip].append(now)

# ============================================================
# SECTION 3: DATABASE
# ============================================================

def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL")
    except Exception:
        pass
    conn.execute("PRAGMA foreign_keys=ON")
    return conn

def init_db():
    """Create tables and seed default data."""
    conn = get_db()
    c = conn.cursor()
    c.executescript("""
        CREATE TABLE IF NOT EXISTS speed_samples (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            segment_id TEXT NOT NULL,
            timestamp REAL NOT NULL,
            speed_kmh REAL NOT NULL,
            free_flow_kmh REAL NOT NULL,
            speed_ratio REAL NOT NULL,
            source TEXT DEFAULT 'mock',
            day_of_week INTEGER NOT NULL,
            time_slot INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_speed_seg_slot
            ON speed_samples(segment_id, day_of_week, time_slot);

        CREATE TABLE IF NOT EXISTS signal_observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            signal_id TEXT NOT NULL,
            timestamp REAL NOT NULL,
            phase TEXT,
            duration_s REAL,
            cycle_length_s REAL
        );
        CREATE INDEX IF NOT EXISTS idx_signal_obs
            ON signal_observations(signal_id);

        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            username TEXT,
            action TEXT NOT NULL,
            endpoint TEXT,
            ip TEXT,
            details TEXT
        );

        CREATE TABLE IF NOT EXISTS avoid_zones (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            polygon TEXT NOT NULL,
            penalty REAL DEFAULT 1000.0,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'operator',
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS incidents_cache (
            id TEXT PRIMARY KEY,
            data TEXT NOT NULL,
            fetched_at REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS monitored_corridors (
            segment_id TEXT PRIMARY KEY,
            lat REAL NOT NULL,
            lng REAL NOT NULL,
            road_name TEXT,
            free_flow_kmh REAL DEFAULT 60.0
        );
    """)
    # Default admin user (password: goswift)
    pw_hash = hashlib.sha256("goswift".encode()).hexdigest()
    c.execute(
        "INSERT OR IGNORE INTO users VALUES (?, ?, ?, ?)",
        ("admin", pw_hash, "admin", datetime.now(timezone.utc).isoformat()),
    )
    # Default operator
    op_hash = hashlib.sha256("operator123".encode()).hexdigest()
    c.execute(
        "INSERT OR IGNORE INTO users VALUES (?, ?, ?, ?)",
        ("operator", op_hash, "operator", datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
    conn.close()

# ============================================================
# SECTION 4: AUTHENTICATION & AUDIT
# ============================================================

def hash_password(pw: str) -> str:
    return hashlib.sha256(pw.encode()).hexdigest()

def create_token(username: str, role: str) -> Tuple[str, str]:
    exp = datetime.now(timezone.utc) + timedelta(hours=JWT_EXPIRE_HOURS)
    payload = {"sub": username, "role": role, "exp": exp.timestamp()}
    token = pyjwt.encode(payload, SECRET_KEY, algorithm=JWT_ALGORITHM)
    return token, exp.isoformat()

def decode_token(token: str) -> dict:
    try:
        return pyjwt.decode(token, SECRET_KEY, algorithms=[JWT_ALGORITHM])
    except pyjwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except pyjwt.InvalidTokenError:
        raise HTTPException(401, "Invalid token")

async def get_current_user(request: Request) -> dict:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return decode_token(auth[7:])
    # Allow unauthenticated for dev
    return {"sub": "anonymous", "role": "operator"}

def audit(username: str, action: str, endpoint: str, ip: str, details: str = ""):
    try:
        conn = get_db()
        conn.execute(
            "INSERT INTO audit_log (timestamp, username, action, endpoint, ip, details) VALUES (?,?,?,?,?,?)",
            (datetime.now(timezone.utc).isoformat(), username, action, endpoint, ip, details),
        )
        conn.commit()
        conn.close()
    except Exception:
        pass  # Audit should never crash the app

# ============================================================
# SECTION 5: PROVIDER ADAPTERS  (Real API + mock fallback)
# ============================================================

# Shared async HTTP client (created once, reused)
_http_client: Optional[httpx.AsyncClient] = None

async def get_http_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(timeout=HTTP_TIMEOUT, follow_redirects=True)
    return _http_client


class TomTomProvider:
    """
    Adapter for TomTom Traffic and Routing APIs.
    Calls real TomTom API when key is available, falls back to mock data.
    """

    TOMTOM_BASE = "https://api.tomtom.com"

    @staticmethod
    def _time_of_day_ratio(dt: datetime) -> float:
        """Return a realistic speed ratio based on time of day."""
        h = dt.hour + dt.minute / 60.0
        wd = dt.weekday()  # 0=Mon
        if wd >= 5:  # Weekend
            return 0.75 + random.uniform(0, 0.2)
        if 7.5 <= h <= 9.5:    return 0.3 + random.uniform(0, 0.3)   # morning rush
        if 16.5 <= h <= 19.0:  return 0.25 + random.uniform(0, 0.3)  # evening rush
        if 22 <= h or h <= 6:  return 0.9 + random.uniform(0, 0.1)   # night
        if 10 <= h <= 16:      return 0.7 + random.uniform(0, 0.15)  # midday
        return 0.65 + random.uniform(0, 0.2)

    @staticmethod
    def _generate_path(origin: dict, dest: dict, num_points: int = 15, offset: float = 0.0) -> List[List[float]]:
        """Generate a realistic curved path between two points (mock fallback)."""
        coords = []
        for i in range(num_points + 1):
            t = i / num_points
            lat = origin["lat"] + t * (dest["lat"] - origin["lat"])
            lng = origin["lng"] + t * (dest["lng"] - origin["lng"])
            perp = math.sin(t * math.pi) * (0.005 + offset * 0.008)
            angle = math.atan2(dest["lat"] - origin["lat"], dest["lng"] - origin["lng"])
            lat += perp * math.cos(angle + math.pi / 2)
            lng += perp * math.sin(angle + math.pi / 2)
            lat += random.uniform(-0.001, 0.001)
            lng += random.uniform(-0.001, 0.001)
            coords.append([round(lat, 6), round(lng, 6)])
        return coords

    @staticmethod
    def _haversine(lat1, lng1, lat2, lng2) -> float:
        """Distance in km between two points."""
        R = 6371
        dlat = math.radians(lat2 - lat1)
        dlng = math.radians(lng2 - lng1)
        a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng/2)**2
        return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    @staticmethod
    def _ratio_to_congestion(ratio: float) -> str:
        if ratio > 0.8:  return "free"
        if ratio > 0.6:  return "light"
        if ratio > 0.4:  return "moderate"
        if ratio > 0.2:  return "heavy"
        return "standstill"

    # ----- FLOW SEGMENT DATA (live speeds) -----

    async def get_flow_segment(self, lat: float, lng: float) -> dict:
        """Get current traffic flow data for a road segment."""
        if not USE_MOCK and TOMTOM_API_KEY:
            try:
                client = await get_http_client()
                url = f"{self.TOMTOM_BASE}/traffic/services/4/flowSegmentData/absolute/10/json"
                resp = await client.get(url, params={
                    "point": f"{lat},{lng}",
                    "key": TOMTOM_API_KEY,
                    "unit": "KMPH",
                })
                resp.raise_for_status()
                data = resp.json().get("flowSegmentData", {})
                current = data.get("currentSpeed", 40)
                freeflow = data.get("freeFlowSpeed", 60)
                ratio = current / freeflow if freeflow > 0 else 0.5
                return {
                    "speed_kmh": round(current, 1),
                    "free_flow_kmh": round(freeflow, 1),
                    "speed_ratio": round(ratio, 3),
                    "confidence": round(data.get("confidence", 0.5), 2),
                    "road_closure": data.get("roadClosure", False),
                }
            except Exception as e:
                print(f"[TomTom Flow] API error at ({lat},{lng}): {e}  -> falling back to mock")

        # ---- Mock fallback ----
        now = datetime.now()
        ratio = self._time_of_day_ratio(now)
        free_flow = random.uniform(40, 80)
        return {
            "speed_kmh": round(free_flow * ratio, 1),
            "free_flow_kmh": round(free_flow, 1),
            "speed_ratio": round(ratio, 3),
            "confidence": round(random.uniform(0.7, 1.0), 2),
            "road_closure": False,
        }

    # ----- ROUTING -----

    async def get_route(self, origin: dict, dest: dict, depart_at: Optional[datetime] = None,
                        alternatives: bool = True) -> List[dict]:
        """Get route(s) between origin and destination using TomTom Routing API."""
        dt = depart_at or datetime.now()

        if not USE_MOCK and TOMTOM_API_KEY:
            try:
                client = await get_http_client()
                coords_str = f"{origin['lat']},{origin['lng']}:{dest['lat']},{dest['lng']}"
                url = f"{self.TOMTOM_BASE}/routing/1/calculateRoute/{coords_str}/json"
                params = {
                    "key": TOMTOM_API_KEY,
                    "traffic": "true",
                    "maxAlternatives": 2 if alternatives else 0,
                    "computeTravelTimeFor": "all",
                    "routeRepresentation": "polyline",
                    "sectionType": "traffic",
                    "travelMode": "car",
                }
                # departAt must be in the future for TomTom
                if depart_at and depart_at > datetime.now():
                    params["departAt"] = depart_at.strftime("%Y-%m-%dT%H:%M:%S")

                resp = await client.get(url, params=params)
                resp.raise_for_status()
                api_data = resp.json()

                return self._parse_tomtom_routes(api_data, dt)

            except Exception as e:
                print(f"[TomTom Route] API error: {e}  -> falling back to mock")

        # ---- Mock fallback ----
        return self._mock_routes(origin, dest, dt, alternatives)

    def _parse_tomtom_routes(self, api_data: dict, dt: datetime) -> List[dict]:
        """Parse TomTom Routing API response into GoSwift internal format."""
        colors = ["#4CAF50", "#FF9800", "#2196F3"]
        routes = []
        tt_routes = api_data.get("routes", [])

        # Build a mapping from sectionType=TRAFFIC sections for congestion coloring
        for idx, tt_route in enumerate(tt_routes[:3]):
            summary = tt_route.get("summary", {})
            legs = tt_route.get("legs", [])
            sections = tt_route.get("sections", [])

            # Collect all points from all legs
            all_points = []
            for leg in legs:
                for pt in leg.get("points", []):
                    all_points.append([pt["latitude"], pt["longitude"]])

            if not all_points:
                continue

            # Calculate total distance
            total_dist_m = summary.get("lengthInMeters", 0)
            total_dist_km = total_dist_m / 1000.0

            # Travel times
            travel_s = summary.get("travelTimeInSeconds", 0)
            traffic_delay_s = summary.get("trafficDelayInSeconds", 0)
            no_traffic_s = summary.get("noTrafficTravelTimeInSeconds", travel_s)
            historical_s = summary.get("historicTrafficTravelTimeInSeconds", travel_s)

            # Build traffic-colored segments from sections
            traffic_sections = [s for s in sections if s.get("sectionType") == "TRAFFIC"]
            segments = []

            if traffic_sections:
                for sec in traffic_sections:
                    start_idx = sec.get("startPointIndex", 0)
                    end_idx = sec.get("endPointIndex", len(all_points) - 1)
                    seg_coords = all_points[start_idx:end_idx + 1]
                    if not seg_coords:
                        continue

                    # Map TomTom simpleCategory to our congestion levels
                    cat = sec.get("simpleCategory", "").upper()
                    congestion_map = {
                        "JAM_UNDEFINED": "light",
                        "JAM_LIGHT": "light",
                        "JAM_MODERATE": "moderate",
                        "JAM_HEAVY": "heavy",
                        "JAM_STANDSTILL": "standstill",
                    }
                    congestion = congestion_map.get(cat, "free")
                    ratio_map = {"free": 0.9, "light": 0.7, "moderate": 0.5, "heavy": 0.3, "standstill": 0.1}
                    ratio = ratio_map.get(congestion, 0.6)
                    # Estimate speed from ratio and free-flow
                    ff = (total_dist_km / (no_traffic_s / 3600)) if no_traffic_s > 0 else 60
                    segments.append({
                        "coords": seg_coords,
                        "speed_ratio": round(ratio, 3),
                        "congestion": congestion,
                        "speed_kmh": round(ff * ratio, 1),
                        "free_flow_kmh": round(ff, 1),
                    })
            else:
                # No traffic sections returned — make one big segment
                overall_ratio = (no_traffic_s / travel_s) if travel_s > 0 else 0.7
                overall_ratio = max(0.05, min(1.0, overall_ratio))
                ff = (total_dist_km / (no_traffic_s / 3600)) if no_traffic_s > 0 else 60
                # Split into ~5 segments for visual granularity
                chunk = max(2, len(all_points) // 5)
                for s in range(0, len(all_points) - 1, chunk):
                    seg_coords = all_points[s: s + chunk + 1]
                    r = overall_ratio + random.uniform(-0.05, 0.05)
                    r = max(0.05, min(1.0, r))
                    segments.append({
                        "coords": seg_coords,
                        "speed_ratio": round(r, 3),
                        "congestion": self._ratio_to_congestion(r),
                        "speed_kmh": round(ff * r, 1),
                        "free_flow_kmh": round(ff, 1),
                    })

            # Estimate signal count from distance (heuristic)
            sig_per_km = 2.0 if total_dist_km < 10 else 1.0 if total_dist_km < 30 else 0.5
            sig_count = max(1, int(total_dist_km * sig_per_km))
            sig_delay = sig_count * random.uniform(15, 30)

            # P50 from TomTom travel time; P90 = add padding
            eta_p50 = travel_s / 60.0
            eta_p90 = max(eta_p50, historical_s / 60.0) * 1.25

            departure_str = summary.get("departureTime", dt.isoformat())
            arrival_str = summary.get("arrivalTime", (dt + timedelta(minutes=eta_p50)).isoformat())

            route_name = f"Route {chr(65 + idx)}"
            if idx == 0:
                route_name += " (Fastest)"
            elif traffic_delay_s < 60:
                route_name += " (Low traffic)"
            else:
                route_name += f" (+{traffic_delay_s // 60} min traffic)"

            routes.append({
                "id": f"route-{idx+1}-{uuid.uuid4().hex[:6]}",
                "name": route_name,
                "color": colors[idx % len(colors)],
                "distance_km": round(total_dist_km, 2),
                "segments": segments,
                "eta_p50_minutes": round(eta_p50, 1),
                "eta_p90_minutes": round(eta_p90, 1),
                "signal_count": sig_count,
                "total_signal_delay_s": round(sig_delay, 1),
                "departure_time": departure_str,
                "arrival_p50": arrival_str,
                "arrival_p90": (dt + timedelta(minutes=eta_p90)).isoformat(),
                "confidence": "high",
                "data_source": "live",
            })

        if not routes:
            print("[TomTom Route] No routes parsed from API response, falling back to mock")
            return self._mock_routes(
                {"lat": api_data.get("routes", [{}])[0].get("legs", [{}])[0].get("points", [{}])[0].get("latitude", 28.6)},
                {"lat": 28.4, "lng": 77.0}, dt, True)

        return routes

    def _mock_routes(self, origin: dict, dest: dict, dt: datetime, alternatives: bool) -> List[dict]:
        """Generate mock routes (fallback when API is unavailable)."""
        routes = []
        configs = [
            {"name": "Route A - City Center", "offset": 0.0, "dist_mult": 1.0, "speed_base": 45, "signals_per_km": 2.5},
            {"name": "Route B - Highway", "offset": 1.0, "dist_mult": 1.3, "speed_base": 70, "signals_per_km": 0.5},
        ]
        if alternatives:
            configs.append(
                {"name": "Route C - Alternative", "offset": -0.7, "dist_mult": 1.15, "speed_base": 55, "signals_per_km": 1.5}
            )
        colors = ["#4CAF50", "#FF9800", "#2196F3"]
        for idx, cfg in enumerate(configs):
            coords = self._generate_path(origin, dest, 15 + idx * 3, cfg["offset"])
            total_dist = 0
            for i in range(len(coords) - 1):
                total_dist += self._haversine(coords[i][0], coords[i][1], coords[i+1][0], coords[i+1][1])
            total_dist *= cfg["dist_mult"]
            segments = []
            seg_size = max(2, len(coords) // 5)
            for s in range(0, len(coords) - 1, seg_size):
                seg_coords = coords[s: s + seg_size + 1]
                ratio = self._time_of_day_ratio(dt) + random.uniform(-0.1, 0.1)
                ratio = max(0.05, min(1.0, ratio))
                segments.append({
                    "coords": seg_coords,
                    "speed_ratio": round(ratio, 3),
                    "congestion": self._ratio_to_congestion(ratio),
                    "speed_kmh": round(cfg["speed_base"] * ratio, 1),
                    "free_flow_kmh": round(cfg["speed_base"] * 1.0, 1),
                })
            sig_count = max(1, int(total_dist * cfg["signals_per_km"]))
            sig_delay = sig_count * random.uniform(15, 35)
            travel_h = total_dist / max(1, cfg["speed_base"] * self._time_of_day_ratio(dt))
            eta_p50 = travel_h * 60 + sig_delay / 60
            eta_p90 = eta_p50 * random.uniform(1.2, 1.4)
            routes.append({
                "id": f"route-{idx+1}-{uuid.uuid4().hex[:6]}",
                "name": cfg["name"],
                "color": colors[idx],
                "distance_km": round(total_dist, 2),
                "segments": segments,
                "eta_p50_minutes": round(eta_p50, 1),
                "eta_p90_minutes": round(eta_p90, 1),
                "signal_count": sig_count,
                "total_signal_delay_s": round(sig_delay, 1),
                "departure_time": dt.isoformat(),
                "arrival_p50": (dt + timedelta(minutes=eta_p50)).isoformat(),
                "arrival_p90": (dt + timedelta(minutes=eta_p90)).isoformat(),
                "confidence": "medium",
                "data_source": "model",
            })
        return routes

    # ----- INCIDENTS -----

    async def get_incidents(self, north: float, south: float, east: float, west: float) -> List[dict]:
        """Get traffic incidents in a bounding box from TomTom Incidents API v5."""
        if not USE_MOCK and TOMTOM_API_KEY:
            try:
                client = await get_http_client()
                # TomTom Incident Details v5: bbox = minLng,minLat,maxLng,maxLat
                bbox = f"{west},{south},{east},{north}"
                url = f"{self.TOMTOM_BASE}/traffic/services/5/incidentDetails"
                fields_param = (
                    "{incidents{type,geometry{type,coordinates},"
                    "properties{id,iconCategory,magnitudeOfDelay,events{description,code},"
                    "startTime,endTime,from,to,length,delay,roadNumbers}}}"
                )
                resp = await client.get(url, params={
                    "bbox": bbox,
                    "key": TOMTOM_API_KEY,
                    "fields": fields_param,
                    "language": "en-GB",
                    "categoryFilter": "0,1,2,3,4,5,6,7,8,9,10,11,14",
                    "timeValidityFilter": "present",
                })
                resp.raise_for_status()
                data = resp.json()
                return self._parse_tomtom_incidents(data)

            except Exception as e:
                print(f"[TomTom Incidents] API error: {e}  -> falling back to mock")

        # ---- Mock fallback ----
        return self._mock_incidents(north, south, east, west)

    def _parse_tomtom_incidents(self, data: dict) -> List[dict]:
        """Parse TomTom Incident Details v5 response."""
        incidents = []
        # TomTom icon category to our type mapping
        cat_map = {
            0: "accident", 1: "accident", 2: "weather", 3: "weather",
            4: "event", 5: "closure", 6: "construction", 7: "construction",
            8: "closure", 9: "event", 10: "accident", 11: "accident", 14: "construction",
        }
        # magnitudeOfDelay to severity
        mag_map = {0: 1, 1: 2, 2: 3, 3: 4, 4: 5}

        for item in data.get("incidents", []):
            props = item.get("properties", {})
            geom = item.get("geometry", {})

            # Get coordinates (could be Point or LineString)
            coords = geom.get("coordinates", [])
            if geom.get("type") == "Point" and len(coords) >= 2:
                lng, lat = coords[0], coords[1]
            elif geom.get("type") == "LineString" and coords:
                # Use midpoint of the line
                mid = coords[len(coords) // 2]
                lng, lat = mid[0], mid[1]
            else:
                continue

            icon_cat = props.get("iconCategory", 0)
            inc_type = cat_map.get(icon_cat, "accident")
            magnitude = props.get("magnitudeOfDelay", 1)
            severity = mag_map.get(magnitude, 2)

            events = props.get("events", [])
            description = events[0].get("description", "Traffic incident") if events else "Traffic incident"
            road_from = props.get("from", "")
            road_to = props.get("to", "")
            road_numbers = props.get("roadNumbers", [])
            road_name = ", ".join(road_numbers) if road_numbers else f"{road_from} to {road_to}"

            delay_s = props.get("delay", 0)

            incidents.append({
                "id": str(props.get("id", uuid.uuid4().hex[:8])),
                "lat": round(lat, 6),
                "lng": round(lng, 6),
                "type": inc_type,
                "severity": severity,
                "title": description[:80],
                "description": description,
                "road_name": road_name[:60] if road_name else "Unknown road",
                "start_time": props.get("startTime", datetime.now(timezone.utc).isoformat()),
                "end_time": props.get("endTime"),
                "delay_minutes": round(delay_s / 60, 1) if delay_s else None,
            })

        return incidents

    def _mock_incidents(self, north, south, east, west) -> List[dict]:
        """Generate mock incidents (fallback)."""
        types = ["accident", "construction", "closure", "weather", "event"]
        count = random.randint(2, 5)
        incidents = []
        for i in range(count):
            t = random.choice(types)
            sev = random.randint(1, 5)
            titles = {
                "accident": "Vehicle collision", "construction": "Road construction work",
                "closure": "Road closed", "weather": "Weather hazard", "event": "Planned event",
            }
            descs = {
                "accident": "Multi-vehicle incident causing delays. Emergency services on scene.",
                "construction": "Lane closures for infrastructure work. Expect delays.",
                "closure": "Road fully closed for maintenance. Seek alternate route.",
                "weather": "Reduced visibility due to fog/rain. Drive with caution.",
                "event": "Large public event causing congestion in surrounding area.",
            }
            incidents.append({
                "id": f"inc-{uuid.uuid4().hex[:8]}",
                "lat": round(random.uniform(south, north), 6),
                "lng": round(random.uniform(west, east), 6),
                "type": t, "severity": sev, "title": titles[t], "description": descs[t],
                "road_name": random.choice(["NH-48", "MG Road", "Ring Road", "GT Karnal Road"]),
                "start_time": (datetime.now(timezone.utc) - timedelta(hours=random.randint(0, 6))).isoformat(),
                "end_time": (datetime.now(timezone.utc) + timedelta(hours=random.randint(1, 12))).isoformat() if random.random() > 0.3 else None,
                "delay_minutes": round(random.uniform(2, 30), 1),
            })
        return incidents


_overpass_stats = {"calls": 0, "last_success": None}
_weather_stats = {"calls": 0, "last_success": None}

class OverpassProvider:
    """
    Adapter for OSM Overpass API to get traffic signal locations.
    Uses reliable Overpass API mirrors with User-Agent identification.
    """

    async def get_traffic_signals(self, route_coords: List[List[float]]) -> List[dict]:
        """Get traffic signal locations near a route from OpenStreetMap."""
        if len(route_coords) < 2:
            return []

        if not USE_MOCK:
            try:
                signals = await self._fetch_overpass_signals(route_coords)
                if signals:
                    _overpass_stats["calls"] += 1
                    _overpass_stats["last_success"] = datetime.now(timezone.utc).isoformat()
                    return signals
            except Exception as e:
                print(f"[Overpass] API error: {e}  -> falling back to model signals")

        # Fallback to model signals so routing always has signals
        return self._mock_signals(route_coords)

    async def _fetch_overpass_signals(self, route_coords: List[List[float]]) -> List[dict]:
        """Query real Overpass API for traffic signals along the route."""
        client = await get_http_client()

        # Sample up to 30 points along the route
        step = max(1, len(route_coords) // 30)
        sampled = route_coords[::step]

        # Build around filter with sampled route points
        coord_str = ",".join(f"{pt[0]},{pt[1]}" for pt in sampled)
        query = f"""[out:json][timeout:15];(node["highway"="traffic_signals"](around:500,{coord_str}););out body;"""

        headers = {
            "User-Agent": "GoSwift/1.0 (defense-traffic-intel; contact@goswift.local)",
            "Accept": "application/json"
        }

        # Try fast mirrors in order
        endpoints = [
            "https://z.overpass-api.de/api/interpreter",
            "https://overpass-api.de/api/interpreter",
            "https://lz4.overpass-api.de/api/interpreter",
            OVERPASS_URL
        ]

        for api_url in endpoints:
            try:
                resp = await client.post(api_url, data={"data": query},
                                         headers=headers,
                                         timeout=12)
                if resp.status_code == 200:
                    data = resp.json()
                    parsed = self._parse_overpass_signals(data, route_coords)
                    if parsed:
                        return parsed
            except Exception as e:
                print(f"[Overpass] {api_url} failed: {e}")
                continue

        raise RuntimeError("All Overpass endpoints returned no signals or failed")

    def _parse_overpass_signals(self, data: dict, route_coords: List[List[float]]) -> List[dict]:
        """Parse Overpass API response into GoSwift signal format."""
        elements = data.get("elements", [])
        signals = []

        # Pre-compute cumulative distances along the route
        cum_dists = [0.0]
        for i in range(1, len(route_coords)):
            d = TomTomProvider._haversine(
                route_coords[i-1][0], route_coords[i-1][1],
                route_coords[i][0], route_coords[i][1]
            ) * 1000  # meters
            cum_dists.append(cum_dists[-1] + d)

        for el in elements:
            if el.get("type") != "node":
                continue
            sig_lat = el.get("lat", 0)
            sig_lng = el.get("lon", 0)
            osm_id = el.get("id", 0)

            # Find closest point on route and distance along route
            min_d = float("inf")
            best_route_dist = 0
            for j in range(len(route_coords)):
                d = TomTomProvider._haversine(sig_lat, sig_lng, route_coords[j][0], route_coords[j][1]) * 1000
                if d < min_d:
                    min_d = d
                    best_route_dist = cum_dists[j]

            if min_d > 200:  # Skip signals too far from route
                continue

            # Assign realistic timing estimates based on OSM tags
            tags = el.get("tags", {})
            # Try to infer signal type from tags
            crossing = tags.get("crossing", "")
            button = tags.get("button_operated", "")
            if crossing or button:
                cycle = 60   # Pedestrian crossing — shorter cycle
            else:
                cycle = random.choice([75, 90, 90, 120])  # Standard intersection

            red_dur = cycle * random.uniform(0.4, 0.6)
            green_dur = cycle - red_dur

            signals.append({
                "id": f"osm-{osm_id}",
                "lat": round(sig_lat, 6),
                "lng": round(sig_lng, 6),
                "distance_along_route_m": round(best_route_dist, 1),
                "cycle_length_s": cycle,
                "red_duration_s": round(red_dur, 1),
                "green_duration_s": round(green_dur, 1),
            })

        # Sort by distance along route
        signals.sort(key=lambda s: s["distance_along_route_m"])
        return signals

    def _mock_signals(self, route_coords: List[List[float]]) -> List[dict]:
        """Generate mock signals (fallback)."""
        signals = []
        total_dist = 0
        dists = [0]
        for i in range(1, len(route_coords)):
            d = TomTomProvider._haversine(
                route_coords[i-1][0], route_coords[i-1][1],
                route_coords[i][0], route_coords[i][1]
            ) * 1000
            total_dist += d
            dists.append(total_dist)

        interval = random.uniform(300, 700)
        dist_along = interval
        sig_idx = 0
        while dist_along < total_dist:
            for j in range(1, len(dists)):
                if dists[j] >= dist_along:
                    frac = (dist_along - dists[j-1]) / max(1, dists[j] - dists[j-1])
                    lat = route_coords[j-1][0] + frac * (route_coords[j][0] - route_coords[j-1][0])
                    lng = route_coords[j-1][1] + frac * (route_coords[j][1] - route_coords[j-1][1])
                    cycle = random.choice([60, 75, 90, 90, 120])
                    red_dur = cycle * random.uniform(0.4, 0.6)
                    signals.append({
                        "id": f"sig-{sig_idx:04d}",
                        "lat": round(lat, 6), "lng": round(lng, 6),
                        "distance_along_route_m": round(dist_along, 1),
                        "cycle_length_s": cycle,
                        "red_duration_s": round(red_dur, 1),
                        "green_duration_s": round(cycle - red_dur, 1),
                    })
                    sig_idx += 1
                    break
            dist_along += random.uniform(300, 700)
        return signals


class OpenMeteoProvider:
    """
    Adapter for Open-Meteo weather API (free, no key required).
    """

    async def get_weather(self, lat: float, lng: float) -> dict:
        """Get current weather conditions from Open-Meteo."""
        if not USE_MOCK:
            try:
                client = await get_http_client()
                resp = await client.get("https://api.open-meteo.com/v1/forecast", params={
                    "latitude": lat,
                    "longitude": lng,
                    "current_weather": "true",
                    "hourly": "precipitation_probability,rain",
                    "forecast_days": 1,
                })
                resp.raise_for_status()
                data = resp.json()
                cw = data.get("current_weather", {})
                hourly = data.get("hourly", {})
                temp = cw.get("temperature", 25)
                wind = cw.get("windspeed", 10)
                wcode = cw.get("weathercode", 0)

                # Weather codes: 0-3 clear/cloudy, 51-67 drizzle/rain, 71-77 snow, 80-82 showers, 95-99 thunderstorm
                is_raining = wcode in range(51, 68) or wcode in range(80, 100)
                rain_vals = hourly.get("rain", [0])
                current_rain = rain_vals[0] if rain_vals else 0

                # Descriptive text from weathercode
                descriptions = {
                    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
                    45: "Foggy", 48: "Depositing rime fog",
                    51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
                    61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
                    71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow",
                    80: "Slight rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
                    95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
                }

                _weather_stats["calls"] += 1
                _weather_stats["last_success"] = datetime.now(timezone.utc).isoformat()

                return {
                    "temperature_c": round(temp, 1),
                    "wind_kmh": round(wind, 1),
                    "is_raining": is_raining,
                    "rain_intensity": round(current_rain, 1),
                    "weather_code": wcode,
                    "description": descriptions.get(wcode, f"Code {wcode}"),
                }
            except Exception as e:
                print(f"[Open-Meteo] API error: {e}  -> falling back to mock")

        # ---- Mock fallback ----
        is_raining = random.random() < 0.15
        return {
            "temperature_c": round(random.uniform(15, 38), 1),
            "wind_kmh": round(random.uniform(5, 30), 1),
            "is_raining": is_raining,
            "rain_intensity": round(random.uniform(0.5, 10.0), 1) if is_raining else 0,
            "weather_code": 61 if is_raining else 0,
            "description": "Light rain" if is_raining else "Clear",
        }


# Instantiate providers
tomtom = TomTomProvider()
overpass = OverpassProvider()
weather_provider = OpenMeteoProvider()



# ============================================================
# SECTION 6: PREDICTOR — THE BRAIN
# ============================================================

class Predictor:
    """
    Traffic speed prediction engine with:
    - Historical profile (Layer 1)
    - Real-time correction (Layer 2)
    - Context features (Layer 3)
    - Uncertainty band (Layer 4)
    """

    TAU = 0.75  # Decay constant in hours (~45 minutes)

    def get_time_slot(self, dt: datetime) -> int:
        """15-minute bucket index 0-95."""
        return dt.hour * 4 + dt.minute // 15

    def get_historical_profile(self, segment_id: str, day_of_week: int,
                                time_slot: int) -> dict:
        """Query historical speed profile from DB."""
        conn = get_db()
        rows = conn.execute(
            "SELECT speed_ratio FROM speed_samples WHERE segment_id=? AND day_of_week=? AND time_slot=?",
            (segment_id, day_of_week, time_slot),
        ).fetchall()
        conn.close()

        if len(rows) < 3:
            # Not enough data — return a time-of-day estimate
            ratio = TomTomProvider._time_of_day_ratio(
                datetime.now().replace(hour=time_slot // 4, minute=(time_slot % 4) * 15)
            )
            return {"median_ratio": ratio, "std": 0.15, "count": len(rows), "sufficient": False}

        ratios = [r["speed_ratio"] for r in rows]
        return {
            "median_ratio": round(statistics.median(ratios), 4),
            "std": round(statistics.stdev(ratios) if len(ratios) > 1 else 0.1, 4),
            "count": len(ratios),
            "sufficient": len(ratios) >= 20,
        }

    def predict_segment_speed(self, segment_id: str, at_dt: datetime,
                               live_ratio: Optional[float] = None,
                               free_flow_kmh: float = 60.0,
                               weather: Optional[dict] = None) -> dict:
        """
        Predict speed for a segment at a future time.

        Returns P50, P90, confidence, and data source.
        """
        dow = at_dt.weekday()
        slot = self.get_time_slot(at_dt)
        hist = self.get_historical_profile(segment_id, dow, slot)

        # Layer 1: Historical baseline
        predicted_ratio = hist["median_ratio"]

        # Layer 2: Real-time correction
        data_source = "historical"
        if live_ratio is not None:
            now = datetime.now()
            hours_ahead = max(0, (at_dt - now).total_seconds() / 3600)
            now_slot = self.get_time_slot(now)
            now_hist = self.get_historical_profile(segment_id, now.weekday(), now_slot)
            deviation = live_ratio - now_hist["median_ratio"]
            correction = deviation * math.exp(-hours_ahead / self.TAU)
            predicted_ratio += correction
            data_source = "live"

        # Layer 3: Context features
        if weather and weather.get("is_raining"):
            rain_penalty = 0.05 + 0.01 * min(weather.get("rain_intensity", 1), 10)
            predicted_ratio -= rain_penalty

        # Clamp
        predicted_ratio = max(0.05, min(1.0, predicted_ratio))

        # Layer 4: Uncertainty band
        std = hist["std"]
        if not hist["sufficient"]:
            std *= 1.5  # Wider band for sparse data

        ratio_p50 = predicted_ratio
        ratio_p90 = max(0.05, predicted_ratio - 1.28 * std)  # P90 = slower = worse case

        confidence = "high" if hist["sufficient"] and data_source == "live" else \
                     "medium" if hist["count"] >= 10 else "low"

        return {
            "speed_p50": round(free_flow_kmh * ratio_p50, 1),
            "speed_p90": round(free_flow_kmh * ratio_p90, 1),
            "free_flow_kmh": free_flow_kmh,
            "ratio_p50": round(ratio_p50, 4),
            "ratio_p90": round(ratio_p90, 4),
            "confidence": confidence,
            "data_source": data_source,
            "history_samples": hist["count"],
        }


predictor = Predictor()

# ============================================================
# SECTION 7: SIGNAL ENGINE — 3 TIERS
# ============================================================

class SignalEngine:
    """
    Three-tier signal timing engine:
      Tier 1 (Gold): Official ATCS feed
      Tier 2 (Silver): Learned from probe data
      Tier 3 (Bronze): Webster's delay model
    """

    def get_official_data(self, signal_id: str) -> Optional[dict]:
        """
        Tier 1: Official signal data from city ATCS.

        ===== TODO: API INTEGRATION =====
        Connect to city ATCS/ATMS NTCIP feed or REST API.
        Typically: GET https://{city-atcs-host}/api/signal/{signal_id}/status
        Returns: current phase, seconds until next phase change
        This is city-specific and requires authorization.
        =====================================
        """
        return None  # No official feed available

    def get_learned_timing(self, signal_id: str) -> Optional[dict]:
        """Tier 2: Estimate timing from historical observations."""
        conn = get_db()
        rows = conn.execute(
            "SELECT timestamp, cycle_length_s, duration_s, phase FROM signal_observations WHERE signal_id=? ORDER BY timestamp DESC LIMIT 50",
            (signal_id,),
        ).fetchall()
        conn.close()

        if len(rows) < 10:
            return None

        cycles = [r["cycle_length_s"] for r in rows if r["cycle_length_s"]]
        if not cycles:
            return None

        median_cycle = statistics.median(cycles)
        red_durations = [r["duration_s"] for r in rows if r["phase"] == "red"]
        red_dur = statistics.median(red_durations) if red_durations else median_cycle * 0.5

        # Estimate current phase by extrapolating from last observation
        last = rows[0]
        elapsed = time.time() - last["timestamp"]
        position_in_cycle = elapsed % median_cycle
        green_dur = median_cycle - red_dur

        if position_in_cycle < green_dur:
            current_phase = "green"
            remaining = green_dur - position_in_cycle
        else:
            current_phase = "red"
            remaining = median_cycle - position_in_cycle

        cycle_std = statistics.stdev(cycles) if len(cycles) > 1 else median_cycle * 0.1

        return {
            "tier": "learned",
            "cycle_length_s": round(median_cycle, 1),
            "red_duration_s": round(red_dur, 1),
            "green_duration_s": round(green_dur, 1),
            "current_phase": current_phase,
            "seconds_remaining": round(max(0, remaining), 1),
            "confidence_seconds": round(cycle_std / 2, 1),
            "confidence_badge": "silver",
            "observation_count": len(rows),
        }

    def get_modelled_delay(self, signal_data: dict, speed_ratio: float = 0.6) -> dict:
        """
        Tier 3: Webster's delay formula.

        d = C(1 - g/C)² / (2(1 - (g/C)·x))

        C = cycle length, g = green time, x = volume/capacity ratio
        """
        C = signal_data.get("cycle_length_s", 90)
        g = signal_data.get("green_duration_s", C * 0.45)

        # Estimate volume/capacity ratio from speed_ratio
        x = max(0.1, min(0.95, 1.0 - speed_ratio * 0.7))

        g_over_C = g / C
        denominator = 2 * (1 - g_over_C * x)
        if denominator <= 0:
            denominator = 0.1  # Prevent division by zero

        delay = C * (1 - g_over_C) ** 2 / denominator

        # Estimate a random current phase (since we don't know)
        now_frac = (time.time() % C) / C
        if now_frac < g / C:
            phase = "green"
            remaining = g - now_frac * C
        else:
            phase = "red"
            remaining = C - now_frac * C

        return {
            "tier": "modelled",
            "cycle_length_s": C,
            "red_duration_s": round(C - g, 1),
            "green_duration_s": round(g, 1),
            "current_phase": phase,
            "seconds_remaining": round(remaining, 1),
            "expected_delay_s": round(delay, 1),
            "confidence_badge": "bronze",
        }

    def process_signals_for_route(self, route_signals: List[dict],
                                   avg_speed_ratio: float = 0.6) -> Tuple[List[dict], dict]:
        """
        Process all signals along a route, using best available tier.
        Returns (processed_signals, green_wave_info).
        """
        processed = []
        for sig in route_signals:
            result = {"id": sig["id"], "lat": sig["lat"], "lng": sig["lng"],
                      "distance_along_route_m": sig["distance_along_route_m"]}

            # Try tiers in order
            official = self.get_official_data(sig["id"])
            if official:
                result.update(official)
                result["tier"] = "official"
                result["confidence_badge"] = "gold"
            else:
                learned = self.get_learned_timing(sig["id"])
                if learned:
                    result.update(learned)
                else:
                    modelled = self.get_modelled_delay(sig, avg_speed_ratio)
                    result.update(modelled)
                    # For modelled, don't show countdown (it's fake)
                    result["seconds_remaining"] = result.get("seconds_remaining")

            processed.append(result)

        # Green wave calculation
        green_wave = self._calculate_green_wave(processed)
        return processed, green_wave

    def _calculate_green_wave(self, signals: List[dict]) -> dict:
        """
        Calculate green-wave advisory if possible.
        Check if a consistent speed can catch 3+ consecutive greens.
        """
        if len(signals) < 3:
            return {"available": False}

        # Try speeds from 30 to 60 km/h
        best_speed = None
        best_caught = 0

        for test_speed_kmh in range(30, 61, 2):
            test_speed_ms = test_speed_kmh / 3.6
            caught = 0
            t = 0  # time at start of route

            for i, sig in enumerate(signals):
                arrival_time = sig["distance_along_route_m"] / test_speed_ms
                cycle = sig.get("cycle_length_s", 90)
                green_dur = sig.get("green_duration_s", cycle * 0.45)

                # Check if we arrive during green
                phase_time = (arrival_time + time.time()) % cycle
                if phase_time < green_dur:
                    caught += 1

            if caught > best_caught:
                best_caught = caught
                best_speed = test_speed_kmh

        if best_caught >= 3 and best_speed:
            return {
                "available": True,
                "advisory": f"Hold {best_speed} km/h to catch the next {best_caught} greens",
                "recommended_speed_kmh": best_speed,
                "signals_caught": best_caught,
            }
        return {"available": False}


signal_engine = SignalEngine()

# ============================================================
# SECTION 8: OPTIMIZER — DEPARTURE SWEEP & TIME-DEPENDENT ROUTING
# ============================================================

class Optimizer:
    """
    Time-dependent routing and departure-time optimization.
    """

    def calculate_route_time(self, segments: List[dict], depart_at: datetime,
                              signals: List[dict] = None) -> dict:
        """
        Calculate travel time using time-dependent segment speeds.
        Each segment's speed is predicted for the moment you'd actually reach it.
        """
        t = depart_at
        total_time_p50 = 0
        total_time_p90 = 0
        total_signal_delay = 0

        for seg in segments:
            coords = seg["coords"]
            seg_dist = 0
            for i in range(1, len(coords)):
                seg_dist += TomTomProvider._haversine(coords[i-1][0], coords[i-1][1],
                                                       coords[i][0], coords[i][1])
            # Predict speed at current arrival time
            speed_p50 = max(5, seg.get("speed_kmh", 40) * TomTomProvider._time_of_day_ratio(t) / max(0.1, seg.get("speed_ratio", 0.5)))
            speed_p90 = speed_p50 * 0.75  # Worst case is slower

            time_p50 = (seg_dist / speed_p50) * 60  # minutes
            time_p90 = (seg_dist / speed_p90) * 60
            total_time_p50 += time_p50
            total_time_p90 += time_p90

            t += timedelta(minutes=time_p50)

        # Add signal delays
        if signals:
            for sig in signals:
                delay = sig.get("expected_delay_s", sig.get("red_duration_s", 20) * 0.5)
                total_signal_delay += delay
        total_time_p50 += total_signal_delay / 60
        total_time_p90 += total_signal_delay * 1.3 / 60

        return {
            "travel_minutes_p50": round(total_time_p50, 1),
            "travel_minutes_p90": round(total_time_p90, 1),
            "signal_delay_s": round(total_signal_delay, 1),
            "arrival_p50": (depart_at + timedelta(minutes=total_time_p50)).isoformat(),
            "arrival_p90": (depart_at + timedelta(minutes=total_time_p90)).isoformat(),
        }

    async def sweep_departure_times(self, origin: dict, dest: dict,
                                      start_time: datetime, end_time: datetime,
                                      interval_minutes: int = 10) -> dict:
        """
        Sweep departure times and find the optimal one.
        """
        options = []
        best_option = None
        best_travel = float("inf")
        first_travel = None

        t = start_time
        while t <= end_time:
            routes = await tomtom.get_route(origin, dest, depart_at=t)
            route_options = []

            for route in routes:
                timing = self.calculate_route_time(route["segments"], t)
                opt = {
                    "id": route["id"],
                    "name": route["name"],
                    "arrival_p50": timing["arrival_p50"],
                    "arrival_p90": timing["arrival_p90"],
                    "travel_minutes_p50": timing["travel_minutes_p50"],
                    "travel_minutes_p90": timing["travel_minutes_p90"],
                }
                route_options.append(opt)

                if timing["travel_minutes_p50"] < best_travel:
                    best_travel = timing["travel_minutes_p50"]
                    best_option = {"depart_at": t.isoformat(), "route_id": route["id"],
                                   "route_name": route["name"],
                                   "travel_minutes": timing["travel_minutes_p50"]}

            if first_travel is None and route_options:
                first_travel = min(r["travel_minutes_p50"] for r in route_options)

            options.append({"depart_at": t.isoformat(), "routes": route_options})
            t += timedelta(minutes=interval_minutes)

        saves = round(first_travel - best_travel, 1) if first_travel and best_option else 0
        recommendation = {
            "depart_at": best_option["depart_at"] if best_option else start_time.isoformat(),
            "route_id": best_option["route_id"] if best_option else "",
            "route_name": best_option["route_name"] if best_option else "",
            "saves_minutes": max(0, saves),
            "message": f"Leave at {best_option['depart_at'][11:16]} via {best_option['route_name']}: saves {max(0,saves):.0f} min"
            if best_option else "No optimization found",
        }

        return {"options": options, "recommendation": recommendation}

    def arrive_by(self, origin: dict, dest: dict, target_arrival: datetime,
                  route_segments: List[dict]) -> dict:
        """
        Binary search for the latest safe departure time (using P90).
        """
        low = target_arrival - timedelta(hours=3)
        high = target_arrival - timedelta(minutes=5)

        for _ in range(15):  # Binary search iterations
            mid = low + (high - low) / 2
            timing = self.calculate_route_time(route_segments, mid)
            arrival = datetime.fromisoformat(timing["arrival_p90"])
            if arrival <= target_arrival:
                low = mid
            else:
                high = mid

        return {
            "leave_by": low.isoformat(),
            "arrival_p90": self.calculate_route_time(route_segments, low)["arrival_p90"],
            "target": target_arrival.isoformat(),
        }


optimizer = Optimizer()

# ============================================================
# SECTION 9: DEFENSE FEATURES
# ============================================================

def point_in_polygon(point: List[float], polygon: List[List[float]]) -> bool:
    """Ray-casting algorithm for point-in-polygon test."""
    x, y = point[0], point[1]
    n = len(polygon)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi + 1e-10) + xi):
            inside = not inside
        j = i
    return inside


def check_avoid_zones(route_coords: List[List[float]], zones: List[dict]) -> List[str]:
    """Check which avoid zones a route passes through."""
    violated = []
    for zone in zones:
        poly = json.loads(zone["polygon"]) if isinstance(zone["polygon"], str) else zone["polygon"]
        for pt in route_coords:
            if point_in_polygon(pt, poly):
                violated.append(zone["id"])
                break
    return violated


def plan_convoy(route: dict, vehicle_count: int, separation_minutes: float,
                lead_depart: datetime, callsigns: Optional[List[str]] = None) -> dict:
    """Plan convoy with staggered departures."""
    vehicles = []
    for i in range(vehicle_count):
        cs = callsigns[i] if callsigns and i < len(callsigns) else f"Alpha-{i+1}"
        dep = lead_depart + timedelta(minutes=i * separation_minutes)
        timing = optimizer.calculate_route_time(route["segments"], dep)
        vehicles.append({
            "index": i,
            "callsign": cs,
            "depart_at": dep.isoformat(),
            "eta_p50": timing["arrival_p50"],
            "eta_p90": timing["arrival_p90"],
        })

    total_window = (vehicle_count - 1) * separation_minutes + route["eta_p90_minutes"]
    return {
        "convoy_id": f"convoy-{uuid.uuid4().hex[:8]}",
        "vehicles": vehicles,
        "total_window_minutes": round(total_window, 1),
        "route_id": route["id"],
    }


# Route diversity tracking (in-memory session)
_recent_routes: List[dict] = []

def track_route_usage(route_id: str, timestamp: str):
    _recent_routes.append({"route_id": route_id, "timestamp": timestamp})
    # Keep last 50
    if len(_recent_routes) > 50:
        _recent_routes.pop(0)

def get_diversity_penalty(route_id: str) -> float:
    """Penalize recently used routes for diversity."""
    recent_uses = sum(1 for r in _recent_routes if r["route_id"] == route_id)
    return recent_uses * 2.0  # minutes penalty

# ============================================================
# SECTION 10: COLLECTOR (Background Task)
# ============================================================

_collector_state = {
    "active": False,
    "last_run": None,
    "next_run": None,
    "calls_today": 0,
    "segments_monitored": 0,
}

async def collector_task():
    """Background task that samples traffic speeds periodically."""
    _collector_state["active"] = True

    while True:
        try:
            conn = get_db()
            corridors = conn.execute("SELECT * FROM monitored_corridors").fetchall()
            conn.close()

            if not corridors:
                # Seed some default corridors for demo
                _seed_corridors()
                conn = get_db()
                corridors = conn.execute("SELECT * FROM monitored_corridors").fetchall()
                conn.close()

            now = datetime.now()
            _collector_state["segments_monitored"] = len(corridors)

            for corridor in corridors:
                flow = await tomtom.get_flow_segment(corridor["lat"], corridor["lng"])
                conn = get_db()
                conn.execute(
                    "INSERT INTO speed_samples (segment_id, timestamp, speed_kmh, free_flow_kmh, speed_ratio, source, day_of_week, time_slot) VALUES (?,?,?,?,?,?,?,?)",
                    (corridor["segment_id"], time.time(), flow["speed_kmh"], flow["free_flow_kmh"],
                     flow["speed_ratio"], "collector", now.weekday(), predictor.get_time_slot(now)),
                )
                conn.commit()
                conn.close()
                _collector_state["calls_today"] += 1

            _collector_state["last_run"] = now.isoformat()
            _collector_state["next_run"] = (now + timedelta(seconds=COLLECTOR_INTERVAL_SEC)).isoformat()

        except Exception as e:
            print(f"[Collector] Error: {e}")

        await asyncio.sleep(COLLECTOR_INTERVAL_SEC)


def _seed_corridors():
    """Seed default monitored corridors for demo."""
    corridors = [
        ("seg-nh48-01", 28.4595, 77.0266, "NH-48 Gurugram", 80),
        ("seg-ring-01", 28.6304, 77.2177, "Ring Road ITO", 60),
        ("seg-mg-01", 28.4796, 77.0839, "MG Road", 50),
        ("seg-gt-01", 28.7041, 77.1025, "GT Karnal Road", 70),
        ("seg-dnd-01", 28.6139, 77.2800, "DND Flyway", 80),
        ("seg-nh24-01", 28.6292, 77.3465, "NH-24 Bypass", 75),
        ("seg-outer-01", 28.6849, 77.1404, "Outer Ring Road", 65),
        ("seg-brt-01", 28.5245, 77.2066, "BRT Corridor", 45),
        ("seg-vikas-01", 28.6376, 77.2245, "Vikas Marg", 50),
        ("seg-mathura-01", 28.5560, 77.2530, "Mathura Road", 60),
    ]
    conn = get_db()
    for seg_id, lat, lng, name, ff in corridors:
        conn.execute(
            "INSERT OR IGNORE INTO monitored_corridors VALUES (?,?,?,?,?)",
            (seg_id, lat, lng, name, ff),
        )
    conn.commit()
    conn.close()


def _seed_historical_data():
    """Pre-populate ~7 days of synthetic history for demo."""
    conn = get_db()
    existing = conn.execute("SELECT COUNT(*) as c FROM speed_samples").fetchone()["c"]
    if existing > 100:
        conn.close()
        return  # Already seeded

    corridors = conn.execute("SELECT * FROM monitored_corridors").fetchall()
    if not corridors:
        _seed_corridors()
        corridors = conn.execute("SELECT * FROM monitored_corridors").fetchall()

    print("[Seed] Generating 7 days of synthetic traffic history...")
    now = datetime.now()
    batch = []
    for day_offset in range(7, 0, -1):
        day = now - timedelta(days=day_offset)
        for slot in range(96):  # Every 15 minutes
            dt = day.replace(hour=slot // 4, minute=(slot % 4) * 15, second=0)
            for corr in corridors:
                ratio = TomTomProvider._time_of_day_ratio(dt) + random.uniform(-0.05, 0.05)
                ratio = max(0.05, min(1.0, ratio))
                ff = corr["free_flow_kmh"]
                spd = ff * ratio
                batch.append((
                    corr["segment_id"], dt.timestamp(), round(spd, 1), ff,
                    round(ratio, 4), "seed", dt.weekday(), slot,
                ))

    conn.executemany(
        "INSERT INTO speed_samples (segment_id, timestamp, speed_kmh, free_flow_kmh, speed_ratio, source, day_of_week, time_slot) VALUES (?,?,?,?,?,?,?,?)",
        batch,
    )

    # Also seed some signal observations
    for sig_idx in range(20):
        sig_id = f"sig-{sig_idx:04d}"
        cycle = random.choice([60, 75, 90, 120])
        for obs in range(15):
            t = time.time() - random.uniform(0, 7 * 86400)
            phase = random.choice(["red", "green"])
            dur = cycle * (0.5 + random.uniform(-0.1, 0.1)) if phase == "red" else cycle * (0.5 + random.uniform(-0.1, 0.1))
            batch_sig = (sig_id, t, phase, round(dur, 1), cycle)
            conn.execute(
                "INSERT INTO signal_observations (signal_id, timestamp, phase, duration_s, cycle_length_s) VALUES (?,?,?,?,?)",
                batch_sig,
            )

    conn.commit()
    conn.close()
    print(f"[Seed] Generated {len(batch)} speed samples and signal observations.")


# ============================================================
# SECTION 11: API ENDPOINTS
# ============================================================

# --------------- Health ---------------
@app.get("/api/health")
async def health():
    conn = get_db()
    sample_count = conn.execute("SELECT COUNT(*) as c FROM speed_samples").fetchone()["c"]
    db_size = os.path.getsize(DB_PATH) / (1024 * 1024) if os.path.exists(DB_PATH) else 0
    conn.close()
    return {
        "status": "operational" if not OFFLINE_MODE else "offline",
        "version": VERSION,
        "uptime_seconds": round(time.time() - START_TIME),
        "offline_mode": OFFLINE_MODE,
        "collector": {
            "active": _collector_state["active"],
            "last_run": _collector_state["last_run"],
            "segments_monitored": _collector_state["segments_monitored"],
        },
        "database": {
            "size_mb": round(db_size, 2),
            "history_days": 7,
            "total_samples": sample_count,
        },
    }


# --------------- Public Config (API keys served server-side) ---------------
@app.get("/api/config")
async def get_config():
    """Return public runtime config including Google Maps API key from env vars."""
    return {
        "google_maps_api_key": GOOGLE_MAPS_API_KEY,
        "maps_enabled": bool(GOOGLE_MAPS_API_KEY),
    }


# --------------- Auth ---------------
@app.post("/api/auth/login")
async def login(request: Request):
    body = await request.json()
    username = body.get("username", "")
    password = body.get("password", "")

    conn = get_db()
    user = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    conn.close()

    if not user or user["password_hash"] != hash_password(password):
        raise HTTPException(401, "Invalid credentials")

    token, expires = create_token(username, user["role"])
    audit(username, "login", "/api/auth/login", request.client.host if request.client else "unknown")

    return {
        "token": token,
        "expires_at": expires,
        "user": {"username": username, "role": user["role"]},
    }


# --------------- Route ---------------
@app.post("/api/route")
async def get_route(request: Request, user: dict = Depends(get_current_user)):
    body = await request.json()
    origin = body.get("origin", {})
    dest = body.get("destination", {})
    depart_at = body.get("depart_at")
    mode = body.get("mode", "car")
    alternatives = body.get("alternatives", True)
    avoid_zones_input = body.get("avoid_zones", [])

    if not origin.get("lat") or not dest.get("lat"):
        raise HTTPException(400, "Origin and destination required with lat/lng")

    check_rate_limit(request.client.host if request.client else "0.0.0.0")

    dt = datetime.fromisoformat(depart_at) if depart_at else datetime.now()
    routes = await tomtom.get_route(origin, dest, depart_at=dt, alternatives=alternatives)

    # Fetch real-time weather from Open-Meteo
    weather_info = None
    try:
        weather_info = await weather_provider.get_weather(origin["lat"], origin["lng"])
        if weather_info and weather_info.get("is_raining"):
            rain_delay_pct = 0.08 + 0.01 * min(weather_info.get("rain_intensity", 1), 10)
            for r in routes:
                r["eta_p50_minutes"] = round(r["eta_p50_minutes"] * (1 + rain_delay_pct), 1)
                r["eta_p90_minutes"] = round(r["eta_p90_minutes"] * (1 + rain_delay_pct * 1.3), 1)
                r["name"] += f" (🌧️ Rain: {weather_info['description']})"
    except Exception as e:
        print(f"[Route Weather] Warning: {e}")

    # Apply avoid zone penalties
    if avoid_zones_input:
        conn = get_db()
        db_zones = conn.execute("SELECT * FROM avoid_zones").fetchall()
        conn.close()
        for route in routes:
            all_coords = [c for seg in route["segments"] for c in seg["coords"]]
            violated = check_avoid_zones(all_coords, [dict(z) for z in db_zones])
            if violated:
                route["eta_p50_minutes"] += 30  # Heavy penalty
                route["eta_p90_minutes"] += 45
                route["name"] += " (⚠ crosses avoid zone)"

    # Apply route diversity
    for route in routes:
        penalty = get_diversity_penalty(route["id"])
        route["eta_p50_minutes"] += penalty

    # Sort by P50
    routes.sort(key=lambda r: r["eta_p50_minutes"])
    best_id = routes[0]["id"] if routes else ""

    # Track usage
    if routes:
        track_route_usage(best_id, dt.isoformat())

    # Handle convoy mode
    convoy_result = None
    if mode == "convoy" and routes:
        conv_opts = body.get("convoy_options", {})
        convoy_result = plan_convoy(
            routes[0],
            conv_opts.get("vehicle_count", 3),
            conv_opts.get("separation_minutes", 5),
            dt,
            conv_opts.get("callsigns"),
        )

    audit(user.get("sub", "anon"), "route_query", "/api/route",
          request.client.host if request.client else "", json.dumps({"origin": origin, "dest": dest}))

    result = {
        "routes": routes,
        "best_route_id": best_id,
        "weather": weather_info,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    if convoy_result:
        result["convoy"] = convoy_result
    return result


# --------------- Geocoding / Address Search ---------------
@app.get("/api/geocode")
async def geocode(q: str = ""):
    q = q.strip()
    if not q or len(q) < 2:
        return {"results": []}

    results = []
    # 1. Primary: TomTom Search API v2
    if TOMTOM_API_KEY and not OFFLINE_MODE:
        try:
            client = await get_http_client()
            url = f"https://api.tomtom.com/search/2/search/{q}.json"
            resp = await client.get(url, params={
                "key": TOMTOM_API_KEY,
                "limit": 6,
                "language": "en-US",
            }, timeout=6)
            if resp.status_code == 200:
                data = resp.json().get("results", [])
                for item in data:
                    addr = item.get("address", {}).get("freeformAddress", "")
                    pos = item.get("position", {})
                    poi = item.get("poi", {}).get("name", "")
                    label = f"{poi} ({addr})" if poi and poi.lower() not in addr.lower() else addr
                    if pos.get("lat") and pos.get("lon") and label:
                        results.append({
                            "label": label,
                            "lat": round(pos["lat"], 6),
                            "lng": round(pos["lon"], 6),
                            "source": "tomtom"
                        })
        except Exception as e:
            print(f"[Geocode TomTom] Error: {e}")

    # 2. Fallback: OpenStreetMap Nominatim
    if not results and not OFFLINE_MODE:
        try:
            client = await get_http_client()
            url = "https://nominatim.openstreetmap.org/search"
            resp = await client.get(url, params={"q": q, "format": "json", "limit": 6},
                                   headers={"User-Agent": "GoSwift/1.0 (defense-traffic-intel)"},
                                   timeout=6)
            if resp.status_code == 200:
                for item in resp.json():
                    results.append({
                        "label": item.get("display_name", q),
                        "lat": round(float(item["lat"]), 6),
                        "lng": round(float(item["lon"]), 6),
                        "source": "osm"
                    })
        except Exception as e:
            print(f"[Geocode Nominatim] Error: {e}")

    return {"results": results}



# --------------- Departure Options ---------------
@app.post("/api/depart-options")
async def depart_options(request: Request, user: dict = Depends(get_current_user)):
    body = await request.json()
    origin = body.get("origin", {})
    dest = body.get("destination", {})
    start_time = body.get("start_time")
    end_time = body.get("end_time")
    interval = body.get("interval_minutes", 10)

    now = datetime.now()
    start = datetime.fromisoformat(start_time) if start_time else now
    end = datetime.fromisoformat(end_time) if end_time else now + timedelta(hours=2)

    check_rate_limit(request.client.host if request.client else "0.0.0.0")

    result = await optimizer.sweep_departure_times(origin, dest, start, end, interval)

    audit(user.get("sub", "anon"), "depart_sweep", "/api/depart-options",
          request.client.host if request.client else "")

    return result


# --------------- Signals ---------------
@app.post("/api/signals")
async def get_signals(request: Request, user: dict = Depends(get_current_user)):
    body = await request.json()
    route_coords = body.get("route_coords", [])
    route_id = body.get("route_id")

    if not route_coords or len(route_coords) < 2:
        raise HTTPException(400, "route_coords required with at least 2 points")

    raw_signals = await overpass.get_traffic_signals(route_coords)

    # Compute average speed ratio for modelled delays
    avg_ratio = 0.6  # Default

    processed, green_wave = signal_engine.process_signals_for_route(raw_signals, avg_ratio)

    return {"signals": processed, "green_wave": green_wave}


# --------------- Incidents ---------------
@app.get("/api/incidents")
async def get_incidents(north: float = 28.75, south: float = 28.45,
                         east: float = 77.40, west: float = 77.00,
                         user: dict = Depends(get_current_user)):
    incidents = await tomtom.get_incidents(north, south, east, west)
    return {
        "incidents": incidents,
        "count": len(incidents),
        "last_updated": datetime.now(timezone.utc).isoformat(),
    }


# --------------- Convoy ---------------
@app.post("/api/convoy/plan")
async def convoy_plan(request: Request, user: dict = Depends(get_current_user)):
    body = await request.json()
    route_id = body.get("route_id")
    vehicle_count = body.get("vehicle_count", 3)
    separation = body.get("separation_minutes", 5)
    lead_depart = body.get("lead_depart_at")
    callsigns = body.get("callsigns")

    if not lead_depart:
        raise HTTPException(400, "lead_depart_at required")

    dt = datetime.fromisoformat(lead_depart)

    # Get a route to base the convoy on
    origin = body.get("origin", {"lat": 28.6139, "lng": 77.2090})
    dest = body.get("destination", {"lat": 28.4595, "lng": 77.0266})
    routes = await tomtom.get_route(origin, dest, depart_at=dt, alternatives=False)

    if not routes:
        raise HTTPException(500, "Could not generate route for convoy")

    result = plan_convoy(routes[0], vehicle_count, separation, dt, callsigns)

    audit(user.get("sub", "anon"), "convoy_plan", "/api/convoy/plan",
          request.client.host if request.client else "")

    return result


# --------------- Avoid Zones ---------------
@app.get("/api/avoid-zones")
async def list_avoid_zones(user: dict = Depends(get_current_user)):
    conn = get_db()
    zones = conn.execute("SELECT * FROM avoid_zones ORDER BY created_at DESC").fetchall()
    conn.close()
    return {"zones": [dict(z) for z in zones]}


@app.post("/api/avoid-zones")
async def create_avoid_zone(request: Request, user: dict = Depends(get_current_user)):
    body = await request.json()
    zone_id = f"zone-{uuid.uuid4().hex[:8]}"
    name = body.get("name", "Unnamed Zone")
    polygon = body.get("polygon", [])
    penalty = body.get("penalty", 1000.0)
    now = datetime.now(timezone.utc).isoformat()

    if len(polygon) < 3:
        raise HTTPException(400, "Polygon requires at least 3 points")

    conn = get_db()
    conn.execute(
        "INSERT INTO avoid_zones VALUES (?,?,?,?,?)",
        (zone_id, name, json.dumps(polygon), penalty, now),
    )
    conn.commit()
    conn.close()

    audit(user.get("sub", "anon"), "create_avoid_zone", "/api/avoid-zones",
          request.client.host if request.client else "", name)

    return {"id": zone_id, "name": name, "polygon": polygon, "penalty": penalty, "created_at": now}


@app.delete("/api/avoid-zones/{zone_id}")
async def delete_avoid_zone(zone_id: str, user: dict = Depends(get_current_user)):
    conn = get_db()
    conn.execute("DELETE FROM avoid_zones WHERE id=?", (zone_id,))
    conn.commit()
    conn.close()
    return {"deleted": True}


# --------------- System Status ---------------
@app.get("/api/system-status")
async def system_status(user: dict = Depends(get_current_user)):
    conn = get_db()
    sample_count = conn.execute("SELECT COUNT(*) as c FROM speed_samples").fetchone()["c"]
    seg_count = conn.execute("SELECT COUNT(DISTINCT segment_id) as c FROM speed_samples").fetchone()["c"]

    oldest = conn.execute("SELECT MIN(timestamp) as t FROM speed_samples").fetchone()["t"]
    db_size = os.path.getsize(DB_PATH) / (1024 * 1024) if os.path.exists(DB_PATH) else 0
    conn.close()

    history_days = 0
    if oldest:
        history_days = (time.time() - oldest) / 86400

    data_sources = [
        {
            "name": "TomTom Traffic",
            "status": "ok" if not OFFLINE_MODE and TOMTOM_API_KEY else "disabled",
            "last_success": _collector_state["last_run"],
            "calls_today": _collector_state["calls_today"],
            "quota_daily": 2500,
            "quota_remaining": max(0, 2500 - _collector_state["calls_today"]),
        },
        {
            "name": "OSM Overpass",
            "status": "ok" if not OFFLINE_MODE else "disabled",
            "last_success": _overpass_stats["last_success"] or datetime.now(timezone.utc).isoformat(),
            "calls_today": _overpass_stats["calls"],
            "quota_daily": None,
            "quota_remaining": None,
        },
        {
            "name": "Open-Meteo Weather",
            "status": "ok" if OPENMETEO_ENABLED and not OFFLINE_MODE else "disabled",
            "last_success": _weather_stats["last_success"],
            "calls_today": _weather_stats["calls"],
            "quota_daily": None,
            "quota_remaining": None,
        },
        {
            "name": "City ATCS (Tier 1)",
            "status": "unconfigured (commercial feed)",
            "last_success": None,
            "calls_today": 0,
            "quota_daily": None,
            "quota_remaining": None,
        },
    ]

    return {
        "status": "operational" if not OFFLINE_MODE else "offline",
        "offline_mode": OFFLINE_MODE,
        "collector": _collector_state,
        "database": {
            "size_mb": round(db_size, 2),
            "history_days": round(history_days, 1),
            "total_samples": sample_count,
            "segments_tracked": seg_count,
        },
        "data_sources": data_sources,
        "confidence_overall": "high" if sample_count > 5000 else "medium" if sample_count > 500 else "low",
    }


# --------------- Audit Log ---------------
@app.get("/api/audit-log")
async def get_audit_log(limit: int = 50, offset: int = 0, user: dict = Depends(get_current_user)):
    if user.get("role") not in ("admin", "commander"):
        raise HTTPException(403, "Insufficient permissions")

    conn = get_db()
    entries = conn.execute(
        "SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?", (limit, offset)
    ).fetchall()
    total = conn.execute("SELECT COUNT(*) as c FROM audit_log").fetchone()["c"]
    conn.close()

    return {"entries": [dict(e) for e in entries], "total": total}


# ============================================================
# SECTION 12: STATIC FILES & STARTUP
# ============================================================

# Serve static files (index.html, style.css, app.js)
@app.get("/")
async def serve_index():
    return FileResponse(BASE_DIR / "index.html")

@app.get("/style.css")
async def serve_css():
    return FileResponse(BASE_DIR / "style.css", media_type="text/css")

@app.get("/app.js")
async def serve_js():
    return FileResponse(BASE_DIR / "app.js", media_type="application/javascript")

@app.get("/manifest.json")
async def serve_manifest():
    return FileResponse(BASE_DIR / "manifest.json", media_type="application/manifest+json")

@app.get("/sw.js")
async def serve_sw():
    return FileResponse(BASE_DIR / "sw.js", media_type="application/javascript")

@app.get("/icon.svg")
async def serve_icon():
    return FileResponse(BASE_DIR / "icon.svg", media_type="image/svg+xml")


@app.on_event("startup")
async def startup():
    print(f"""
==============================================
   GoSwift v{VERSION}
   Defense-Grade Traffic Intelligence
----------------------------------------------
   Mode:      {'OFFLINE' if OFFLINE_MODE else 'ONLINE'}
   Mock Data: {'YES' if USE_MOCK else 'NO'}
   DB Path:   {DB_PATH}
   Collector: every {COLLECTOR_INTERVAL_SEC}s
==============================================
    """)
    init_db()
    _seed_corridors()
    _seed_historical_data()
    if not os.getenv("VERCEL"):
        asyncio.create_task(collector_task())
    print("[GoSwift] Server ready.")


# ============================================================
# SECTION 13: MAIN
# ============================================================

if __name__ == "__main__":
    uvicorn.run("app:app", host="0.0.0.0", port=7000, reload=True)
