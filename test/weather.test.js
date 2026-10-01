import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createWeather,
  describeCode,
  eventPlace,
  forecastFor,
  HOME_TOWN,
  townOf,
  wantsForecast,
  weatherLine,
} from '../public/lib/weather.js';

const FORECAST = {
  daily: {
    time: ['2026-10-01', '2026-10-02', '2026-10-03'],
    weather_code: [0, 61, 3],
    temperature_2m_max: [74.4, 68.2, 70],
    temperature_2m_min: [58.1, 55, 52.6],
    precipitation_probability_max: [5, 80, 20],
  },
  hourly: {
    time: ['2026-10-03T17:00', '2026-10-03T18:00', '2026-10-03T19:00'],
    temperature_2m: [69.6, 67.2, 64],
    weather_code: [2, 1, 0],
    precipitation_probability: [15, 10, 5],
  },
};

describe('finding the town', () => {
  it('reads the town and state out of a street address', () => {
    assert.deepEqual(townOf('12 Oak St, Augusta, GA 30901'), { town: 'Augusta', state: 'Georgia' });
    assert.deepEqual(townOf('Riverside Park, Shelter B, North Augusta, SC'), {
      town: 'North Augusta',
      state: 'South Carolina',
    });
    assert.deepEqual(townOf('Evans, Georgia'), { town: 'Evans', state: 'Georgia' });
  });

  it('finds nothing in a place with no town in it', () => {
    assert.equal(townOf("the Smiths' home"), null);
    assert.equal(townOf('Riverside Park, Shelter B'), null);
    assert.equal(townOf('12 Oak St, GA'), null);
    assert.equal(townOf(''), null);
  });

  it("uses the event's location, else a host's address", () => {
    assert.equal(eventPlace({ location: 'Evans, GA', hosts: [] }), 'Evans, GA');
    assert.equal(eventPlace({ location: '', hosts: [{ address: '9 Elm, Evans, GA' }] }), '9 Elm, Evans, GA');
    assert.equal(eventPlace({ location: '', hosts: [] }), '');
  });
});

describe('which events get a forecast', () => {
  const today = '2026-10-01';
  it('includes today and the next 15 days, and nothing past or cancelled', () => {
    assert.equal(wantsForecast({ date: '2026-10-01' }, today), true);
    assert.equal(wantsForecast({ date: '2026-10-16' }, today), true);
    assert.equal(wantsForecast({ date: '2026-10-17' }, today), false);
    assert.equal(wantsForecast({ date: '2026-09-30' }, today), false);
    assert.equal(wantsForecast({ date: '2026-10-03', cancelled: true }, today), false);
  });
});

describe('reading the forecast', () => {
  it("takes the day's high, low and rain, rounded", () => {
    const f = forecastFor(FORECAST, '2026-10-01');
    assert.equal(f.high, 74);
    assert.equal(f.low, 58);
    assert.equal(f.rain, 5);
    assert.equal(f.label, 'Clear');
    assert.equal(f.at, null);
  });

  it('adds the conditions in the hour the event starts', () => {
    const f = forecastFor(FORECAST, '2026-10-03', '18:30');
    assert.deepEqual(f.at, { temp: 67, rain: 10, icon: '🌤️', label: 'Mostly clear' });
  });

  it('has nothing for a day beyond the forecast', () => {
    assert.equal(forecastFor(FORECAST, '2026-10-20'), null);
    assert.equal(forecastFor(null, '2026-10-01'), null);
  });

  it('says it in one line', () => {
    assert.equal(
      weatherLine(forecastFor(FORECAST, '2026-10-03', '18:30'), '6:30 PM'),
      '🌤️ Mostly clear, 67° at 6:30 PM · High 70°, low 53° · 10% chance of rain',
    );
    assert.equal(weatherLine(forecastFor(FORECAST, '2026-10-02')), '🌧️ Rain · High 68°, low 55° · 80% chance of rain');
  });

  it('knows the weather codes', () => {
    assert.equal(describeCode(95).label, 'Thunderstorms');
    assert.equal(describeCode(999).label, 'Weather');
  });
});

describe('fetching', () => {
  const event = (over) => ({ id: 'e', date: '2026-10-03', startTime: '18:30', location: '', hosts: [], ...over });

  it('looks up a town once and fetches its forecast', async () => {
    const urls = [];
    const weather = createWeather({
      fetchJson: async (url) => {
        urls.push(url);
        if (url.includes('geocoding')) {
          return { results: [{ admin1: 'Indiana', latitude: 1, longitude: 1 }, { admin1: 'Georgia', latitude: 33.5, longitude: -82.1 }] };
        }
        return FORECAST;
      },
    });
    const found = await weather.forEvents(
      [event({ id: 'a', location: '1 A St, Evans, GA' }), event({ id: 'b', location: '2 B St, Evans, GA' })],
      '2026-10-01',
    );
    assert.equal(found.get('a').at.temp, 67);
    assert.equal(urls.filter((u) => u.includes('geocoding')).length, 1);
    assert.ok(urls.some((u) => u.includes('latitude=33.5') && u.includes('temperature_unit=fahrenheit')));
  });

  it('uses the home town when there is no town to go on', async () => {
    const urls = [];
    const weather = createWeather({ fetchJson: async (url) => (urls.push(url), FORECAST) });
    await weather.forEvents([event({ location: "the Smiths' home" })], '2026-10-01');
    assert.ok(urls[0].includes(`latitude=${HOME_TOWN.latitude}`));
  });

  it('gives up quietly when the weather service is down', async () => {
    const weather = createWeather({
      fetchJson: async () => {
        throw new Error('offline');
      },
    });
    const found = await weather.forEvents([event({})], '2026-10-01');
    assert.equal(found.size, 0);
  });
});
