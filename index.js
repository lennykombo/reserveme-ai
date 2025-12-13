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
  ttl: 5 * 60 * 1000, // ✅ 5 minutes Firestore cache
};

const AI_QUERY_CACHE = new Map(); // ✅ Natural language cache

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
// Helpers
// ---------------------
const normalize = (s) => (s ? String(s).toLowerCase().trim().replace(/_/g, " ") : "");

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
// ✅ CACHED FIRESTORE LOADER
// ---------------------
async function loadAllCollectionsByUserId() {
  const now = Date.now();

  if (RESTAURANT_CACHE.data && now - RESTAURANT_CACHE.timestamp < RESTAURANT_CACHE.ttl) {
    console.log("🔥 USING FIRESTORE CACHE");
    return RESTAURANT_CACHE.data;
  }

  console.log("📦 FETCHING ALL DATA FROM FIRESTORE");

  const collections = [
    "users",
    "restaurantcuisine",
    "amenities",
    "mealtimes",
    "offers",
    "tables",
    "experiences",
    "menuItems",
    "openingHours",
    "reviews",
    "sections",
    "extrareserves",
    "coverimage",
    "logoimage"
  ];

  const snaps = await Promise.all(
    collections.map((col) =>
      db.collection(col).get().catch(() => ({ docs: [] }))
    )
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

  const usersSnap = snaps[0];
  for (const uDoc of usersSnap.docs) {
    const uid = uDoc.id;
    const data = uDoc.data();
    maps[uid] = maps[uid] || {};
    maps[uid].users = maps[uid].users || [];
    maps[uid].users.push({ id: uid, ...data });
  }

  RESTAURANT_CACHE = {
    data: maps,
    timestamp: now,
    ttl: RESTAURANT_CACHE.ttl,
  };

  return maps;
}

// ---------------------
// ✅ BUILD RESTAURANT PROFILE
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

  // 🔹 Filter images by restaurant userId
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
    image, // include image here
    tables: bucket.tables || [],
    extrareserves: bucket.extrareserves || [],
  raw: { 
    userDoc,
    tables: bucket.tables || [],
    extrareserves: bucket.extrareserves || [] 
   },
  };
}

