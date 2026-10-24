// ============================================================
// GoSwift v1.0 — Frontend Application
// Defense-Grade Traffic Intelligence System
// ============================================================

(function () {
    'use strict';

    // === SECTION 1: CONFIGURATION ===
    const CONFIG = {
        API_BASE: '',
        MAP_CENTER: [28.6139, 77.2090],
        MAP_ZOOM: 12,
        REFRESH_INTERVAL: 60000,
        SIGNAL_REFRESH: 10000,
        COUNTDOWN_FPS: 10,
        MAX_ALTERNATIVES: 3,
        CONGESTION_COLORS: {
            free: '#22c55e',
            light: '#84cc16',
            moderate: '#eab308',
            heavy: '#f97316',
            standstill: '#ef4444'
        },
        ROUTE_COLORS: ['#4CAF50', '#FF9800', '#2196F3'],
        CONFIDENCE_COLORS: { high: '#22c55e', medium: '#eab308', low: '#ef4444' },
        TILE_OSM: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        TILE_DARK: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
        TILE_TOMTOM: 'https://api.tomtom.com/map/1/tile/basic/main/{z}/{x}/{y}.png?key=z6OWt7WBJOEzT3KDHjlZ3Qln86K0DAx3',
        TILE_ATTRIBUTION: '&copy; OpenStreetMap &copy; CARTO &copy; TomTom'
    };

    // === SECTION 2: STATE MANAGEMENT ===
    const state = {
        token: localStorage.getItem('goswift_token'),
        user: JSON.parse(localStorage.getItem('goswift_user') || 'null'),
        origin: null,
        destination: null,
        routes: [],
        selectedRouteId: null,
        routeLayers: [],
        signalMarkers: [],
        incidentMarkers: [],
        signals: [],
        signalDataTime: null,
        avoidZones: [],
        avoidZonePolygons: [],
        avoidZoneDrawing: false,
        drawingPoints: [],
        drawingLayer: null,
        departureChart: null,
        countdownRAF: null,
        convoyMode: false,
        refreshTimer: null,
        statusTimer: null,
        map: null,
        tileLayer: null,
        originMarker: null,
        destMarker: null,
        systemStatus: null,
        tacticalMode: false,
        theme: 'night',
        hudActive: true,
        carMarker: null,
        roadSignalMarkers: [],
        roadAlertMarkers: [],
        isDriving: false,
        driveProgressIndex: 0,
        driveTimer: null,
        currentSpeed: 24,
        speedLimit: 50,
        miniMap: null,
        miniMapPolyline: null,
        miniMapMarker: null,
        hudSignalPhase: 'green',
        hudSignalTimer: 24,
        viewMode: '2d',
        weather4D: 'clear',
        time4D: 'night',
        streetViewHeading: 45,
        streetViewPitch: 0,
        streetViewIndex: 0,
        streetViewDragging: false,
        streetViewDragStart: { x: 0, y: 0, heading: 0, pitch: 0 },
        canvas4D: null,
        ctx4D: null,
        raf4D: null,
        simOffset: 0
    };

    // === SECTION 3: API CLIENT ===

    /** Generic API fetch wrapper with auth and error handling */
    async function api(endpoint, options = {}) {
        const url = CONFIG.API_BASE + endpoint;
        const headers = { ...(options.headers || {}) };
        if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
        if (options.body && typeof options.body === 'object') {
            headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(options.body);
        }
        try {
            const resp = await fetch(url, { ...options, headers });
            if (resp.status === 401) {
                logout();
                throw new Error('Session expired');
            }
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({ detail: resp.statusText }));
                throw new Error(err.detail || resp.statusText);
            }
            return await resp.json();
        } catch (e) {
            if (e.message !== 'Session expired') {
                showToast(e.message || 'Network error', 'error');
            }
            throw e;
        }
    }
    api.get = (url) => api(url);
    api.post = (url, body) => api(url, { method: 'POST', body });
    api.delete = (url) => api(url, { method: 'DELETE' });

    // === SECTION 4: AUTHENTICATION ===

    async function login(username, password) {
        try {
            const data = await api.post('/api/auth/login', { username, password });
            state.token = data.token;
            state.user = data.user;
            localStorage.setItem('goswift_token', data.token);
            localStorage.setItem('goswift_user', JSON.stringify(data.user));
            hideLoginModal();
            updateUserBadge();
            showToast('Logged in as ' + data.user.username + ' (' + data.user.role + ')', 'success');
        } catch (e) {
            const el = document.getElementById('login-error');
            if (el) { el.textContent = e.message || 'Login failed'; el.style.display = 'block'; }
        }
    }

    function logout() {
        state.token = null;
        state.user = null;
        localStorage.removeItem('goswift_token');
        localStorage.removeItem('goswift_user');
        showLoginModal();
    }

    async function checkAuth() {
        if (!state.token) {
            try {
                // Auto-login as default admin for instant zero-friction command-center access
                const data = await api.post('/api/auth/login', { username: 'admin', password: 'goswift' });
                state.token = data.token;
                state.user = data.user;
                localStorage.setItem('goswift_token', data.token);
                localStorage.setItem('goswift_user', JSON.stringify(data.user));
                hideLoginModal();
                updateUserBadge();
            } catch (e) {
                // If offline or first load, still keep modal closed so map is accessible
                hideLoginModal();
            }
        } else {
            hideLoginModal();
            updateUserBadge();
        }
    }

    function showLoginModal() {
        const m = document.getElementById('login-modal');
        if (m) m.style.display = 'flex';
    }
    function hideLoginModal() {
        const m = document.getElementById('login-modal');
        if (m) m.style.display = 'none';
    }

    function updateUserBadge() {
        const el = document.getElementById('user-role');
        if (el && state.user) {
            const abbr = { admin: 'ADM', commander: 'CMD', operator: 'OP' };
            el.textContent = abbr[state.user.role] || 'OP';
        }
    }

    // === SECTION 5: MAP MANAGEMENT ===

    function initMap() {
        state.map = L.map('map', {
            center: CONFIG.MAP_CENTER,
            zoom: CONFIG.MAP_ZOOM,
            zoomControl: false,
            preferCanvas: true
        });

        // 1. Base Layer: Carto Dark Matter (Tactical Dark)
        const darkLayer = L.tileLayer(CONFIG.TILE_DARK, {
            subdomains: 'abcd',
            maxZoom: 19,
            attribution: '&copy; CARTO &copy; OpenStreetMap'
        });

        // 2. Base Layer: OpenStreetMap Standard (High availability fallback)
        const osmLayer = L.tileLayer(CONFIG.TILE_OSM, {
            subdomains: 'abc',
            maxZoom: 19,
            attribution: '&copy; OpenStreetMap'
        });

        // 3. Base Layer: TomTom Real-Time Road Map (Using your live TomTom key)
        const tomtomLayer = L.tileLayer(CONFIG.TILE_TOMTOM, {
            maxZoom: 19,
            attribution: '&copy; TomTom'
        });

        // Auto-fallback to OpenStreetMap if Carto tiles have network issues
        let fallbackDone = false;
        darkLayer.on('tileerror', function () {
            if (!fallbackDone && state.map) {
                fallbackDone = true;
                console.warn('Switching to standard OSM tiles fallback');
                if (state.map.hasLayer(darkLayer)) {
                    state.map.removeLayer(darkLayer);
                    osmLayer.addTo(state.map);
                    state.tileLayer = osmLayer;
                }
            }
        });

        // Add default layer
        darkLayer.addTo(state.map);
        state.tileLayer = darkLayer;

        // Leaflet Layer Switcher Control (Top Right)
        const baseMaps = {
            "Tactical Dark": darkLayer,
            "TomTom Live Map": tomtomLayer,
            "Standard OSM": osmLayer
        };
        L.control.layers(baseMaps, null, { position: 'topright' }).addTo(state.map);

        L.control.zoom({ position: 'topright' }).addTo(state.map);
        L.control.scale({ position: 'bottomleft', imperial: false }).addTo(state.map);

        // Force multiple size invalidations so Leaflet computes geometry immediately
        setTimeout(() => state.map && state.map.invalidateSize(), 100);
        setTimeout(() => state.map && state.map.invalidateSize(), 500);
        setTimeout(() => state.map && state.map.invalidateSize(), 1500);

        // Mouse position tracking
        state.map.on('mousemove', function (e) {
            const el = document.getElementById('bottom-coords');
            if (el) el.textContent = e.latlng.lat.toFixed(5) + ', ' + e.latlng.lng.toFixed(5);
        });
        state.map.on('zoomend', function () {
            const el = document.getElementById('bottom-zoom');
            if (el) el.textContent = 'Z' + state.map.getZoom();
        });

        // Click to set origin / destination
        state.map.on('click', function (e) {
            if (state.avoidZoneDrawing) {
                addDrawingPoint(e.latlng);
                return;
            }
            if (!state.origin) {
                setOrigin(e.latlng);
            } else if (!state.destination) {
                setDestination(e.latlng);
            }
        });
    }

    function createMarkerIcon(color, label) {
        return L.divIcon({
            className: '',
            html: '<div style="width:28px;height:28px;background:' + color +
                  ';border:3px solid #fff;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;">' +
                  (label || '') + '</div>',
            iconSize: [28, 28],
            iconAnchor: [14, 14]
        });
    }

    function setOrigin(latlng, label) {
        state.origin = { lat: latlng.lat, lng: latlng.lng, label: label || '' };
        if (state.originMarker) state.map.removeLayer(state.originMarker);
        state.originMarker = L.marker(latlng, { icon: createMarkerIcon('#22c55e', 'A') })
            .addTo(state.map)
            .bindPopup('<b>Origin:</b> ' + (label || (latlng.lat.toFixed(5) + ', ' + latlng.lng.toFixed(5))));
        document.getElementById('input-origin').value = label || (latlng.lat.toFixed(5) + ', ' + latlng.lng.toFixed(5));
        showToast('Origin: ' + (label ? label.slice(0, 30) + '...' : latlng.lat.toFixed(4) + ', ' + latlng.lng.toFixed(4)), 'info', 2000);
    }

    function setDestination(latlng, label) {
        state.destination = { lat: latlng.lat, lng: latlng.lng, label: label || '' };
        if (state.destMarker) state.map.removeLayer(state.destMarker);
        state.destMarker = L.marker(latlng, { icon: createMarkerIcon('#ef4444', 'B') })
            .addTo(state.map)
            .bindPopup('<b>Destination:</b> ' + (label || (latlng.lat.toFixed(5) + ', ' + latlng.lng.toFixed(5))));
        document.getElementById('input-destination').value = label || (latlng.lat.toFixed(5) + ', ' + latlng.lng.toFixed(5));
        showToast('Destination: ' + (label ? label.slice(0, 30) + '...' : latlng.lat.toFixed(4) + ', ' + latlng.lng.toFixed(4)), 'info', 2000);
    }

    function fitMapToRoute(route) {
        if (!route || !route.segments || !route.segments.length) return;
        const allCoords = route.segments.flatMap(s => s.coords);
        if (allCoords.length) {
            state.map.fitBounds(L.latLngBounds(allCoords.map(c => [c[0], c[1]])), { padding: [60, 60] });
        }
    }

    // === SECTION 6: ROUTE RENDERING ===

    function clearRoutes() {
        state.routeLayers.forEach(l => state.map.removeLayer(l));
        state.routeLayers = [];
        state.signalMarkers.forEach(m => state.map.removeLayer(m));
        state.signalMarkers = [];
    }

    function renderRoutes(routes) {
        clearRoutes();
        state.routes = routes;
        const cardsEl = document.getElementById('route-cards');
        cardsEl.innerHTML = '';

        routes.forEach((route, idx) => {
            // Draw segments on map
            route.segments.forEach(seg => {
                const latlngs = seg.coords.map(c => [c[0], c[1]]);
                const isSelected = route.id === state.selectedRouteId;
                const poly = L.polyline(latlngs, {
                    color: CONFIG.CONGESTION_COLORS[seg.congestion] || route.color,
                    weight: isSelected ? 7 : 4,
                    opacity: isSelected ? 1.0 : 0.55,
                    lineJoin: 'round',
                    lineCap: 'round'
                }).addTo(state.map);
                poly.bindPopup(
                    '<b>' + seg.congestion.toUpperCase() + '</b><br>' +
                    'Speed: ' + seg.speed_kmh + ' km/h<br>' +
                    'Free flow: ' + seg.free_flow_kmh + ' km/h<br>' +
                    'Ratio: ' + (seg.speed_ratio * 100).toFixed(0) + '%'
                );
                poly._routeId = route.id;
                state.routeLayers.push(poly);
            });

            // Create route card
            cardsEl.appendChild(createRouteCard(route, idx));
        });

        // Select best route
        if (routes.length && !state.selectedRouteId) {
            selectRoute(routes[0].id);
        }
    }

    function createRouteCard(route, index) {
        const card = document.createElement('div');
        card.className = 'route-card' + (route.id === state.selectedRouteId ? ' selected' : '');
        card.dataset.routeId = route.id;
        card.style.borderLeftColor = route.color;

        card.innerHTML = `
            <div class="route-card-header">
                <span class="route-color-dot" style="background:${route.color}"></span>
                <span class="route-name">${route.name}</span>
                <span class="confidence-badge confidence-${route.confidence}">${route.confidence.toUpperCase()}</span>
            </div>
            <div class="route-card-body">
                <div class="route-eta">
                    <span class="eta-p50">${formatDuration(route.eta_p50_minutes)}</span>
                    <span class="eta-p90">${formatDuration(route.eta_p90_minutes)} worst</span>
                </div>
                <div class="route-details">
                    <span>${route.distance_km} km</span>
                    <span>•</span>
                    <span>${route.signal_count} signals</span>
                    <span>•</span>
                    <span>~${Math.round(route.total_signal_delay_s)}s delay</span>
                </div>
            </div>
            <div class="route-card-footer">
                <span class="data-source">Source: ${route.data_source}</span>
                <button class="btn-select">SELECT</button>
            </div>
        `;

        card.addEventListener('click', () => selectRoute(route.id));
        const btn = card.querySelector('.btn-select');
        if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); selectRoute(route.id); });

        return card;
    }

    function selectRoute(routeId) {
        state.selectedRouteId = routeId;

        // Update route card highlights
        document.querySelectorAll('.route-card').forEach(c => {
            c.classList.toggle('selected', c.dataset.routeId === routeId);
        });

        // Update polyline weights
        state.routeLayers.forEach(l => {
            const isSelected = l._routeId === routeId;
            l.setStyle({ weight: isSelected ? 7 : 4, opacity: isSelected ? 1.0 : 0.55 });
            if (isSelected) l.bringToFront();
        });

        // Load signals for selected route
        const route = state.routes.find(r => r.id === routeId);
        if (route) {
            const allCoords = route.segments.flatMap(s => s.coords);
            loadSignals(allCoords, routeId);
            updateNavHUDWithRoute(route);
        }
    }

    // === SECTION 7: SIGNAL ENGINE (UI) ===

    async function loadSignals(routeCoords, routeId) {
        try {
            const data = await api.post('/api/signals', { route_coords: routeCoords, route_id: routeId });
            state.signals = data.signals || [];
            state.signalDataTime = Date.now();
            renderSignalStrip(state.signals);
            renderSignalMarkers(state.signals);
            updateGreenWave(data.green_wave);
            startCountdowns();
            const selRoute = state.routes.find(r => r.id === (routeId || state.selectedRouteId));
            if (selRoute) renderRoadHUDMarkers(selRoute, state.signals);
        } catch (e) {
            console.error('Failed to load signals:', e);
        }
    }

    function renderSignalStrip(signals) {
        const strip = document.getElementById('signal-strip');
        if (!strip) return;

        if (!signals.length) {
            strip.innerHTML = '<div class="empty-state small"><p>No signals on this route</p></div>';
            return;
        }

        strip.innerHTML = signals.map((sig, i) => {
            const phaseClass = 'phase-' + (sig.current_phase || 'unknown');
            const badgeClass = 'badge-' + (sig.confidence_badge || 'bronze');
            const badgeText = (sig.confidence_badge || 'bronze').toUpperCase();
            const remaining = sig.seconds_remaining != null ? Math.round(sig.seconds_remaining) + 's' : '—';
            const dist = sig.distance_along_route_m >= 1000
                ? (sig.distance_along_route_m / 1000).toFixed(1) + ' km'
                : Math.round(sig.distance_along_route_m) + ' m';

            return `
                <div class="signal-entry" data-signal-id="${sig.id}" data-index="${i}">
                    <div class="signal-distance">${dist}</div>
                    <div class="signal-phase">
                        <span class="phase-dot ${phaseClass}"></span>
                        <span class="signal-countdown" data-remaining="${sig.seconds_remaining || 0}">${remaining}</span>
                    </div>
                    <div class="signal-info">
                        <span class="signal-cycle">C: ${sig.cycle_length_s || '?'}s</span>
                        <span class="${badgeClass}">${badgeText}</span>
                    </div>
                </div>
            `;
        }).join('');
    }

    function renderSignalMarkers(signals) {
        state.signalMarkers.forEach(m => state.map.removeLayer(m));
        state.signalMarkers = [];

        signals.forEach(sig => {
            const color = sig.current_phase === 'green' ? '#22c55e' :
                          sig.current_phase === 'red' ? '#ef4444' :
                          sig.current_phase === 'yellow' ? '#eab308' : '#64748b';
            const marker = L.circleMarker([sig.lat, sig.lng], {
                radius: 6, fillColor: color, color: '#fff',
                weight: 1.5, fillOpacity: 0.9
            }).addTo(state.map);
            marker.bindPopup(
                '<b>Signal ' + sig.id + '</b><br>' +
                'Phase: ' + (sig.current_phase || 'unknown') + '<br>' +
                'Cycle: ' + (sig.cycle_length_s || '?') + 's<br>' +
                'Tier: ' + (sig.confidence_badge || 'bronze').toUpperCase()
            );
            state.signalMarkers.push(marker);
        });
    }

    function updateGreenWave(gw) {
        const box = document.getElementById('green-wave-box');
        if (!box) return;
        if (gw && gw.available) {
            box.classList.add('active');
            box.innerHTML = `
                <span class="green-wave-icon">🟢</span>
                <div>
                    <div class="green-wave-speed">${gw.recommended_speed_kmh} km/h</div>
                    <div class="green-wave-text">${gw.advisory}</div>
                </div>
            `;
        } else {
            box.classList.remove('active');
            box.innerHTML = '<span class="green-wave-icon">🌊</span><span class="green-wave-text">No green wave available</span>';
        }
    }

    // === SECTION 8: DEPARTURE CHART ===

    async function loadDepartureOptions() {
        if (!state.origin || !state.destination) {
            showToast('Set origin and destination first', 'warning');
            return;
        }
        showLoading('Analyzing departure times...');
        try {
            const now = new Date();
            const end = new Date(now.getTime() + 2 * 3600000);
            const data = await api.post('/api/depart-options', {
                origin: state.origin,
                destination: state.destination,
                start_time: now.toISOString(),
                end_time: end.toISOString(),
                interval_minutes: 10
            });
            renderDepartureChart(data.options);
            renderRecommendation(data.recommendation);
            switchTab('departures');
            showToast('Departure analysis complete', 'success');
        } catch (e) {
            console.error('Departure analysis failed:', e);
        } finally {
            hideLoading();
        }
    }

    function renderDepartureChart(options) {
        const canvas = document.getElementById('departure-chart');
        if (!canvas) return;

        if (state.departureChart) {
            state.departureChart.destroy();
            state.departureChart = null;
        }

        if (!options || !options.length || !options[0].routes) return;

        const labels = options.map(o => formatTime(o.depart_at));
        const routeNames = {};
        options.forEach(o => o.routes.forEach(r => { routeNames[r.id] = r.name; }));

        const datasets = [];
        const routeIds = Object.keys(routeNames);
        routeIds.forEach((rid, idx) => {
            const color = CONFIG.ROUTE_COLORS[idx % CONFIG.ROUTE_COLORS.length];
            // P50 line
            datasets.push({
                label: routeNames[rid] + ' (P50)',
                data: options.map(o => {
                    const r = o.routes.find(rt => rt.id === rid);
                    return r ? r.travel_minutes_p50 : null;
                }),
                borderColor: color,
                backgroundColor: color + '20',
                tension: 0.3,
                pointRadius: 3,
                borderWidth: 2
            });
            // P90 line (dashed)
            datasets.push({
                label: routeNames[rid] + ' (P90)',
                data: options.map(o => {
                    const r = o.routes.find(rt => rt.id === rid);
                    return r ? r.travel_minutes_p90 : null;
                }),
                borderColor: color + '80',
                borderDash: [6, 4],
                tension: 0.3,
                pointRadius: 2,
                borderWidth: 1.5
            });
        });

        state.departureChart = new Chart(canvas, {
            type: 'line',
            data: { labels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: {
                        display: true, position: 'bottom',
                        labels: { color: '#94a3b8', font: { size: 10 }, boxWidth: 12 }
                    },
                    tooltip: {
                        backgroundColor: '#1a2236',
                        titleColor: '#e2e8f0',
                        bodyColor: '#94a3b8',
                        borderColor: '#2a3a5c',
                        borderWidth: 1
                    }
                },
                scales: {
                    x: {
                        ticks: { color: '#94a3b8', font: { size: 10 } },
                        grid: { color: '#2a3a5c33' },
                        title: { display: true, text: 'Departure Time', color: '#64748b', font: { size: 10 } }
                    },
                    y: {
                        ticks: { color: '#94a3b8', font: { size: 10 } },
                        grid: { color: '#2a3a5c33' },
                        title: { display: true, text: 'Travel Time (min)', color: '#64748b', font: { size: 10 } }
                    }
                }
            }
        });
    }

    function renderRecommendation(rec) {
        const el = document.getElementById('depart-recommendation');
        if (!el || !rec) return;
        el.innerHTML = `
            <div class="rec-title">⚡ RECOMMENDATION</div>
            <div class="rec-time">${formatTime(rec.depart_at)}</div>
            <div class="rec-details">via ${rec.route_name}</div>
            <div class="rec-savings">${rec.saves_minutes > 0 ? 'Saves ' + rec.saves_minutes + ' min' : 'Optimal now'}</div>
            <div class="rec-details" style="margin-top:8px;font-style:italic;">${rec.message}</div>
        `;
    }

    // === SECTION 9: INCIDENT MANAGEMENT ===

    async function loadIncidents() {
        if (!state.map) return;
        const bounds = state.map.getBounds();
        try {
            const data = await api.get(
                '/api/incidents?north=' + bounds.getNorth() +
                '&south=' + bounds.getSouth() +
                '&east=' + bounds.getEast() +
                '&west=' + bounds.getWest()
            );
            renderIncidents(data.incidents);
        } catch (e) {
            console.error('Failed to load incidents:', e);
        }
    }

    function renderIncidents(incidents) {
        // Clear old markers
        state.incidentMarkers.forEach(m => state.map.removeLayer(m));
        state.incidentMarkers = [];

        const listEl = document.getElementById('incident-list');

        if (!incidents || !incidents.length) {
            if (listEl) listEl.innerHTML = '<div class="empty-state small"><p>No incidents in this area</p></div>';
            return;
        }

        // Map markers
        const icons = { accident: '🚗', construction: '🚧', closure: '⛔', weather: '🌧️', event: '🎪' };
        incidents.forEach(inc => {
            const marker = L.marker([inc.lat, inc.lng], {
                icon: L.divIcon({
                    className: '',
                    html: '<div style="font-size:20px;text-shadow:0 1px 4px rgba(0,0,0,0.7);">' + (icons[inc.type] || '⚠️') + '</div>',
                    iconSize: [24, 24], iconAnchor: [12, 12]
                })
            }).addTo(state.map);
            marker.bindPopup('<b>' + inc.title + '</b><br>' + inc.description +
                (inc.delay_minutes ? '<br>Delay: ~' + inc.delay_minutes + ' min' : ''));
            state.incidentMarkers.push(marker);
        });

        // List cards
        if (listEl) {
            listEl.innerHTML = incidents.map(inc => `
                <div class="incident-card" data-severity="${inc.severity}">
                    <div class="incident-header">
                        <span class="severity-badge" style="background:${severityColor(inc.severity)}"></span>
                        <span class="incident-type">${inc.type}</span>
                        <span class="incident-title">${inc.title}</span>
                    </div>
                    <div class="incident-desc">${inc.description}</div>
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <span class="incident-meta">${inc.road_name || ''} · ${formatTime(inc.start_time)}</span>
                        ${inc.delay_minutes ? '<span class="incident-delay">+' + inc.delay_minutes + ' min</span>' : ''}
                    </div>
                </div>
            `).join('');
        }
    }

    function severityColor(sev) {
        const colors = { 1: '#22c55e', 2: '#eab308', 3: '#f97316', 4: '#ef4444', 5: '#991b1b' };
        return colors[sev] || '#64748b';
    }

    // === SECTION 10: CONVOY MODE ===

    function toggleConvoyMode(enabled) {
        state.convoyMode = enabled;
        const convoyOpts = document.getElementById('convoy-options');
        const convoyPlan = document.getElementById('convoy-plan');
        if (convoyOpts) convoyOpts.style.display = enabled ? 'block' : 'none';
        if (convoyPlan) convoyPlan.style.display = 'none'; // reset until a route is calculated

        document.querySelectorAll('.toggle-btn[data-mode]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === (enabled ? 'convoy' : 'car'));
        });
    }

    function renderConvoyPlan(convoy) {
        const planEl = document.getElementById('convoy-plan');
        const tbody = document.getElementById('convoy-table-body');
        if (!planEl || !tbody || !convoy) return;

        planEl.style.display = 'block';
        tbody.innerHTML = convoy.vehicles.map(v => `
            <tr>
                <td>${v.callsign}</td>
                <td>${formatTime(v.depart_at)}</td>
                <td>${formatTime(v.eta_p50)}</td>
                <td>${formatTime(v.eta_p90)}</td>
            </tr>
        `).join('');
    }

    // === SECTION 11: AVOID ZONES ===

    async function loadAvoidZones() {
        try {
            const data = await api.get('/api/avoid-zones');
            state.avoidZones = data.zones || [];
            renderAvoidZonesList();
            renderAvoidZonesOnMap();
        } catch (e) {
            // Silently fail — zones are optional
        }
    }

    function renderAvoidZonesList() {
        const list = document.getElementById('avoid-zones-list');
        if (!list) return;
        if (!state.avoidZones.length) {
            list.innerHTML = '<div class="empty-state small"><p>No avoid zones defined</p></div>';
            return;
        }
        list.innerHTML = state.avoidZones.map(z => `
            <div class="avoid-zone-card">
                <span class="avoid-zone-name">${z.name}</span>
                <button class="btn-delete-zone" data-zone-id="${z.id}" title="Delete">🗑️</button>
            </div>
        `).join('');

        list.querySelectorAll('.btn-delete-zone').forEach(btn => {
            btn.addEventListener('click', () => deleteAvoidZone(btn.dataset.zoneId));
        });
    }

    function renderAvoidZonesOnMap() {
        state.avoidZonePolygons.forEach(p => state.map.removeLayer(p));
        state.avoidZonePolygons = [];

        state.avoidZones.forEach(z => {
            const polygon = typeof z.polygon === 'string' ? JSON.parse(z.polygon) : z.polygon;
            const leafletPoly = L.polygon(polygon, {
                color: '#ef4444', fillColor: '#ef4444', fillOpacity: 0.15,
                weight: 2, dashArray: '8 4'
            }).addTo(state.map);
            leafletPoly.bindPopup('Avoid Zone: ' + z.name);
            state.avoidZonePolygons.push(leafletPoly);
        });
    }

    async function deleteAvoidZone(id) {
        try {
            await api.delete('/api/avoid-zones/' + id);
            showToast('Zone deleted', 'success', 2000);
            await loadAvoidZones();
        } catch (e) {
            console.error('Failed to delete zone:', e);
        }
    }

    function startDrawingZone() {
        state.avoidZoneDrawing = true;
        state.drawingPoints = [];
        if (state.drawingLayer) state.map.removeLayer(state.drawingLayer);
        state.drawingLayer = L.polygon([], { color: '#ef4444', fillOpacity: 0.2, dashArray: '4 4' }).addTo(state.map);
        showToast('Click on the map to add points. Double-click to finish.', 'info', 5000);

        document.getElementById('btn-draw-zone').style.display = 'none';
        document.getElementById('btn-finish-zone').style.display = 'block';
        document.getElementById('btn-cancel-zone').style.display = 'block';
    }

    function addDrawingPoint(latlng) {
        state.drawingPoints.push([latlng.lat, latlng.lng]);
        if (state.drawingLayer) state.drawingLayer.setLatLngs(state.drawingPoints);
    }

    async function finishDrawingZone() {
        state.avoidZoneDrawing = false;
        if (state.drawingPoints.length < 3) {
            showToast('Need at least 3 points for a zone', 'warning');
            cancelDrawingZone();
            return;
        }
        const name = document.getElementById('input-zone-name').value || 'Zone ' + (state.avoidZones.length + 1);
        try {
            await api.post('/api/avoid-zones', { name, polygon: state.drawingPoints });
            showToast('Zone "' + name + '" created', 'success');
            await loadAvoidZones();
        } catch (e) {
            console.error('Failed to create zone:', e);
        }
        cleanupDrawing();
    }

    function cancelDrawingZone() {
        state.avoidZoneDrawing = false;
        cleanupDrawing();
    }

    function cleanupDrawing() {
        state.drawingPoints = [];
        if (state.drawingLayer) { state.map.removeLayer(state.drawingLayer); state.drawingLayer = null; }
        document.getElementById('btn-draw-zone').style.display = 'block';
        document.getElementById('btn-finish-zone').style.display = 'none';
        document.getElementById('btn-cancel-zone').style.display = 'none';
        document.getElementById('input-zone-name').value = '';
    }

    // === SECTION 12: UI CONTROLS ===

    function setupPanelToggles() {
        const leftPanel = document.getElementById('left-panel');
        const rightPanel = document.getElementById('right-panel');
        const btnLeft = document.getElementById('btn-collapse-left');
        const btnRight = document.getElementById('btn-collapse-right');
        const mapEl = document.getElementById('map');

        if (btnLeft) {
            btnLeft.addEventListener('click', () => {
                const isCollapsed = leftPanel.classList.toggle('panel-collapsed');
                btnLeft.textContent = isCollapsed ? '▸' : '◂';
                if (mapEl) mapEl.style.left = isCollapsed ? '0px' : 'var(--left-panel-w)';
                setTimeout(() => state.map && state.map.invalidateSize(), 200);
            });
        }
        if (btnRight) {
            btnRight.addEventListener('click', () => {
                const isCollapsed = rightPanel.classList.toggle('panel-collapsed');
                btnRight.textContent = isCollapsed ? '◂' : '▸';
                if (mapEl) mapEl.style.right = isCollapsed ? '0px' : 'var(--right-panel-w)';
                setTimeout(() => state.map && state.map.invalidateSize(), 200);
            });
        }
    }

    function switchTab(tabName) {
        document.querySelectorAll('.tab-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.tab === tabName);
        });
        document.querySelectorAll('.tab-content').forEach(c => {
            c.classList.toggle('active', c.id === 'tab-' + tabName);
        });
    }

    // === SECTION 13: COUNTDOWN TIMERS ===

    function startCountdowns() {
        stopCountdowns();
        const lastFrame = { time: 0 };

        function update(timestamp) {
            if (timestamp - lastFrame.time < 1000 / CONFIG.COUNTDOWN_FPS) {
                state.countdownRAF = requestAnimationFrame(update);
                return;
            }
            lastFrame.time = timestamp;

            if (!state.signals.length || !state.signalDataTime) {
                state.countdownRAF = requestAnimationFrame(update);
                return;
            }

            const elapsed = (Date.now() - state.signalDataTime) / 1000;

            document.querySelectorAll('.signal-entry').forEach((el, i) => {
                const sig = state.signals[i];
                if (!sig || sig.seconds_remaining == null) return;

                const cycle = sig.cycle_length_s || 90;
                const greenDur = sig.green_duration_s || cycle * 0.45;
                const redDur = sig.red_duration_s || cycle - greenDur;
                let raw = sig.seconds_remaining - elapsed;

                // Wrap around cycle
                while (raw < 0) raw += cycle;
                raw = raw % cycle;

                // Determine current phase based on position in cycle
                let phase, remaining;
                if (sig.current_phase === 'green') {
                    if (raw <= greenDur) {
                        phase = 'green';
                        remaining = raw;
                    } else {
                        phase = 'red';
                        remaining = raw - greenDur;
                        if (remaining > redDur) { phase = 'green'; remaining = raw % greenDur; }
                    }
                } else {
                    if (raw <= redDur) {
                        phase = 'red';
                        remaining = raw;
                    } else {
                        phase = 'green';
                        remaining = raw - redDur;
                        if (remaining > greenDur) { phase = 'red'; remaining = raw % redDur; }
                    }
                }

                const countdownEl = el.querySelector('.signal-countdown');
                const dotEl = el.querySelector('.phase-dot');

                if (countdownEl) {
                    countdownEl.textContent = Math.max(0, Math.round(remaining)) + 's';
                    countdownEl.classList.toggle('pulse', remaining < 5 && remaining > 0);
                }
                if (dotEl) {
                    dotEl.className = 'phase-dot phase-' + phase;
                }
            });

            state.countdownRAF = requestAnimationFrame(update);
        }

        state.countdownRAF = requestAnimationFrame(update);
    }

    function stopCountdowns() {
        if (state.countdownRAF) {
            cancelAnimationFrame(state.countdownRAF);
            state.countdownRAF = null;
        }
    }

    // === SECTION 14: SYSTEM STATUS ===

    async function loadSystemStatus() {
        try {
            const data = await api.get('/api/system-status');
            state.systemStatus = data;
            renderSystemStatus(data);
        } catch (e) {
            // Show degraded
            const dot = document.getElementById('system-status-dot');
            const txt = document.getElementById('system-status-text');
            if (dot) { dot.className = 'status-dot status-offline'; }
            if (txt) { txt.textContent = 'OFFLINE'; }
        }
    }

    function renderSystemStatus(data) {
        // Top bar status
        const dot = document.getElementById('system-status-dot');
        const txt = document.getElementById('system-status-text');
        if (dot) {
            dot.className = 'status-dot status-' + (data.status === 'operational' ? 'operational' : data.status === 'degraded' ? 'degraded' : 'offline');
        }
        if (txt) txt.textContent = data.status.toUpperCase();

        // Degraded banner
        const banner = document.getElementById('degraded-banner');
        if (banner) banner.classList.toggle('visible', data.status === 'degraded' || data.offline_mode);

        // Bottom bar confidence
        const confEl = document.getElementById('bottom-confidence');
        if (confEl && data.confidence_overall) {
            confEl.className = 'confidence-pill confidence-' + data.confidence_overall;
            confEl.textContent = 'DATA CONFIDENCE: ' + data.confidence_overall.toUpperCase();
        }

        // Bottom source info
        const srcEl = document.getElementById('bottom-source');
        if (srcEl && data.collector) {
            const lastUp = data.collector.last_run ? formatTime(data.collector.last_run) : 'never';
            srcEl.textContent = 'Source: ' + (data.offline_mode ? 'Offline' : 'Live + Historical') + ' | Last update: ' + lastUp;
        }

        // Status tab details
        const fields = {
            'status-val': { text: data.status.toUpperCase(), class: data.status === 'operational' ? 'status-ok' : 'status-warn' },
            'status-uptime': { text: formatUptime(data.collector && data.collector.last_run ? 0 : 0) },
            'status-mode': { text: data.offline_mode ? 'Offline' : 'Online' },
            'db-size': { text: (data.database?.size_mb || 0) + ' MB' },
            'db-history': { text: (data.database?.history_days || 0) + ' days' },
            'db-samples': { text: (data.database?.total_samples || 0).toLocaleString() },
            'db-segments': { text: (data.database?.segments_tracked || 0).toString() },
            'coll-active': { text: data.collector?.active ? '✓ Active' : '✗ Inactive', class: data.collector?.active ? 'status-ok' : 'status-err' },
            'coll-last': { text: data.collector?.last_run ? formatTime(data.collector.last_run) : 'Never' },
            'coll-segments': { text: (data.collector?.segments_monitored || 0).toString() }
        };

        for (const [id, val] of Object.entries(fields)) {
            const el = document.getElementById(id);
            if (el) {
                el.textContent = val.text;
                if (val.class) el.className = 'status-value ' + val.class;
            }
        }

        // Data sources
        const sourcesEl = document.getElementById('status-sources');
        if (sourcesEl && data.data_sources) {
            sourcesEl.innerHTML = data.data_sources.map(s => {
                const dotClass = s.status === 'ok' ? 'ok' : s.status === 'error' ? 'error' : 'disabled';
                const quota = s.quota_daily ? `${s.calls_today}/${s.quota_daily}` : '∞';
                const pct = s.quota_daily ? Math.min(100, (s.calls_today / s.quota_daily) * 100) : 0;
                return `
                    <div class="source-row">
                        <span class="source-dot ${dotClass}"></span>
                        <span class="source-name">${s.name}</span>
                        <span class="source-stats">${quota}</span>
                    </div>
                    ${s.quota_daily ? '<div class="quota-bar" style="margin:0 14px 8px;"><div class="quota-fill" style="width:' + pct + '%"></div></div>' : ''}
                `;
            }).join('');
        }
    }

    // === SECTION 15: TOASTS & NOTIFICATIONS ===

    function showToast(message, type = 'info', duration = 5000) {
        const container = document.getElementById('toast-container');
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = 'toast toast-' + type;
        toast.textContent = message;
        container.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('dismiss');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    function showLoading(message) {
        const el = document.getElementById('loading-overlay');
        const txt = document.getElementById('loading-text');
        if (el) el.classList.add('visible');
        if (txt) txt.textContent = message || 'Loading...';
    }

    function hideLoading() {
        const el = document.getElementById('loading-overlay');
        if (el) el.classList.remove('visible');
    }

    // === SECTION 16: UTILITIES ===

    function formatTime(isoStr) {
        if (!isoStr) return '—';
        try {
            const d = new Date(isoStr);
            return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
        } catch { return '—'; }
    }

    function formatDateTime(isoStr) {
        if (!isoStr) return '—';
        try {
            const d = new Date(isoStr);
            return (d.getDate() + '/' + (d.getMonth() + 1) + ' ' +
                d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0'));
        } catch { return '—'; }
    }

    function formatDuration(minutes) {
        if (minutes == null) return '—';
        if (minutes < 60) return Math.round(minutes) + ' min';
        const h = Math.floor(minutes / 60);
        const m = Math.round(minutes % 60);
        return h + 'h ' + m + 'min';
    }

    function formatUptime(seconds) {
        if (!seconds) return '—';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        return h + 'h ' + m + 'm';
    }

    function debounce(fn, ms) {
        let timer;
        return function (...args) { clearTimeout(timer); timer = setTimeout(() => fn.apply(this, args), ms); };
    }

    function startClock() {
        function tick() {
            const now = new Date();
            const el = document.getElementById('clock-display');
            if (el) {
                el.textContent = now.getHours().toString().padStart(2, '0') + ':' +
                    now.getMinutes().toString().padStart(2, '0') + ':' +
                    now.getSeconds().toString().padStart(2, '0');
            }
        }
        tick();
        setInterval(tick, 1000);
    }

    function parseCoordInput(val) {
        if (!val) return null;
        const parts = val.split(',').map(s => parseFloat(s.trim()));
        if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
            return { lat: parts[0], lng: parts[1] };
        }
        return null;
    }

    // === SECTION 16.5: SEARCH & GEOCODING ===

    async function fetchGeocode(query) {
        if (!query || query.trim().length < 2) return [];
        try {
            const data = await api.get('/api/geocode?q=' + encodeURIComponent(query.trim()));
            return data.results || [];
        } catch (e) {
            console.warn('Geocoding query failed:', e);
            return [];
        }
    }

    async function triggerGeocode(inputId, onSelect, dropdownId) {
        const input = document.getElementById(inputId);
        const dropdown = document.getElementById(dropdownId);
        if (!input) return;
        const val = input.value.trim();
        if (!val) {
            showToast('Enter a place name or address to search', 'warning');
            return;
        }

        // Check if numeric lat, lng
        const parsed = parseCoordInput(val);
        if (parsed) {
            onSelect(parsed.lat, parsed.lng, val);
            if (dropdown) dropdown.style.display = 'none';
            return;
        }

        showLoading('Searching "' + val + '"...');
        try {
            const results = await fetchGeocode(val);
            if (results && results.length > 0) {
                const top = results[0];
                onSelect(top.lat, top.lng, top.label);
                showToast('Located: ' + top.label, 'success', 3000);
            } else {
                showToast('No matching locations found for "' + val + '"', 'warning');
            }
        } catch (e) {
            showToast('Search failed: ' + (e.message || 'Network error'), 'error');
        } finally {
            hideLoading();
            if (dropdown) dropdown.style.display = 'none';
        }
    }

    function setupSearchAutocomplete(inputId, dropdownId, onSelect) {
        const input = document.getElementById(inputId);
        const dropdown = document.getElementById(dropdownId);
        if (!input || !dropdown) return;

        let activeIndex = -1;
        let currentResults = [];

        function renderDropdown(results) {
            currentResults = results;
            activeIndex = -1;
            dropdown.innerHTML = '';
            if (!results || results.length === 0) {
                dropdown.innerHTML = '<div class="suggestion-item suggestion-empty">No locations found</div>';
                dropdown.style.display = 'block';
                return;
            }

            results.forEach((item, idx) => {
                const row = document.createElement('div');
                row.className = 'suggestion-item';
                row.dataset.index = idx;
                row.innerHTML = `
                    <span class="suggestion-icon">📍</span>
                    <span class="suggestion-label" title="${item.label}">${item.label}</span>
                    <span class="suggestion-source badge-${item.source === 'tomtom' ? 'gold' : 'silver'}">${item.source.toUpperCase()}</span>
                `;
                row.addEventListener('mousedown', (e) => {
                    e.preventDefault(); // Prevent input blur before click registers
                    onSelect(item.lat, item.lng, item.label);
                    dropdown.style.display = 'none';
                });
                dropdown.appendChild(row);
            });
            dropdown.style.display = 'block';
        }

        function highlightItem(index) {
            const items = dropdown.querySelectorAll('.suggestion-item');
            items.forEach((el, i) => {
                if (i === index) {
                    el.classList.add('highlighted');
                    el.scrollIntoView({ block: 'nearest' });
                } else {
                    el.classList.remove('highlighted');
                }
            });
        }

        const handleInput = debounce(async () => {
            const val = input.value.trim();
            if (val.length < 2) {
                dropdown.style.display = 'none';
                return;
            }
            if (parseCoordInput(val)) {
                dropdown.style.display = 'none';
                return;
            }
            const results = await fetchGeocode(val);
            renderDropdown(results);
        }, 280);

        input.addEventListener('input', handleInput);

        input.addEventListener('keydown', (e) => {
            if (dropdown.style.display === 'none') {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    triggerGeocode(inputId, onSelect, dropdownId);
                }
                return;
            }

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (currentResults.length > 0) {
                    activeIndex = (activeIndex + 1) % currentResults.length;
                    highlightItem(activeIndex);
                }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (currentResults.length > 0) {
                    activeIndex = (activeIndex - 1 + currentResults.length) % currentResults.length;
                    highlightItem(activeIndex);
                }
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (activeIndex >= 0 && activeIndex < currentResults.length) {
                    const chosen = currentResults[activeIndex];
                    onSelect(chosen.lat, chosen.lng, chosen.label);
                    dropdown.style.display = 'none';
                } else if (currentResults.length > 0) {
                    const top = currentResults[0];
                    onSelect(top.lat, top.lng, top.label);
                    dropdown.style.display = 'none';
                } else {
                    triggerGeocode(inputId, onSelect, dropdownId);
                }
            } else if (e.key === 'Escape') {
                dropdown.style.display = 'none';
            }
        });

        // Hide dropdown on click outside
        document.addEventListener('click', (e) => {
            if (!input.contains(e.target) && !dropdown.contains(e.target)) {
                dropdown.style.display = 'none';
            }
        });
    }

    // === SECTION 17: EVENT HANDLERS ===

    async function handleCalculateRoute() {
        const oVal = document.getElementById('input-origin')?.value.trim();
        const dVal = document.getElementById('input-destination')?.value.trim();

        // Auto-resolve origin if typed address without map click
        if (!state.origin || (oVal && oVal !== state.origin.label && oVal !== `${state.origin.lat.toFixed(5)}, ${state.origin.lng.toFixed(5)}`)) {
            const parsed = parseCoordInput(oVal);
            if (parsed) {
                setOrigin(L.latLng(parsed.lat, parsed.lng));
            } else if (oVal) {
                showLoading('Locating origin "' + oVal + '"...');
                const results = await fetchGeocode(oVal);
                if (results.length > 0) {
                    setOrigin(L.latLng(results[0].lat, results[0].lng), results[0].label);
                }
            }
        }

        // Auto-resolve destination if typed address without map click
        if (!state.destination || (dVal && dVal !== state.destination.label && dVal !== `${state.destination.lat.toFixed(5)}, ${state.destination.lng.toFixed(5)}`)) {
            const parsed = parseCoordInput(dVal);
            if (parsed) {
                setDestination(L.latLng(parsed.lat, parsed.lng));
            } else if (dVal) {
                showLoading('Locating destination "' + dVal + '"...');
                const results = await fetchGeocode(dVal);
                if (results.length > 0) {
                    setDestination(L.latLng(results[0].lat, results[0].lng), results[0].label);
                }
            }
        }

        if (!state.origin || !state.destination) {
            showToast('Set both origin and destination (type place name or click map)', 'warning');
            hideLoading();
            return;
        }

        showLoading('Calculating route...');
        state.selectedRouteId = null;

        try {
            const departMode = document.querySelector('input[name="depart-mode"]:checked')?.value || 'now';
            let depart_at = null;
            if (departMode !== 'now') {
                const dtVal = document.getElementById('input-datetime').value;
                if (dtVal) depart_at = new Date(dtVal).toISOString();
            }

            const body = {
                origin: state.origin,
                destination: state.destination,
                depart_at,
                mode: state.convoyMode ? 'convoy' : 'car',
                alternatives: document.getElementById('opt-alternatives')?.checked ?? true,
            };

            if (state.convoyMode) {
                body.convoy_options = {
                    vehicle_count: parseInt(document.getElementById('input-convoy-count')?.value) || 3,
                    separation_minutes: parseInt(document.getElementById('input-convoy-sep')?.value) || 5
                };
            }

            const data = await api.post('/api/route', body);

            renderRoutes(data.routes);

            if (data.best_route_id) selectRoute(data.best_route_id);

            if (data.routes.length) {
                fitMapToRoute(data.routes[0]);
                updateNavHUDWithRoute(data.routes[0]);
            }

            // Auto-close drawers on mobile so navigation HUD is immediately visible
            const lp = document.getElementById('left-panel');
            const rp = document.getElementById('right-panel');
            const mb = document.getElementById('mobile-backdrop');
            if (lp) lp.classList.remove('drawer-open');
            if (rp) rp.classList.remove('drawer-open');
            if (mb) mb.style.display = 'none';

            // Load incidents
            if (document.getElementById('opt-incidents')?.checked) {
                await loadIncidents();
            }

            // Convoy plan
            if (data.convoy) {
                renderConvoyPlan(data.convoy);
            }

            showToast(data.routes.length + ' route(s) found', 'success', 3000);

        } catch (e) {
            console.error('Route calculation failed:', e);
        } finally {
            hideLoading();
        }
    }

    async function handleAnalyzeDepartures() {
        await loadDepartureOptions();
    }

    // === SECTION 17.5: IN-CAR NAVIGATION HUD & SIMULATION ===

    function calculateBearing(lat1, lng1, lat2, lng2) {
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const y = Math.sin(dLng) * Math.cos(lat2 * Math.PI / 180);
        const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
                  Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLng);
        const brng = Math.atan2(y, x) * 180 / Math.PI;
        return (brng + 360) % 360;
    }

    function createCarIcon(bearingDeg = 0) {
        return L.divIcon({
            className: 'nav-car-marker-container',
            html: `
                <div class="nav-car-marker" style="transform: rotate(${Math.round(bearingDeg)}deg)">
                    <svg width="44" height="74" viewBox="0 0 44 74" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <ellipse cx="22" cy="38" rx="15" ry="30" fill="rgba(0,0,0,0.45)" />
                        <rect x="7" y="10" width="30" height="54" rx="10" fill="#dc2626" />
                        <path d="M10 22 C10 14 34 14 34 22 L33 54 C33 58 11 58 11 54 Z" fill="#ef4444" />
                        <rect x="11" y="24" width="22" height="24" rx="6" fill="#991b1b" />
                        <path d="M12 24 C14 18 30 18 32 24 Z" fill="#0f172a" />
                        <path d="M12 48 C14 52 30 52 32 48 Z" fill="#0f172a" />
                        <rect x="10" y="27" width="2.5" height="18" rx="1" fill="#0f172a" />
                        <rect x="31.5" y="27" width="2.5" height="18" rx="1" fill="#0f172a" />
                        <rect x="8" y="10" width="7" height="4" rx="2" fill="#fef08a" />
                        <rect x="29" y="10" width="7" height="4" rx="2" fill="#fef08a" />
                        <polygon points="4,-4 40,-4 34,10 10,10" fill="rgba(254, 240, 138, 0.25)" />
                        <rect x="8" y="61" width="7" height="3" rx="1.5" fill="#f87171" />
                        <rect x="29" y="61" width="7" height="3" rx="1.5" fill="#f87171" />
                    </svg>
                </div>
            `,
            iconSize: [44, 74],
            iconAnchor: [22, 37]
        });
    }

    function createRoadSignalPillIcon(seconds = 24, phase = 'green') {
        const isGreen = phase === 'green';
        return L.divIcon({
            className: 'nav-signal-pill-marker-container',
            html: `
                <div class="nav-road-signal-group">
                    <div class="nav-road-pill">
                        <span class="nav-road-pill-timer ${isGreen ? 'green' : 'red'}">${seconds}</span>
                        <div class="nav-road-lanes">
                            <span class="lane-arrow">↑</span>
                            <span class="lane-arrow active">↑</span>
                            <span class="lane-arrow">↑</span>
                            <span class="lane-arrow">↱</span>
                        </div>
                    </div>
                    <div class="nav-road-traffic-light">
                        <div class="tl-housing">
                            <span class="tl-bulb red ${!isGreen ? 'active' : ''}"></span>
                            <span class="tl-bulb yellow"></span>
                            <span class="tl-bulb green ${isGreen ? 'active' : ''}"></span>
                        </div>
                    </div>
                </div>
            `,
            iconSize: [140, 60],
            iconAnchor: [70, 50]
        });
    }

    function createRoadAlertIcon(type = 'cam') {
        return L.divIcon({
            className: 'nav-road-alert-container',
            html: `
                <div class="nav-road-alert-badge">
                    <div class="alert-icon-circle cam">📷</div>
                    <div class="alert-icon-circle no-stop">🚫</div>
                </div>
            `,
            iconSize: [52, 28],
            iconAnchor: [26, 14]
        });
    }

    function toggleDayNightTheme(targetTheme) {
        const newTheme = targetTheme || (state.theme === 'night' ? 'day' : 'night');
        state.theme = newTheme;
        const isDay = newTheme === 'day';
        document.body.classList.toggle('theme-day', isDay);

        const iconEl = document.getElementById('hud-theme-icon');
        if (iconEl) iconEl.textContent = isDay ? '☀️' : '🌙';

        // Switch map tile layer
        if (state.map) {
            if (state.tileLayer) state.map.removeLayer(state.tileLayer);
            if (isDay) {
                state.tileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
                    subdomains: 'abcd', maxZoom: 19, attribution: '&copy; CartoDB'
                }).addTo(state.map);
            } else {
                state.tileLayer = L.tileLayer(CONFIG.TILE_ESRI_DARK, {
                    maxZoom: 16, attribution: '&copy; Esri'
                }).addTo(state.map);
            }
        }
        showToast(isDay ? 'Day Mode Activated' : 'Night Mode Activated', 'info', 1800);
    }

    function updateSpeedometer(speedKmh) {
        state.currentSpeed = Math.max(0, Math.round(speedKmh));
        const valEl = document.getElementById('hud-speed-val');
        if (valEl) valEl.textContent = state.currentSpeed;

        const barEl = document.getElementById('hud-speed-bar');
        if (barEl) {
            // Circumference of r=32 is 2 * PI * 32 = 201
            const maxSpeed = 80;
            const fraction = Math.min(1, state.currentSpeed / maxSpeed);
            const offset = 201 - (fraction * 150);
            barEl.style.strokeDashoffset = offset;
        }
    }

    function initMiniMap(routeCoords) {
        if (!routeCoords || routeCoords.length === 0) return;
        const container = document.getElementById('hud-minimap');
        if (!container) return;

        try {
            if (!state.miniMap) {
                state.miniMap = L.map('hud-minimap', {
                    zoomControl: false,
                    attributionControl: false,
                    dragging: false,
                    scrollWheelZoom: false,
                    doubleClickZoom: false,
                    boxZoom: false
                });
                L.tileLayer(CONFIG.TILE_ESRI_DARK, { maxZoom: 16 }).addTo(state.miniMap);
            }

            if (state.miniMapPolyline) state.miniMap.removeLayer(state.miniMapPolyline);

            const latlngs = routeCoords.map(c => [c[0], c[1]]);
            state.miniMapPolyline = L.polyline(latlngs, {
                color: '#38bdf8',
                weight: 4,
                opacity: 0.95
            }).addTo(state.miniMap);

            state.miniMap.fitBounds(L.latLngBounds(latlngs), { padding: [10, 10] });
        } catch (e) {
            console.warn('MiniMap init note:', e);
        }
    }

    function updateNavHUDWithRoute(route) {
        if (!route) return;

        // Turn Card
        const turnDistEl = document.getElementById('hud-turn-dist');
        const turnStreetEl = document.getElementById('hud-turn-street');
        const turnIconEl = document.getElementById('hud-turn-icon');

        const distKm = route.distance_km || 1.6;
        if (turnDistEl) {
            if (distKm >= 1) turnDistEl.innerHTML = (distKm * 0.7).toFixed(1) + ' <span class="unit">km</span>';
            else turnDistEl.innerHTML = Math.round(distKm * 700) + ' <span class="unit">m</span>';
        }

        const destLabel = state.destination?.label || 'Durova St';
        const origLabel = state.origin?.label || 'Tsvetnoy Blvd';

        if (turnStreetEl) turnStreetEl.textContent = destLabel.split(',')[0];
        if (turnIconEl) turnIconEl.textContent = '↰';

        // Current street
        const curStreetEl = document.getElementById('hud-current-street-name');
        if (curStreetEl) curStreetEl.textContent = origLabel.split(',')[0];

        // Bottom dock stats
        const statTime = document.getElementById('hud-stat-time');
        const statArrival = document.getElementById('hud-stat-arrival');
        const statDist = document.getElementById('hud-stat-dist');

        const etaMin = Math.round(route.eta_p50_minutes || 4);
        if (statTime) statTime.textContent = etaMin;
        if (statDist) statDist.textContent = distKm.toFixed(1);

        if (statArrival) {
            const arrDate = new Date(Date.now() + etaMin * 60000);
            statArrival.textContent = arrDate.getHours().toString().padStart(2, '0') + ':' +
                                      arrDate.getMinutes().toString().padStart(2, '0');
        }

        // Initialize or update MiniMap
        const allCoords = route.segments.flatMap(s => s.coords);
        if (allCoords.length) {
            initMiniMap(allCoords);
            renderRoadHUDMarkers(route, state.signals);
        }
    }

    function renderRoadHUDMarkers(route, signals) {
        if (!state.map) return;
        // Clear previous road HUD markers
        if (state.carMarker) { state.map.removeLayer(state.carMarker); state.carMarker = null; }
        state.roadSignalMarkers.forEach(m => state.map.removeLayer(m));
        state.roadSignalMarkers = [];
        state.roadAlertMarkers.forEach(m => state.map.removeLayer(m));
        state.roadAlertMarkers = [];

        const allCoords = route.segments.flatMap(s => s.coords);
        if (!allCoords.length) return;

        // 1. Initial Car Marker at start of route
        const startPt = allCoords[0];
        const nextPt = allCoords[Math.min(3, allCoords.length - 1)];
        const bearing = calculateBearing(startPt[0], startPt[1], nextPt[0], nextPt[1]);

        state.carMarker = L.marker([startPt[0], startPt[1]], {
            icon: createCarIcon(bearing),
            zIndexOffset: 1000
        }).addTo(state.map);

        // 2. Traffic Signal with live countdown & lane guidance on road
        if (allCoords.length > 6) {
            const sigIdx = Math.floor(allCoords.length * 0.45);
            const sigPt = allCoords[sigIdx];
            const roadSigMarker = L.marker([sigPt[0], sigPt[1]], {
                icon: createRoadSignalPillIcon(state.hudSignalTimer, state.hudSignalPhase),
                zIndexOffset: 900
            }).addTo(state.map);
            state.roadSignalMarkers.push(roadSigMarker);
        }

        // 3. Speed camera alert marker on road
        if (allCoords.length > 10) {
            const camIdx = Math.floor(allCoords.length * 0.75);
            const camPt = allCoords[camIdx];
            const alertMarker = L.marker([camPt[0], camPt[1]], {
                icon: createRoadAlertIcon('cam'),
                zIndexOffset: 850
            }).addTo(state.map);
            state.roadAlertMarkers.push(alertMarker);
        }
    }

    function startDriveSimulation() {
        if (!state.routes.length) {
            showToast('Calculate a route first to start navigation', 'warning');
            return;
        }

        const route = state.routes.find(r => r.id === state.selectedRouteId) || state.routes[0];
        const allCoords = route.segments.flatMap(s => s.coords);
        if (allCoords.length < 2) return;

        state.isDriving = true;
        const driveBtn = document.getElementById('btn-hud-drive');
        if (driveBtn) {
            driveBtn.innerHTML = '<span>⏸</span>';
            driveBtn.classList.add('active');
        }
        showToast('Navigation Drive Started', 'success', 2000);

        let coordIdx = state.driveProgressIndex || 0;
        const total = allCoords.length;

        if (state.driveTimer) clearInterval(state.driveTimer);

        state.driveTimer = setInterval(() => {
            if (!state.isDriving) return;

            coordIdx = (coordIdx + 1) % total;
            state.driveProgressIndex = coordIdx;

            const curr = allCoords[coordIdx];
            const next = allCoords[(coordIdx + 1) % total];
            const bearing = calculateBearing(curr[0], curr[1], next[0], next[1]);

            // Update car marker
            if (state.carMarker) {
                state.carMarker.setLatLng([curr[0], curr[1]]);
                state.carMarker.setIcon(createCarIcon(bearing));
            }

            // Smoothly pan map with vehicle
            if (coordIdx % 4 === 0) {
                state.map.panTo([curr[0], curr[1]], { animate: true, duration: 0.3 });
            }

            // Dynamically simulate speed
            const progressRatio = coordIdx / total;
            const isNearSignal = Math.abs(progressRatio - 0.45) < 0.08;
            let targetSpeed = 48;
            if (isNearSignal) {
                targetSpeed = state.hudSignalPhase === 'red' ? 0 : 26;
            } else {
                targetSpeed = 45 + Math.round(Math.sin(coordIdx) * 8);
            }
            updateSpeedometer(targetSpeed);

            // Signal countdown decrement
            state.hudSignalTimer--;
            if (state.hudSignalTimer <= 0) {
                state.hudSignalPhase = state.hudSignalPhase === 'green' ? 'red' : 'green';
                state.hudSignalTimer = state.hudSignalPhase === 'green' ? 24 : 32;
            }

            // Update Road Signal Pill Marker
            state.roadSignalMarkers.forEach(m => {
                m.setIcon(createRoadSignalPillIcon(state.hudSignalTimer, state.hudSignalPhase));
            });

            // Update Center HUD Signal Pill
            const centerSignal = document.getElementById('hud-signal-circle');
            if (centerSignal) {
                centerSignal.textContent = state.hudSignalTimer;
                centerSignal.className = 'hud-signal-circle ' + state.hudSignalPhase;
            }

            // Update remaining distance and turn distance
            const remKm = Math.max(0.1, (route.distance_km * (1 - progressRatio)));
            const statDist = document.getElementById('hud-stat-dist');
            if (statDist) statDist.textContent = remKm.toFixed(1);

            const turnDistEl = document.getElementById('hud-turn-dist');
            if (turnDistEl) {
                const turnDist = (remKm * 0.6);
                if (turnDist >= 1) turnDistEl.innerHTML = turnDist.toFixed(1) + ' <span class="unit">km</span>';
                else turnDistEl.innerHTML = Math.max(50, Math.round(turnDist * 1000)) + ' <span class="unit">m</span>';
            }

        }, 130);
    }

    function pauseDriveSimulation() {
        state.isDriving = false;
        if (state.driveTimer) {
            clearInterval(state.driveTimer);
            state.driveTimer = null;
        }
        const driveBtn = document.getElementById('btn-hud-drive');
        if (driveBtn) {
            driveBtn.innerHTML = '<span>▶</span>';
            driveBtn.classList.remove('active');
        }
        showToast('Navigation Drive Paused', 'info', 1500);
    }

    function setupMobileDrawers() {
        const leftPanel = document.getElementById('left-panel');
        const rightPanel = document.getElementById('right-panel');
        const backdrop = document.getElementById('mobile-backdrop');

        function openDrawer(panel) {
            panel.classList.add('drawer-open');
            if (backdrop) backdrop.style.display = 'block';
        }

        function closeAllDrawers() {
            if (leftPanel) leftPanel.classList.remove('drawer-open');
            if (rightPanel) rightPanel.classList.remove('drawer-open');
            if (backdrop) backdrop.style.display = 'none';
        }

        // Search button in bottom dock
        document.getElementById('btn-hud-search')?.addEventListener('click', () => {
            if (leftPanel && leftPanel.classList.contains('drawer-open')) {
                closeAllDrawers();
            } else if (leftPanel) {
                closeAllDrawers();
                openDrawer(leftPanel);
            }
        });

        // Menu button in bottom dock
        document.getElementById('btn-hud-menu')?.addEventListener('click', () => {
            if (rightPanel && rightPanel.classList.contains('drawer-open')) {
                closeAllDrawers();
            } else if (rightPanel) {
                closeAllDrawers();
                openDrawer(rightPanel);
            }
        });

        // Backdrop click closes drawers
        if (backdrop) backdrop.addEventListener('click', closeAllDrawers);

        // Day/Night toggle buttons
        document.getElementById('btn-toggle-daynight')?.addEventListener('click', () => toggleDayNightTheme());
        document.getElementById('btn-hud-theme')?.addEventListener('click', () => toggleDayNightTheme());

        // HUD Drive Simulation buttons
        document.getElementById('btn-hud-drive')?.addEventListener('click', () => {
            if (state.isDriving) pauseDriveSimulation();
            else startDriveSimulation();
        });
        document.getElementById('btn-hud-start-nav')?.addEventListener('click', () => {
            if (state.isDriving) pauseDriveSimulation();
            else startDriveSimulation();
        });

        // Toggle HUD on desktop button
        document.getElementById('btn-toggle-hud')?.addEventListener('click', () => {
            const hud = document.getElementById('nav-hud');
            if (hud) {
                const isHidden = hud.style.display === 'none';
                hud.style.display = isHidden ? 'flex' : 'none';
                showToast(isHidden ? 'In-Car HUD Enabled' : 'In-Car HUD Hidden', 'info', 1500);
            }
        });
    }

    // === SECTION 17.6: 4D ROAD PERSPECTIVE ENGINE & 360° STREET VIEW ===

    function init4DEngine() {
        const canvas = document.getElementById('view-4d-canvas');
        if (!canvas) return;
        state.canvas4D = canvas;
        state.ctx4D = canvas.getContext('2d');

        function resizeCanvas() {
            if (canvas) {
                canvas.width = window.innerWidth;
                canvas.height = window.innerHeight - (window.innerWidth <= 900 ? 42 : 48);
            }
        }
        window.addEventListener('resize', resizeCanvas);
        resizeCanvas();
    }

    function switchViewMode(mode) {
        state.viewMode = mode;
        const canvas4D = document.getElementById('view-4d-canvas');
        const svOverlay = document.getElementById('street-view-overlay');
        const mapEl = document.getElementById('map');

        document.querySelectorAll('.view-switch-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.view === mode);
        });

        if (mode === '2d') {
            if (canvas4D) canvas4D.style.display = 'none';
            if (svOverlay) svOverlay.style.display = 'none';
            if (mapEl) mapEl.style.opacity = '1';
            stop4DLoop();
            if (state.map) state.map.invalidateSize();
            showToast('2D Tactical Map View', 'info', 1500);
        } else if (mode === '3d') {
            if (svOverlay) svOverlay.style.display = 'none';
            if (canvas4D) {
                canvas4D.style.display = 'block';
                canvas4D.width = window.innerWidth;
                canvas4D.height = window.innerHeight - (window.innerWidth <= 900 ? 42 : 48);
            }
            start4DLoop();
            showToast('3D / 4D Perspective Driver View', 'info', 1500);
        } else if (mode === 'street') {
            stop4DLoop();
            if (canvas4D) canvas4D.style.display = 'none';
            if (svOverlay) svOverlay.style.display = 'flex';
            initStreetViewPanorama();
            showToast('360° Panoramic Street View', 'info', 1500);
        }
    }

    function toggle4DWeather() {
        const modes = ['clear', 'rain', 'fog'];
        const nextIdx = (modes.indexOf(state.weather4D) + 1) % modes.length;
        state.weather4D = modes[nextIdx];

        const iconEl = document.getElementById('hud-weather-icon');
        if (iconEl) {
            if (state.weather4D === 'clear') iconEl.textContent = '☀️';
            else if (state.weather4D === 'rain') iconEl.textContent = '🌧️';
            else iconEl.textContent = '🌫️';
        }
        showToast('4D Weather: ' + state.weather4D.toUpperCase(), 'info', 1800);
    }

    // 4D Perspective Road Render Loop
    function start4DLoop() {
        if (state.raf4D) return;

        // Rain particle system
        const raindrops = [];
        for (let i = 0; i < 120; i++) {
            raindrops.push({
                x: Math.random() * window.innerWidth,
                y: Math.random() * window.innerHeight,
                len: 12 + Math.random() * 18,
                speed: 18 + Math.random() * 12
            });
        }

        let trafficOffset = 0;

        function loop() {
            if (state.viewMode !== '3d') {
                stop4DLoop();
                return;
            }
            render4DScene(raindrops, trafficOffset);
            trafficOffset += (state.currentSpeed > 0 ? 0.005 : 0.001);
            state.raf4D = requestAnimationFrame(loop);
        }
        state.raf4D = requestAnimationFrame(loop);
    }

    function stop4DLoop() {
        if (state.raf4D) {
            cancelAnimationFrame(state.raf4D);
            state.raf4D = null;
        }
    }

    function render4DScene(raindrops, trafficOffset) {
        const ctx = state.ctx4D;
        const canvas = state.canvas4D;
        if (!ctx || !canvas) return;

        const w = canvas.width;
        const h = canvas.height;
        const isDay = state.theme === 'day';
        const speed = state.currentSpeed || 24;

        state.simOffset = (state.simOffset + (speed * 0.08)) % 100;

        // 1. Sky & Horizon
        const skyGrad = ctx.createLinearGradient(0, 0, 0, h * 0.45);
        if (isDay) {
            skyGrad.addColorStop(0, '#7dd3fc');
            skyGrad.addColorStop(0.7, '#bae6fd');
            skyGrad.addColorStop(1, '#e0f2fe');
        } else {
            skyGrad.addColorStop(0, '#040711');
            skyGrad.addColorStop(0.6, '#0b1324');
            skyGrad.addColorStop(1, '#111e38');
        }
        ctx.fillStyle = skyGrad;
        ctx.fillRect(0, 0, w, h * 0.45);

        // Distant city silhouette
        ctx.fillStyle = isDay ? '#cbd5e1' : '#090f1d';
        for (let bx = 0; bx < w; bx += 32) {
            const bh = 15 + Math.sin(bx * 0.05) * 12 + ((bx % 64 === 0) ? 18 : 0);
            ctx.fillRect(bx, h * 0.45 - bh, 30, bh);
        }

        // 2. Ground Terrain & Sidewalks
        const groundGrad = ctx.createLinearGradient(0, h * 0.45, 0, h);
        groundGrad.addColorStop(0, isDay ? '#94a3b8' : '#0c1220');
        groundGrad.addColorStop(1, isDay ? '#64748b' : '#080c16');
        ctx.fillStyle = groundGrad;
        ctx.fillRect(0, h * 0.45, w, h * 0.55);

        // Horizon vanishing point
        const vx = w / 2;
        const vy = h * 0.45;

        // 3. Road Surface (Asphalt trapezoid)
        const roadBottomW = Math.min(w * 0.72, 700);
        const roadTopW = 28;

        ctx.beginPath();
        ctx.moveTo(vx - roadTopW / 2, vy);
        ctx.lineTo(vx + roadTopW / 2, vy);
        ctx.lineTo(vx + roadBottomW / 2, h);
        ctx.lineTo(vx - roadBottomW / 2, h);
        ctx.closePath();
        ctx.fillStyle = isDay ? '#334155' : '#141a29';
        ctx.fill();

        // 4. Sidewalks & Curb Lines
        ctx.strokeStyle = isDay ? '#94a3b8' : '#2a3b5c';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(vx - roadTopW / 2, vy);
        ctx.lineTo(vx - roadBottomW / 2, h);
        ctx.moveTo(vx + roadTopW / 2, vy);
        ctx.lineTo(vx + roadBottomW / 2, h);
        ctx.stroke();

        // 5. Active Guidance Lane Corridor (Vibrant Green Path matching screenshot)
        ctx.beginPath();
        const navTopW = roadTopW * 0.35;
        const navBotW = roadBottomW * 0.28;
        const navCenterX = vx - (roadBottomW * 0.12);
        ctx.moveTo(vx - navTopW / 2, vy);
        ctx.lineTo(vx + navTopW / 2, vy);
        ctx.lineTo(navCenterX + navBotW / 2, h);
        ctx.lineTo(navCenterX - navBotW / 2, h);
        ctx.closePath();

        const pathColor = state.hudSignalPhase === 'red' ? '#ef4444' : '#22c55e';
        ctx.fillStyle = isDay ? 'rgba(34, 197, 94, 0.45)' : 'rgba(16, 185, 129, 0.55)';
        ctx.fill();
        ctx.strokeStyle = pathColor;
        ctx.lineWidth = 4;
        ctx.stroke();

        // 6. Dashed Moving Lane Stripes
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 3;
        ctx.setLineDash([18, 16]);
        ctx.lineDashOffset = -state.simOffset;

        ctx.beginPath();
        ctx.moveTo(vx, vy);
        ctx.lineTo(vx, h);
        ctx.stroke();
        ctx.setLineDash([]);

        // 7. Pedestrian Crosswalk (Зебра)
        const crossY = h * 0.68;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
        for (let i = -5; i <= 5; i++) {
            ctx.fillRect(vx + (i * 24) - 8, crossY, 14, 12);
        }

        // 8. 3D Extruded Buildings (Matching Screenshot)
        // Left Building 1 (24 к1 / N-clinic)
        render3DBuilding(ctx, vx - (roadBottomW * 0.55), h * 0.88, 110, 190, '24 к1', isDay);
        render3DBuilding(ctx, vx - (roadBottomW * 0.75), h * 0.65, 80, 150, 'N-clinic', isDay);

        // Right Building 1 (VkusVill / 20/1 / 18)
        render3DBuilding(ctx, vx + (roadBottomW * 0.54), h * 0.86, 115, 200, '20/1', isDay);
        render3DBuilding(ctx, vx + (roadBottomW * 0.74), h * 0.64, 85, 160, '18', isDay);

        // 9. Roadside 3D Trees
        render3DTree(ctx, vx - (roadBottomW * 0.45), h * 0.78, 28, isDay);
        render3DTree(ctx, vx - (roadBottomW * 0.42), h * 0.62, 20, isDay);
        render3DTree(ctx, vx + (roadBottomW * 0.45), h * 0.74, 26, isDay);

        // 10. Roadside Traffic Light Pole & Countdown Marker (Right side of road)
        const tlX = vx + (roadBottomW * 0.28);
        const tlY = h * 0.62;
        renderRoadTrafficSignal(ctx, tlX, tlY, state.hudSignalTimer, state.hudSignalPhase, isDay);

        // 11. 3D Red Vehicle Follow-Cam (Foreground)
        render3DCarForeground(ctx, navCenterX, h * 0.84, isDay);

        // 12. 4D Weather: Rain Effect
        if (state.weather4D === 'rain') {
            ctx.strokeStyle = 'rgba(186, 230, 253, 0.65)';
            ctx.lineWidth = 1.5;
            raindrops.forEach(drop => {
                ctx.beginPath();
                ctx.moveTo(drop.x, drop.y);
                ctx.lineTo(drop.x - 3, drop.y + drop.len);
                ctx.stroke();

                drop.y += drop.speed;
                drop.x -= 1.5;
                if (drop.y > h) {
                    drop.y = -10;
                    drop.x = Math.random() * w;
                }
            });
        }
    }

    function render3DBuilding(ctx, x, y, bw, bh, label, isDay) {
        // Base shadow
        ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
        ctx.fillRect(x - 5, y - bh + 5, bw + 10, bh + 5);

        // Front wall
        ctx.fillStyle = isDay ? '#f8fafc' : '#1e293b';
        ctx.fillRect(x, y - bh, bw, bh);

        // Side perspective wall
        ctx.fillStyle = isDay ? '#e2e8f0' : '#0f172a';
        ctx.beginPath();
        ctx.moveTo(x + bw, y - bh);
        ctx.lineTo(x + bw + 20, y - bh - 15);
        ctx.lineTo(x + bw + 20, y - 15);
        ctx.lineTo(x + bw, y);
        ctx.closePath();
        ctx.fill();

        // Roof
        ctx.fillStyle = isDay ? '#cbd5e1' : '#334155';
        ctx.beginPath();
        ctx.moveTo(x, y - bh);
        ctx.lineTo(x + 20, y - bh - 15);
        ctx.lineTo(x + bw + 20, y - bh - 15);
        ctx.lineTo(x + bw, y - bh);
        ctx.closePath();
        ctx.fill();

        // Building Label
        ctx.fillStyle = isDay ? '#475569' : '#94a3b8';
        ctx.font = 'bold 11px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(label, x + bw / 2, y - bh + 22);

        // Windows
        const winColor = isDay ? '#93c5fd' : (label.includes('1') ? '#fbbf24' : '#38bdf8');
        ctx.fillStyle = winColor;
        for (let wy = y - bh + 36; wy < y - 15; wy += 22) {
            for (let wx = x + 12; wx < x + bw - 15; wx += 20) {
                ctx.fillRect(wx, wy, 10, 12);
            }
        }
    }

    function render3DTree(ctx, x, y, r, isDay) {
        ctx.fillStyle = 'rgba(0,0,0,0.2)';
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * 0.4, 0, 0, Math.PI * 2);
        ctx.fill();

        // Trunk
        ctx.fillStyle = '#78350f';
        ctx.fillRect(x - 3, y - r * 1.4, 6, r * 1.4);

        // Foliage
        ctx.fillStyle = isDay ? '#22c55e' : '#15803d';
        ctx.beginPath();
        ctx.arc(x, y - r * 1.6, r, 0, Math.PI * 2);
        ctx.fill();
    }

    function renderRoadTrafficSignal(ctx, x, y, timer, phase, isDay) {
        const isGreen = phase === 'green';
        // Post
        ctx.fillStyle = '#475569';
        ctx.fillRect(x - 2, y, 4, 38);

        // Housing
        ctx.fillStyle = '#0f172a';
        ctx.strokeStyle = '#334155';
        ctx.lineWidth = 2;
        ctx.fillRect(x - 8, y - 40, 16, 40);
        ctx.strokeRect(x - 8, y - 40, 16, 40);

        // Bulbs
        ctx.fillStyle = !isGreen ? '#ef4444' : '#334155';
        ctx.beginPath(); ctx.arc(x, y - 32, 4, 0, Math.PI * 2); ctx.fill();

        ctx.fillStyle = '#334155';
        ctx.beginPath(); ctx.arc(x, y - 20, 4, 0, Math.PI * 2); ctx.fill();

        ctx.fillStyle = isGreen ? '#22c55e' : '#334155';
        ctx.beginPath(); ctx.arc(x, y - 8, 4, 0, Math.PI * 2); ctx.fill();

        // Floating Pill with countdown & lane guidance
        const pillW = 86;
        const pillH = 26;
        const px = x - pillW / 2;
        const py = y - 72;

        ctx.fillStyle = 'rgba(15, 23, 42, 0.95)';
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(px, py, pillW, pillH, 13);
        ctx.fill();
        ctx.stroke();

        // Timer badge
        ctx.fillStyle = isGreen ? '#22c55e' : '#ef4444';
        ctx.beginPath();
        ctx.arc(px + 14, py + 13, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(timer, px + 14, py + 16.5);

        // Lane arrows
        ctx.font = 'bold 11px sans-serif';
        ctx.fillStyle = '#64748b';
        ctx.fillText('↑', px + 34, py + 17);
        ctx.fillStyle = '#ffffff';
        ctx.fillText('↑', px + 48, py + 17);
        ctx.fillStyle = '#64748b';
        ctx.fillText('↑', px + 62, py + 17);
        ctx.fillText('↱', px + 75, py + 17);
    }

    function render3DCarForeground(ctx, x, y, isDay) {
        // Shadow
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.beginPath();
        ctx.ellipse(x, y + 25, 34, 14, 0, 0, Math.PI * 2);
        ctx.fill();

        // Headlight Beams (Night mode)
        if (!isDay) {
            const beamGrad = ctx.createLinearGradient(x, y, x, y - 180);
            beamGrad.addColorStop(0, 'rgba(254, 240, 138, 0.35)');
            beamGrad.addColorStop(1, 'rgba(254, 240, 138, 0)');
            ctx.fillStyle = beamGrad;
            ctx.beginPath();
            ctx.moveTo(x - 22, y - 20);
            ctx.lineTo(x - 90, y - 200);
            ctx.lineTo(x + 90, y - 200);
            ctx.lineTo(x + 22, y - 20);
            ctx.closePath();
            ctx.fill();
        }

        // Car Body
        const cw = 54;
        const ch = 84;
        const cx = x - cw / 2;
        const cy = y - ch / 2;

        ctx.fillStyle = '#b91c1c';
        ctx.beginPath();
        ctx.roundRect(cx, cy, cw, ch, 14);
        ctx.fill();

        ctx.fillStyle = '#dc2626';
        ctx.beginPath();
        ctx.roundRect(cx + 3, cy + 4, cw - 6, ch - 8, 12);
        ctx.fill();

        // Roof & Cabin
        ctx.fillStyle = '#7f1d1d';
        ctx.beginPath();
        ctx.roundRect(cx + 8, cy + 22, cw - 16, 40, 8);
        ctx.fill();

        // Rear window
        ctx.fillStyle = '#0f172a';
        ctx.beginPath();
        ctx.roundRect(cx + 10, cy + 44, cw - 20, 14, 4);
        ctx.fill();

        // Front windshield
        ctx.fillStyle = '#0f172a';
        ctx.beginPath();
        ctx.roundRect(cx + 10, cy + 24, cw - 20, 12, 4);
        ctx.fill();

        // Taillights
        ctx.fillStyle = '#ef4444';
        ctx.shadowColor = '#ef4444';
        ctx.shadowBlur = 10;
        ctx.fillRect(cx + 4, cy + ch - 8, 12, 4);
        ctx.fillRect(cx + cw - 16, cy + ch - 8, 12, 4);
        ctx.shadowBlur = 0;
    }

    // 360° Street View Engine
    function initStreetViewPanorama() {
        const canvas = document.getElementById('street-view-canvas');
        if (!canvas) return;

        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight - 56;

        const streetNameEl = document.getElementById('sv-street-name');
        const coordsEl = document.getElementById('sv-coords');

        const curPt = state.origin || { lat: 28.6139, lng: 77.2090, label: 'Tsvetnoy Boulevard' };
        if (streetNameEl) streetNameEl.textContent = curPt.label || 'Tsvetnoy Boulevard';
        if (coordsEl) coordsEl.textContent = `${curPt.lat.toFixed(5)}, ${curPt.lng.toFixed(5)}`;

        renderStreetViewPanorama();

        // Mouse & Touch 360 Drag Controls
        canvas.onmousedown = (e) => {
            state.streetViewDragging = true;
            state.streetViewDragStart = { x: e.clientX, y: e.clientY, heading: state.streetViewHeading, pitch: state.streetViewPitch };
        };

        window.onmousemove = (e) => {
            if (!state.streetViewDragging) return;
            const dx = e.clientX - state.streetViewDragStart.x;
            const dy = e.clientY - state.streetViewDragStart.y;
            state.streetViewHeading = (state.streetViewDragStart.heading - dx * 0.3 + 360) % 360;
            state.streetViewPitch = Math.max(-45, Math.min(45, state.streetViewDragStart.pitch + dy * 0.25));

            const compass = document.getElementById('sv-compass-dial');
            if (compass) compass.style.transform = `rotate(${-state.streetViewHeading}deg)`;

            renderStreetViewPanorama();
        };

        window.onmouseup = () => { state.streetViewDragging = false; };

        // Touch support
        canvas.ontouchstart = (e) => {
            if (e.touches.length === 1) {
                state.streetViewDragging = true;
                state.streetViewDragStart = {
                    x: e.touches[0].clientX, y: e.touches[0].clientY,
                    heading: state.streetViewHeading, pitch: state.streetViewPitch
                };
            }
        };
        window.ontouchmove = (e) => {
            if (!state.streetViewDragging || e.touches.length !== 1) return;
            const dx = e.touches[0].clientX - state.streetViewDragStart.x;
            const dy = e.touches[0].clientY - state.streetViewDragStart.y;
            state.streetViewHeading = (state.streetViewDragStart.heading - dx * 0.3 + 360) % 360;
            state.streetViewPitch = Math.max(-45, Math.min(45, state.streetViewDragStart.pitch + dy * 0.25));
            renderStreetViewPanorama();
        };
        window.ontouchend = () => { state.streetViewDragging = false; };
    }

    function renderStreetViewPanorama() {
        const canvas = document.getElementById('street-view-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;

        const heading = state.streetViewHeading;
        const pitch = state.streetViewPitch;
        const horizonY = (h / 2) + (pitch * 4);

        // 1. 360 Sky Dome
        const skyGrad = ctx.createLinearGradient(0, 0, 0, horizonY);
        skyGrad.addColorStop(0, '#0284c7');
        skyGrad.addColorStop(0.7, '#7dd3fc');
        skyGrad.addColorStop(1, '#e0f2fe');
        ctx.fillStyle = skyGrad;
        ctx.fillRect(0, 0, w, horizonY);

        // Clouds & Sun
        const sunX = ((heading + 90) % 360) * (w / 360);
        ctx.fillStyle = 'rgba(254, 240, 138, 0.85)';
        ctx.beginPath();
        ctx.arc(sunX, horizonY * 0.4, 26, 0, Math.PI * 2);
        ctx.fill();

        // 2. 360 Street Floor & Asphalt
        const roadGrad = ctx.createLinearGradient(0, horizonY, 0, h);
        roadGrad.addColorStop(0, '#64748b');
        roadGrad.addColorStop(0.2, '#334155');
        roadGrad.addColorStop(1, '#1e293b');
        ctx.fillStyle = roadGrad;
        ctx.fillRect(0, horizonY, w, h - horizonY);

        // Perspective Road Markings in 360 Panorama
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 4;
        ctx.setLineDash([24, 20]);
        ctx.beginPath();
        ctx.moveTo(w / 2, horizonY);
        ctx.lineTo(w / 2, h);
        ctx.stroke();
        ctx.setLineDash([]);

        // 3. 360 Panorama Cityscape Facades (Equirectangular Cylindrical projection)
        const buildingCount = 12;
        const colW = w / 6;

        for (let i = 0; i < buildingCount; i++) {
            const bAngle = (i * (360 / buildingCount));
            const angleDiff = ((bAngle - heading + 540) % 360) - 180;
            const bx = (w / 2) + (angleDiff * (w / 120));

            if (bx > -colW && bx < w + colW) {
                const bh = 140 + Math.sin(i * 3) * 60;
                // Building Wall
                ctx.fillStyle = (i % 2 === 0) ? '#e2e8f0' : '#cbd5e1';
                ctx.fillRect(bx - colW / 2, horizonY - bh, colW - 6, bh);

                // Shopfront / Store sign
                ctx.fillStyle = (i % 3 === 0) ? '#2563eb' : (i % 3 === 1 ? '#16a34a' : '#ea580c');
                ctx.fillRect(bx - colW / 2 + 6, horizonY - 45, colW - 18, 16);
                ctx.fillStyle = '#fff';
                ctx.font = 'bold 9px sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText(i % 2 === 0 ? 'STORE' : 'CAFE', bx, horizonY - 33);

                // Windows
                ctx.fillStyle = '#94a3b8';
                for (let wy = horizonY - bh + 20; wy < horizonY - 55; wy += 22) {
                    for (let wx = bx - colW / 2 + 10; wx < bx + colW / 2 - 15; wx += 16) {
                        ctx.fillRect(wx, wy, 10, 14);
                    }
                }
            }
        }

        // 4. Street Trees & Lamp Posts
        for (let i = 0; i < 8; i++) {
            const tAngle = (i * 45);
            const diff = ((tAngle - heading + 540) % 360) - 180;
            const tx = (w / 2) + (diff * (w / 120));
            if (tx > -30 && tx < w + 30) {
                // Tree
                ctx.fillStyle = '#15803d';
                ctx.beginPath();
                ctx.arc(tx, horizonY - 25, 24, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#78350f';
                ctx.fillRect(tx - 3, horizonY - 8, 6, 18);
            }
        }
    }

    function setupViewControls() {
        // Mode Switcher buttons
        document.querySelectorAll('.view-switch-btn').forEach(btn => {
            btn.addEventListener('click', () => switchViewMode(btn.dataset.view));
        });

        // Weather toggle button
        document.getElementById('btn-hud-weather')?.addEventListener('click', toggle4DWeather);

        // Street View header actions
        document.getElementById('btn-sv-close')?.addEventListener('click', () => switchViewMode('2d'));

        document.getElementById('btn-sv-step-next')?.addEventListener('click', () => {
            if (state.routes.length) {
                const route = state.routes[0];
                const allCoords = route.segments.flatMap(s => s.coords);
                state.streetViewIndex = Math.min(allCoords.length - 1, state.streetViewIndex + 2);
                const pt = allCoords[state.streetViewIndex];
                if (pt) {
                    state.origin = { lat: pt[0], lng: pt[1], label: route.name || 'En Route' };
                    initStreetViewPanorama();
                }
            }
        });

        document.getElementById('btn-sv-step-prev')?.addEventListener('click', () => {
            if (state.routes.length) {
                const route = state.routes[0];
                const allCoords = route.segments.flatMap(s => s.coords);
                state.streetViewIndex = Math.max(0, state.streetViewIndex - 2);
                const pt = allCoords[state.streetViewIndex];
                if (pt) {
                    state.origin = { lat: pt[0], lng: pt[1], label: route.name || 'En Route' };
                    initStreetViewPanorama();
                }
            }
        });

        document.getElementById('btn-sv-open-external')?.addEventListener('click', () => {
            const curPt = state.origin || { lat: 28.6139, lng: 77.2090 };
            const url = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${curPt.lat},${curPt.lng}`;
            window.open(url, '_blank');
        });
    }

    function initHUD() {
        updateSpeedometer(24);
    }

    function setupEventListeners() {
        setupMobileDrawers();
        setupViewControls();
        // Calculate route
        const btnCalc = document.getElementById('btn-calculate');
        if (btnCalc) btnCalc.addEventListener('click', handleCalculateRoute);

        // Analyze departures
        const btnDep = document.getElementById('btn-departures');
        if (btnDep) btnDep.addEventListener('click', handleAnalyzeDepartures);

        // Swap
        const btnSwap = document.getElementById('btn-swap');
        if (btnSwap) {
            btnSwap.addEventListener('click', () => {
                const tmpO = state.origin;
                const tmpM = state.originMarker;
                state.origin = state.destination;
                state.originMarker = state.destMarker;
                state.destination = tmpO;
                state.destMarker = tmpM;
                const oInput = document.getElementById('input-origin');
                const dInput = document.getElementById('input-destination');
                if (oInput && dInput) {
                    const tmp = oInput.value;
                    oInput.value = dInput.value;
                    dInput.value = tmp;
                }
            });
        }

        // Departure mode radios
        document.querySelectorAll('input[name="depart-mode"]').forEach(radio => {
            radio.addEventListener('change', () => {
                const dtInput = document.getElementById('input-datetime');
                if (dtInput) dtInput.style.display = radio.value === 'now' ? 'none' : 'block';
            });
        });

        // Mode toggles
        document.querySelectorAll('.toggle-btn[data-mode]').forEach(btn => {
            btn.addEventListener('click', () => toggleConvoyMode(btn.dataset.mode === 'convoy'));
        });

        // Options toggle
        const btnOpts = document.getElementById('btn-toggle-options');
        if (btnOpts) {
            btnOpts.addEventListener('click', () => {
                const sec = document.getElementById('options-section');
                if (sec) {
                    const showing = sec.style.display !== 'none';
                    sec.style.display = showing ? 'none' : 'block';
                    btnOpts.textContent = (showing ? '▸' : '▾') + ' Options';
                }
            });
        }

        // Tab switching
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => switchTab(btn.dataset.tab));
        });

        // Panel collapse
        setupPanelToggles();

        // Login
        const btnLogin = document.getElementById('btn-login');
        if (btnLogin) {
            btnLogin.addEventListener('click', () => {
                const u = document.getElementById('login-username')?.value;
                const p = document.getElementById('login-password')?.value;
                if (u && p) login(u, p);
            });
        }
        // Login on Enter
        document.getElementById('login-password')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') document.getElementById('btn-login')?.click();
        });

        // Settings
        document.getElementById('btn-settings')?.addEventListener('click', () => {
            const m = document.getElementById('settings-modal');
            if (m) m.style.display = 'flex';
        });
        document.getElementById('btn-close-settings')?.addEventListener('click', () => {
            const m = document.getElementById('settings-modal');
            if (m) m.style.display = 'none';
        });

        // Map theme selector in settings
        document.getElementById('select-map-theme')?.addEventListener('change', (e) => {
            const val = e.target.value;
            if (!state.map) return;
            if (state.tileLayer) state.map.removeLayer(state.tileLayer);
            if (val === 'standard') {
                state.tileLayer = L.tileLayer(CONFIG.TILE_OSM, { subdomains: 'abc', maxZoom: 19 }).addTo(state.map);
            } else if (val === 'tomtom') {
                state.tileLayer = L.tileLayer(CONFIG.TILE_TOMTOM, { maxZoom: 19 }).addTo(state.map);
            } else {
                state.tileLayer = L.tileLayer(CONFIG.TILE_DARK, { subdomains: 'abcd', maxZoom: 19 }).addTo(state.map);
            }
        });

        // Tactical mode
        document.getElementById('opt-tactical')?.addEventListener('change', (e) => {
            document.body.classList.toggle('tactical', e.target.checked);
            state.tacticalMode = e.target.checked;
        });

        // Logout
        document.getElementById('btn-logout')?.addEventListener('click', () => {
            document.getElementById('settings-modal').style.display = 'none';
            logout();
        });

        // Offline toggle
        document.getElementById('btn-offline-toggle')?.addEventListener('click', () => {
            showToast('Offline mode toggle — requires server restart with GOSWIFT_OFFLINE=1', 'info');
        });

        // Avoid zones
        document.getElementById('btn-draw-zone')?.addEventListener('click', startDrawingZone);
        document.getElementById('btn-finish-zone')?.addEventListener('click', finishDrawingZone);
        document.getElementById('btn-cancel-zone')?.addEventListener('click', cancelDrawingZone);

        // Search Place autocomplete & geocoding
        setupSearchAutocomplete('input-origin', 'origin-suggestions', (lat, lng, label) => {
            setOrigin(L.latLng(lat, lng), label);
            if (state.map) state.map.setView([lat, lng], 13);
        });
        setupSearchAutocomplete('input-destination', 'destination-suggestions', (lat, lng, label) => {
            setDestination(L.latLng(lat, lng), label);
            if (state.map) state.map.setView([lat, lng], 13);
        });

        document.getElementById('btn-geocode-origin')?.addEventListener('click', () => {
            triggerGeocode('input-origin', (lat, lng, label) => {
                setOrigin(L.latLng(lat, lng), label);
                if (state.map) state.map.setView([lat, lng], 13);
            }, 'origin-suggestions');
        });

        document.getElementById('btn-geocode-dest')?.addEventListener('click', () => {
            triggerGeocode('input-destination', (lat, lng, label) => {
                setDestination(L.latLng(lat, lng), label);
                if (state.map) state.map.setView([lat, lng], 13);
            }, 'destination-suggestions');
        });

        // Current location
        document.getElementById('btn-locate-origin')?.addEventListener('click', () => {
            if (navigator.geolocation) {
                navigator.geolocation.getCurrentPosition(
                    pos => {
                        setOrigin(L.latLng(pos.coords.latitude, pos.coords.longitude));
                        if (state.map) state.map.setView([pos.coords.latitude, pos.coords.longitude], 13);
                    },
                    () => showToast('Could not get location', 'error')
                );
            }
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.target.closest('.modal') && !e.target.closest('.search-group')) {
                handleCalculateRoute();
            }
            if (e.key === 'Escape') {
                document.querySelectorAll('.modal').forEach(m => m.style.display = 'none');
                document.querySelectorAll('.suggestions-dropdown').forEach(d => d.style.display = 'none');
                if (state.avoidZoneDrawing) cancelDrawingZone();
            }
        });

        // Window resize
        window.addEventListener('resize', debounce(() => {
            if (state.map) state.map.invalidateSize();
        }, 200));
    }

    // === SECTION 18: INITIALIZATION ===

    function setupAutoRefresh() {
        // Refresh system status every 30s
        state.statusTimer = setInterval(() => loadSystemStatus(), 30000);
    }

    function init() {
        checkAuth();
        initMap();
        startClock();
        loadSystemStatus();
        loadAvoidZones();
        setupEventListeners();
        setupAutoRefresh();
        initHUD();
        init4DEngine();

        console.log('%c◉ GoSwift v1.0 Initialized', 'color: #3b82f6; font-weight: bold; font-size: 14px;');
    }

    document.addEventListener('DOMContentLoaded', init);
    window.addEventListener('load', () => {
        if (state.map) state.map.invalidateSize();
    });

})();
