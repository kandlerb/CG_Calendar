import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mapsUrl } from '../public/lib/maps.js';

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

describe('tapping an address', () => {
  it('opens the default maps app on Android', () => {
    assert.equal(mapsUrl('12 Oak St, Augusta, GA', ANDROID), 'geo:0,0?q=12%20Oak%20St%2C%20Augusta%2C%20GA');
  });

  it('opens Apple Maps on an iPhone, iPad or Mac', () => {
    assert.equal(mapsUrl('12 Oak St', IPHONE), 'https://maps.apple.com/?q=12%20Oak%20St');
    assert.equal(mapsUrl('12 Oak St', MAC), 'https://maps.apple.com/?q=12%20Oak%20St');
  });

  it('opens Google Maps anywhere else', () => {
    assert.equal(
      mapsUrl('Riverside Park, Shelter B', WINDOWS),
      'https://www.google.com/maps/search/?api=1&query=Riverside%20Park%2C%20Shelter%20B',
    );
    assert.equal(mapsUrl('Park & Rec #2'), 'https://www.google.com/maps/search/?api=1&query=Park%20%26%20Rec%20%232');
  });

  it('has nothing to open for a blank address', () => {
    assert.equal(mapsUrl('  ', WINDOWS), null);
    assert.equal(mapsUrl(undefined), null);
  });
});
