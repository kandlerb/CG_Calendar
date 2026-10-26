// Turning an event's location or a host's address into a link that opens it
// in the maps app the person would expect on their device.

/**
 * A maps link for `address`, or null when there is nothing to look up.
 * `userAgent` decides which app: Apple Maps on an iPhone, iPad or Mac; on
 * Android a geo: link, which opens whichever maps app is the default; Google
 * Maps in the browser everywhere else.
 */
export function mapsUrl(address, userAgent = '') {
  const value = String(address ?? '').trim();
  if (!value) return null;
  const query = encodeURIComponent(value);
  const ua = String(userAgent);
  if (/Android/i.test(ua)) return `geo:0,0?q=${query}`;
  // An iPad asks for the desktop site and says it is a Mac, so it lands here too.
  if (/iPhone|iPad|iPod|Macintosh/i.test(ua)) return `https://maps.apple.com/?q=${query}`;
  return `https://www.google.com/maps/search/?api=1&query=${query}`;
}
