// Serves the static site and a cached /api/reviews endpoint backed by the
// Google Places API, so the reviews section stays current on its own.
//
// Needs the GOOGLE_PLACES_API_KEY secret. GOOGLE_PLACE_ID is optional; when
// it's missing the place is looked up once by name and cached.

const PLACES = "https://places.googleapis.com/v1";
const SEARCH_QUERY = "Texas Moose Contractors New Braunfels TX";
const TTL = 6 * 60 * 60; // seconds; reviews are refetched at most every 6 hours

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/reviews") return reviews(url, env, ctx);
    return env.ASSETS.fetch(request);
  },
};

async function reviews(url, env, ctx) {
  if (!env.GOOGLE_PLACES_API_KEY) return json({ error: "not configured" }, 503);

  const cache = caches.default;
  const key = new Request(url.origin + "/api/reviews");
  const hit = await cache.match(key);
  if (hit) return hit;

  try {
    const placeId = env.GOOGLE_PLACE_ID || (await findPlaceId(env, cache, url.origin));
    const res = await fetch(`${PLACES}/places/${placeId}`, {
      headers: {
        "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY,
        "X-Goog-FieldMask": "rating,userRatingCount,reviews,googleMapsUri",
      },
    });
    if (!res.ok) throw new Error(`details ${res.status}: ${await googleError(res)}`);
    const place = await res.json();

    const body = {
      placeId,
      rating: place.rating ?? null,
      count: place.userRatingCount ?? 0,
      url: place.googleMapsUri ?? null,
      reviews: (place.reviews || []).map((r) => ({
        rating: r.rating,
        text: (r.originalText || r.text || {}).text || "",
        when: r.relativePublishTimeDescription || "",
        author: r.authorAttribution?.displayName || "Google user",
        authorUrl: r.authorAttribution?.uri || null,
      })),
    };
    const out = json(body, 200, { "Cache-Control": `public, max-age=${TTL}` });
    ctx.waitUntil(cache.put(key, out.clone()));
    return out;
  } catch (err) {
    return json({ error: String(err.message || err) }, 502);
  }
}

async function findPlaceId(env, cache, origin) {
  const key = new Request(origin + "/api/reviews/place-id");
  const hit = await cache.match(key);
  if (hit) return hit.text();

  const res = await fetch(`${PLACES}/places:searchText`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY,
      "X-Goog-FieldMask": "places.id",
    },
    body: JSON.stringify({ textQuery: SEARCH_QUERY }),
  });
  if (!res.ok) throw new Error(`search ${res.status}: ${await googleError(res)}`);
  const id = (await res.json()).places?.[0]?.id;
  if (!id) throw new Error("place not found");
  await cache.put(key, new Response(id, { headers: { "Cache-Control": "max-age=2592000" } }));
  return id;
}

// Google's error body names the cause (API not enabled, billing, key restrictions).
async function googleError(res) {
  try {
    return (await res.json()).error?.message || res.statusText;
  } catch {
    return res.statusText;
  }
}

function json(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}
