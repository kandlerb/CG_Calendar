// The weather for an event: the forecast for the town it is in, from
// Open-Meteo (https://open-meteo.com) — free, no key, and readable straight
// from the browser. Town level is plenty: the weather at a street address and
// at the town it is in are the same.
//
// The parts that decide things (which town, which forecast numbers, what to
// call them) are plain functions so they can be tested; the fetching is in
// createWeather() at the bottom.

/** Where the group meets, used when an event says nothing more specific. */
export const HOME_TOWN = { name: 'Augusta, GA', latitude: 33.4735, longitude: -82.0105 };

/** Open-Meteo forecasts this many days ahead, today included. */
export const FORECAST_DAYS = 16;

const TIME_ZONE = 'America/New_York';

const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
  KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts',
  MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
  NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

/**
 * The town and state in an address, or null when there is none to find.
 * "12 Oak St, Augusta, GA 30901" → { town: 'Augusta', state: 'Georgia' }.
 * Something like "the Smiths' home" has no town in it, so the event falls
 * back to the home town.
 */
export function townOf(text) {
  const parts = String(text ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const stateMatch = last.match(/^([A-Za-z]{2}|[A-Za-z][A-Za-z .]+?)(?:\s+\d{5}(?:-\d{4})?)?$/);
  if (!stateMatch) return null;
  const code = stateMatch[1].toUpperCase();
  const state = STATES[code] ?? Object.values(STATES).find((s) => s.toLowerCase() === stateMatch[1].toLowerCase());
  if (!state) return null;
  const town = parts[parts.length - 2];
  // "Riverside Park, Shelter B, Augusta, GA" and "12 Oak St, Augusta, GA" both
  // end town, state; a street line on its own ("12 Oak St, GA") is not a town.
  if (!town || /^\d/.test(town)) return null;
  return { town, state };
}

/** The address an event is at: its own location, else a host's address. */
export function eventPlace(event) {
  if (event.location) return event.location;
  return (event.hosts ?? event.signups?.filter((s) => s.kind === 'host') ?? []).find((h) => h.address)?.address ?? '';
}

/** Whether an event is close enough, and still on, to have a forecast. */
export function wantsForecast(event, todayKey) {
  if (event.cancelled || !event.date || event.date < todayKey) return false;
  const [y, m, d] = todayKey.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1, d + FORECAST_DAYS - 1)).toISOString().slice(0, 10);
  return event.date <= last;
}

// WMO weather codes, as Open-Meteo reports them.
const CODES = [
  [[0], '☀️', 'Clear'],
  [[1], '🌤️', 'Mostly clear'],
  [[2], '⛅', 'Partly cloudy'],
  [[3], '☁️', 'Cloudy'],
  [[45, 48], '🌫️', 'Fog'],
  [[51, 53, 55, 56, 57], '🌦️', 'Drizzle'],
  [[61, 63, 80, 81], '🌧️', 'Rain'],
  [[65, 82], '🌧️', 'Heavy rain'],
  [[66, 67], '🌧️', 'Freezing rain'],
  [[71, 73, 75, 77, 85, 86], '🌨️', 'Snow'],
  [[95, 96, 99], '⛈️', 'Thunderstorms'],
];

export function describeCode(code) {
  const found = CODES.find(([codes]) => codes.includes(Number(code)));
  return found ? { icon: found[1], label: found[2] } : { icon: '🌡️', label: 'Weather' };
}

/**
 * What the forecast says for one event: the day's high and low, and — when
 * the event has a start time — the conditions in that hour. Null when the
 * forecast does not reach the day.
 */
