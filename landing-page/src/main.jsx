import React from 'react';
import { ClerkProvider } from '@clerk/react';
import { createRoot } from 'react-dom/client';

import App from './App.jsx';
import './index.css';

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

function Root() {
  if (!clerkPublishableKey) {
    return <App clerkEnabled={false} />;
  }

  return (
    <ClerkProvider publishableKey={clerkPublishableKey} waitlistUrl="/waitlist">
      <App clerkEnabled />
    </ClerkProvider>
  );
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
