import "dotenv/config";
import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import Groq from "groq-sdk";

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------
// 🔥 GLOBAL CACHES
// ---------------------
let RESTAURANT_CACHE = {
  data: null,
  timestamp: 0,
  ttl: 5 * 60 * 1000, // 5 minutes cache
};

const AI_QUERY_CACHE = new Map(); // Natural language cache

// ---------------------
// Firebase
// ---------------------
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("Missing FIREBASE_SERVICE_ACCOUNT env var");
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

// ---------------------
// Groq AI
// ---------------------
if (!process.env.GROQ_API_KEY) {
  console.error("Missing GROQ_API_KEY env var");
  process.exit(1);
}
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ---------------------
// HELPERS
// ---------------------
const normalize = (s) =>
  s ? String(s).toLowerCase().trim().replace(/_/g, " ") : "";

function safeParseJSON(maybe) {
  if (!maybe || typeof maybe !== "string") return {};
  try {
    return JSON.parse(maybe);
  } catch {
    const match = maybe.match(/{[\s\S]*}/);
    try {
      return match ? JSON.parse(match[0]) : {};
    } catch {
      return {};
    }
  }
}

function parseTimestamp(val) {
  if (!val) return null;
  if (typeof val.toDate === "function") return val.toDate();
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

function extractPeopleFromText(text = "") {
  const match = text.match(/\b(\d{1,2})\s*(people|persons|guests|pax)\b/i);
  return match ? Number(match[1]) : null;
}

// ---------------------
// CACHED FIRESTORE LOADER
// ---------------------
async function loadAllCollectionsByUserId() {
  const now = Date.now();
  if (RESTAURANT_CACHE.data && now - RESTAURANT_CACHE.timestamp < RESTAURANT_CACHE.ttl) {
    console.log("🔥 USING FIRESTORE CACHE");
    return RESTAURANT_CACHE.data;
  }

  console.log("📦 FETCHING ALL DATA FROM FIRESTORE");

  const collections = [
    "users", "restaurantcuisine", "amenities", "mealtimes", "offers",
    "tables", "experiences", "menuItems", "openingHours", "reviews",
    "sections", "extrareserves", "coverimage", "logoimage"
  ];

  const snaps = await Promise.all(
    collections.map(col => db.collection(col).get().catch(() => ({ docs: [] })))
  );

  const maps = {};
  snaps.forEach((snap, idx) => {
    const name = collections[idx];
    for (const d of snap.docs) {
      const data = d.data();
      const uid = data.userId || d.id;
      if (!uid) continue;
      maps[uid] = maps[uid] || {};
      maps[uid][name] = maps[uid][name] || [];
      maps[uid][name].push({ id: d.id, ...data });
    }
  });

  // Ensure users are included
  const usersSnap = snaps[0];
  for (const uDoc of usersSnap.docs) {
    const uid = uDoc.id;
    const data = uDoc.data();
    maps[uid] = maps[uid] || {};
    maps[uid].users = maps[uid].users || [];
    maps[uid].users.push({ id: uid, ...data });
  }

  RESTAURANT_CACHE = { data: maps, timestamp: now, ttl: RESTAURANT_CACHE.ttl };
  return maps;
}

// ---------------------
// BUILD RESTAURANT PROFILE
// ---------------------
function buildRestaurantProfile(userId, bucket) {
  const userDoc = bucket.users?.[0] || {};
  const cuisineDoc = bucket.restaurantcuisine?.[0] || {};
  const cuisines = cuisineDoc.cuisines || [];

  let averageCost = Number(userDoc.averageCost || userDoc.averagecost || 0);
  const menu = bucket.menuItems || [];
  if (!averageCost && menu.length) {
    const prices = menu.map((m) => Number(m.price || 0)).filter(Boolean);
    if (prices.length)
      averageCost = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
  }

  const offers = (bucket.offers || []).map((o) => ({
    id: o.id,
    name: o.name,
    price: o.price,
    from: parseTimestamp(o.dateFrom),
    to: parseTimestamp(o.dateTo),
  }));

  const coverImageDoc = (bucket.coverimage || []).find(img => img.userId === userId);
  const logoImageDoc = (bucket.logoimage || []).find(img => img.userId === userId);
  const coverImage = coverImageDoc?.coverImageUrl;
  const logoImage = logoImageDoc?.logoImageUrl;

  const image = coverImage || logoImage || "";

  return {
    id: userId,
    restaurantName: userDoc.restaurantName || "",
    location: userDoc.location || "",
    cuisines,
    averageCost,
    offers,
    image,
    tables: bucket.tables || [],
    extrareserves: bucket.extrareserves || [],
    raw: { userDoc, tables: bucket.tables || [], extrareserves: bucket.extrareserves || [] },
  };
}

// ---------------------
// BUILD SEARCH INDEX
// ---------------------
async function buildRestaurantsSearchIndex() {
  console.log("🔄 Building restaurants_search index...");
  const byUser = await loadAllCollectionsByUserId();
  const batch = db.batch();
  let count = 0;

  for (const [uid, bucket] of Object.entries(byUser)) {
    const user = bucket.users?.[0];
    if (!user || user.role !== "hotel") continue;

    const restaurantName = user.restaurantName || "";
    const location = user.location || "";

    const cuisines = (bucket.restaurantcuisine?.[0]?.cuisines || []).map(c => String(c).toLowerCase());
    const image = bucket.coverimage?.[0]?.coverImageUrl || bucket.logoimage?.[0]?.logoImageUrl || "";
    let averageCost = Number(user.averageCost || 0);
    const menu = bucket.menuItems || [];
    if (!averageCost && menu.length) {
      const prices = menu.map(m => Number(m.price || 0)).filter(Boolean);
      if (prices.length) averageCost = Math.round(prices.reduce((a,b) => a+b,0)/prices.length);
    }

    const maxSeats = (bucket.tables || []).reduce((max, t) => Math.max(max, Number(t.numSeats || 0)), 0);
    const amenities = (bucket.amenities || []).map(a => String(a.name || a).toLowerCase());
    const vibes = (bucket.experiences || []).map(e => String(e.name || "").toLowerCase());

    const ref = db.collection("restaurants_search").doc(uid);
    batch.set(ref, {
      restaurantId: uid,
      restaurantName,
      location,
      cuisines,
      averageCost,
      maxSeats,
      image,
      amenities,
      vibes,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    count++;
  }

  await batch.commit();
  console.log(`✅ Indexed ${count} restaurants`);
}

// ---------------------
// AUTO-REBUILD INDEX ON STARTUP
// ---------------------
async function initSearchIndex() {
  try {
    console.log("🔄 Initializing restaurants_search index...");
    await buildRestaurantsSearchIndex();
    console.log("✅ restaurants_search index ready");
  } catch (err) {
    console.error("❌ Failed to build search index:", err);
  }
}
initSearchIndex();
setInterval(() => {
  console.log("🔁 Rebuilding restaurants_search index (periodic)...");
  buildRestaurantsSearchIndex().catch(err => console.error("❌ Index rebuild error:", err));
}, 10 * 60 * 1000);

// ---------------------
// AI SEARCH ROUTE
// ---------------------
app.post("/ai-search", async (req, res) => {
  try {
    const { query } = req.body;
    if (!query || !String(query).trim()) {
      return res.status(400).json({ error: "Query is required" });
    }

    const normalizedQuery = query.toLowerCase().trim();
    console.log("🔍 SEARCH QUERY:", normalizedQuery);

    // ----------------------------
    // Helper for normalization
    // ----------------------------
    const normalize = (s) =>
      s
        ? String(s)
            .toLowerCase()
            .trim()
            .replace(/\s+/g, " ")       // collapse multiple spaces
            .replace(/\s*,\s*/g, ",")  // remove spaces around commas
        : "";

    function extractPeopleFromText(text = "") {
      const match = text.match(/\b(?:for|number of|group of)?\s*(\d{1,3})\s*(people|persons|guests|pax)?\b/i);
      return match ? Number(match[1]) : null;
    }

    // ----------------------------
    // AI CACHE HIT
    // ----------------------------
    if (AI_QUERY_CACHE.has(normalizedQuery)) {
      console.log("🧠 USING AI CACHE");
      const intent = AI_QUERY_CACHE.get(normalizedQuery);
      let { place, cuisine, vibe, maxBudget, keywords, people } = intent;

      const snap = await db.collection("restaurants_search").get();
      let candidates = snap.docs.map((d) => d.data());
      console.log("Total candidates from index:", candidates.length);

      // ----------------------------
      // APPLY FILTERS
      // ----------------------------
      if (place) {
        const queryPlace = normalize(place);
        candidates = candidates.filter((r) =>
          normalize(r.location).includes(queryPlace)
        );
        console.log("After PLACE filter:", candidates.length);
      }

      if (cuisine) {
        const queryCuisine = normalize(cuisine);
        candidates = candidates.filter((r) =>
          (r.cuisines || []).some((c) => normalize(c).includes(queryCuisine))
        );
        console.log("After CUISINE filter:", candidates.length);
      }

      if (vibe) {
        const queryVibe = normalize(vibe);
        candidates = candidates.filter((r) =>
          [...r.vibes, ...r.amenities].some((v) =>
            normalize(v).includes(queryVibe)
          )
        );
        console.log("After VIBE filter:", candidates.length);
      }

      if (maxBudget) {
        candidates = candidates.filter((r) => r.averageCost <= maxBudget);
      }

      if (people) {
        candidates = candidates.filter((r) => r.maxSeats >= people);
      }

      if (keywords && Array.isArray(keywords)) {
        const keywordsNorm = keywords.map((k) => normalize(k));
        candidates = candidates.filter((r) => {
          const blob = JSON.stringify(r).toLowerCase();
          return keywordsNorm.some((k) => blob.includes(k));
        });
      }

      return res.json({
        success: true,
        cached: true,
        intent,
        total: candidates.length,
        restaurants: candidates.slice(0, 50),
      });
    }

    // ----------------------------
    // NEW AI QUERY
    // ----------------------------
    const prompt = `
You are an AI that extracts restaurant search intent.
Extract fields if present:
- place (area or location)
- cuisine (food type)
- vibe (romantic, family, chill, rooftop, etc)
- maxBudget (number only)
- people (number of guests — detect phrases like "for 2", "group of 5", "number of people 10")
- keywords (any other useful words)
Return ONLY valid JSON:

{
  "place": "",
  "cuisine": "",
  "vibe": "",
  "maxBudget": null,
  "people": null,
  "keywords": []
}

Query: "${query}"
`;

    const aiResp = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: prompt }],
    });

    const rawAiText = aiResp?.choices?.[0]?.message?.content || "";
    console.log("🧠 AI RAW RESPONSE:", rawAiText);

    const intent = safeParseJSON(rawAiText);
    let place = normalize(intent.place);
    let cuisine = normalize(intent.cuisine);
    let vibe = normalize(intent.vibe);
    let maxBudget = Number(intent.maxBudget) || null;
    let people =
      Number(intent.people) || extractPeopleFromText(query) || null;
    let keywords = Array.isArray(intent.keywords)
      ? intent.keywords
      : intent.keywords
      ? [intent.keywords]
      : [];

    // SAVE TO AI CACHE
    AI_QUERY_CACHE.set(normalizedQuery, {
      place,
      cuisine,
      vibe,
      maxBudget,
      people,
      keywords,
    });

    // Fetch all candidates
    const snap = await db.collection("restaurants_search").get();
    let candidates = snap.docs.map((d) => d.data());
    console.log("Total candidates from index:", candidates.length);

    // ----------------------------
    // FILTERING
    // ----------------------------
    if (place) {
      candidates = candidates.filter((r) =>
        normalize(r.location).includes(place)
      );
    }

    if (cuisine) {
      candidates = candidates.filter((r) =>
        (r.cuisines || []).some((c) => normalize(c).includes(cuisine))
      );
    }

    if (vibe) {
      candidates = candidates.filter((r) =>
        [...r.vibes, ...r.amenities].some((v) => normalize(v).includes(vibe))
      );
    }

    if (maxBudget) {
      candidates = candidates.filter((r) => r.averageCost <= maxBudget);
    }

    if (people) {
      candidates = candidates.filter((r) => r.maxSeats >= people);
    }

    if (keywords.length) {
      const keywordsNorm = keywords.map((k) => normalize(k));
      candidates = candidates.filter((r) => {
        const blob = JSON.stringify(r).toLowerCase();
        return keywordsNorm.some((k) => blob.includes(k));
      });
    }

    return res.json({
      success: true,
      intent: { place, cuisine, vibe, maxBudget, people, keywords },
      total: candidates.length,
      restaurants: candidates.slice(0, 50),
    });
  } catch (err) {
    console.error("❌ SEARCH ERROR:", err);
    return res
      .status(500)
      .json({ error: "Server error", details: err.message });
  }
});


// ---------------------
app.get("/", (req, res) => res.send("✅ ReserveMe AI Search Backend (Optimized)"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