export function forecastFor(forecast, date, startTime = '') {
  const daily = forecast?.daily;
  const day = daily?.time?.indexOf(date) ?? -1;
  if (!daily || day < 0) return null;
  const round = (n) => (n === null || n === undefined ? null : Math.round(n));
  const result = {
    high: round(daily.temperature_2m_max?.[day]),
    low: round(daily.temperature_2m_min?.[day]),
    rain: round(daily.precipitation_probability_max?.[day]),
    ...describeCode(daily.weather_code?.[day]),
    at: null,
  };
  const hourly = forecast.hourly;
  if (startTime && hourly?.time) {
    const hour = hourly.time.indexOf(`${date}T${startTime.slice(0, 2)}:00`);
    if (hour >= 0) {
      result.at = {
        temp: round(hourly.temperature_2m?.[hour]),
        rain: round(hourly.precipitation_probability?.[hour]),
        ...describeCode(hourly.weather_code?.[hour]),
      };
    }
  }
  return result;
}

/**
 * One short line for an event: "☀️ Clear, 71° at 6:30 PM · High 74°, low 58° ·
 * 10% chance of rain". `timeLabel` is the start time as the page shows it.
 */
export function weatherLine(f, timeLabel = '') {
  if (!f) return '';
  const parts = [];
  if (f.at) {
    parts.push(`${f.at.icon} ${f.at.label}${f.at.temp !== null ? `, ${f.at.temp}°${timeLabel ? ` at ${timeLabel}` : ''}` : ''}`);
  } else {
    parts.push(`${f.icon} ${f.label}`);
  }
  if (f.high !== null && f.low !== null) parts.push(`High ${f.high}°, low ${f.low}°`);
  const rain = f.at ? f.at.rain : f.rain;
  if (rain !== null && rain !== undefined) parts.push(`${rain}% chance of rain`);
  return parts.join(' · ');
}

/**
 * Fetches and remembers forecasts and town locations. `fetchJson` is
 * injectable for tests. Every failure is quiet: the weather is a nicety, and
 * the calendar works the same without it.
 */
export function createWeather({ fetchJson = defaultFetchJson, home = HOME_TOWN } = {}) {
  const places = new Map(); // "Augusta|Georgia" → { latitude, longitude } | null
  const forecasts = new Map(); // "lat,lon" → { at, data: Promise }
  const FRESH_MS = 30 * 60 * 1000;

  async function locate(place) {
    const found = townOf(place);
    if (!found) return home;
    const key = `${found.town}|${found.state}`.toLowerCase();
    if (!places.has(key)) {
      places.set(
        key,
        fetchJson(
          `https://geocoding-api.open-meteo.com/v1/search?count=10&language=en&format=json&countryCode=US&name=${encodeURIComponent(found.town)}`,
        )
          .then((data) => {
            const hit = (data?.results ?? []).find((r) => r.admin1 === found.state);
            return hit ? { latitude: hit.latitude, longitude: hit.longitude } : null;
          })
          .catch(() => null),
      );
    }
    return (await places.get(key)) ?? home;
  }

  function forecastAt({ latitude, longitude }) {
    const key = `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
    const cached = forecasts.get(key);
    if (cached && Date.now() - cached.at < FRESH_MS) return cached.data;
    const data = fetchJson(
      'https://api.open-meteo.com/v1/forecast' +
        `?latitude=${latitude}&longitude=${longitude}` +
        '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
        '&hourly=temperature_2m,weather_code,precipitation_probability' +
        `&temperature_unit=fahrenheit&timezone=${encodeURIComponent(TIME_ZONE)}&forecast_days=${FORECAST_DAYS}`,
    ).catch(() => null);
    forecasts.set(key, { at: Date.now(), data });
    return data;
  }

  return {
    /** A Map of event id → forecastFor() result, for the events that have one. */
    async forEvents(events, todayKey) {
      const wanted = events.filter((e) => wantsForecast(e, todayKey));
      const out = new Map();
      await Promise.all(
        wanted.map(async (event) => {
          const forecast = await forecastAt(await locate(eventPlace(event)));
          const f = forecastFor(forecast, event.date, event.startTime);
          if (f) out.set(event.id, f);
        }),
      );
      return out;
    },
  };
}

async function defaultFetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`weather ${res.status}`);
  return res.json();
}
