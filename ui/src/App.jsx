import React, { useState } from 'react';
import LoginScreen from './components/LoginScreen.jsx';
import DataScreen from './components/DataScreen.jsx';

export default function App() {
  const [creds, setCreds] = useState(null);

  if (!creds)
    return <LoginScreen onConnect={setCreds} />;

  return <DataScreen masterKey={creds.masterKey} onDisconnect={() => setCreds(null)} />;
}
