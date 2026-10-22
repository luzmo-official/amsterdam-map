/* global COMPANIES, SECTORS, ROLES */
// Rows shaped like a Luzmo query result for the chart's buildQuery layout:
// dimensions [name, color (categorical), text details...], measures [lat, lng, measure, color (numeric), numeric details...]

const H = (id, color) => ({ id, name: { en: id }, ...(color ? { color } : {}) });
const col = (columnId, label, type, extra = {}) => ({ datasetId: 'ds-test', columnId, type, label: { en: label }, ...extra });
const EUR = { subtype: 'currency', currency: '€', format: ',.0f', aggregationFunc: 'average' };

export function techPay() {
  const slots = [
    { name: 'name', content: [col('company', 'Company', 'hierarchy')] },
    { name: 'coordinates', content: [col('lat', 'Latitude', 'numeric', { aggregationFunc: 'average' }), col('lng', 'Longitude', 'numeric', { aggregationFunc: 'average' })] },
    { name: 'measure', content: [col('median', 'Median total comp', 'numeric', EUR)] },
    { name: 'color', content: [col('sector', 'Sector', 'hierarchy')] },
    { name: 'details', content: [
      col('hood', 'Neighbourhood', 'hierarchy'),
      col('district', 'District', 'hierarchy'),
      col('base', 'Median base', 'numeric', EUR),
      col('stock', 'Median stock', 'numeric', EUR),
      col('bonus', 'Median bonus', 'numeric', EUR),
      col('subs', 'Submissions', 'numeric', { format: ',.0f', aggregationFunc: 'sum' }),
      col('url', 'Levels.fyi', 'hierarchy')
    ] }
  ];
  const rows = COMPANIES.map((c) => {
    const k = c.roles.swe ? 'swe' : Object.keys(c.roles)[0];
    const r = c.roles[k];
    const m = r.m ?? (r.r ? (r.r[0] + r.r[1]) / 2 : null);
    const p = r.p ?? [null, null, null];
    const url = `https://www.levels.fyi/companies/${c.s}/salaries/${ROLES[k][1]}/locations/greater-amsterdam-area`;
    return [
      H(c.n), H(SECTORS[c.sec].label, SECTORS[c.sec].color), H(c.hood), H(c.ar), H(url),
      c.ll[0], c.ll[1], m, p[0], p[1], p[2], r.n ?? null
    ];
  });
  return { slots, rows };
}

// A non-pay example: EV charging stations with kWh delivered.
export function evCharging(n = 320) {
  const slots = [
    { name: 'name', content: [col('station', 'Station', 'hierarchy')] },
    { name: 'coordinates', content: [col('lat', 'Latitude', 'numeric'), col('lng', 'Longitude', 'numeric')] },
    { name: 'measure', content: [col('kwh', 'kWh delivered', 'numeric', { format: ',.0f', aggregationFunc: 'sum' })] },
    { name: 'color', content: [col('operator', 'Operator', 'hierarchy')] },
    { name: 'details', content: [col('street', 'Street', 'hierarchy'), col('sessions', 'Sessions', 'numeric', { format: ',.0f', aggregationFunc: 'sum' }), col('uptime', 'Uptime', 'numeric', { format: ',.1%', aggregationFunc: 'average' })] }
  ];
  const ops = ['Vattenfall', 'Shell Recharge', 'Equans', 'Allego', 'Fastned'];
  const streets = ['Prinsengracht', 'Ceintuurbaan', 'Javastraat', 'Kinkerstraat', 'Van Woustraat', 'Overtoom', 'Bilderdijkstraat', 'Middenweg', 'Buikslotermeerplein', 'Osdorpplein'];
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const rows = [];
  for (let i = 0; i < n; i++) {
    const lat = 52.33 + rnd() * 0.07, lng = 4.82 + rnd() * 0.13;
    const kwh = Math.round(200 + Math.pow(rnd(), 2.2) * 24000);
    rows.push([H(`EV-${String(i + 1).padStart(4, '0')}`), H(ops[i % ops.length]), H(streets[(i * 7) % streets.length]), lat, lng, kwh, Math.round(kwh / 14), 0.9 + rnd() * 0.1]);
  }
  // edge cases
  rows.push([H('EV-null'), H('Allego'), H('Damrak'), 52.3745, 4.8955, null, null, null]);
  rows.push([H('EV-zero'), H('Allego'), H('Rokin'), 52.3700, 4.8920, 0, 0, 0.5]);
  rows.push([H('EV-negative'), H('Allego'), H('Spui'), 52.3685, 4.8895, -1200, 3, 0.7]);
  rows.push([H('EV-tiny'), H('Allego'), H('Kalverstraat'), 52.3710, 4.8910, 3, 1, 0.99]);
  rows.push([H('EV-Haarlem'), H('Fastned'), H('Grote Markt Haarlem'), 52.3812, 4.6368, 9000, 600, 0.97]);
  rows.push([H('EV-no-coords'), H('Fastned'), H('Unknown'), null, null, 5000, 300, 0.95]);
  return { slots, rows };
}

// Numeric colour: hotels by occupancy, coloured by average daily rate, with a link per hotel.
export function hotels() {
  const slots = [
    { name: 'name', content: [col('hotel', 'Hotel', 'hierarchy')] },
    { name: 'coordinates', content: [col('lat', 'Latitude', 'numeric'), col('lng', 'Longitude', 'numeric')] },
    { name: 'measure', content: [col('occ', 'Occupancy', 'numeric', { format: ',.0%', aggregationFunc: 'average' })] },
    { name: 'color', content: [col('adr', 'Average daily rate', 'numeric', EUR)] },
    { name: 'details', content: [col('site', 'Website', 'hierarchy'), col('rooms', 'Rooms', 'numeric', { format: ',.0f', aggregationFunc: 'sum' })] }
  ];
  const H2 = [['Hotel Okura', 52.3496, 4.8932], ['Conservatorium', 52.3583, 4.8794], ['De L\'Europe', 52.3679, 4.8941], ['Pulitzer', 52.3741, 4.8843], ['Krasnapolsky', 52.3726, 4.8937], ['Sir Albert', 52.3557, 4.8880], ['Lloyd Hotel', 52.3757, 4.9450], ['Hotel V Nesplein', 52.3698, 4.8925], ['Volkshotel', 52.3551, 4.9119], ['Hilton Apollolaan', 52.3497, 4.8820], ['Mövenpick', 52.3785, 4.9152], ['Sir Adam', 52.3846, 4.9018]];
  const rows = H2.map(([n, la, lo], i) => [H(n), H(`https://example.com/hotels/${i + 1}`), la, lo, 0.55 + ((i * 37) % 40) / 100, 120 + ((i * 53) % 400), 80 + i * 21]);
  return { slots, rows };
}
