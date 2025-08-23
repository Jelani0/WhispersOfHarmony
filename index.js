import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css'; // Assuming you have a standard CSS file for base styles
import App from './App';
import reportWebVitals from './reportWebVitals'; // Ensure this file exists and exports reportWebVitals
// Import the functions you need from the SDKs you need
// import { getAnalytics } from "firebase/analytics"; // Removed as Firebase initialization is handled in firebase-config.js

// Dynamically load Tailwind CSS CDN
// This is typically done in public/index.html or a build process,
// but for a self-contained immersive, adding it here.
const tailwindScript = document.createElement('script');
tailwindScript.src = "https://cdn.tailwindcss.com";
document.head.appendChild(tailwindScript);

// Dynamically load Stripe.js from CDN
// This is essential for Stripe Checkout and Connect redirects.
const stripeScript = document.createElement('script');
stripeScript.src = "https://js.stripe.com/v3/";
document.head.appendChild(stripeScript);

// Create a root element to render the React application into.
// This is the modern way to initialize a React app with React 18+.
const root = ReactDOM.createRoot(document.getElementById('root'));

// Render the main App component.
// The App is wrapped in a React.StrictMode component to highlight potential problems in the app.
// ErrorBoundary is assumed to be handled within App.js or a higher-level component if needed.
root.render(
  <React.StrictMode>
    {/* Removed Stripe Elements wrapper here as it's not needed globally unless all of App depends on it.
        If specific components need it, wrap them individually or within App.js if it's a core dependency. */}
    <App />
  </React.StrictMode>
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();