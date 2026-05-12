import React, { useState } from 'react';
import LoginScreen from './components/LoginScreen.jsx';
import DataScreen from './components/DataScreen.jsx';

const THEMES = ['light', 'dark', 'sepia'];

export default function App() {
  const [creds, setCreds] = useState(null);
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') ?? 'light');

  function cycleTheme() {
    setTheme(prev => {
      const next = THEMES[(THEMES.indexOf(prev) + 1) % THEMES.length];
      localStorage.setItem('theme', next);
      return next;
    });
  }

  const themeProps = {
    'data-bs-theme': theme === 'dark' ? 'dark' : undefined,
    className: theme === 'sepia' ? 'theme-sepia' : undefined,
    style: { minHeight: '100vh' },
  };

  if (!creds)
    return <div {...themeProps}><LoginScreen onConnect={setCreds} /></div>;

  return (
    <div {...themeProps}>
      <DataScreen
        masterKey={creds.masterKey}
        onDisconnect={() => setCreds(null)}
        theme={theme}
        onThemeCycle={cycleTheme}
      />
    </div>
  );
}
