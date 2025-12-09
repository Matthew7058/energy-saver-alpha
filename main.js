// INFO FROM API
/*
const roofSize = 12; //m^2
const slope = 0; //degrees

const longitude = 0; //degrees
const latitude = 0; //degrees
const azimuth = 0; //degrees 

const currentElectricityKWHprice = 0.3; //£/kWh
const currentElectricityStandingCharge = 0.1; //£/day
const currentElectricityConsumption = 30; //kWh/day
*/


// Minimal Node.js server — PV annual electricity savings (Method B) — NO EXPORT CASE
// Assumes a large site that self-consumes (nearly) all PV in daylight hours.
// No external deps. Run: `node minimal-pv-method-b-server.js` and open:
//   http://localhost:3000/estimate
// Query overrides (numbers): arrayKWp, panelCount, panelWatt (W), tiltDeg, importRate, demand
//   e.g. /estimate?panelCount=250&panelWatt=400&tiltDeg=20&importRate=0.24&demand=250000
// Notes:
// - Uses Liu–Jordan daily Rb (south-facing) + isotropic diffuse transposition.
// - Ground albedo fixed at 0.20 (typical). You can ignore or change in code if desired.
// - Focus is ONLY annual electricity £ savings; no export, no carbon, no cashflow.

const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

// Basic fabricated consumption profile so we can estimate savings vs. status quo.
const companyElectricityProfile = {
  name: 'Network Rail',
  annualConsumptionKWh: 424000,   // ~424 MWh/year total import
  averageDailyKWh: 1160,          // round(annual/365)
  peakDemandKW: 210,              // highest half-hour demand seen on bills
  workingDaysPerYear: 260,        // used if we later need load-shifting calcs
  // Monthly split maintains the same annual total for future analytics.
  monthlyKWh: [32000, 31000, 33000, 35000, 36000, 38000, 39000, 40000, 37000, 36000, 34000, 33000]
};

// Rough cost assumptions used to incorporate maintenance and give ballpark install CAPEX.
const costAssumptions = {
  maintenanceGBPperKWp: 18, // ~£18 per installed kWp per year
  installGBPperKWp: 1050    // £1.05k/kWp turnkey EPC cost
};

const PANEL_WATT_DEFAULT = 400; // W per panel (used when converting panelCount to array kWp)

const FRONTEND_PATH = path.join(__dirname, 'public', 'index.html');
const ASSETS_DIR = path.join(__dirname, 'assets');

// ----------------------------
// 1) Defaults (edit here or override via query params)
// ----------------------------
const defaults = {
  // Site & array
  latDeg: 53.4,   // Manchester-ish
  tiltDeg: 35,    // roof tilt from horizontal
  arrayKWp: 4.0,  // kWp size (override for business-scale)
  albedo: 0.20,   // fixed ground reflectivity (kept simple)
  PR: 0.86,       // performance ratio (~14% losses)

  // Tariff & demand
  importRateGBPperKWh: 0.28, // £/kWh avoided
  // Standing Charge??
  annualElecDemandKWh: companyElectricityProfile.annualConsumptionKWh, // assume we offset this load
  maintenanceGBPperKWp: costAssumptions.maintenanceGBPperKWp,
  installGBPperKWp: costAssumptions.installGBPperKWp,

  // Monthly climate data (kWh/m^2/day). Replace with NASA POWER later.
  GHI_daily: [0.8, 1.5, 2.6, 3.6, 4.6, 4.9, 4.8, 4.3, 3.1, 2.1, 1.0, 0.7], // Radiation straight from sun
  DHI_daily: [0.6, 0.9, 1.2, 1.5, 1.6, 1.6, 1.6, 1.4, 1.2, 0.9, 0.6, 0.5] // Radiation scattered by atmosphere
};

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MID_DOY = [15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349]; // Middle Day of the Month in day of year
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ----------------------------
// 2) Core maths
// ----------------------------
const deg2rad = (d) => (Math.PI / 180) * d;
const rad2deg = (r) => (180 / Math.PI) * r;
const round = (x, n) => { const p = 10 ** n; return Math.round(x * p) / p; };

function declination(dayOfYear) { // radians - angular distance of a point north or south of equator
  return deg2rad(23.45) * Math.sin(deg2rad(360 * (284 + dayOfYear) / 365));
}

function sunsetHourAngle(phi, delta) { // radians - angle of the sun below the horizon
  const x = -Math.tan(phi) * Math.tan(delta);
  const xc = Math.max(-1, Math.min(1, x));
  return Math.acos(xc);
}