// ---------------------
// 🔎 BUILD SEARCH INDEX
// ---------------------
async function buildRestaurantsSearchIndex() {
  console.log("🔄 Building restaurants_search index...");

  const byUser = await loadAllCollectionsByUserId();
  const batch = db.batch();
  let count = 0;

  for (const [uid, bucket] of Object.entries(byUser)) {
    const user = bucket.users?.[0];
    if (!user || user.role !== "hotel") continue;

    // Basic info
    const restaurantName = user.restaurantName || "";
    const location = user.location || "";

    // Cuisines
    const cuisines =
      bucket.restaurantcuisine?.[0]?.cuisines?.map(c =>
        String(c).toLowerCase()
      ) || [];

    // Image
    const image =
      bucket.coverimage?.[0]?.coverImageUrl ||
      bucket.logoimage?.[0]?.logoImageUrl ||
      "";

    // Average cost
    let averageCost = Number(user.averageCost || 0);
    const menu = bucket.menuItems || [];

    if (!averageCost && menu.length) {
      const prices = menu.map(m => Number(m.price || 0)).filter(Boolean);
      if (prices.length) {
        averageCost = Math.round(
          prices.reduce((a, b) => a + b, 0) / prices.length
        );
      }
    }

    // Max seats
    const maxSeats = (bucket.tables || []).reduce(
      (max, t) => Math.max(max, Number(t.numSeats || 0)),
      0
    );

    // Amenities & vibes
    const amenities = (bucket.amenities || []).map(a =>
      String(a.name || a).toLowerCase()
    );

    const vibes = (bucket.experiences || []).map(e =>
      String(e.name || "").toLowerCase()
    );

    // Write index doc
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
// 🔁 REBUILD SEARCH INDEX (RUN ONCE)
// ---------------------
app.post("/ai-search", async (req, res) => {
  try {
    const { query } = req.body;
    if (!query || !String(query).trim()) {
      return res.status(400).json({ error: "Query is required" });
    }

    const normalizedQuery = query.toLowerCase().trim();
    console.log("🔍 SEARCH QUERY:", normalizedQuery);

    // ---------------------------
    // ✅ AI CACHE HIT
    // ---------------------------
    if (AI_QUERY_CACHE.has(normalizedQuery)) {
      console.log("🧠 USING AI CACHE");

      let cachedIntent = AI_QUERY_CACHE.get(normalizedQuery);

      // Normalize keywords to always be an array
      if (!Array.isArray(cachedIntent.keywords)) {
        if (typeof cachedIntent.keywords === "string" && cachedIntent.keywords.trim()) {
          cachedIntent.keywords = [cachedIntent.keywords.trim()];
        } else {
          cachedIntent.keywords = [];
        }
      }

      const { place, cuisine, vibe, maxBudget, people, keywords } = cachedIntent;

      const snap = await db.collection("restaurants_search").get();
      let candidates = snap.docs.map(d => d.data());
      console.log("Total candidates from index:", candidates.length);

      // ---------------------------
      // Apply filters
      // ---------------------------
      if (place) {
        const placeNorm = place.toLowerCase();
        candidates = candidates.filter(r => r.location.toLowerCase().includes(placeNorm));
        console.log("After PLACE filter:", candidates.length);
      }

      if (cuisine) {
        const cuisineNorm = cuisine.toLowerCase();
        candidates = candidates.filter(r =>
          (r.cuisines || []).some(c => c.toLowerCase().includes(cuisineNorm))
        );
        console.log("After CUISINE filter:", candidates.length);
      }

      if (maxBudget) {
        candidates = candidates.filter(r => r.averageCost <= maxBudget);
        console.log("After BUDGET filter:", candidates.length);
      }

      if (people) {
        candidates = candidates.filter(r => r.maxSeats >= people);
        console.log("After PEOPLE filter:", candidates.length);
      }

      if (vibe) {
        const vibeNorm = vibe.toLowerCase();
        candidates = candidates.filter(r =>
          [...r.vibes, ...r.amenities].join(" ").toLowerCase().includes(vibeNorm)
        );
        console.log("After VIBE filter:", candidates.length);
      }

      if (keywords.length) {
        const keywordsNorm = keywords.map(k => k.toLowerCase());
        candidates = candidates.filter(p => {
          const blob = JSON.stringify(p).toLowerCase();
          return keywordsNorm.some(k => blob.includes(k));
        });
      }

      return res.json({
        success: true,
        cached: true,
        intent: cachedIntent,
        total: candidates.length,
        restaurants: candidates.slice(0, 50),
      });
    }

    // ---------------------------
    // ✅ AI REQUEST (new query)
    // ---------------------------
    const prompt = `
You are an AI that extracts restaurant search intent.

Extract the following fields if present:
- place (area or location)
- cuisine (food type)
- vibe (romantic, family, chill, rooftop, etc)
- maxBudget (number only, if price is mentioned)
- people (number of guests — detect from phrases like:
  "for 2", "2 people", "group of 5", "for ten", "party of 8")
- keywords (any remaining useful words)

Return ONLY valid JSON in this format:

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
    let people = Number(intent.people) || extractPeopleFromText(query) || null;
    let keywords = intent.keywords || [];

    // Normalize keywords to always be an array
    if (!Array.isArray(keywords)) {
      if (typeof keywords === "string" && keywords.trim()) {
        keywords = [keywords.trim()];
      } else {
        keywords = [];
      }
    }

    // Save to AI cache
    AI_QUERY_CACHE.set(normalizedQuery, { place, cuisine, vibe, maxBudget, people, keywords });

    // Fetch candidates from search index
    const snap = await db.collection("restaurants_search").get();
    let candidates = snap.docs.map(d => d.data());
    console.log("Total candidates from index:", candidates.length);

    // ---------------------------
    // Apply filters
    // ---------------------------
    if (place) {
      const placeNorm = place.toLowerCase();
      candidates = candidates.filter(r => r.location.toLowerCase().includes(placeNorm));
    }

    if (cuisine) {
      const cuisineNorm = cuisine.toLowerCase();
      candidates = candidates.filter(r =>
        (r.cuisines || []).some(c => c.toLowerCase().includes(cuisineNorm))
      );
    }

    if (maxBudget) {
      candidates = candidates.filter(r => r.averageCost <= maxBudget);
    }

    if (people) {
      candidates = candidates.filter(r => r.maxSeats >= people);
    }

    if (vibe) {
      const vibeNorm = vibe.toLowerCase();
      candidates = candidates.filter(r =>
        [...r.vibes, ...r.amenities].join(" ").toLowerCase().includes(vibeNorm)
      );
    }

    if (keywords.length) {
      const keywordsNorm = keywords.map(k => k.toLowerCase());
      candidates = candidates.filter(p => {
        const blob = JSON.stringify(p).toLowerCase();
        return keywordsNorm.some(k => blob.includes(k));
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
    return res.status(500).json({ error: "Server error", details: err.message });
  }
});


app.get("/test-firestore", async (req, res) => {
  try {
    const snap = await db.collection("users").limit(5).get();
    res.json({
      ok: true,
      count: snap.size,
      sample: snap.docs.map(d => d.data())
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});


// ---------------------
app.get("/", (req, res) => res.send("✅ ReserveMe AI Search Backend (Optimized)"));

const PORT = process.env.PORT || 1000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
