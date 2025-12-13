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
// ✅ AI SEARCH (CACHED)
// ---------------------
app.post("/ai-search", async (req, res) => {
  try {
    const { query } = req.body;
    if (!query || !String(query).trim()) {
      return res.status(400).json({ error: "Query is required" });
    }

    const normalizedQuery = query.toLowerCase().trim();
    console.log("🔍 SEARCH:", normalizedQuery);

  /*  const isEventSearch =
  normalizedQuery.includes("event") ||
  normalizedQuery.includes("conference") ||
  normalizedQuery.includes("ground") ||
  normalizedQuery.includes("meeting") ||
  normalizedQuery.includes("hall");*/

    // ✅ AI CACHE HIT
    if (AI_QUERY_CACHE.has(normalizedQuery)) {
  console.log("🧠 USING AI CACHE");
  const intent = AI_QUERY_CACHE.get(normalizedQuery); // full intent object
  const { place, cuisine, vibe, maxBudget, keywords } = intent;

  const byUser = await loadAllCollectionsByUserId();
  let candidates = Object.entries(byUser)
    .map(([uid, bucket]) => buildRestaurantProfile(uid, bucket))
    .filter((p) => p.raw?.userDoc?.role === "hotel");

  // Apply all filters exactly like below
  if (place) candidates = candidates.filter((p) => normalize(p.location).includes(place));
  if (cuisine) candidates = candidates.filter((p) => (p.cuisines || []).some((c) => normalize(c).includes(cuisine)));
  if (maxBudget) candidates = candidates.filter((p) => p.averageCost <= maxBudget);
  if (vibe) candidates = candidates.filter((p) => {
    const text = [
      ...(p.amenities || []),
      ...(p.experiences || []).map((e) => e.name),
      p.cuisines || [],
      p.restaurantName,
      p.location,
    ].join(" ").toLowerCase();
    return text.includes(vibe);
  });
  if (keywords.length) candidates = candidates.filter((p) => {
    const blob = JSON.stringify(p).toLowerCase();
    return keywords.some((k) => blob.includes(k.toLowerCase()));
  });

  return res.json({ success: true, cached: true, intent, total: candidates.length, restaurants: candidates.slice(0, 50) });
}


    // ✅ AI REQUEST
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
    console.log("🧠 AI RAW:", rawAiText);

    const intent = safeParseJSON(rawAiText);

    const place = normalize(intent.place);
    const cuisine = normalize(intent.cuisine);
    const vibe = normalize(intent.vibe);
    const maxBudget = Number(intent.maxBudget) || null;
    const people =
         Number(intent.people) ||
        extractPeopleFromText(query) ||
        null;
    // ⭐ EVENT SPACE SEARCH LOGIC (Runs before restaurant filters)
/*if (isEventSearch && people) {
  console.log("🎪 EVENT SEARCH ACTIVATED for", people, "people");

  const eventSpaces = [];

  for (const [uid, bucket] of Object.entries(await loadAllCollectionsByUserId())) {
    const extras = bucket.extrareserves || [];

    extras.forEach((ex) => {
      const cap = Number(ex.capacity || 0);

      // Must hold required number of people
      if (cap >= people) {
        eventSpaces.push({
          id: ex.id,
          userId: uid,
          name: ex.name,
          capacity: ex.capacity,
          size: ex.size,
          imageUrl: ex.imageUrl,
          location: bucket.users?.[0]?.location || "",
          restaurantName: bucket.users?.[0]?.restaurantName || "",
        });
      }
    });
  }

  return res.json({
    success: true,
    type: "event_spaces",
    intent: { place, cuisine, vibe, maxBudget, people, keywords },
    total: eventSpaces.length,
    events: eventSpaces,
  });
}*/
    const keywords = intent.keywords || [];



    // ✅ SAVE TO AI CACHE
    AI_QUERY_CACHE.set(normalizedQuery, { place, cuisine, vibe, maxBudget, people, keywords });

    const byUser = await loadAllCollectionsByUserId();
console.log("BY USER:", JSON.stringify(byUser, null, 2));
    let candidates = Object.entries(byUser)
  .map(([uid, bucket]) => buildRestaurantProfile(uid, bucket))
  console.log("ALL USERS:", candidates.map(c => ({ name: c.restaurantName, role: c.raw.userDoc.role })))
  .filter((p) => p.raw?.userDoc?.role === "hotel");

// ✅ PLACE
if (place) {
  candidates = candidates.filter((p) =>
    normalize(p.location).includes(place)
  );
}

// ✅ CUISINE 
if (cuisine) {
  const normalizeCuisine = (c) =>
    c
      ?.toLowerCase()
      .replace(/_/g, " ")
      .replace(/\bfood\b|\bcuisine\b/g, "") // remove 'food' or 'cuisine'
      .trim();

  const normalizedInput = normalizeCuisine(cuisine);

  candidates = candidates.filter((p) =>
    (p.cuisines || []).some((c) => normalizeCuisine(c).includes(normalizedInput))
  );
}


// ✅ BUDGET
if (maxBudget) {
  candidates = candidates.filter((p) => p.averageCost <= maxBudget);
}

// ✅ PEOPLE / SEATS FILTER (TABLES)
if (people) {
  candidates = candidates.filter((p) => {
    const tables = p.raw?.tables || [];

    return tables.some((t) => {
      const seats = Number(t.numSeats || 0);
      return seats >= people;
    });
  });
}


// ✅ VIBE → match against amenities + experiences + keywords
if (vibe) {
  candidates = candidates.filter((p) => {
    const text = [
      ...(p.amenities || []),
      ...(p.experiences || []).map((e) => e.name),
      p.restaurantName,
      p.location,
    ]
      .join(" ")
      .toLowerCase();

    return text.includes(vibe);
  });
}

// ✅ KEYWORDS
if (keywords.length) {
  candidates = candidates.filter((p) => {
    const blob = JSON.stringify(p).toLowerCase();
    return keywords.some((k) => blob.includes(k.toLowerCase()));
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
