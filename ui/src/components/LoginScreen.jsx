import React, { useState, useEffect } from 'react';
import { initCrypto, parseMasterKey } from '../crypto.js';
import { initDb } from '../db.js';

export default function LoginScreen({ onConnect }) {
  const [cryptoReady, setCryptoReady] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => { initCrypto().then(() => setCryptoReady(true)); }, []);

  async function handleFile(file) {
    setError(null);
    try {
      const json = JSON.parse(await file.text());
      if (!json.turso_database_url || !json.turso_auth_token || !json.master_key)
        throw new Error('Missing required fields in creds.json');
      initDb(json.turso_database_url, json.turso_auth_token);
      onConnect({ masterKey: parseMasterKey(json.master_key) });
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className="min-vh-100 d-flex align-items-center justify-content-center bg-light">
      <div className="card shadow-sm" style={{ maxWidth: 440, width: '100%', margin: '1rem' }}>
        <div className="card-body p-4">
          <h4 className="mb-1 fw-bold">txt_vault</h4>
          <p className="text-muted mb-4 small">
            Upload <code>creds.json</code> to connect to your Turso database.
          </p>
          {!cryptoReady && (
            <div className="d-flex align-items-center gap-2 mb-3 text-secondary small">
              <span className="spinner-border spinner-border-sm" />
              Initialising crypto…
            </div>
          )}
          {error && <div className="alert alert-danger py-2 small">{error}</div>}
          <label className="form-label fw-semibold">creds.json</label>
          <input
            type="file"
            className="form-control"
            accept=".json,application/json"
            disabled={!cryptoReady}
            onChange={e => e.target.files[0] && handleFile(e.target.files[0])}
          />
        </div>
      </div>
    </div>
  );
}