// Amount of solar that reaches the panel per year
function annualPOA_kWhm2({ latDeg, tiltDeg, albedo, GHI_daily, DHI_daily }, monthlyDetails = null) {
  const phi = deg2rad(latDeg);
  const beta = deg2rad(tiltDeg);
  let H_POA_year = 0;

  for (let m = 0; m < 12; m++) {
    const H = GHI_daily[m] * DAYS_IN_MONTH[m];
    const Hd = DHI_daily[m] * DAYS_IN_MONTH[m];
    const Hb = H - Hd;

    const delta = declination(MID_DOY[m]);
    const ws = sunsetHourAngle(phi, delta);

    // Liu–Jordan Rb for south-facing plane (azimuth = 0°)
    const num = Math.cos(phi - beta) * Math.cos(delta) * Math.sin(ws)
              + ws * Math.sin(phi - beta) * Math.sin(delta);
    const den = Math.cos(phi) * Math.cos(delta) * Math.sin(ws)
              + ws * Math.sin(phi) * Math.sin(delta);
    const Rb = den !== 0 ? (num / den) : 0;

    const H_tilt = Hb * Rb
                 + Hd * (1 + Math.cos(beta)) / 2
                 + H  * albedo * (1 - Math.cos(beta)) / 2;

    H_POA_year += H_tilt;

    if (monthlyDetails) {
      const ghiMonthly = H;
      const dhiMonthly = Hd;
      const poaMonthly = H_tilt;
      monthlyDetails.push({
        monthIndex: m,
        monthLabel: MONTH_NAMES[m],
        ghiDaily: GHI_daily[m],
        dhiDaily: DHI_daily[m],
        ghiMonthly,
        dhiMonthly,
        poaMonthly,
        beamFraction: (ghiMonthly > 0 ? round(Math.max(0, ghiMonthly - dhiMonthly) / ghiMonthly, 2) : 0),
        sunsetHourAngleDeg: round(rad2deg(ws), 1)
      });
    }
  }
  return H_POA_year; // kWh/m^2/year
}

function estimateAnnualSavingsNoExport(cfg /*All the default values (defaults*/) {
  const monthlySolarDetails = [];
  const H_POA_year = annualPOA_kWhm2(cfg, monthlySolarDetails);

  // Specific yield (kWh/kWp) ≈ POA * PR
  const specificYield = H_POA_year * cfg.PR;
  const pvAnnualKWh = specificYield * cfg.arrayKWp;

  // No export: assume all PV offsets imports, but cap by annual demand if provided
  const demandCapKWh = (cfg.annualElecDemandKWh == null) ? Infinity : Math.max(0, cfg.annualElecDemandKWh);
  const selfUseKWh = Math.min(pvAnnualKWh, demandCapKWh);
  const demandCapApplied = Number.isFinite(demandCapKWh) && pvAnnualKWh > demandCapKWh;

  const avoidedImportGBP = selfUseKWh * cfg.importRateGBPperKWh;
  const annualMaintenanceGBP = cfg.arrayKWp * cfg.maintenanceGBPperKWp;
  const estimatedInstallCostGBP = cfg.arrayKWp * cfg.installGBPperKWp;
  const netAnnualSavingsGBP = avoidedImportGBP - annualMaintenanceGBP;

  const totalGHIkWhm2 = monthlySolarDetails.reduce((sum, m) => sum + m.ghiMonthly, 0);
  const totalDHIkWhm2 = monthlySolarDetails.reduce((sum, m) => sum + m.dhiMonthly, 0);
  const avgSunsetHourAngleDeg = monthlySolarDetails.length
    ? monthlySolarDetails.reduce((sum, m) => sum + m.sunsetHourAngleDeg, 0) / monthlySolarDetails.length
    : 0;
  const solarStory = {
    latitudeDeg: cfg.latDeg,
    tiltDeg: cfg.tiltDeg,
    azimuthDeg: 0,
    arrayKWp: cfg.arrayKWp,
    annualGHIkWhm2: round(totalGHIkWhm2, 1),
    annualDHIkWhm2: round(totalDHIkWhm2, 1),
    annualPOA_kWhm2: round(H_POA_year, 1),
    avgSunsetHourAngleDeg: round(avgSunsetHourAngleDeg, 1),
    monthly: monthlySolarDetails.map((m) => ({
      ...m,
      ghiMonthly: round(m.ghiMonthly, 1),
      dhiMonthly: round(m.dhiMonthly, 1),
      poaMonthly: round(m.poaMonthly, 1)
    }))
  };

  return {
    inputsUsed: {
      arrayKWp: cfg.arrayKWp,
      tiltDeg: cfg.tiltDeg,
      latDeg: cfg.latDeg,
      PR: cfg.PR,
      importRateGBPperKWh: cfg.importRateGBPperKWh,
      annualElecDemandKWh: (cfg.annualElecDemandKWh == null ? 'assumed large (no cap)' : cfg.annualElecDemandKWh),
      maintenanceGBPperKWp: cfg.maintenanceGBPperKWp,
      installGBPperKWp: cfg.installGBPperKWp
    },
    pvAnnualKWh: round(pvAnnualKWh, 0),
    selfUseKWh: round(selfUseKWh, 0),
    avoidedImportGBP: round(avoidedImportGBP, 2),
    annualMaintenanceGBP: round(annualMaintenanceGBP, 2),
    annualSavingsGBP: round(netAnnualSavingsGBP, 2),
    specificYield_kWhPerKWp: round(specificYield, 1),
    H_POA_year_kWhm2: round(H_POA_year, 1),
    demandCapApplied,
    estimatedInstallCostGBP: round(estimatedInstallCostGBP, 2),
    costAssumptionsUsed: {
      maintenanceGBPperKWp: cfg.maintenanceGBPperKWp,
      installGBPperKWp: cfg.installGBPperKWp
    },
    solarStory,
    companyLoadProfile: {
      name: companyElectricityProfile.name,
      annualConsumptionKWh: companyElectricityProfile.annualConsumptionKWh,
      averageDailyKWh: companyElectricityProfile.averageDailyKWh,
      peakDemandKW: companyElectricityProfile.peakDemandKW,
      workingDaysPerYear: companyElectricityProfile.workingDaysPerYear,
      monthlyKWh: companyElectricityProfile.monthlyKWh
    }
  };
}

