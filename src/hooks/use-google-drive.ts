import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useMemo, useState } from 'react';

import { GoogleDriveProvider } from '@/lib/google-drive';

WebBrowser.maybeCompleteAuthSession();

const discovery = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
};

const scopes = [
  'openid',
  'profile',
  'email',
  'https://www.googleapis.com/auth/drive.file',
];

export interface GoogleDriveAuthState {
  configured: boolean;
  busy: boolean;
  error: string | null;
  provider: GoogleDriveProvider | null;
  connect: () => Promise<GoogleDriveProvider | null>;
  disconnect: () => Promise<void>;
}

export function useGoogleDrive(): GoogleDriveAuthState {
  const clientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
  const redirectUri = AuthSession.makeRedirectUri({ scheme: 'onetake' });
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [request, , promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: clientId ?? 'missing-google-client-id',
      redirectUri,
      scopes,
      responseType: AuthSession.ResponseType.Token,
    },
    discovery
  );

  const provider = useMemo(
    () => (accessToken ? new GoogleDriveProvider(accessToken) : null),
    [accessToken]
  );

  const connect = useCallback(async (): Promise<GoogleDriveProvider | null> => {
    if (!clientId || !request || busy) return null;
    setBusy(true);
    setError(null);
    try {
      const res = await promptAsync();
      if (res.type !== 'success') return null;
      const token = res.authentication?.accessToken ?? null;
      if (!token) throw new Error('Google did not return an access token.');
      setAccessToken(token);
      return new GoogleDriveProvider(token);
    } catch (e) {
      setError((e as { message?: string })?.message ?? 'Google Drive sign-in failed.');
      return null;
    } finally {
      setBusy(false);
    }
  }, [busy, clientId, promptAsync, request]);

  const disconnect = useCallback(async () => {
    setAccessToken(null);
    setError(null);
  }, []);

  return {
    configured: Boolean(clientId),
    busy,
    error,
    provider,
    connect,
    disconnect,
  };
}
