import '@fontsource-variable/literata/opsz.css';
import '@fontsource-variable/literata/opsz-italic.css';
import React, { useEffect, useRef, useState } from 'react';
import LoginScreen from './components/LoginScreen.jsx';
import DataScreen from './components/DataScreen.jsx';
import { resetDb } from './db.js';
import { zeroBytes } from './crypto.js';

function clearSession(masterKeyRef, setConnected) {
  resetDb();
  zeroBytes(masterKeyRef.current);
  masterKeyRef.current = null;
  setConnected(false);
}

function useSession() {
  const masterKeyRef = useRef(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => () => clearSession(masterKeyRef, setConnected), []);
  return { masterKeyRef, connected, setConnected };
}

export default function App() {
  const session = useSession();
  const { masterKeyRef, connected, setConnected } = session;
  const disconnect = () => clearSession(masterKeyRef, setConnected);
  const connect = ({ masterKey }) => {
    zeroBytes(masterKeyRef.current);
    masterKeyRef.current = masterKey;
    setConnected(true);
  };
  return connected
    ? <DataScreen masterKey={masterKeyRef.current} onDisconnect={disconnect} />
    : <LoginScreen onConnect={connect} />;
}
