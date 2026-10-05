import { useState } from 'react';
import { api, type Notify } from './api';
import { useData } from './pages';
import { Button, Field, Loading } from './ui';
export function AccountSecurity({ notify }: { notify: Notify }) {
  const { data, reload } = useData<any>('/api/account/security', notify);
  const [setup, setSetup] = useState<any>(null),
    [codes, setCodes] = useState<string[]>([]),
    [busy, setBusy] = useState(false);
  const action = async (path: string, body: any) => {
    setBusy(true);
    try {
      return await api(path, body);
    } catch (error) {
      notify((error as Error).message, true);
      return null;
    } finally {
      setBusy(false);
    }
  };
  if (!data) return <Loading />;
  return (
    <div className="settings-grid">
      <section className="panel settings-form">
        <h3>Two-factor authentication</h3>
        <p>
          {data.mfaEnabled
            ? 'Enabled. Sign-in requires an authenticator or a recovery code.'
            : 'Add a second verification step to protect your account.'}
        </p>
        {codes.length > 0 && (
          <div className="result-block">
            <strong>Save these recovery codes now.</strong>
            <p>Each works once. You will need one if you lose your authenticator.</p>
            <pre>{codes.join('\n')}</pre>
            <Button onClick={() => setCodes([])}>I saved my recovery codes</Button>
          </div>
        )}
        {!data.mfaEnabled && !setup && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const r = await action(
                '/api/account/mfa/setup',
                Object.fromEntries(new FormData(e.currentTarget)),
              );
              if (r) setSetup(r);
            }}
          >
            <Field label="Confirm your password">
              <input name="password" type="password" required autoComplete="current-password" />
            </Field>
            <Button variant="primary" disabled={busy}>
              Set up authenticator
            </Button>
          </form>
        )}
        {setup && !data.mfaEnabled && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const r = await action(
                '/api/account/mfa/confirm',
                Object.fromEntries(new FormData(e.currentTarget)),
              );
              if (r) {
                setCodes(r.recoveryCodes);
                setSetup(null);
                reload();
                notify('Two-factor authentication enabled');
              }
            }}
          >
            <p>Add a time-based account in your authenticator app using this setup key.</p>
            <Field label="Authenticator setup key">
              <input value={setup.secret} readOnly />
            </Field>
            <Field label="Authenticator code">
              <input
                name="code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                required
                autoComplete="one-time-code"
              />
            </Field>
            <Button variant="primary" disabled={busy}>
              Enable two-factor authentication
            </Button>
          </form>
        )}
        {data.mfaEnabled && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const r = await action(
                '/api/account/mfa/disable',
                Object.fromEntries(new FormData(e.currentTarget)),
              );
              if (r) {
                reload();
                setCodes([]);
                notify('Two-factor authentication disabled');
              }
            }}
          >
            <p>{data.recoveryCodesRemaining} recovery codes remaining.</p>
            <Field label="Password">
              <input name="password" type="password" autoComplete="current-password" required />
            </Field>
            <Field label="Verification or recovery code">
              <input name="code" autoComplete="one-time-code" required />
            </Field>
            <Button disabled={busy}>Disable two-factor authentication</Button>
          </form>
        )}
      </section>
      <section className="panel settings-form">
        <h3>Change password</h3>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget,
              r = await action('/api/account/password', Object.fromEntries(new FormData(form)));
            if (r) {
              form.reset();
              notify('Password updated; other sessions were signed out');
            }
          }}
        >
          <Field label="Current password">
            <input name="current" type="password" required autoComplete="current-password" />
          </Field>
          <Field label="New password" hint="At least 10 characters.">
            <input
              name="password"
              type="password"
              minLength={10}
              required
              autoComplete="new-password"
            />
          </Field>
          {data.mfaEnabled && (
            <Field label="Verification code">
              <input name="code" required autoComplete="one-time-code" />
            </Field>
          )}
          <Button variant="primary" disabled={busy}>
            Update password
          </Button>
        </form>
        <p>
          Organization sign-in: {data.sso ? 'configured' : 'not configured'}
          <br />
          Email recovery: {data.passwordReset ? 'configured' : 'not configured'}
        </p>
      </section>
    </div>
  );
}
