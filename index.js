import express from "express";
import cors from "cors";
import crypto from "crypto";
import dotenv from "dotenv";
import { db } from "./firebase.js";
import { Groq } from "groq-sdk";

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

    // Step 4a: Hash query for caching
    const queryHash = crypto.createHash("sha256").update(query.toLowerCase().trim()).digest("hex");

    // Step 4b: Check Firestore cache
    const cacheSnap = await db.collection("ai_search_cache").doc(queryHash).get();
    if (cacheSnap.exists) {
      return res.json({ success: true, fromCache: true, restaurants: cacheSnap.data().restaurants });
    }

    // Step 4c: Send query to Llama 3
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

    const aiRes = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: prompt }],
    });

    const intent = JSON.parse(aiRes.choices[0].message.content);

    // Step 4d: Query Firestore using your schema
    const usersSnap = await db.collection("users").get();
    const cuisinesSnap = await db.collection("restaurantcuisine").get();
    const tablesSnap = await db.collection("tables").get();

    const matchedRestaurants = usersSnap.docs.filter(userDoc => {
      const userData = userDoc.data();
      const cuisineDoc = cuisinesSnap.docs.find(c => c.data().userId === userDoc.id);
      const tableDocs = tablesSnap.docs.filter(t => t.data().userId === userDoc.id);
      const totalSeats = tableDocs.reduce((sum, t) => sum + Number(t.data().numSeats), 0);

      return (
        cuisineDoc.data().cuisines.includes(intent.cuisine) &&
        totalSeats >= intent.groupSize &&
        userData.location.toLowerCase().includes(intent.location.toLowerCase())
      );
    });

    // Step 4e: Ranking
    const ranked = matchedRestaurants.map(r => ({
      ...r.data(),
      score:
        (r.ambience?.includes(intent.ambience) ? 30 : 0) +
        (r.location.toLowerCase() === intent.location.toLowerCase() ? 25 : 0)
    })).sort((a,b) => b.score - a.score);

    // Step 4f: Save to Firestore cache
    await db.collection("ai_search_cache").doc(queryHash).set({
      extractedIntent: intent,
      restaurants: ranked.map(r => r.id),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 6) // 6 hours
    });

    res.json({ success: true, fromCache: false, restaurants: ranked });

  } catch(err) {
    console.error(err);
    res.status(500).json({ error: "AI search failed" });
  }
});

// Add this **above** app.listen()
app.get("/geocode", async (req, res) => {
  const { q } = req.query;
  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}`
    );
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("Geocode error:", err);
    res.status(500).json({ error: "Failed to geocode" });
  }
});


app.listen(process.env.PORT || 5000, () => {
  console.log(`Backend running on port ${process.env.PORT || 5000}`);
});
