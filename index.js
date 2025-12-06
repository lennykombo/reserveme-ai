import express from "express";
import cors from "cors";
import crypto from "crypto";
import dotenv from "dotenv";
import { db } from "./firebase.js";
import { Groq } from "groq-sdk";
import fetch from "node-fetch";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());


app.get("/", (req, res) => {
  res.send("✅ ReserveMe AI Backend is Live on Render");
});


// Llama 3 (Groq) client
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });


app.post("/ai-search", async (req, res) => {
  try {
    const { query, userLocation } = req.body;
    if (!query) return res.status(400).json({ error: "Query is required" });

    // Step 1: Hash query for caching
    const queryHash = crypto
      .createHash("sha256")
      .update(query.toLowerCase().trim())
      .digest("hex");

    // Step 2: Check Firestore cache
    const cacheSnap = await db.collection("ai_search_cache").doc(queryHash).get();
    if (cacheSnap.exists) {
      return res.json({ success: true, fromCache: true, restaurants: cacheSnap.data().restaurants });
    }

    // Step 3: Send query to Llama 3
    const prompt = `
Extract restaurant search intent from this query:
"${query}"

Return ONLY JSON:
{
  "cuisine": "",
  "ambience": "",
  "price": "",
  "occasion": "",
  "location": "",
  "groupSize": ""
}
    `;

    let aiRes;
    try {
      aiRes = await groq.chat.completions.create({
        model: "llama-3.1-8b-instant", // double-check this model ID
        messages: [{ role: "user", content: prompt }],
      });
      console.log("AI Raw Response:", aiRes);
    } catch (err) {
      console.error("AI call failed:", err);
      return res.status(500).json({ error: "AI request failed" });
    }

    // Step 4: Parse AI response safely
    let intent;
    try {
      intent = JSON.parse(aiRes.choices?.[0]?.message?.content || "{}");
    } catch (err) {
      console.error("Failed to parse AI output:", err);
      return res.status(500).json({ error: "AI output invalid JSON" });
    }

    // Step 5: Set default values to avoid crashes
    intent.cuisine = intent.cuisine || "";
    intent.ambience = intent.ambience || "";
    intent.location = intent.location || userLocation || "";
    intent.groupSize = Number(intent.groupSize) || 1;

    console.log("Parsed Intent:", intent);

    // Step 6: Query Firestore
    const usersSnap = await db.collection("users").get();
    const cuisinesSnap = await db.collection("restaurantcuisine").get();
    const tablesSnap = await db.collection("tables").get();

    const matchedRestaurants = usersSnap.docs.filter(userDoc => {
      const userData = userDoc.data();
      const cuisineDoc = cuisinesSnap.docs.find(c => c.data().userId === userDoc.id);
      if (!cuisineDoc) return false;
      const tableDocs = tablesSnap.docs.filter(t => t.data().userId === userDoc.id);
      const totalSeats = tableDocs.reduce((sum, t) => sum + Number(t.data().numSeats || 0), 0);

      return (
        cuisineDoc.data().cuisines.includes(intent.cuisine) &&
        totalSeats >= intent.groupSize &&
        userData.location?.toLowerCase().includes(intent.location.toLowerCase())
      );
    });

    // Step 7: Ranking
    const ranked = matchedRestaurants.map(r => ({
      id: r.id,
      ...r.data(),
      score:
        (r.data().ambience?.includes(intent.ambience) ? 30 : 0) +
        (r.data().location?.toLowerCase() === intent.location.toLowerCase() ? 25 : 0)
    })).sort((a, b) => b.score - a.score);

    // Step 8: Save to Firestore cache
    await db.collection("ai_search_cache").doc(queryHash).set({
      extractedIntent: intent,
      restaurants: ranked.map(r => r.id),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 6), // 6 hours
    });

    res.json({ success: true, fromCache: false, restaurants: ranked });

  } catch (err) {
    console.error("Unexpected error in /ai-search:", err);
    res.status(500).json({ error: "AI search failed" });
  }
});



// Add this **above** app.listen()
app.get('/geocode', async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: "Missing query parameter" });

    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`;
    const response = await fetch(url, { headers: { 'User-Agent': 'ReserveMeApp/1.0' } });
    const data = await response.json();

    if (!data || data.length === 0) {
      return res.status(404).json({ error: "No results found" });
    }

    // Return the first match
    res.json({
      lat: data[0].lat,
      lon: data[0].lon,
      display_name: data[0].display_name
    });
  } catch (err) {
    console.error("Geocode error:", err);
    res.status(500).json({ error: "Geocoding failed" });
  }
});



app.listen(process.env.PORT || 5000, () => {
  console.log(`Backend running on port ${process.env.PORT || 5000}`);
});
