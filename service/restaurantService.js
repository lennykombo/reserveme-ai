// backend/restaurantService.js
import admin from "firebase-admin";
import serviceAccount from "./serviceAccountKey.json" assert { type: "json" };

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

/**
 * Get restaurants by location/place
 * @param {string} place - Name of the place, e.g., "Kilimani"
 * @returns {Promise<Array>} - Array of restaurant objects
 */
export const getRestaurantsByPlace = async (place) => {
  try {
    const restaurantsRef = db.collection("restaurants");
    const querySnapshot = await restaurantsRef
      .where("place", "==", place.toLowerCase()) // assuming 'place' field is lowercase
      .get();

    if (querySnapshot.empty) {
      return []; // no restaurants found
    }

    const restaurants = [];
    querySnapshot.forEach((doc) => {
      restaurants.push({ id: doc.id, ...doc.data() });
    });

    return restaurants;
  } catch (error) {
    console.error("Error fetching restaurants by place:", error);
    throw error;
  }
};