// ----------------------------
// 3) HTTP
// ----------------------------
function serveFrontend(res) {
  fs.readFile(FRONTEND_PATH, 'utf8', (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('Frontend missing. Please rebuild the vibes.');
    }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  });
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,OPTIONS'
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return serveFrontend(res);
  }

  if (url.pathname.startsWith('/assets/')) {
    const relPath = decodeURIComponent(url.pathname.replace('/assets/', ''));
    const assetPath = path.resolve(ASSETS_DIR, relPath);
    if (!assetPath.startsWith(ASSETS_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('Forbidden');
    }
    fs.readFile(assetPath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not found');
      }
      const ext = path.extname(assetPath).toLowerCase();
      const type = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : ext === '.png' ? 'image/png'
        : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length });
      res.end(data);
    });
    return;
  }

  if (url.pathname === '/estimate') {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      return res.end();
    }
    if (process.env.NODE_ENV !== 'test') {
      console.log('[estimate]', { query: url.search, origin: req.headers.origin || 'same-origin' });
    }
    const cfg = { ...defaults };
    const q = url.searchParams;

    const num = (k) => (q.has(k) ? Number(q.get(k)) : undefined);
    const setNum = (param, key) => { const v = num(param); if (v !== undefined && !Number.isNaN(v)) cfg[key] = v; };

    setNum('arrayKWp', 'arrayKWp');
    setNum('tiltDeg', 'tiltDeg');
    setNum('importRate', 'importRateGBPperKWh');
    setNum('demand', 'annualElecDemandKWh'); // annual kWh demand (optional cap)
    setNum('maintenancePerKWp', 'maintenanceGBPperKWp');
    setNum('installPerKWp', 'installGBPperKWp');

    const panelCount = num('panelCount');
    const panelWatt = num('panelWatt');
    if (panelCount !== undefined && !Number.isNaN(panelCount)) {
      const wattsPerPanel = (!Number.isNaN(panelWatt) && panelWatt > 0) ? panelWatt : PANEL_WATT_DEFAULT;
      cfg.arrayKWp = (panelCount * wattsPerPanel) / 1000;
    }

    const results = estimateAnnualSavingsNoExport(cfg);
    const body = JSON.stringify(results, null, 2);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...CORS_HEADERS });
    return res.end(body);
  }

  const help = `Minimal PV annual savings (no export)

` +
    `GET / -> silly dashboard hitting /estimate\n` +
    `GET /estimate -> JSON with pvAnnualKWh, selfUseKWh, and annualSavingsGBP.
` +
    `Query overrides: arrayKWp, panelCount, panelWatt (W), tiltDeg, importRate, demand
` +
    `Example: /estimate?panelCount=250&panelWatt=400&tiltDeg=20&importRate=0.24&demand=250000`;

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(help);
});

if (require.main === module) {
  server.listen(3000, () => {
    console.log('PV annual savings server (no export) on http://localhost:3000');
  });
}

module.exports = {
  estimateAnnualSavingsNoExport,
  defaults,
  companyElectricityProfile,
  costAssumptions
};
