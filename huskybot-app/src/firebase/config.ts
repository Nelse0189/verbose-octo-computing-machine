// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDSIlrTV810fbGzKLuUf42nQD2oXAi2uO4",
  authDomain: "huskybot-dabab.firebaseapp.com",
  projectId: "huskybot-dabab",
  storageBucket: "huskybot-dabab.firebasestorage.app",
  messagingSenderId: "859091020639",
  appId: "1:859091020639:web:e50fa814a52d2f211464ea",
  measurementId: "G-5HFRMREE87"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize Firebase services
const analytics = getAnalytics(app);
const auth = getAuth(app);
const db = getFirestore(app);

// Export the services for use in other files
export { app, analytics, auth, db };
export default app; 