import fetch from "node-fetch";
import { db } from "../firebase.js";

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function geocodeAllRestaurants() {
  const usersSnap = await db
    .collection("users")
    .where("role", "==", "hotel")
    .get();

  for (const doc of usersSnap.docs) {
    const data = doc.data();
    const location = data.location;

    if (!location) continue;

    if (data.coords?.lat && data.coords?.lng) {
      console.log("✅ Already geocoded:", data.restaurantName);
      continue;
    }

    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
        location
      )}`;

      const res = await fetch(url, {
        headers: {
          "User-Agent": "ReserveMeBot/1.0 (contact@reserveme.ke)",
          "Accept-Language": "en"
        }
      });

      if (!res.ok) {
        console.warn("⚠️ Nominatim blocked:", location, res.status);
        await sleep(3000); // backoff on block
        continue;
      }

      const geo = await res.json();

      if (!geo.length) {
        console.log("❌ No results for:", location);
        await sleep(1200);
        continue;
      }

      const coords = {
        lat: Number(geo[0].lat),
        lng: Number(geo[0].lon)
      };

      await db.collection("users").doc(doc.id).update({ coords });

      console.log("✅ Geocoded:", data.restaurantName, coords);

      // ✅ REQUIRED RATE LIMIT
      await sleep(1200);

    } catch (err) {
      console.error("❌ Failed for:", data.restaurantName, err.message);
      await sleep(3000);
    }
  }

  console.log("🎉 ALL DONE");
  process.exit();
}

geocodeAllRestaurants();
