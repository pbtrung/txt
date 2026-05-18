import React, { useEffect, useState } from 'react';
import {
  initCrypto, parseMasterKey, decryptName, zeroBytes,
} from '../crypto.js';
import { initDb, resetDb, fetchOneTxt } from '../db.js';

function _parseCredentials(json) {
  const { turso_database_url: url, turso_auth_token: token, master_key } = json;
  if (!url || !token || !master_key)
    throw new Error('Missing required fields: turso_database_url, turso_auth_token, master_key');
  return { url, token, master_key };
}

async function _verifyConnection() {
  try { return await fetchOneTxt(); }
  catch (e) { throw new Error(`Turso connection failed: ${e.message}`); }
}

function _verifyMasterKey(row, masterKey) {
  if (!row) return;
  try { decryptName(row.name, masterKey); }
  catch { throw new Error('master_key is incorrect: failed to decrypt a stored filename'); }
}

function useCryptoReady() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    initCrypto().then(() => setReady(true));
  }, []);
  return ready;
}

async function connectWithCredentials(file, onConnect, setVerifying) {
  let masterKey = null;
  try {
    const json = JSON.parse(await file.text());
    const { url, token, master_key } = _parseCredentials(json);
    masterKey = parseMasterKey(master_key);
    initDb(url, token);
    setVerifying(true);
    _verifyMasterKey(await _verifyConnection(), masterKey);
    onConnect({ masterKey });
  } catch (e) {
    resetDb(); zeroBytes(masterKey); throw e;
  }
}

function LoginCard({ busy, verifying, error, onFile }) {
  return (
    <div className="card shadow-sm" style={{ maxWidth: 440, width: '100%', margin: '1rem' }}>
      <div className="card-body p-4">
        <LoginIntro />
        <CryptoStatus busy={busy} verifying={verifying} />
        <CredentialsInput busy={busy} onFile={onFile} />
        <VerifyStatus verifying={verifying} />
        <ErrorAlert error={error} />
      </div>
    </div>
  );
}

function LoginIntro() {
  return (
    <>
      <h4 className="mb-1 fw-bold">Text Reader</h4>
      <p className="text-muted mb-4 small">
        Upload a credentials JSON file to connect to your Turso database.
      </p>
    </>
  );
}

function CryptoStatus({ busy, verifying }) {
  if (!busy || verifying) return null;
  return <StatusLine text="Initialising crypto…" />;
}

function VerifyStatus({ verifying }) {
  return verifying
    ? <StatusLine text="Verifying connection and master key…" />
    : null;
}

function StatusLine({ text }) {
  return (
    <div className="d-flex align-items-center gap-2 mb-3 text-secondary small">
      <span className="spinner-border spinner-border-sm" />
      {text}
    </div>
  );
}

function CredentialsInput({ busy, onFile }) {
  const handleChange = e => e.target.files[0] && onFile(e.target.files[0]);
  return (
    <>
      <label className="form-label fw-semibold">Credentials file</label>
      <input type="file" className="form-control" accept=".json,application/json" disabled={busy} onChange={handleChange} />
    </>
  );
}

function ErrorAlert({ error }) {
  return error
    ? <div className="alert alert-danger py-2 small mt-3">{error}</div>
    : null;
}

export default function LoginScreen({ onConnect }) {
  const cryptoReady = useCryptoReady();
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState(null);
  const busy = !cryptoReady || verifying;
  const onFile = file => handleFile(file, onConnect, setError, setVerifying);
  return (
    <div className="min-vh-100 d-flex align-items-center justify-content-center bg-light">
      <LoginCard busy={busy} verifying={verifying} error={error} onFile={onFile} />
    </div>
  );
}

async function handleFile(file, onConnect, setError, setVerifying) {
  setError(null);
  try {
    await connectWithCredentials(file, onConnect, setVerifying);
  } catch (e) {
    setError(e.message);
  } finally {
    setVerifying(false);
  }
}
