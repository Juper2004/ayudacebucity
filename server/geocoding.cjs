'use strict';

const DEFAULT_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
const CACHE_TTL = 24 * 60 * 60 * 1000;
const CACHE_SIZE = 500;
// Shared by every app instance in this process, including requests from different users.
const sharedRequestGate = { nextAllowedAt: 0, busy: false };

class GeocodingError extends Error {
  constructor(status, message, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function validCoordinates(latitude, longitude) {
  return Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
    && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
}

function createGeocoder(options = {}) {
  const fetchProvider = options.fetch || globalThis.fetch;
  const now = options.clock || Date.now;
  const gate = options.requestGate || sharedRequestGate;
  const timeoutMs = options.timeoutMs ?? 7000;
  const endpoint = new URL(options.reverseUrl || DEFAULT_REVERSE_URL);
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error('GEOCODING_REVERSE_URL must be an HTTP or HTTPS reverse-geocoding endpoint without URL credentials.');
  }
  const userAgent = options.userAgent || `AYUDA-Cebu/1.0 (+${options.appOrigin || 'http://localhost:3000'})`;
  const cache = new Map();
  const controllers = new Set();
  let closed = false;

  async function reverse(latitude, longitude) {
    if (!validCoordinates(latitude, longitude)) throw new GeocodingError(400, 'Enter valid latitude and longitude coordinates.');
    if (closed) throw new GeocodingError(503, 'Address lookup is temporarily unavailable. Your coordinates can still be used.');
    const lat = latitude.toFixed(6);
    const lon = longitude.toFixed(6);
    const key = `${lat},${lon}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.address;
    if (cached) cache.delete(key);
    const wait = gate.nextAllowedAt - now();
    if (gate.busy || wait > 0) {
      throw new GeocodingError(429, 'Address lookup is busy. Your coordinates can still be used.', Math.max(1, Math.ceil(wait / 1000)));
    }
    // Nominatim permits at most one request per second across the entire application.
    gate.nextAllowedAt = now() + 1100;
    gate.busy = true;
    const controller = new AbortController();
    controllers.add(controller);
    let abortListener;
    const cancelled = new Promise((resolve, reject) => {
      abortListener = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abortListener, { once: true });
    });
    const timer = setTimeout(() => controller.abort(new GeocodingError(504, 'Address lookup timed out. Your coordinates can still be used.')), timeoutMs);
    const url = new URL(endpoint);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('lat', lat);
    url.searchParams.set('lon', lon);
    url.searchParams.set('addressdetails', '0');
    url.searchParams.set('zoom', '18');
    try {
      const address = await Promise.race([
        Promise.resolve().then(async () => {
          const response = await fetchProvider(url, {
            headers: { Accept: 'application/json', 'Accept-Language': 'en', 'User-Agent': userAgent },
            signal: controller.signal,
            redirect: 'error'
          });
          if (response.status === 404) return '';
          if (!response.ok) throw new Error('Provider unavailable');
          const data = await response.json();
          return typeof data?.display_name === 'string' ? data.display_name.trim().slice(0, 500) : '';
        }),
        cancelled
      ]);
      // Bound memory and remove expired entries without persisting household coordinates.
      for (const [entryKey, entry] of cache) if (entry.expiresAt <= now()) cache.delete(entryKey);
      if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value);
      cache.set(key, { address, expiresAt: now() + CACHE_TTL });
      return address;
    } catch (error) {
      if (error instanceof GeocodingError) throw error;
      throw new GeocodingError(503, 'Address lookup is temporarily unavailable. Your coordinates can still be used.');
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', abortListener);
      // Also release an unread response body after an upstream 404 or failure.
      controller.abort();
      controllers.delete(controller);
      gate.busy = false;
    }
  }

  function close() {
    closed = true;
    cache.clear();
    for (const controller of controllers) {
      controller.abort(new GeocodingError(503, 'Address lookup is temporarily unavailable. Your coordinates can still be used.'));
    }
  }

  return { reverse, close };
}

module.exports = { createGeocoder, GeocodingError, validCoordinates };
