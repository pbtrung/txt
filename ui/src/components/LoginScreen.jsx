import React, { useState, useEffect } from 'react';
import {
  initCrypto,
  parseMasterKey,
  decryptName,
} from '../crypto.js';
import { initDb, fetchOneTxt } from '../db.js';

export default function LoginScreen({ onConnect }) {
  const [cryptoReady, setCryptoReady] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    initCrypto().then(() => setCryptoReady(true));
  }, []);

  async function handleFile(file) {
    setError(null);
    try {
      const json = JSON.parse(await file.text());
      const {
        turso_database_url: url,
        turso_auth_token: token,
        master_key,
      } = json;
      if (!url || !token || !master_key)
        throw new Error(
          'Missing required fields:' +
          ' turso_database_url, turso_auth_token, master_key',
        );

      initDb(url, token);
      const masterKey = parseMasterKey(master_key);

      setVerifying(true);
      console.debug('[login] verifying Turso connection…');
      let row;
      try {
        row = await fetchOneTxt();
      } catch (e) {
        throw new Error(`Turso connection failed: ${e.message}`);
      }
      console.debug(
        '[login] connection OK, row:',
        row ? `id=${row.id}` : 'none (empty db)',
      );

      if (row) {
        console.debug('[login] verifying master_key…');
        try {
          decryptName(row.name, masterKey);
        } catch {
          throw new Error(
            'master_key is incorrect:' +
            ' failed to decrypt a stored filename',
          );
        }
        console.debug('[login] master_key OK');
      } else {
        console.debug(
          '[login] skipping key check — database is empty',
        );
      }

      onConnect({ masterKey });
    } catch (e) {
      setError(e.message);
    } finally {
      setVerifying(false);
    }
  }

  const busy = !cryptoReady || verifying;

  return (
    <div className={
      'min-vh-100 d-flex align-items-center' +
      ' justify-content-center bg-light'
    }>
      <div
        className="card shadow-sm"
        style={{ maxWidth: 440, width: '100%', margin: '1rem' }}
      >
        <div className="card-body p-4">
          <h4 className="mb-1 fw-bold">Text Reader</h4>
          <p className="text-muted mb-4 small">
            Upload a credentials JSON file to connect
            to your Turso database.
          </p>
          {!cryptoReady && (
            <div className={
              'd-flex align-items-center' +
              ' gap-2 mb-3 text-secondary small'
            }>
              <span
                className="spinner-border spinner-border-sm"
              />
              Initialising crypto…
            </div>
          )}
          <label className="form-label fw-semibold">
            Credentials file
          </label>
          <input
            type="file"
            className="form-control"
            accept=".json,application/json"
            disabled={busy}
            onChange={e =>
              e.target.files[0] && handleFile(e.target.files[0])
            }
          />
          {verifying && (
            <div className={
              'd-flex align-items-center' +
              ' gap-2 mt-3 text-secondary small'
            }>
              <span
                className="spinner-border spinner-border-sm"
              />
              Verifying connection and master key…
            </div>
          )}
          {error && (
            <div className="alert alert-danger py-2 small mt-3">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
